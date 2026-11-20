import type { AttemptEventV1, RecoveredAttemptV1 } from "@qb-study/contracts";
import { describe, expect, it, vi } from "vitest";
import { generateDailyReviewPlan, type ReviewMemoryModel } from "../src/index.js";

const AS_OF = "2026-10-19T12:00:00+09:00";
function recovery(id = 1, overrides: Partial<RecoveredAttemptV1> = {}): RecoveredAttemptV1 {
  return { schema_version: "1", record_type: "recovered_attempt",
    recovery_id: `a0000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    question_key: "119A12", answered_on: "2026-10-18", result: "incorrect",
    observed_at: "2026-10-18T22:00:00+09:00", recovered_at: "2026-10-19T09:00:00+09:00",
    study_mode: "unclassified", selected_option_indices: null, source_system: "computer-history",
    source_event_id: `synthetic-${id}`, source_segment: "segment-1", ...overrides };
}
function attempt(id = 1, answeredAt = "2026-10-17T12:00:00+09:00", overrides: Partial<AttemptEventV1> = {}): AttemptEventV1 {
  return { schema_version: "1", record_type: "attempt_event",
    event_id: `10000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    question_key: "119A12", answered_at: answeredAt, result: "incorrect", selected_option_indices: [1],
    provenance: { producer: "browser-extension", producer_version: "0.1.1", source_system: "qb-web-dom", recorded_at: answeredAt },
    quality: { acquisition_method: "direct_capture", temporal_precision: "exact", state_precision: "exact" }, ...overrides };
}
function model(): ReviewMemoryModel {
  return { model_id: "test", model_version: "1", grade_policy_version: "test-v1",
    predict: vi.fn(() => ({ next_review_at: "2026-10-17T00:00:00.000Z", retrievability: 0.5,
      stability_days: 1, difficulty: 5, derived_grades: [] })) };
}

describe("date-only recovered evidence", () => {
  it("counts a recovery as unclassified without inventing an exact model input or answer instant", () => {
    const memory = model();
    const source = recovery();
    const before = structuredClone(source);
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [], recovered_attempts: [source], model: memory });
    expect(memory.predict).not.toHaveBeenCalled();
    expect(plan.all_time_counts.total).toMatchObject({ attempts: 1, unique_questions: 1, incorrect: 1 });
    expect(plan.all_time_counts.unclassified.attempts).toBe(1);
    expect(plan.all_time_counts.normal.attempts).toBe(0);
    expect(plan.all_time_counts.review.attempts).toBe(0);
    expect(plan.recovered_evidence).toEqual({ attempts: 1, attempts_today: 0, excluded_future: 0, suppressed_by_direct: 0 });
    expect(plan.states[0]).toMatchObject({ latest_answered_at: null, latest_answered_on: "2026-10-18",
      recovered_due_on: "2026-10-19", graded_attempts: 0, evidence_sufficiency: "insufficient",
      prediction: { next_review_at: null, retrievability: null, stability_days: null, difficulty: null, derived_grades: [] } });
    expect(plan.items[0]?.reasons).toContainEqual({ code: "recovered_evidence_due", facts: {
      answered_on: "2026-10-18", recovered_due_on: "2026-10-19", result: "incorrect", provisional: true, interval_days: 1 } });
    expect(source).toEqual(before);
    expect(plan.algorithm_version).toBe("5");
  });

  it("deduplicates normalized recovery IDs and timestamps, but rejects changed contents", () => {
    const source = recovery();
    const equivalent = { ...source, recovery_id: source.recovery_id.toUpperCase(),
      observed_at: "2026-10-18T13:00:00Z", recovered_at: "2026-10-19T00:00:00Z" };
    const input = { as_of: AS_OF, attempts: [], recovered_attempts: [source, equivalent] };
    expect(generateDailyReviewPlan(input).all_time_counts.total.attempts).toBe(1);
    expect(generateDailyReviewPlan(input).evidence_hash).toBe(generateDailyReviewPlan({ ...input, recovered_attempts: [equivalent] }).evidence_hash);
    expect(() => generateDailyReviewPlan({ ...input, recovered_attempts: [source, { ...source, result: "correct" }] }))
      .toThrow("REVIEW_RECOVERY_CONFLICT");
  });

  it("rejects two different recovery IDs for a date-only question/day instead of guessing two answers", () => {
    expect(() => generateDailyReviewPlan({ as_of: AS_OF, attempts: [], recovered_attempts: [recovery(), recovery(2)] }))
      .toThrow("REVIEW_RECOVERY_CONFLICT");
  });

  it("keeps different question/day evidence and stable order regardless of input order", () => {
    const records = [recovery(), recovery(2, { question_key: "119A13" }), recovery(3, { answered_on: "2026-10-17" })];
    const first = generateDailyReviewPlan({ as_of: AS_OF, attempts: [], recovered_attempts: records });
    const reversed = generateDailyReviewPlan({ as_of: AS_OF, attempts: [], recovered_attempts: [...records].reverse() });
    expect(first).toEqual(reversed);
    expect(first.all_time_counts.total).toMatchObject({ attempts: 3, unique_questions: 2 });
  });

  it("excludes future observation and later recovery availability and carries upstream exclusions", () => {
    const laterObservation = recovery(2, { question_key: "119A13", observed_at: "2026-10-20T00:00:00Z", recovered_at: "2026-10-20T00:00:00Z" });
    const laterRecovery = recovery(3, { question_key: "119A14", recovered_at: "2026-10-19T13:00:00+09:00" });
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [], recovered_attempts: [recovery(), laterObservation, laterRecovery],
      excluded_future_recovered_attempts: 4, suppressed_recovered_attempts: 2 });
    expect(plan.recovered_evidence).toEqual({ attempts: 1, attempts_today: 0, excluded_future: 6, suppressed_by_direct: 2 });
    expect(plan.states.map((state) => state.question_key)).toEqual(["119A12"]);
  });

  it("suppresses a recovery when direct evidence arrives for the same Tokyo date", () => {
    const captured = attempt(1, "2026-10-17T15:01:00Z");
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [captured], recovered_attempts: [recovery()],
      contexts: [{ event_id: captured.event_id, study_mode: "normal" }] });
    expect(plan.all_time_counts.total.attempts).toBe(1);
    expect(plan.all_time_counts.normal.attempts).toBe(1);
    expect(plan.all_time_counts.unclassified.attempts).toBe(0);
    expect(plan.recovered_evidence).toMatchObject({ attempts: 0, suppressed_by_direct: 1 });
    expect(plan.states[0]).not.toHaveProperty("latest_answered_on");
  });

  it("does not let an unavailable direct capture suppress recovery evidence", () => {
    const captured = attempt(1, "2026-10-18T12:00:00+09:00");
    const unavailable = { ...captured, provenance: { ...captured.provenance, recorded_at: "2026-10-19T13:00:00+09:00" } };
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [unavailable], recovered_attempts: [recovery()] });
    expect(plan.excluded_future_attempts).toBe(1);
    expect(plan.recovered_evidence).toMatchObject({ attempts: 1, suppressed_by_direct: 0 });
    expect(plan.states[0]?.latest_answered_at).toBeNull();
  });

  it("hides an older model prediction after a recovery and restores exact-only prediction after a later direct answer", () => {
    const memory = model();
    const old = attempt();
    const current = generateDailyReviewPlan({ as_of: AS_OF, attempts: [old], recovered_attempts: [recovery()], model: memory });
    expect(current.states[0]?.prediction.retrievability).toBeNull();
    expect(memory.predict).not.toHaveBeenCalled();
    const later = attempt(2, "2026-10-19T09:00:00+09:00");
    const updated = generateDailyReviewPlan({ as_of: AS_OF, attempts: [old, later], recovered_attempts: [recovery()], model: memory });
    expect(updated.states[0]?.prediction.retrievability).toBe(0.5);
    expect(memory.predict).toHaveBeenCalledTimes(1);
    expect(vi.mocked(memory.predict).mock.calls[0]?.[0].attempts.map((event) => event.event_id)).toEqual([old.event_id, later.event_id]);
    expect(updated.states[0]).not.toHaveProperty("latest_answered_on");
    expect(updated.all_time_counts.total.attempts).toBe(3);
  });

  it.each([
    { result: "incorrect" as const, day: "2026-10-18", due: "2026-10-19", before: "2026-10-18T23:00:00+09:00" },
    { result: "correct" as const, day: "2026-10-12", due: "2026-10-19", before: "2026-10-18T23:00:00+09:00" },
  ])("uses a date-only provisional schedule for $result", ({ result, day, due, before }) => {
    const source = recovery(1, { result, answered_on: day, observed_at: `${day}T10:00:00+09:00`, recovered_at: `${day}T11:00:00+09:00` });
    const early = generateDailyReviewPlan({ as_of: before, attempts: [], recovered_attempts: [source] });
    expect(early.items).toHaveLength(0);
    const plan = generateDailyReviewPlan({ as_of: `${due}T00:00:00+09:00`, attempts: [], recovered_attempts: [source] });
    expect(plan.states[0]?.recovered_due_on).toBe(due);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.model_due_at).toBeNull();
    expect(plan.items[0]?.reasons.some((reason) => reason.code === "recovered_evidence_due")).toBe(true);
  });

  it("honors today's correct evidence and the merged daily cap even with a manual due date", () => {
    const source = recovery(1, { answered_on: "2026-10-19", observed_at: "2026-10-19T08:00:00+09:00" });
    const input = { as_of: AS_OF, attempts: [], questions: [{ question_key: source.question_key, next_review_on: "2026-10-18" }],
      settings: { per_question_daily_cap: 1 } };
    const capped = generateDailyReviewPlan({ ...input, recovered_attempts: [source, source] });
    expect(capped.states[0]?.exclusion).toBe("daily_cap_reached");
    expect(capped.daily_counts.unclassified.attempts).toBe(1);
    expect(capped.recovered_evidence?.attempts_today).toBe(1);
    const correct = generateDailyReviewPlan({ ...input, recovered_attempts: [{ ...source, result: "correct" }] });
    expect(correct.states[0]?.exclusion).toBe("correct_today");
    expect(correct.items).toHaveLength(0);
  });

  it("preserves manual future and stop exclusions for recovered candidates", () => {
    for (const [metadata, exclusion] of [
      [{ stopped: true }, "stopped"], [{ next_review_on: "2026-10-20" }, "manual_due_future"],
    ] as const) {
      const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [], recovered_attempts: [recovery()],
        questions: [{ question_key: "119A12", ...metadata }] });
      expect(plan.states[0]?.exclusion).toBe(exclusion);
      expect(plan.items).toHaveLength(0);
    }
  });

  it("rejects malformed recovery metadata and invalid upstream counts", () => {
    expect(() => generateDailyReviewPlan({ as_of: AS_OF, attempts: [], recovered_attempts: [recovery(1, { answered_on: "2026-10-20" })] }))
      .toThrow("REVIEW_RECOVERED_ATTEMPT_INVALID");
    expect(() => generateDailyReviewPlan({ as_of: AS_OF, attempts: [], suppressed_recovered_attempts: -1 })).toThrow("REVIEW_INPUT_INVALID");
  });

  it("leaves recovery fields absent and evidence hashes unchanged without recovery input", () => {
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [] });
    expect(plan).not.toHaveProperty("recovered_evidence");
    expect(plan.algorithm_version).toBe("5");
    expect(plan.evidence_hash).toBe("0650aa6fc01a5b29ec276f096e029ff07b70ef128038bf5eaee2b9d5e044cbb5");
  });
});
