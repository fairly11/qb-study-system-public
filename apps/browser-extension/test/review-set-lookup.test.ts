import { describe, expect, it, vi } from "vitest";
import { createReviewSetLookup } from "../src/background/review-set-lookup.js";
import { isStoredStudyContext } from "../src/background/study-context.js";

const plan = "30000000-0000-4000-8000-000000000001";
const endpoint = "http://127.0.0.1:8765/v2/attempt-events";
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe("verified review-set lookup", () => {
  it("binds a verified exact set to its plan without sending credentials or following redirects", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response({
      schema_version: "1", question_set_id: "set-A", study_mode: "review", review_plan_id: plan,
    }));
    expect(await createReviewSetLookup(async () => endpoint, transport)("set-A"))
      .toEqual({ study_mode: "review", review_plan_id: plan });
    expect(transport).toHaveBeenCalledWith("http://127.0.0.1:8765/v1/review-sets/set-A", expect.objectContaining({
      credentials: "omit", redirect: "error", method: "GET",
      headers: { "X-QB-Study-Client": "browser-extension" },
    }));
  });
  it("only reports normal when a successful exact response confirms absence", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response({
      schema_version: "1", question_set_id: "set-A", study_mode: "normal",
    }));
    expect(await createReviewSetLookup(async () => endpoint, transport)("set-A"))
      .toEqual({ study_mode: "normal" });
  });
  it.each([
    { schema_version: "1", question_set_id: "other", study_mode: "review", review_plan_id: plan },
    { schema_version: "1", question_set_id: "set-A", study_mode: "review" },
    { schema_version: "1", question_set_id: "set-A", study_mode: "normal", review_plan_id: plan },
    { schema_version: "1", question_set_id: "set-A", study_mode: "normal", extra: "untrusted" },
  ])("keeps a malformed or mismatched response unclassified", async (body) => {
    expect(await createReviewSetLookup(async () => endpoint, async () => response(body))("set-A"))
      .toEqual({ study_mode: "unclassified" });
  });
  it("does not classify outages as normal and refuses non-loopback or injected set IDs", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const lookup = createReviewSetLookup(async () => endpoint, transport);
    expect(await lookup("set-A")).toEqual({ study_mode: "unclassified" });
    expect(await lookup("set-A?secret=x")).toEqual({ study_mode: "unclassified" });
    expect(await createReviewSetLookup(async () => "https://example.test", transport)("set-A"))
      .toEqual({ study_mode: "unclassified" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await createReviewSetLookup(async () => endpoint, async () => response({}, 503))("set-A"))
      .toEqual({ study_mode: "unclassified" });
  });
  it("restores review-plan evidence but rejects plan IDs attached to normal learning", () => {
    const context = { schema_version: "1", record_type: "study_context", event_id: plan, study_mode: "review", review_plan_id: plan };
    expect(isStoredStudyContext(context, plan)).toBe(true);
    expect(isStoredStudyContext({ ...context, study_mode: "normal" }, plan)).toBe(false);
    expect(isStoredStudyContext({ ...context, review_plan_id: "invalid" }, plan)).toBe(false);
  });
});
