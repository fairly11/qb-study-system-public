import type { StudyContextV1, StudyMode } from "@qb-study/contracts";

export interface StudyCaptureContext {
  readonly study_mode: StudyMode;
  readonly review_plan_id?: string;
}

export function isStudyMode(value: unknown): value is StudyMode {
  return value === "normal" || value === "review" || value === "unclassified";
}

export function isReviewPlanId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function isStudyCaptureContext(value: unknown): value is StudyCaptureContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return Object.keys(context).every((key) => key === "study_mode" || key === "review_plan_id")
    && isStudyMode(context.study_mode)
    && (context.review_plan_id === undefined
      || (context.study_mode === "review" && isReviewPlanId(context.review_plan_id)));
}

export function createStudyContext(
  eventId: string, mode: StudyMode = "unclassified", reviewPlanId?: string,
): StudyContextV1 {
  return Object.freeze({
    schema_version: "1", record_type: "study_context", event_id: eventId, study_mode: mode,
    ...(reviewPlanId === undefined ? {} : { review_plan_id: reviewPlanId }),
  });
}

/** Browser-safe validation: do not ship the server's dynamic JSON-schema compiler. */
export function isStoredStudyContext(value: unknown, eventId: string): value is StudyContextV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return Object.keys(context).every((key) => [
    "schema_version", "record_type", "event_id", "study_mode", "review_plan_id",
  ].includes(key))
    && context.schema_version === "1" && context.record_type === "study_context"
    && context.event_id === eventId && isStudyMode(context.study_mode)
    && (context.review_plan_id === undefined
      || (context.study_mode === "review" && isReviewPlanId(context.review_plan_id)));
}
