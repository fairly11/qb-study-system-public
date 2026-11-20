import { isValidCollectorEndpoint } from "./endpoint.js";
import { isReviewPlanId, type StudyCaptureContext } from "./study-context.js";

const UNKNOWN: StudyCaptureContext = Object.freeze({ study_mode: "unclassified" });
const SET_ID = /^[A-Za-z0-9_-]{1,100}$/u;

/** Only the local collector knows which exact QB sets the publisher verified. */
export function createReviewSetLookup(
  getEndpoint: () => Promise<string>,
  fetchImpl: typeof fetch = globalThis.fetch,
): (questionSetId: string) => Promise<StudyCaptureContext> {
  return async (questionSetId) => {
    if (!SET_ID.test(questionSetId)) return UNKNOWN;
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); }, 12_000);
    try {
      const endpoint = await getEndpoint();
      if (!isValidCollectorEndpoint(endpoint)) return UNKNOWN;
      const url = new URL(endpoint);
      url.pathname = `/v1/review-sets/${questionSetId}`;
      const response = await fetchImpl(url.toString(), {
        method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
        headers: { "X-QB-Study-Client": "browser-extension" }, signal: abort.signal,
      });
      if (response.status !== 200) return UNKNOWN;
      const value: unknown = await response.json();
      if (value === null || typeof value !== "object" || Array.isArray(value)) return UNKNOWN;
      const body = value as Record<string, unknown>;
      const keys = Object.keys(body).sort().join(",");
      if (body.schema_version !== "1" || body.question_set_id !== questionSetId) return UNKNOWN;
      if (body.study_mode === "normal" && keys === "question_set_id,schema_version,study_mode") {
        return { study_mode: "normal" };
      }
      if (body.study_mode === "review" && isReviewPlanId(body.review_plan_id)
        && keys === "question_set_id,review_plan_id,schema_version,study_mode") {
        return { study_mode: "review", review_plan_id: body.review_plan_id };
      }
      return UNKNOWN;
    } catch {
      return UNKNOWN;
    } finally {
      clearTimeout(timer);
    }
  };
}
