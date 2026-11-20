import type { AttemptEventV1, HistorySnapshotV1, RecoveredAttemptV1 } from "@qb-study/contracts";

export type StudyMode = "normal" | "review" | "unclassified";

/** StudyContextV1 is structurally compatible. No context is inferred from a result. */
export interface ReviewAttemptContext {
  readonly event_id: string;
  readonly study_mode: StudyMode;
}

export interface ReviewQuestionMetadata {
  readonly question_key: string;
  readonly stopped?: boolean;
  /** User-managed date, preserved separately from the model's prediction. */
  readonly next_review_on?: string | null;
  readonly subjects?: readonly string[];
  readonly fields?: readonly string[];
  readonly knowledge_tags?: readonly string[];
}

export interface ReviewSettings {
  readonly settings_version: string;
  readonly max_questions: number;
  readonly request_retention: number;
  readonly per_question_daily_cap: number;
  readonly sparse_min_graded_attempts: number;
  readonly sparse_min_distinct_days: number;
}

export interface StudyCounts {
  readonly attempts: number;
  readonly unique_questions: number;
  readonly correct: number;
  readonly incorrect: number;
  readonly unknown: number;
}

export type StudyStatistics = Readonly<Record<StudyMode | "total", StudyCounts>>;

export interface DerivedGrade {
  readonly event_id: string;
  readonly answered_at: string;
  readonly observed_result: AttemptEventV1["result"];
  readonly derived_grade: "Good" | "Again" | null;
}

export interface MemoryPrediction {
  readonly next_review_at: string | null;
  readonly retrievability: number | null;
  readonly stability_days: number | null;
  readonly difficulty: number | null;
  readonly derived_grades: readonly DerivedGrade[];
}

/** Replaceable prediction boundary. No selection policy or I/O belongs here. */
export interface ReviewMemoryModel {
  readonly model_id: string;
  readonly model_version: string;
  readonly grade_policy_version: string;
  predict(input: {
    readonly attempts: readonly AttemptEventV1[];
    readonly as_of: string;
    readonly request_retention: number;
  }): MemoryPrediction;
}

export type ReviewExclusion = "stopped" | "correct_today" | "daily_cap_reached"
  | "manual_due_future" | "not_due" | "insufficient_evidence" | "outside_exam_scope";

export interface ReviewQuestionState {
  readonly question_key: string;
  readonly metadata: ReviewQuestionMetadata;
  readonly prediction: MemoryPrediction;
  readonly evidence_sufficiency: "insufficient" | "partial" | "sufficient";
  readonly graded_attempts: number;
  readonly graded_distinct_days: number;
  readonly snapshot_count: number;
  readonly latest_result: AttemptEventV1["result"] | null;
  readonly latest_answered_at: string | null;
  /** Date-only recovery evidence never supplies an invented answer instant. */
  readonly latest_answered_on?: string;
  readonly recovered_due_on?: string;
  readonly daily_counts: StudyStatistics;
  readonly all_time_counts: StudyStatistics;
  readonly exclusion: ReviewExclusion | null;
}

export type ReviewReasonCode = "manual_due" | "model_due" | "latest_incorrect"
  | "same_day_retry_lower_priority" | "sparse_evidence" | "balance_bucket" | "recovered_evidence_due" | "exam_priority_weight";

export interface ReviewReason {
  readonly code: ReviewReasonCode;
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DailyReviewItem {
  readonly question_key: string;
  readonly position: number;
  readonly priority_tier: number;
  readonly reasons: readonly ReviewReason[];
  readonly model_due_at: string | null;
  readonly manual_due_on: string | null;
  readonly retrievability: number | null;
  readonly evidence_sufficiency: ReviewQuestionState["evidence_sufficiency"];
}

export interface RecoveredEvidenceSummary {
  readonly attempts: number;
  readonly attempts_today: number;
  readonly excluded_future: number;
  readonly suppressed_by_direct: number;
}

export interface DailyReviewPlan {
  readonly schema_version: "review-plan-v2";
  /** Latest 04:00 JST boundary; differs from calendar_date before 04:00. */
  readonly target_date: string;
  readonly calendar_date: string;
  readonly scheduled_at: string;
  readonly selection_at: string;
  /** Exclusive next-04:00 JST deadline. Absent on older plans selected only through selection_at. */
  readonly due_before?: string;
  readonly timezone: "Asia/Tokyo";
  readonly evidence_hash: string;
  readonly settings_hash: string;
  readonly settings: ReviewSettings;
  readonly algorithm_id: string;
  readonly algorithm_version: string;
  readonly model_id: string;
  readonly model_version: string;
  readonly grade_policy_version: string;
  readonly model_status: "provisional";
  readonly daily_counts: StudyStatistics;
  readonly all_time_counts: StudyStatistics;
  readonly excluded_future_attempts: number;
  readonly excluded_future_snapshots: number;
  readonly recovered_evidence?: RecoveredEvidenceSummary;
  readonly eligible_question_count: number;
  readonly items: readonly DailyReviewItem[];
  readonly states: readonly ReviewQuestionState[];
}

export interface GenerateDailyReviewPlanInput {
  readonly as_of: string;
  readonly attempts: readonly AttemptEventV1[];
  /** Separately observed date-only answers; never replayed into the memory model. */
  readonly recovered_attempts?: readonly RecoveredAttemptV1[];
  /** Reader-side exclusions, added to exclusions made by this calculation. */
  readonly suppressed_recovered_attempts?: number;
  readonly excluded_future_recovered_attempts?: number;
  readonly contexts?: readonly ReviewAttemptContext[];
  readonly questions?: readonly ReviewQuestionMetadata[];
  /** Summary evidence is kept separate and is never replayed as an answer. */
  readonly snapshots?: readonly HistorySnapshotV1[];
  readonly settings?: Partial<ReviewSettings>;
  readonly model?: ReviewMemoryModel;
}
