import type { AttemptEventV1 } from "@qb-study/contracts";
import { describe, expect, it } from "vitest";

import { generateDailyReviewPlan, type DailyReviewPlan, type ReviewMemoryModel } from "../src/index.js";
import { selectDailyReviewAdditions, selectDailyReviewItems } from "../src/selector.js";

const AS_OF = "2026-11-12T04:00:00+09:00";
const DUE = "2026-11-10T00:00:00.000Z";

function attempt(id: number, questionKey: string, overrides: Partial<AttemptEventV1> = {}): AttemptEventV1 {
  return { schema_version: "1", record_type: "attempt_event",
    event_id: `10000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    question_key: questionKey, answered_at: "2026-11-01T00:00:00.000Z", result: "incorrect",
    selected_option_indices: [1],
    provenance: { producer: "browser-extension", producer_version: "0.1.0", source_system: "qb-web-dom",
      recorded_at: "2026-11-01T00:00:01.000Z" },
    quality: { acquisition_method: "direct_capture", temporal_precision: "exact", state_precision: "exact" },
    ...overrides };
}

function model(rates: Readonly<Record<string, number>> = {}, dues: Readonly<Record<string, string>> = {}): ReviewMemoryModel {
  return { model_id: "test", model_version: "1", grade_policy_version: "test-v1",
    predict: ({ attempts }) => {
      const key = attempts[0]?.question_key;
      return { next_review_at: key === undefined ? null : dues[key] ?? DUE,
        retrievability: key === undefined ? null : rates[key] ?? 0.5,
        stability_days: key === undefined ? null : 1, difficulty: key === undefined ? null : 5, derived_grades: [] };
    } };
}

const keys = (plan: Pick<DailyReviewPlan, "items">) => plan.items.map((item) => item.question_key);

function legacySelection(plan: DailyReviewPlan) {
  return selectDailyReviewItems({ states: plan.states, calendar_date: plan.calendar_date,
    as_of: plan.selection_at, due_before: plan.due_before!, max_questions: plan.settings.max_questions });
}

describe("exam 120 priority weighting for new daily plans", () => {
  it("promotes a nearby risk but retains a substantially higher-risk earlier exam and original predictions", () => {
    const events = [attempt(1, "119A1"), attempt(2, "119A2"), attempt(3, "120A1")];
    const before = JSON.stringify(events);
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: events,
      model: model({ "119A1": 0.5, "119A2": 0.2, "120A1": 0.55 }) });
    expect(plan.algorithm_version).toBe("5");
    expect(keys(plan)).toEqual(["119A2", "120A1", "119A1"]);
    expect(keys(legacySelection(plan))).toEqual(["119A2", "119A1", "120A1"]);
    const latest = plan.items[1]!;
    expect(latest.retrievability).toBe(0.55);
    expect(latest.model_due_at).toBe(DUE);
    const reason = latest.reasons.find((entry) => entry.code === "exam_priority_weight");
    expect(reason?.facts).toMatchObject({ exam: 120, weight: 1.25 });
    expect(reason?.facts["base_forgetting_risk"]).toBeCloseTo(0.45);
    expect(reason?.facts["weighted_forgetting_risk"]).toBeCloseTo(0.5625);
    expect(plan.states.find((state) => state.question_key === "120A1")?.prediction.retrievability).toBe(0.55);
    expect(JSON.stringify(events)).toBe(before);
  });

  it("keeps manual deadlines, incorrect answers, ordinary due questions and today's retries in their existing tiers", () => {
    const events = [attempt(1, "119A1", { result: "correct" }), attempt(2, "119A2"),
      attempt(3, "120A1", { result: "correct" }),
      attempt(4, "120A2", { answered_at: "2026-11-12T03:00:00+09:00" })];
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: events,
      questions: [{ question_key: "119A1", next_review_on: "2026-11-11" }],
      model: model({ "119A1": 0.99, "119A2": 0.99, "120A1": 0, "120A2": 0 }) });
    expect(keys(plan)).toEqual(["119A1", "119A2", "120A1", "120A2"]);
    expect(plan.items.map((item) => item.priority_tier)).toEqual([0, 1, 2, 3]);
  });

  it("preserves subject balance ahead of the exam weight", () => {
    const plan = generateDailyReviewPlan({ as_of: AS_OF,
      attempts: [attempt(1, "120A1"), attempt(2, "120A2"), attempt(3, "119A1")],
      model: model({ "120A1": 0.1, "120A2": 0.2, "119A1": 0.9 }),
      questions: [{ question_key: "120A1", subjects: ["alpha"] },
        { question_key: "120A2", subjects: ["alpha"] }, { question_key: "119A1", subjects: ["beta"] }] });
    expect(keys(plan)).toEqual(["120A1", "119A1", "120A2"]);
  });

  it("uses an exam tie-break for unknown predictions without inventing a risk estimate", () => {
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [attempt(1, "119A2")], model: model(),
      questions: ["119A1", "119A2", "120A1"].map((question_key) => ({ question_key, next_review_on: "2026-11-11" })) });
    expect(keys(plan)).toEqual(["119A2", "120A1", "119A1"]);
    expect(plan.items[1]).toMatchObject({ retrievability: null, model_due_at: null });
    expect(plan.items[1]!.reasons).toContainEqual({ code: "exam_priority_weight", facts: {
      exam: 120, weight: 1.25, base_forgetting_risk: null, weighted_forgetting_risk: null,
    } });
    expect(plan.states.find((state) => state.question_key === "120A1")?.prediction).toMatchObject({
      retrievability: null, next_review_at: null, stability_days: null, difficulty: null,
    });
    expect(keys(legacySelection(plan))).toEqual(["119A2", "119A1", "120A1"]);
  });

  it("applies the weight before the 100-question cap without changing the eligible count", () => {
    const events = Array.from({ length: 101 }, (_, i) => attempt(i + 1, `119A${i + 1}`));
    events.push(attempt(102, "120A1"));
    const rates = Object.fromEntries(events.map((event) => [event.question_key, event.question_key === "120A1" ? 0.65 : 0.6]));
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: events, model: model(rates) });
    expect(plan.items).toHaveLength(100);
    expect(plan.eligible_question_count).toBe(102);
    expect(keys(plan)[0]).toBe("120A1");
    expect(new Set(keys(plan)).size).toBe(100);
    expect(keys(legacySelection(plan))).not.toContain("120A1");
  });

  it("does not override range, stop, correct-today, daily-cap, manual-future or not-due exclusions", () => {
    const events = [attempt(1, "115A1"), attempt(2, "120A1"),
      attempt(3, "120A2", { result: "correct", answered_at: "2026-11-12T02:00:00+09:00" }),
      attempt(4, "120A3"), attempt(5, "120A4"),
      attempt(6, "120A5", { answered_at: "2026-11-12T02:00:00+09:00" }),
      attempt(7, "120A5", { answered_at: "2026-11-12T03:00:00+09:00" }), attempt(8, "119A1")];
    const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: events,
      questions: [{ question_key: "120A1", stopped: true }, { question_key: "120A3", next_review_on: "2026-11-13" }],
      model: model({}, { "120A4": "2026-11-12T19:00:00.000Z" }) });
    expect(keys(plan)).toEqual(["119A1"]);
    expect(Object.fromEntries(plan.states.map((state) => [state.question_key, state.exclusion]))).toEqual({
      "115A1": "outside_exam_scope", "119A1": null, "120A1": "stopped", "120A2": "correct_today",
      "120A3": "manual_due_future", "120A4": "not_due", "120A5": "daily_cap_reached",
    });
    expect(plan.all_time_counts.total.attempts).toBe(8);
  });

  it("replays old unweighted additions in their original order and preserves the saved prefix and states", () => {
    const later = "2026-11-12T03:00:00.000Z";
    const newPlan = generateDailyReviewPlan({ as_of: AS_OF,
      attempts: [attempt(1, "116A1"), attempt(2, "119A1"), attempt(3, "120A1")],
      model: model({ "116A1": 0.1, "119A1": 0.5, "120A1": 0.55 }, { "119A1": later, "120A1": later }) });
    const states = newPlan.states.map((state) => state.question_key === "116A1" ? state : { ...state, exclusion: "not_due" as const });
    const selected = selectDailyReviewItems({ states, calendar_date: newPlan.calendar_date,
      as_of: newPlan.selection_at, max_questions: newPlan.settings.max_questions });
    const saved: DailyReviewPlan = { ...newPlan, algorithm_version: "2", states, ...selected };
    const before = JSON.stringify(saved);
    const additions = selectDailyReviewAdditions(saved);
    expect(keys(saved)).toEqual(["116A1"]);
    expect(keys(additions)).toEqual(["119A1", "120A1"]);
    expect(additions.items.map((item) => item.position)).toEqual([2, 3]);
    expect(additions.items.flatMap((item) => item.reasons).some((reason) => reason.code === "exam_priority_weight")).toBe(false);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("repeats weighted ties deterministically across input permutations", () => {
    const events = [attempt(1, "119A1"), attempt(2, "120A2"), attempt(3, "120A1")];
    const first = generateDailyReviewPlan({ as_of: AS_OF, attempts: events, model: model() });
    const reversed = generateDailyReviewPlan({ as_of: AS_OF, attempts: [...events].reverse(), model: model() });
    expect(first).toEqual(reversed);
    expect(keys(first)).toEqual(["120A1", "120A2", "119A1"]);
  });
});
