import { toTokyoDate } from "@qb-study/contracts";

import { countStudy, evidenceHash, exactTimestamp, hasControlCharacters, prepareEvidence, resolveReviewSettings, ReviewEngineError } from "./evidence.js";
import { fsrsMemoryModel } from "./fsrs-model.js";
import { reviewDueBefore, selectDailyReviewItems } from "./selector.js";
import type { DailyReviewPlan, GenerateDailyReviewPlanInput, ReviewExclusion, ReviewQuestionState } from "./types.js";

// User-selected fixed exam range. This does not roll forward with the calendar.
const FIRST_REVIEW_EXAM = 116;
const LAST_REVIEW_EXAM = 120;

function addCalendarDays(date: string, days: number): string {
  // UTC is used only for calendar arithmetic; no answer timestamp is inferred or persisted.
  const calendar = new Date(date);
  calendar.setUTCDate(calendar.getUTCDate() + days);
  return calendar.toISOString().slice(0, 10);
}

/** Pure computation. The caller owns the once-per-day persistence/selection lock. */
export function generateDailyReviewPlan(input: GenerateDailyReviewPlanInput): DailyReviewPlan {
  const evidence = prepareEvidence(input);
  const settings = resolveReviewSettings(input.settings);
  const dueBefore = reviewDueBefore(evidence.targetDate);
  const model = input.model ?? fsrsMemoryModel;
  if ([model.model_id, model.model_version, model.grade_policy_version].some((value) =>
    typeof value !== "string" || value.length < 1 || value.length > 160 || hasControlCharacters(value))) {
    throw new ReviewEngineError("REVIEW_MODEL_INVALID");
  }
  const today = evidence.attempts.filter((event) => toTokyoDate(event.answered_at) === evidence.calendarDate);
  const recoveredToday = evidence.recoveredAttempts.filter((event) => event.answered_on === evidence.calendarDate);
  const groupAttempts = <T extends { readonly question_key: string }>(events: readonly T[]) => {
    const grouped = new Map<string, T[]>();
    for (const event of events) {
      const group = grouped.get(event.question_key) ?? [];
      group.push(event);
      grouped.set(event.question_key, group);
    }
    return grouped;
  };
  const allByQuestion = groupAttempts(evidence.attempts);
  const todayByQuestion = groupAttempts(today);
  const recoveredByQuestion = groupAttempts(evidence.recoveredAttempts);
  const recoveredTodayByQuestion = groupAttempts(recoveredToday);
  const snapshotCounts = new Map<string, number>();
  for (const snapshot of evidence.snapshots) {
    snapshotCounts.set(snapshot.question_key, (snapshotCounts.get(snapshot.question_key) ?? 0) + 1);
  }
  const states: ReviewQuestionState[] = evidence.questionKeys.map((questionKey) => {
    const attempts = allByQuestion.get(questionKey) ?? [];
    const todaysAttempts = todayByQuestion.get(questionKey) ?? [];
    const recoveries = recoveredByQuestion.get(questionKey) ?? [];
    const todaysRecoveries = recoveredTodayByQuestion.get(questionKey) ?? [];
    const graded = attempts.filter((event) => event.result !== "unknown");
    const gradedDays = new Set(graded.map((event) => toTokyoDate(event.answered_at))).size;
    const latest = attempts.at(-1);
    const recovered = recoveries.at(-1);
    const latestIsRecovery = recovered !== undefined && (latest === undefined
      || recovered.answered_on > toTokyoDate(latest.answered_at));
    const recoveredDueOn = latestIsRecovery ? addCalendarDays(recovered.answered_on, recovered.result === "incorrect" ? 1 : 7) : undefined;
    const metadata = evidence.metadata.get(questionKey) ?? { question_key: questionKey };
    const prediction = latestIsRecovery ? { next_review_at: null, retrievability: null, stability_days: null,
      difficulty: null, derived_grades: [] }
      : model.predict({ attempts, as_of: evidence.asOf, request_retention: settings.request_retention });
    if ((prediction.next_review_at !== null && exactTimestamp(prediction.next_review_at) !== prediction.next_review_at)
      || (prediction.retrievability !== null && (!Number.isFinite(prediction.retrievability)
        || prediction.retrievability < 0 || prediction.retrievability > 1))
      || (prediction.stability_days !== null && (!Number.isFinite(prediction.stability_days) || prediction.stability_days <= 0))
      || (prediction.difficulty !== null && (!Number.isFinite(prediction.difficulty) || prediction.difficulty < 1 || prediction.difficulty > 10))) {
      throw new ReviewEngineError("REVIEW_MODEL_INVALID");
    }
    const dailyCounts = countStudy(todaysAttempts, evidence.contexts, todaysRecoveries);
    const sufficiency = latestIsRecovery || graded.length === 0 ? "insufficient"
      : graded.length < settings.sparse_min_graded_attempts || gradedDays < settings.sparse_min_distinct_days ? "partial" : "sufficient";
    let exclusion: ReviewExclusion | null = null;
    // prepareEvidence has validated the canonical three-digit exam prefix.
    // Keep all evidence and accounting; restrict only newly selected candidates.
    const exam = Number(questionKey.slice(0, 3));
    if (exam < FIRST_REVIEW_EXAM || exam > LAST_REVIEW_EXAM) exclusion = "outside_exam_scope";
    else if (metadata.stopped === true) exclusion = "stopped";
    else if ([...todaysAttempts, ...todaysRecoveries].some((event) => event.result === "correct")) exclusion = "correct_today";
    else if (dailyCounts.total.attempts >= settings.per_question_daily_cap) exclusion = "daily_cap_reached";
    else if (metadata.next_review_on !== null && metadata.next_review_on !== undefined
      && metadata.next_review_on > evidence.calendarDate) exclusion = "manual_due_future";
    else {
      const manualDue = metadata.next_review_on !== null && metadata.next_review_on !== undefined
        && metadata.next_review_on <= evidence.calendarDate;
      const modelDue = prediction.next_review_at !== null && prediction.next_review_at < dueBefore;
      const todayRetry = !latestIsRecovery && todaysAttempts.length > 0 && latest?.result === "incorrect";
      const recoveredDue = recoveredDueOn !== undefined && recoveredDueOn <= evidence.calendarDate;
      if (!manualDue && !modelDue && !todayRetry && !recoveredDue) {
        exclusion = graded.length === 0 && !latestIsRecovery ? "insufficient_evidence" : "not_due";
      }
    }
    return {
      question_key: questionKey, metadata, prediction, evidence_sufficiency: sufficiency,
      graded_attempts: graded.length, graded_distinct_days: gradedDays,
      snapshot_count: snapshotCounts.get(questionKey) ?? 0,
      latest_result: latestIsRecovery ? recovered.result : latest?.result ?? null,
      latest_answered_at: latestIsRecovery ? null : latest?.answered_at ?? null,
      ...(latestIsRecovery ? { latest_answered_on: recovered.answered_on, recovered_due_on: recoveredDueOn! } : {}),
      daily_counts: dailyCounts, all_time_counts: countStudy(attempts, evidence.contexts, recoveries), exclusion,
    };
  });
  const selected = selectDailyReviewItems({ states, calendar_date: evidence.calendarDate,
    as_of: evidence.asOf, due_before: dueBefore, max_questions: settings.max_questions, exam_weighting: "exam120_v1" });
  return {
    schema_version: "review-plan-v2", target_date: evidence.targetDate, calendar_date: evidence.calendarDate,
    scheduled_at: evidence.scheduledAt, selection_at: evidence.asOf, due_before: dueBefore, timezone: "Asia/Tokyo",
    evidence_hash: evidence.hash, settings_hash: evidenceHash(settings), settings,
    algorithm_id: "daily-budget-selector", algorithm_version: "5",
    model_id: model.model_id, model_version: model.model_version, grade_policy_version: model.grade_policy_version,
    model_status: "provisional", daily_counts: countStudy(today, evidence.contexts, recoveredToday),
    all_time_counts: countStudy(evidence.attempts, evidence.contexts, evidence.recoveredAttempts),
    ...(evidence.recoveryEnabled ? { recovered_evidence: { attempts: evidence.recoveredAttempts.length,
      attempts_today: recoveredToday.length, excluded_future: evidence.excludedFutureRecoveries,
      suppressed_by_direct: evidence.suppressedRecoveries } } : {}),
    excluded_future_attempts: evidence.excludedFutureAttempts, excluded_future_snapshots: evidence.excludedFutureSnapshots,
    ...selected, states,
  };
}
