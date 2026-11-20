import type { AttemptEventV1 } from "@qb-study/contracts";
import { describe, expect, it, vi } from "vitest";

import { generateDailyReviewPlan, type DailyReviewPlan, type ReviewMemoryModel } from "../src/index.js";
import { selectDailyReviewAdditions, selectDailyReviewItems } from "../src/selector.js";

const AS_OF = "2026-10-16T04:00:00+09:00";
const DUE_BEFORE = "2026-10-16T19:00:00.000Z";

function attempt(id: number, questionKey: string, answeredAt = "2026-10-01T12:00:00+09:00",
  result: AttemptEventV1["result"] = "incorrect"): AttemptEventV1 {
  return { schema_version: "1", record_type: "attempt_event",
    event_id: `10000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    question_key: questionKey, answered_at: answeredAt, result, selected_option_indices: [1],
    provenance: { producer: "browser-extension", producer_version: "0.1.2", source_system: "qb-web-dom", recorded_at: answeredAt },
    quality: { acquisition_method: "direct_capture", temporal_precision: "exact", state_precision: "exact" } };
}

function model(dueByQuestion: Readonly<Record<string, string>>): ReviewMemoryModel {
  return { model_id: "test", model_version: "1", grade_policy_version: "test-v1",
    predict: vi.fn(({ attempts }: Parameters<ReviewMemoryModel["predict"]>[0]) => ({
      next_review_at: new Date(dueByQuestion[attempts[0]!.question_key]!).toISOString(),
      retrievability: 0.5, stability_days: 1, difficulty: 5, derived_grades: [],
    })) };
}

/** Build an old saved plan without changing evidence or recomputing predictions. */
function legacyPlan(plan: DailyReviewPlan): DailyReviewPlan {
  const states = plan.states.map((state) => state.exclusion === null
    && state.prediction.next_review_at !== null && state.prediction.next_review_at > plan.selection_at
    ? { ...state, exclusion: "not_due" as const } : state);
  const selected = selectDailyReviewItems({ states, as_of: plan.selection_at,
    calendar_date: plan.calendar_date, max_questions: plan.settings.max_questions });
  const old: DailyReviewPlan = { ...plan, algorithm_version: "2", states, ...selected };
  const { due_before: omitted, ...withoutHorizon } = old;
  expect(omitted).toBe(DUE_BEFORE);
  return withoutHorizon;
}

describe("review deadlines through the next 04:00 JST", () => {
  it("includes afternoon, night and pre-04:00 deadlines but excludes the exact next boundary", () => {
    const dates = {
      "119A1": "2026-10-16T03:00:00+09:00", "119A2": "2026-10-16T15:00:00+09:00",
      "119A3": "2026-10-16T23:00:00+09:00", "119A4": "2026-10-17T03:59:59.999+09:00",
      "119A5": "2026-10-17T04:00:00+09:00", "119A6": "2026-10-17T04:00:00.001+09:00",
    };
    const plan = generateDailyReviewPlan({ as_of: AS_OF,
      attempts: Object.keys(dates).map((key, i) => attempt(i + 1, key)), model: model(dates) });
    expect(plan.items.map((item) => item.question_key)).toEqual(["119A1", "119A2", "119A3", "119A4"]);
    expect(plan.states.slice(4).map((state) => state.exclusion)).toEqual(["not_due", "not_due"]);
    expect(plan.due_before).toBe(DUE_BEFORE);
    expect(plan.algorithm_version).toBe("5");
    expect(plan.items[0]!.reasons).toContainEqual({ code: "model_due", facts: {
      model_due_at: "2026-10-15T18:00:00.000Z", as_of: "2026-10-15T19:00:00.000Z",
      due_before: DUE_BEFORE, due_window: "overdue",
    } });
    expect(plan.items[3]!.reasons).toContainEqual({ code: "model_due", facts: {
      model_due_at: "2026-10-16T18:59:59.999Z", as_of: "2026-10-15T19:00:00.000Z",
      due_before: DUE_BEFORE, due_window: "later_in_review_day",
    } });
  });

  it.each(["2026-10-16T23:00:00+09:00", "2026-10-17T01:00:00+09:00"])(
    "keeps the target day's next 04:00 boundary when execution is delayed until %s", (asOf) => {
      const memory = model({ "119A1": "2026-10-17T03:00:00+09:00", "119A2": "2026-10-17T04:00:00+09:00" });
      const plan = generateDailyReviewPlan({ as_of: asOf, attempts: [attempt(1, "119A1"), attempt(2, "119A2")], model: memory });
      expect(plan.target_date).toBe("2026-10-16");
      expect(plan.due_before).toBe(DUE_BEFORE);
      expect(plan.items.map((item) => item.question_key)).toEqual(["119A1"]);
      expect(vi.mocked(memory.predict).mock.calls.every(([input]) => input.as_of === new Date(asOf).toISOString())).toBe(true);
    });

  it("advances the exclusive deadline across month and year boundaries at 04:00", () => {
    const before = generateDailyReviewPlan({ as_of: "2027-01-01T03:59:59.999+09:00", attempts: [] });
    const after = generateDailyReviewPlan({ as_of: "2027-01-01T04:00:00+09:00", attempts: [] });
    expect(before).toMatchObject({ target_date: "2026-12-31", due_before: "2026-12-31T19:00:00.000Z" });
    expect(after).toMatchObject({ target_date: "2027-01-01", due_before: "2027-01-01T19:00:00.000Z" });
  });

  it("keeps future answers and not-yet-recorded evidence out of the model despite the wider deadline", () => {
    const normal = attempt(1, "119A1");
    const future = attempt(2, "119A1", "2026-10-16T15:00:00+09:00", "correct");
    const unavailable = { ...attempt(3, "119A1"), provenance: { ...normal.provenance, recorded_at: future.answered_at } };
    const memory = model({ "119A1": "2026-10-16T21:00:00+09:00" });
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [normal, future, unavailable],
      contexts: [{ event_id: normal.event_id, study_mode: "normal" }], model: memory });
    expect(plan.excluded_future_attempts).toBe(2);
    expect(plan.all_time_counts.normal.attempts).toBe(1);
    expect(plan.items).toHaveLength(1);
    expect(vi.mocked(memory.predict).mock.calls[0]![0]).toMatchObject({
      as_of: "2026-10-15T19:00:00.000Z", attempts: [{ event_id: normal.event_id }],
    });
    expect(vi.mocked(memory.predict).mock.calls[0]![0].attempts).toHaveLength(1);
  });

  it("includes a normal correct answer whose FSRS review deadline falls later today", () => {
    const normal = attempt(1, "119A1", "2026-10-13T21:00:00+09:00", "correct");
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [normal],
      contexts: [{ event_id: normal.event_id, study_mode: "normal" }] });
    expect(plan.states[0]!.prediction.derived_grades[0]).toMatchObject({ observed_result: "correct", derived_grade: "Good" });
    expect(plan.items[0]).toMatchObject({ question_key: "119A1", model_due_at: "2026-10-16T12:00:00.000Z" });
    expect(plan.all_time_counts.normal.correct).toBe(1);
    expect(normal.result).toBe("correct");
  });

  it("preserves stops, future manual dates, today's correct answers and daily caps for later deadlines", () => {
    const attempts = [attempt(1, "119A1"), attempt(2, "119A2"),
      attempt(3, "119A3", "2026-10-16T02:00:00+09:00", "correct"),
      attempt(4, "119A4", "2026-10-16T02:00:00+09:00"), attempt(5, "119A4", "2026-10-16T03:00:00+09:00")];
    const due = "2026-10-16T21:00:00+09:00";
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts, questions: [
      { question_key: "119A1", stopped: true }, { question_key: "119A2", next_review_on: "2026-10-17" },
    ], model: model({ "119A1": due, "119A2": due, "119A3": due, "119A4": due }) });
    expect(plan.items).toEqual([]);
    expect(plan.states.map((state) => state.exclusion)).toEqual(["stopped", "manual_due_future", "correct_today", "daily_cap_reached"]);
  });
});

describe("append-only additions from saved predictions", () => {
  function savedPlan(maxQuestions = 100): DailyReviewPlan {
    const due = "2026-10-16T21:00:00+09:00";
    return legacyPlan(generateDailyReviewPlan({ as_of: AS_OF,
      attempts: Array.from({ length: 7 }, (_, i) => attempt(i + 1, `119A${i + 1}`)),
      questions: [{ question_key: "119A5", stopped: true }, { question_key: "119A6", next_review_on: "2026-10-17" }],
      settings: { max_questions: maxQuestions }, model: model({
        "119A1": "2026-10-15T21:00:00+09:00", "119A2": due, "119A3": due,
        "119A4": "2026-10-17T04:00:00+09:00", "119A5": due, "119A6": due, "119A7": due,
      }) }));
  }

  it("adds only previously not-due questions, preserving original items and all saved evidence", () => {
    const original = savedPlan();
    const before = structuredClone(original);
    const additions = selectDailyReviewAdditions(original);
    expect(original).not.toHaveProperty("due_before");
    expect(original).toEqual(before);
    expect(additions).toMatchObject({ due_before: DUE_BEFORE, eligible_question_count: 3 });
    expect(additions.items.map((item) => [item.question_key, item.position])).toEqual([["119A2", 2], ["119A3", 3], ["119A7", 4]]);
    expect([...original.items, ...additions.items].slice(0, original.items.length)).toEqual(before.items);
    expect(additions.items.every((item) => item.reasons.some((reason) => reason.code === "model_due"
      && reason.facts.due_window === "later_in_review_day"))).toBe(true);
  });

  it("limits additions to remaining capacity while reporting all newly eligible questions", () => {
    const additions = selectDailyReviewAdditions(savedPlan(2));
    expect(additions.eligible_question_count).toBe(3);
    expect(additions.items.map((item) => [item.question_key, item.position])).toEqual([["119A2", 2]]);
    const full = selectDailyReviewAdditions(savedPlan(1));
    expect(full.eligible_question_count).toBe(3);
    expect(full.items).toEqual([]);
  });

  it("does not re-add existing keys or relax another exclusion and is deterministic", () => {
    const original = savedPlan();
    const revised = { ...original, states: original.states.map((state) =>
      state.question_key === "119A2" ? { ...state, exclusion: "correct_today" as const }
        : state.question_key === "119A3" ? { ...state, exclusion: "daily_cap_reached" as const }
          : state.question_key === "119A1" ? { ...state, exclusion: "not_due" as const } : state) };
    const first = selectDailyReviewAdditions(revised);
    const second = selectDailyReviewAdditions({ ...revised, states: [...revised.states].reverse() });
    expect(first).toEqual(second);
    expect(first.items.map((item) => item.question_key)).toEqual(["119A7"]);
  });

  it("returns no additions after the new deadline policy has already selected a plan", () => {
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt(1, "119A1")],
      model: model({ "119A1": "2026-10-16T21:00:00+09:00" }) });
    expect(selectDailyReviewAdditions(plan)).toMatchObject({ items: [], eligible_question_count: 0 });
  });
});
