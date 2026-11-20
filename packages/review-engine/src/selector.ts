import { compareText, exactTimestamp, ReviewEngineError } from "./evidence.js";
import type { DailyReviewItem, DailyReviewPlan, ReviewQuestionState, ReviewReason } from "./types.js";

interface Candidate {
  readonly state: ReviewQuestionState;
  readonly tier: number;
  readonly bucket: string;
  readonly reasons: readonly ReviewReason[];
}

function balanceBucket(state: ReviewQuestionState): string {
  const tags = state.metadata.knowledge_tags ?? [];
  if (tags.length > 0) return `knowledge:${tags[0]!}`;
  const subjects = state.metadata.subjects ?? [];
  const fields = state.metadata.fields ?? [];
  if (subjects.length + fields.length > 0) return `subject:${subjects[0] ?? "unknown"}/field:${fields[0] ?? "unknown"}`;
  return "unclassified";
}

/** JST has no daylight-saving transitions; the next review day starts exactly 24 hours later. */
export function reviewDueBefore(targetDate: string): string {
  const start = exactTimestamp(`${targetDate}T04:00:00+09:00`);
  return new Date(Date.parse(start) + 24 * 60 * 60 * 1_000).toISOString();
}

/** Policy only: consumes predictions; never learns or modifies source evidence. */
export function selectDailyReviewItems(input: {
  readonly states: readonly ReviewQuestionState[];
  readonly calendar_date: string;
  readonly as_of: string;
  /** Omit only when replaying the legacy selection-at-instant policy. */
  readonly due_before?: string;
  readonly max_questions: number;
  /** Explicit opt-in for new plans; omitted for legacy selection and amendment replay. */
  readonly exam_weighting?: "exam120_v1";
}): { readonly items: readonly DailyReviewItem[]; readonly eligible_question_count: number } {
  if (!Number.isInteger(input.max_questions) || input.max_questions < 0 || input.max_questions > 100) {
    throw new ReviewEngineError("REVIEW_SETTINGS_INVALID");
  }
  if (input.exam_weighting !== undefined && input.exam_weighting !== "exam120_v1") {
    throw new ReviewEngineError("REVIEW_SETTINGS_INVALID");
  }
  const examWeight = (state: ReviewQuestionState): number =>
    input.exam_weighting === "exam120_v1" && state.question_key.startsWith("120") ? 1.25 : 1;
  // Selection score only. Never alter the stored probability or the model due date.
  const weightedRisk = (state: ReviewQuestionState): number =>
    (1 - (state.prediction.retrievability ?? 1)) * examWeight(state);
  const asOf = exactTimestamp(input.as_of);
  const dueBefore = input.due_before === undefined ? undefined : exactTimestamp(input.due_before);
  if (dueBefore !== undefined && dueBefore <= asOf) throw new ReviewEngineError("REVIEW_DUE_WINDOW_INVALID");
  const candidates: Candidate[] = input.states.filter((state) => state.exclusion === null).map((state) => {
    const manualDue = state.metadata.next_review_on ?? null;
    const manual = manualDue !== null && manualDue <= input.calendar_date;
    const modelDue = state.prediction.next_review_at;
    const model = modelDue !== null && (dueBefore === undefined ? modelDue <= asOf : modelDue < dueBefore);
    const retry = state.daily_counts.total.attempts > 0;
    const reasons: ReviewReason[] = [];
    if (examWeight(state) > 1) {
      const risk = state.prediction.retrievability === null ? null : 1 - state.prediction.retrievability;
      reasons.push({ code: "exam_priority_weight", facts: { exam: 120, weight: 1.25,
        base_forgetting_risk: risk, weighted_forgetting_risk: risk === null ? null : risk * 1.25 } });
    }
    if (manual) reasons.push({ code: "manual_due", facts: { manual_due_on: manualDue } });
    if (model) reasons.push({ code: "model_due", facts: { model_due_at: modelDue, as_of: asOf,
      ...(dueBefore === undefined ? {} : { due_before: dueBefore,
        due_window: modelDue <= asOf ? "overdue" : "later_in_review_day" }) } });
    if (state.recovered_due_on !== undefined && state.recovered_due_on <= input.calendar_date) {
      reasons.push({ code: "recovered_evidence_due", facts: { recovered_due_on: state.recovered_due_on,
        answered_on: state.latest_answered_on ?? null, result: state.latest_result, provisional: true,
        interval_days: state.latest_result === "incorrect" ? 1 : 7 } });
    }
    if (state.latest_result === "incorrect") reasons.push({ code: "latest_incorrect",
      facts: { last_answered_at: state.latest_answered_at,
        ...(state.latest_answered_on === undefined ? {} : { last_answered_on: state.latest_answered_on }) } });
    if (retry) reasons.push({ code: "same_day_retry_lower_priority", facts: { attempts_today: state.daily_counts.total.attempts } });
    if (state.evidence_sufficiency !== "sufficient") reasons.push({ code: "sparse_evidence", facts: {
      graded_attempts: state.graded_attempts, graded_distinct_days: state.graded_distinct_days,
      evidence_sufficiency: state.evidence_sufficiency,
    } });
    // Today's retries follow all eligible questions not answered today.
    const tier = retry ? 3 : manual ? 0 : state.latest_result === "incorrect" ? 1 : 2;
    return { state, tier, bucket: balanceBucket(state), reasons };
  });
  const eligibleQuestionCount = candidates.length;
  const usedBuckets = new Map<string, number>();
  const items: DailyReviewItem[] = [];
  while (items.length < input.max_questions && candidates.length > 0) {
    candidates.sort((a, b) => a.tier - b.tier
      || (usedBuckets.get(a.bucket) ?? 0) - (usedBuckets.get(b.bucket) ?? 0)
      || (input.exam_weighting === undefined
        ? (a.state.prediction.retrievability ?? 1) - (b.state.prediction.retrievability ?? 1)
        : weightedRisk(b.state) - weightedRisk(a.state) || examWeight(b.state) - examWeight(a.state))
      || compareText(a.state.prediction.next_review_at ?? "", b.state.prediction.next_review_at ?? "")
      || compareText(a.state.question_key, b.state.question_key));
    const candidate = candidates.shift()!;
    usedBuckets.set(candidate.bucket, (usedBuckets.get(candidate.bucket) ?? 0) + 1);
    const { state } = candidate;
    items.push({
      question_key: state.question_key, position: items.length + 1, priority_tier: candidate.tier,
      reasons: [...candidate.reasons, { code: "balance_bucket", facts: { bucket: candidate.bucket } }],
      model_due_at: state.prediction.next_review_at,
      manual_due_on: state.metadata.next_review_on ?? null,
      retrievability: state.prediction.retrievability,
      evidence_sufficiency: state.evidence_sufficiency,
    });
  }
  return { items, eligible_question_count: eligibleQuestionCount };
}

/** Select only newly eligible saved states; an external append-only amendment owns persistence. */
export function selectDailyReviewAdditions(plan: DailyReviewPlan): {
  readonly due_before: string;
  readonly items: readonly DailyReviewItem[];
  /** Number of newly eligible questions before applying the remaining capacity. */
  readonly eligible_question_count: number;
} {
  const dueBefore = reviewDueBefore(plan.target_date);
  const existingKeys = new Set(plan.items.map((item) => item.question_key));
  const states = plan.states.filter((state) => state.exclusion === "not_due"
    && !existingKeys.has(state.question_key) && state.prediction.next_review_at !== null
    && state.prediction.next_review_at < dueBefore).map((state) => ({ ...state, exclusion: null }));
  const selected = selectDailyReviewItems({ states, calendar_date: plan.calendar_date,
    as_of: plan.selection_at, due_before: dueBefore, max_questions: plan.settings.max_questions - plan.items.length });
  return { ...selected, due_before: dueBefore,
    items: selected.items.map((item) => ({ ...item, position: item.position + plan.items.length })) };
}
