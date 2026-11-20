import { describe, expect, it, vi } from "vitest";
import { StudyRouteContext, type StudyRouteState } from "../src/background/study-route-context.js";
import type { ConsentSenderContext } from "../src/background/consent-controller.js";
import type { StudyCaptureContext } from "../src/background/study-context.js";
import { isQbPageRouteMessageV1, isQbPageRouteProbeMessageV1, qbPageRouteDescriptor, sameQbPageRoute, type QbPageRouteDescriptor, type StudyRouteEvidence } from "../src/shared/protocol.js";

const ORIGIN = "https://qb.medilink-study.com";
const PLAN = "20000000-0000-4000-8000-000000000001";

function setup() {
  let stored: unknown;
  const urls = new Map<number, string>();
  const documents = new Map<number, string>();
  const lookup = vi.fn(async (id: string): Promise<StudyCaptureContext> => {
    void id;
    return { study_mode: "review" as const, review_plan_id: PLAN };
  });
  const ports = { store: { read: async () => structuredClone(stored), write: async (state: StudyRouteState) => {
    stored = structuredClone(state);
  } }, isCurrent: async (sender: ConsentSenderContext, route?: QbPageRouteDescriptor) => {
    if ((documents.get(sender.tab_id) ?? `document-${sender.tab_id}`) !== sender.document_id) return false;
    const current = urls.get(sender.tab_id);
    return current !== undefined && (route === undefined ? current === sender.url
      : sameQbPageRoute(route, qbPageRouteDescriptor(new URL(current))));
  }, lookup };
  const routes = new StudyRouteContext(ports);
  const sender = (path: string, tab = 7): ConsentSenderContext => ({
    tab_id: tab, window_id: 3, tab_active: true, frame_id: 0, origin: ORIGIN, url: ORIGIN + path,
    document_id: documents.get(tab) ?? `document-${tab}`,
  });
  const visit = async (path: string, tab = 7, lost = false, evidence?: StudyRouteEvidence) => {
    urls.set(tab, ORIGIN + path);
    return await routes.handleRoute(sender(path, tab), lost, evidence);
  };
  return { routes, ports, lookup, urls, documents, sender, visit,
    get stored() { return stored; }, set stored(value: unknown) { stored = value; } };
}

describe("tab-scoped study route context", () => {
  it("accepts only bounded navigation evidence without arbitrary page data", () => {
    expect(isQbPageRouteMessageV1({kind: "qb_page_route_v1", first_document_navigation: "navigate", referrer_set_id: "known-set"})).toBe(true);
    for (const fields of [
      {referrer_set_id: "known-set"},
      {first_document_navigation: "prerender"},
      {first_document_navigation: "navigate", referrer_set_id: "a".repeat(101)},
      {first_document_navigation: "navigate", referrer_set_id: "https://example.com"},
      {first_document_navigation: "navigate", question_text: "not allowed"},
    ]) expect(isQbPageRouteMessageV1({kind: "qb_page_route_v1", ...fields})).toBe(false);
  });

  it("prefetches a search set and keeps it through quiz question changes and reload", async () => {
    const test = setup();
    await test.visit("/search?questionSetId=known-set&operation=OR");
    expect(test.lookup).toHaveBeenCalledWith("known-set");
    await test.visit("/quiz?question_id=question-a");
    expect(await test.routes.resolve(test.sender("/quiz?question_id=question-a")))
      .toEqual({ study_mode: "review", review_plan_id: PLAN });
    await test.visit("/quiz?question_id=question-b");
    await test.visit("/quiz?question_id=question-b");
    expect(await test.routes.resolve(test.sender("/quiz?question_id=question-b")))
      .toEqual({ study_mode: "review", review_plan_id: PLAN });
    expect(test.lookup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(test.stored)).not.toContain("https:");
    expect(JSON.stringify(test.stored)).not.toContain("question-a");
  });

  it("keeps tabs independent and clears a set on other routes or ordinary searches", async () => {
    const test = setup();
    await test.visit("/search?questionSetId=review-set");
    await test.visit("/quiz", 8);
    expect(await test.routes.resolve(test.sender("/quiz", 8))).toEqual({ study_mode: "normal" });
    await test.visit("/view/question-set");
    await test.visit("/quiz");
    expect(await test.routes.resolve(test.sender("/quiz"))).toEqual({ study_mode: "normal" });
    await test.visit("/search?questionSetId=review-set");
    await test.visit("/search?keyword=some-search");
    await test.visit("/quiz");
    expect(await test.routes.resolve(test.sender("/quiz"))).toEqual({ study_mode: "normal" });
  });

  it("restores a known set after worker restart and removes it when its tab closes", async () => {
    const test = setup();
    await test.visit("/search?questionSetId=review-set");
    await test.visit("/quiz");
    const restored = new StudyRouteContext(test.ports);
    expect(await restored.resolve(test.sender("/quiz"))).toEqual({ study_mode: "review", review_plan_id: PLAN });
    await restored.removeTab(7);
    expect(await restored.resolve(test.sender("/quiz"))).toEqual({ study_mode: "unclassified" });
  });

  it.each(["/search?questionSetId=", "/search?questionSetId=a&questionSetId=b", "/search?questionSetId=%2F"])(
    "keeps ambiguous set context unclassified: %s", async (search) => {
      const test = setup();
      await test.visit(search);
      await test.visit("/quiz");
      expect(await test.routes.resolve(test.sender("/quiz"))).toEqual({ study_mode: "unclassified" });
      expect(test.lookup).not.toHaveBeenCalled();
    },
  );

  it("defaults a lost route origin to normal without reusing a stale review set", async () => {
    const test = setup();
    await test.visit("/search?questionSetId=old-set");
    await test.visit("/quiz", 7, true);
    expect(await test.routes.resolve(test.sender("/quiz"))).toEqual({ study_mode: "normal" });
  });

  it("rejects delayed and non-top-frame route notifications", async () => {
    const test = setup();
    await test.visit("/search?questionSetId=current-set");
    expect(await test.routes.handleRoute(test.sender("/search?questionSetId=stale-set"))).toBe(false);
    expect(await test.routes.handleRoute({ ...test.sender("/search?questionSetId=current-set"), frame_id: 1 })).toBe(false);
    await test.visit("/quiz");
    expect(test.lookup).toHaveBeenCalledTimes(1);
    expect(test.lookup).toHaveBeenCalledWith("current-set");
  });

  it("fails closed on corrupt session storage", async () => {
    const test = setup();
    test.stored = { version: 1, tabs: [{ tab_id: 7, question_set_id: "a", uncertain: false, token: "not-allowed" }] };
    await expect(test.visit("/quiz")).rejects.toThrow("STUDY_ROUTE_STORAGE_INVALID");
    expect(test.lookup).not.toHaveBeenCalled();
  });

  it.each(["navigate", "back_forward", "unknown"] as const)(
    "defaults a new direct quiz document to normal instead of carrying an old review set: %s", async (navigation) => {
      const test = setup();
      await test.visit("/search?questionSetId=review-set");
      await test.visit("/quiz?question_id=question-a");
      test.documents.set(7, "new-document");
      await test.visit("/quiz?question_id=question-a", 7, false, {first_document_navigation: navigation});
      expect(await test.routes.resolve(test.sender("/quiz?question_id=question-a"))).toEqual({study_mode: "normal"});
    },
  );

  it("retains review on verified reload and defaults a different quiz to normal", async () => {
    const test = setup();
    await test.visit("/search?questionSetId=review-set");
    await test.visit("/quiz?question_id=question-a");
    test.documents.set(7, "reload-document");
    await test.visit("/quiz?question_id=question-a", 7, false, {first_document_navigation: "reload"});
    expect(await test.routes.resolve(test.sender("/quiz?question_id=question-a")))
      .toEqual({study_mode: "review", review_plan_id: PLAN});
    test.documents.set(7, "different-reload");
    await test.visit("/quiz?question_id=question-b", 7, false, {
      first_document_navigation: "reload", referrer_set_id: "review-set",
    });
    expect(await test.routes.resolve(test.sender("/quiz?question_id=question-b"))).toEqual({study_mode: "normal"});
  });

  it.each([true, false])("inherits review only for an exact search referrer: matching=%s", async (matching) => {
    const test = setup();
    await test.visit("/search?questionSetId=review-set");
    test.documents.set(7, "new-document");
    await test.visit("/quiz", 7, false, {
      first_document_navigation: "navigate", referrer_set_id: matching ? "review-set" : "other-set",
    });
    expect(await test.routes.resolve(test.sender("/quiz"))).toEqual(matching
      ? {study_mode: "review", review_plan_id: PLAN} : {study_mode: "normal"});
  });

  it("keeps normal study across questions when the search referrer is missing", async () => {
    const test = setup();
    await test.visit("/search?questionSetId=review-set");
    test.documents.set(7, "new-document");
    await test.visit("/quiz?question_id=question-a", 7, false, {first_document_navigation: "navigate"});
    expect(await test.routes.resolve(test.sender("/quiz?question_id=question-a"))).toEqual({study_mode: "normal"});
    await test.visit("/quiz?question_id=question-b");
    expect(await test.routes.resolve(test.sender("/quiz?question_id=question-b"))).toEqual({study_mode: "normal"});
  });

  it("keeps fresh direct quizzes and later normal-study re-entry normal without set evidence", async () => {
    const test = setup();
    await test.visit("/quiz?question_id=question-a", 7, false, {first_document_navigation: "navigate"});
    expect(await test.routes.resolve(test.sender("/quiz?question_id=question-a"))).toEqual({study_mode: "normal"});
    test.documents.set(7, "new-document");
    await test.visit("/quiz?question_id=question-b", 7, false, {first_document_navigation: "navigate"});
    expect(await test.routes.resolve(test.sender("/quiz?question_id=question-b"))).toEqual({study_mode: "normal"});
    await test.visit("/quiz?question_id=question-b", 7, true);
    expect(await test.routes.resolve(test.sender("/quiz?question_id=question-b"))).toEqual({study_mode: "normal"});
  });

  it("discards unavailable search prefetch so quiz classification can immediately recover", async () => {
    const test = setup();
    test.lookup.mockResolvedValueOnce({study_mode: "unclassified"});
    await test.visit("/search?questionSetId=review-set");
    await test.visit("/quiz?question_id=question-a");
    expect(await test.routes.resolve(test.sender("/quiz?question_id=question-a")))
      .toEqual({study_mode: "review", review_plan_id: PLAN});
    expect(test.lookup).toHaveBeenCalledTimes(2);
  });

  it("does not serialize another route behind a slow review lookup", async () => {
    const test = setup();
    let finish!: (context: StudyCaptureContext) => void;
    test.lookup.mockImplementationOnce(async () => await new Promise((resolve) => {finish = resolve;}));
    await test.visit("/search?questionSetId=review-set");
    await test.visit("/quiz");
    const pending = test.routes.resolve(test.sender("/quiz"));
    await test.visit("/quiz", 8);
    expect(await test.routes.resolve(test.sender("/quiz", 8))).toEqual({study_mode: "normal"});
    finish({study_mode: "review", review_plan_id: PLAN});
    expect(await pending).toEqual({study_mode: "review", review_plan_id: PLAN});
  });
});


describe("verified descriptors with stale browser sender URLs", () => {
  it("uses only the verified current route, preserving a set after SPA navigation", async () => {
    const t = setup();
    await t.visit("/search?questionSetId=known-set");
    const initial = t.sender("/search?questionSetId=known-set");
    t.urls.set(7, ORIGIN + "/quiz?question_id=q1");
    expect(await t.routes.handleRoute(initial, false, { route: { route_kind: "quiz", question_id: "q1" } })).toBe(true);
    expect(await t.routes.hasRegisteredQuizRoute(initial)).toBe(true);
    expect(await t.routes.resolve(initial)).toEqual({ study_mode: "review", review_plan_id: PLAN });
    // This is only the registered route check. Consent must separately probe live pageSession.
    t.urls.set(7, ORIGIN + "/quiz?question_id=q2");
    expect(await t.routes.hasRegisteredQuizRoute(initial)).toBe(true);
    expect(await t.routes.handleRoute(initial, false, { route: { route_kind: "quiz", question_id: "q2" } })).toBe(true);
    t.urls.set(7, ORIGIN + "/search?questionSetId=another");
    expect(await t.routes.handleRoute(initial, false, { route: { route_kind: "search", question_set_id: "another", invalid_set_id: false } })).toBe(true);
    expect(await t.routes.hasRegisteredQuizRoute(initial)).toBe(false);
  });

  it("rejects delayed descriptors and wrong document, frame or origin without changing the registered route", async () => {
    const t = setup();
    await t.visit("/search?questionSetId=known-set");
    const source = t.sender("/search?questionSetId=known-set");
    const before = t.stored;
    const evidence = { route: { route_kind: "search", question_set_id: "known-set", invalid_set_id: false } } as const;
    const withoutDocument = { ...source }; delete withoutDocument.document_id;
    const invalidSenders: ConsentSenderContext[] = [ withoutDocument, { ...source, document_id: "old-document" },
      { ...source, frame_id: 1 }, { ...source, origin: "https://example.test" }, { ...source, url: "https://example.test/search" } ];
    for (const sender of invalidSenders) {
      expect(await t.routes.handleRoute(sender, false, evidence)).toBe(false);
      expect(t.stored).toEqual(before);
    }
    t.urls.set(7, ORIGIN + "/quiz?question_id=q1");
    expect(await t.routes.handleRoute(source, false, evidence)).toBe(false);
    expect(t.stored).toEqual(before);
  });

  it("rejects a route that changes while storage is being read", async () => {
    const t = setup();
    await t.visit("/search?questionSetId=known-set");
    const before = t.stored;
    const originalRead = t.ports.store.read;
    t.ports.store.read = async () => { const state = await originalRead(); t.urls.set(7, ORIGIN + "/quiz?question_id=q1"); return state; };
    expect(await t.routes.handleRoute(t.sender("/search?questionSetId=known-set"), false,
      { route: { route_kind: "search", question_set_id: "known-set", invalid_set_id: false } })).toBe(false);
    expect(t.stored).toEqual(before);
  });
});


describe("bounded route descriptor contract", () => {
  it("drops unrelated query data and preserves invalid set evidence", () => {
    expect(qbPageRouteDescriptor(new URL(ORIGIN + "/search?questionSetId=safe-ID&unrelated=discard")))
      .toEqual({ route_kind: "search", question_set_id: "safe-ID", invalid_set_id: false });
    expect(qbPageRouteDescriptor(new URL(ORIGIN + "/search?questionSetId=a&questionSetId=b")))
      .toEqual({ route_kind: "search", question_set_id: null, invalid_set_id: true });
    expect(qbPageRouteDescriptor(new URL(ORIGIN + "/quiz?question_id=q1&unrelated=discard")))
      .toEqual({ route_kind: "quiz", question_id: "q1" });
    expect(qbPageRouteDescriptor(new URL("https://example.test/quiz"))).toBeNull();
  });

  it("accepts exactly bounded descriptors in notifications and document probes", () => {
    const route = { route_kind: "quiz", question_id: "q1" };
    expect(isQbPageRouteMessageV1({ kind: "qb_page_route_v1", route })).toBe(true);
    expect(isQbPageRouteProbeMessageV1({ kind: "qb_page_route_probe_v1", expected_route: route })).toBe(true);
    expect(isQbPageRouteProbeMessageV1({ kind: "qb_page_route_probe_v1", expected_route: route, expected_url: ORIGIN + "/quiz" })).toBe(false);
    for (const invalid of [ { ...route, question_id: "a".repeat(101) }, { ...route, text: "not-allowed" },
      { ...route, question_id: "https://example.test" }, { route_kind: "search", question_set_id: "a", invalid_set_id: true },
      { route_kind: "other", pathname: "/unneeded" } ]) {
      expect(isQbPageRouteMessageV1({ kind: "qb_page_route_v1", route: invalid })).toBe(false);
      expect(isQbPageRouteProbeMessageV1({ kind: "qb_page_route_probe_v1", expected_route: invalid })).toBe(false);
    }
  });
});
