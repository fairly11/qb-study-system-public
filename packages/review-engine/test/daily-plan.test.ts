import type { AttemptEventV1, HistorySnapshotV1, RecoveredAttemptV1 } from "@qb-study/contracts";
import { describe, expect, it } from "vitest";

import { generateDailyReviewPlan, fsrsMemoryModel, type ReviewMemoryModel } from "../src/index.js";
import { selectDailyReviewAdditions } from "../src/selector.js";

const AS_OF = "2026-10-16T04:00:00+09:00";
function attempt(id = 1, overrides: Partial<AttemptEventV1> = {}): AttemptEventV1 {
  return {
    schema_version: "1", record_type: "attempt_event",
    event_id: `10000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    question_key: "119A12", answered_at: "2026-10-01T09:00:00+09:00", result: "incorrect",
    selected_option_indices: [1],
    provenance: { producer: "browser-extension", producer_version: "0.1.0", source_system: "qb-web-dom",
      recorded_at: "2026-10-01T09:00:01+09:00" },
    quality: { acquisition_method: "direct_capture", temporal_precision: "exact", state_precision: "exact" },
    ...overrides,
  };
}
function snapshot(): HistorySnapshotV1 {
  return { schema_version: "1", record_type: "history_snapshot",
    snapshot_id: "20000000-0000-4000-8000-000000000001", snapshot_run_id: "30000000-0000-4000-8000-000000000001",
    question_key: "119A12", observed_at: "2026-10-01T09:00:00+09:00", final_state: "incorrect",
    attempt_count: 83, last_attempted_on: "2026-09-30",
    provenance: { producer: "baseline-import", producer_version: "1", source_system: "qb-history",
      recorded_at: "2026-10-01T09:00:00+09:00" },
    quality: { acquisition_method: "imported_baseline", temporal_precision: "date_only", state_precision: "final_state_only" },
  };
}
const dueModel: ReviewMemoryModel = {
  model_id: "test", model_version: "1", grade_policy_version: "test-v1",
  predict: () => ({ next_review_at: "2026-10-01T00:00:00.000Z", retrievability: 0.5,
    stability_days: 1, difficulty: 5, derived_grades: [] }),
};

describe("daily plan evidence and accounting", () => {
  it("deduplicates a retransmission, preserving distinct answers and counting unique questions separately", () => {
    const first = attempt();
    const second = attempt(2);
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [first, first, second],
      contexts: [{ event_id: first.event_id, study_mode: "normal" }, { event_id: second.event_id, study_mode: "review" }] });
    expect(plan.all_time_counts.total).toMatchObject({ attempts: 2, unique_questions: 1 });
    expect(plan.all_time_counts.normal.attempts).toBe(1);
    expect(plan.all_time_counts.review.attempts).toBe(1);
  });

  it("rejects an event-id content conflict rather than selecting a preferred copy", () => {
    expect(() => generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt(), attempt(1, { result: "correct" })] }))
      .toThrow("REVIEW_EVENT_CONFLICT");
  });

  it("rejects conflicting study classifications, and keeps missing classification visible", () => {
    const event = attempt();
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [event] });
    expect(plan.all_time_counts.unclassified.attempts).toBe(1);
    expect(() => generateDailyReviewPlan({ as_of: AS_OF, attempts: [event], contexts: [
      { event_id: event.event_id, study_mode: "normal" }, { event_id: event.event_id, study_mode: "review" },
    ] })).toThrow("REVIEW_CONTEXT_CONFLICT");
  });

  it("uses normal answers for memory updates while keeping observed results and derived grades separate", () => {
    const event = attempt(1, { result: "correct" });
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [event],
      contexts: [{ event_id: event.event_id, study_mode: "normal" }] });
    expect(plan.states[0]!.prediction.derived_grades).toEqual([{
      event_id: event.event_id, answered_at: "2026-10-01T00:00:00.000Z", observed_result: "correct", derived_grade: "Good",
    }]);
    expect(plan.states[0]!.prediction.stability_days).toBeGreaterThan(0);
    expect(event.result).toBe("correct");
  });

  it("counts unknown results without changing the memory state", () => {
    const first = attempt();
    const unknown = attempt(2, { result: "unknown", answered_at: "2026-10-02T00:00:00Z" });
    const one = generateDailyReviewPlan({ as_of: AS_OF, attempts: [first] });
    const two = generateDailyReviewPlan({ as_of: AS_OF, attempts: [first, unknown] });
    expect(two.states[0]!.prediction.stability_days).toBe(one.states[0]!.prediction.stability_days);
    expect(two.states[0]!.prediction.next_review_at).toBe(one.states[0]!.prediction.next_review_at);
    expect(two.all_time_counts.total.unknown).toBe(1);
    expect(two.states[0]!.prediction.derived_grades.at(-1)!.derived_grade).toBeNull();
  });

  it("keeps an initial aggregate snapshot separate, without inventing 83 historical answers", () => {
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [], snapshots: [snapshot()] });
    expect(plan.all_time_counts.total.attempts).toBe(0);
    expect(plan.states[0]).toMatchObject({ snapshot_count: 1, graded_attempts: 0, evidence_sufficiency: "insufficient" });
    expect(plan.states[0]!.prediction.next_review_at).toBeNull();
    expect(plan.items).toEqual([]);
  });

  it("excludes future answers and records not yet observed at the as-of instant", () => {
    const future = attempt(2, { answered_at: "2026-10-16T04:00:00.001+09:00" });
    const notObserved = attempt(3, { provenance: { ...attempt().provenance, recorded_at: "2026-10-16T04:00:00.001+09:00" } });
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt(), future, notObserved] });
    expect(plan.all_time_counts.total.attempts).toBe(1);
    expect(plan.excluded_future_attempts).toBe(2);
  });

  it("includes the exact cutoff and switches plan dates at 04:00 JST rather than midnight", () => {
    const before = generateDailyReviewPlan({ as_of: "2026-10-16T03:59:59.999+09:00", attempts: [] });
    const at = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt(1, { answered_at: AS_OF })] });
    expect(before).toMatchObject({ target_date: "2026-10-15", calendar_date: "2026-10-16" });
    expect(at).toMatchObject({ target_date: "2026-10-16", calendar_date: "2026-10-16", scheduled_at: "2026-10-15T19:00:00.000Z" });
    expect(at.daily_counts.total.attempts).toBe(1);
  });

  it("supports a missed 04:00 run using the explicitly supplied recovery-time evidence", () => {
    const event = attempt(2, { answered_at: "2026-10-16T08:00:00+09:00" });
    const atFour = generateDailyReviewPlan({ as_of: AS_OF, attempts: [event] });
    const atNine = generateDailyReviewPlan({ as_of: "2026-10-16T09:00:00+09:00", attempts: [event] });
    expect(atFour.all_time_counts.total.attempts).toBe(0);
    expect(atNine.all_time_counts.total.attempts).toBe(1);
    expect(atNine.target_date).toBe(atFour.target_date);
    expect(atNine.selection_at).toBe("2026-10-16T00:00:00.000Z");
  });
});

describe("daily candidate policy", () => {
  it("excludes stopped, manually deferred, already-correct-today, and capped questions", () => {
    const events = [attempt(1), attempt(2, { question_key: "119A13" }),
      attempt(3, { question_key: "119A14", result: "correct", answered_at: "2026-10-16T03:00:00+09:00" }),
      attempt(4, { question_key: "119A15", answered_at: "2026-10-16T02:00:00+09:00" }),
      attempt(5, { question_key: "119A15", answered_at: "2026-10-16T03:00:00+09:00" })];
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: events, questions: [
      { question_key: "119A12", stopped: true }, { question_key: "119A13", next_review_on: "2026-10-17" },
    ] });
    expect(plan.items).toEqual([]);
    expect(plan.states.map((state) => state.exclusion)).toEqual(["stopped", "manual_due_future", "correct_today", "daily_cap_reached"]);
  });

  it("preserves a manual due date separately and allows an explicitly due question with sparse evidence", () => {
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [],
      questions: [{ question_key: "119A12", next_review_on: "2026-10-15" }] });
    expect(plan.items[0]).toMatchObject({ manual_due_on: "2026-10-15", model_due_at: null, evidence_sufficiency: "insufficient" });
    expect(plan.items[0]!.reasons.map((reason) => reason.code)).toContain("manual_due");
  });

  it("deprioritizes a same-day incorrect retry without discarding its count", () => {
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt(1, {
      question_key: "119A11", answered_at: "2026-10-16T03:00:00+09:00",
    }), attempt(2)], model: dueModel });
    expect(plan.items.map((item) => item.question_key)).toEqual(["119A12", "119A11"]);
    expect(plan.items[1]!.reasons).toContainEqual({ code: "same_day_retry_lower_priority", facts: { attempts_today: 1 } });
  });

  it("returns at most 100 unique candidates and does not add unattempted questions to fill the list", () => {
    const attempts = Array.from({ length: 120 }, (_, index) => attempt(index + 1, { question_key: `119A${index + 1}` }));
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts, model: dueModel });
    expect(plan.items).toHaveLength(100);
    expect(new Set(plan.items.map((item) => item.question_key)).size).toBe(100);
    expect(plan.eligible_question_count).toBe(120);
    const small = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt()],
      questions: [{ question_key: "119A13" }], model: fsrsMemoryModel });
    expect(small.items).toHaveLength(1);
  });

  it("does not accumulate unused quota on the following day", () => {
    const attempts = Array.from({ length: 4 }, (_, index) => attempt(index + 1, { question_key: `119A${index + 1}` }));
    const first = generateDailyReviewPlan({ as_of: AS_OF, attempts, settings: { max_questions: 3 }, model: dueModel });
    const next = generateDailyReviewPlan({ as_of: "2026-10-17T04:00:00+09:00", attempts, settings: { max_questions: 3 }, model: dueModel });
    expect(first.items).toHaveLength(3);
    expect(next.items).toHaveLength(3);
  });

  it("balances provided subject/field metadata within priority tiers without inferring knowledge tags", () => {
    const events = [attempt(1), attempt(2, { question_key: "119A13" }), attempt(3, { question_key: "119A14" })];
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: events, model: dueModel, questions: [
      { question_key: "119A12", subjects: ["内科"], fields: ["循環器"] },
      { question_key: "119A13", subjects: ["内科"], fields: ["循環器"] },
      { question_key: "119A14", subjects: ["内科"], fields: ["呼吸器"] },
    ] });
    expect(plan.items.map((item) => item.question_key)).toEqual(["119A12", "119A14", "119A13"]);
    expect(plan.items[0]!.reasons.at(-1)!.facts.bucket).toBe("subject:内科/field:循環器");
  });

  it("marks sparse observations without calling the model personally trained", () => {
    const sparse = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt()] });
    expect(sparse.model_status).toBe("provisional");
    expect(sparse.states[0]!.evidence_sufficiency).toBe("partial");
    expect(sparse.items[0]!.reasons.map((reason) => reason.code)).toContain("sparse_evidence");
    const more = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt(),
      attempt(2, { answered_at: "2026-10-02T09:00:00+09:00" }), attempt(3, { answered_at: "2026-10-03T09:00:00+09:00" })] });
    expect(more.states[0]!.evidence_sufficiency).toBe("sufficient");
    expect(more.model_status).toBe("provisional");
  });
});

describe("fixed review scope for exams 116 through 120", () => {
  it("includes all five exams and both boundaries, preserving excluded evidence and statistics", () => {
    const keys = ["080A1", "115F99", "116A1", "117B2", "118C3", "119D4", "120F99", "121A1"];
    const events = keys.map((question_key, i) => attempt(i + 1, { question_key }));
    const before = JSON.stringify(events);
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: events, model: dueModel });
    expect(plan.algorithm_version).toBe("5");
    expect(plan.items.map((item) => item.question_key)).toEqual(["120F99", ...keys.slice(2, 6)]);
    expect(plan.eligible_question_count).toBe(5);
    expect(plan.states.filter((state) => state.exclusion === "outside_exam_scope")
      .map((state) => state.question_key)).toEqual(["080A1", "115F99", "121A1"]);
    expect(plan.states).toHaveLength(8);
    expect(plan.states.every((state) => state.all_time_counts.total.attempts === 1)).toBe(true);
    expect(plan.all_time_counts.total).toMatchObject({ attempts: 8, unique_questions: 8 });
    expect(JSON.stringify(events)).toBe(before);
    expect(generateDailyReviewPlan({ as_of: AS_OF, attempts: [...events].reverse(), model: dueModel })).toEqual(plan);
  });

  it("filters before applying the budget, preserving priority within the allowed range", () => {
    const keys = ["115A1", "116A1", "119A1", "120A1", "121A1"];
    const plan = generateDailyReviewPlan({ as_of: AS_OF,
      attempts: keys.map((question_key, i) => attempt(i + 1, { question_key })), model: dueModel,
      questions: ["115A1", "120A1", "121A1"].map((question_key) => ({ question_key, next_review_on: "2026-10-15" })),
      settings: { max_questions: 2 } });
    expect(plan.items.map((item) => item.question_key)).toEqual(["120A1", "116A1"]);
    expect(plan.items.map((item) => item.position)).toEqual([1, 2]);
    expect(plan.eligible_question_count).toBe(3);
  });

  it("does not fill an empty candidate list with out-of-range incorrect retries or manual dates", () => {
    const plan = generateDailyReviewPlan({ as_of: AS_OF,
      attempts: [attempt(1, { question_key: "115A1", answered_at: "2026-10-16T03:00:00+09:00" })],
      questions: [{ question_key: "121A1", next_review_on: "2026-10-15" }] });
    expect(plan.items).toEqual([]);
    expect(plan.eligible_question_count).toBe(0);
    expect(plan.states.map((state) => state.exclusion)).toEqual(["outside_exam_scope", "outside_exam_scope"]);
    expect(plan.daily_counts.total.attempts).toBe(1);
    expect(selectDailyReviewAdditions(plan).items).toEqual([]);
  });

  it("applies the same range to date-only recoveries without losing recovered counts", () => {
    const recovered: RecoveredAttemptV1[] = ["115A1", "116A1", "120A1", "121A1"].map((question_key, i) => ({
      schema_version: "1", record_type: "recovered_attempt",
      recovery_id: `20000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      question_key, answered_on: "2026-10-15", result: "incorrect",
      observed_at: "2026-10-15T20:00:00+09:00", recovered_at: "2026-10-16T03:00:00+09:00",
      study_mode: "unclassified", selected_option_indices: null, source_system: "computer-history",
      source_event_id: `synthetic-${i + 1}`, source_segment: "segment-1",
    }));
    const before = JSON.stringify(recovered);
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [], recovered_attempts: recovered });
    expect(plan.items.map((item) => item.question_key)).toEqual(["120A1", "116A1"]);
    expect(plan.recovered_evidence?.attempts).toBe(4);
    expect(plan.all_time_counts.total.attempts).toBe(4);
    expect(plan.states.every((state) => state.prediction.next_review_at === null)).toBe(true);
    expect(JSON.stringify(recovered)).toBe(before);
  });

  it("does not roll the fixed exam range forward in a later calendar year", () => {
    const plan = generateDailyReviewPlan({ as_of: "2027-10-16T04:00:00+09:00", attempts: [],
      questions: ["115A1", "116A1", "120A1", "121A1"].map((question_key) => ({
        question_key, next_review_on: "2027-10-15",
      })) });
    expect(plan.items.map((item) => item.question_key)).toEqual(["120A1", "116A1"]);
  });
});

describe("repeatability and model replacement", () => {
  it("replays input permutations identically and does not mutate the supplied evidence", () => {
    const events = [attempt(1), attempt(2, { question_key: "119A13" })];
    const original = JSON.stringify(events);
    const first = generateDailyReviewPlan({ as_of: AS_OF, attempts: events });
    const second = generateDailyReviewPlan({ as_of: "2026-10-15T19:00:00Z", attempts: [...events].reverse() });
    expect(first).toEqual(second);
    expect(JSON.stringify(events)).toBe(original);
    expect(first.evidence_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("hashes effective configuration and evidence separately", () => {
    const baseline = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt()] });
    const changed = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt()], settings: { request_retention: 0.95 } });
    expect(changed.evidence_hash).toBe(baseline.evidence_hash);
    expect(changed.settings_hash).not.toBe(baseline.settings_hash);
    expect(changed.model_version).toBe(baseline.model_version);
  });

  it("uses an injected model without changing original answers or mode counts", () => {
    const original = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt()] });
    const replaced = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt()], model: dueModel });
    expect(replaced.model_id).toBe("test");
    expect(replaced.all_time_counts).toEqual(original.all_time_counts);
    expect(replaced.evidence_hash).toBe(original.evidence_hash);
  });

  it.each([0, 1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid retention %s", (requestRetention) => {
    expect(() => generateDailyReviewPlan({ as_of: AS_OF, attempts: [], settings: { request_retention: requestRetention } }))
      .toThrow("REVIEW_SETTINGS_INVALID");
  });

  it("rejects date-only cutoffs, invalid metadata dates, and overlarge candidate limits", () => {
    expect(() => generateDailyReviewPlan({ as_of: "2026-10-16", attempts: [] })).toThrow("REVIEW_TIMESTAMP_INVALID");
    expect(() => generateDailyReviewPlan({ as_of: AS_OF, attempts: [],
      questions: [{ question_key: "119A12", next_review_on: "2026-02-30" }] })).toThrow("REVIEW_METADATA_INVALID");
    expect(() => generateDailyReviewPlan({ as_of: AS_OF, attempts: [], settings: { max_questions: 101 } }))
      .toThrow("REVIEW_SETTINGS_INVALID");
  });
});
