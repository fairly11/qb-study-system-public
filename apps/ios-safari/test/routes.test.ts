import { describe, expect, it } from "vitest";
import { RouteTracker } from "../src/routes.js";
import { validStaged, trustedQbSender } from "../src/protocol.js";
import { SESSION, staged } from "./helpers.js";
const origin = "https://qb.medilink-study.com";
describe("bounded route evidence", () => {
  it("binds exact observed set ID to continuous SPA questions without storing URLs or names", () => {
    const routes = new RouteTracker(() => SESSION);
    routes.update(`${origin}/search?questionSetId=set-synthetic&name=ignored`);
    const first = routes.update(`${origin}/quiz?questionId=one`);
    expect(first).toEqual({ quiz_id: SESSION, classification_policy: "normal_default_v1", entry_source: "observed_navigation", set_id: "set-synthetic" });
    expect(routes.update(`${origin}/quiz?questionId=two`)).toBe(first);
  });
  it.each(["/quiz?questionSetId=claimed", "/search?questionSetId=one&questionSetId=two", "/search?questionSetId=%3Cinvalid%3E"])("preserves unresolved provenance for unverified origin: %s", (path) => {
    const routes = new RouteTracker(() => SESSION); routes.update(`${origin}${path}`);
    expect(routes.update(`${origin}/quiz`)).toEqual({ quiz_id: SESSION, classification_policy: "normal_default_v1", entry_source: "unresolved" });
  });
  it("permits explicit observed normal search and clears provenance on departure/reentry/restart", () => {
    const routes = new RouteTracker(() => SESSION); routes.update(`${origin}/search`);
    expect(routes.update(`${origin}/quiz`)?.entry_source).toBe("observed_navigation");
    routes.update(`${origin}/home`); expect(routes.update(`${origin}/quiz`)?.entry_source).toBe("unresolved");
    routes.update(`${origin}/search?questionSetId=known`); routes.reset();
    expect(routes.update(`${origin}/quiz`)?.entry_source).toBe("unresolved");
  });
  it("snapshots manual selections and resets them when leaving the exercise", () => {
    let counter = 0;
    const routes = new RouteTracker(() => `10000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`);
    const original = routes.update(`${origin}/quiz`)!;
    expect(routes.setStudyMode("stale-quiz", "review")).toBe(false);
    expect(routes.setStudyMode(original.quiz_id, "review")).toBe(true);
    expect(original.manual_study_mode).toBeUndefined();
    expect(routes.update(`${origin}/quiz?questionId=two`)?.manual_study_mode).toBe("review");
    routes.update(`${origin}/search?questionSetId=other`);
    const next = routes.update(`${origin}/quiz`)!;
    expect(next.manual_study_mode).toBeUndefined();
    expect(routes.setStudyMode(original.quiz_id, "normal")).toBe(false);
  });
  it("accepts only an exact same-origin search referrer for a fresh full-document quiz navigation", () => {
    const initial = { navigationType: "navigate", referrer: `${origin}/search?questionSetId=known` };
    expect(new RouteTracker(() => SESSION, initial).update(`${origin}/quiz`)).toMatchObject({ entry_source: "observed_navigation", set_id: "known" });
    for (const referrer of ["https://example.org/search?questionSetId=known", `${origin}/quiz?questionSetId=known`, `${origin}/search?questionSetId=a&questionSetId=b`, `${origin}/search?questionSetId=%3Cinvalid%3E`, `${origin}/`]) {
      expect(new RouteTracker(() => SESSION, { ...initial, referrer }).update(`${origin}/quiz`)?.entry_source).toBe("unresolved");
    }
    expect(new RouteTracker(() => SESSION, { ...initial, navigationType: "reload" }).update(`${origin}/quiz`)?.entry_source).toBe("unresolved");
    const later = new RouteTracker(() => SESSION, initial); later.update(`${origin}/home`);
    expect(later.update(`${origin}/quiz`)?.entry_source).toBe("unresolved");
  });
});
describe("web boundary validation", () => {
  it("rejects extra payload fields, forged route association, contents and invalid result/selection", () => {
    const value = staged(); expect(validStaged(value)).toBe(true);
    expect(validStaged({ ...value, route: { ...value.route, manual_study_mode: "normal", classification_policy: "normal_default_v1" } })).toBe(true);
    expect(validStaged({ ...value, route: { ...value.route, manual_study_mode: "review" } })).toBe(true);
    expect(validStaged({ ...value, route: { ...value.route, manual_study_mode: "unclassified" } })).toBe(false);
    expect(validStaged({ ...value, route: { ...value.route, classification_policy: "invented" } })).toBe(false);
    expect(validStaged({ ...value, token: "synthetic" })).toBe(false);
    expect(validStaged({ ...value, event: { ...value.event, question_text: "synthetic" } })).toBe(false);
    expect(validStaged({ ...value, route: { ...value.route, quiz_id: "20000000-0000-4000-8000-000000000002" } })).toBe(false);
    expect(validStaged({ ...value, event: { ...value.event, selected_option_indices: [6] } })).toBe(false);
    expect(validStaged({ ...value, route: { ...value.route, set_id: "not-verified" } })).toBe(false);
  });
  it("allows only this extension's top-frame QB content sender", () => {
    const sender = { id: "extension", url: `${origin}/search`, origin, frameId: 0, tab: { id: 1 } };
    expect(trustedQbSender(sender, "extension")).toBe(true);
    for (const modified of [{ ...sender, id: "other" }, { ...sender, frameId: 1 }, { ...sender, url: "https://example.org/quiz" }, { ...sender, origin: "https://example.org" }, { ...sender, tab: {} }]) expect(trustedQbSender(modified, "extension")).toBe(false);
  });
});
