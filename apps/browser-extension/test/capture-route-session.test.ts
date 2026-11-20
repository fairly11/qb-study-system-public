import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptDomObservation } from "../src/adapters/index.js";
import { CaptureController } from "../src/capture-controller.js";
import { startQbQuizBootstrap, type StartQbQuizBootstrapOptions } from "../src/content-script.js";
import { ConsentController, type ConsentSenderContext } from "../src/background/consent-controller.js";
import { BackgroundMessageRouter } from "../src/background/message-router.js";
import { StudyRouteContext } from "../src/background/study-route-context.js";
import type { StudyCaptureContext } from "../src/background/study-context.js";
import type { AttemptCandidateMessageV1, CommandResponseV1 } from "../src/shared/protocol.js";

type BootstrapListener = Parameters<StartQbQuizBootstrapOptions["runtime"]["onMessage"]["addListener"]>[0];
type BootstrapMessage = Parameters<StartQbQuizBootstrapOptions["runtime"]["sendMessage"]>[0];
const PLAN = "40000000-0000-4000-8000-000000000001";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

class RouteEvents {
  readonly listeners = new Map<string, Set<() => void>>();
  public addEventListener(type: string, listener: () => void): void {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener); this.listeners.set(type, group);
  }
  public removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener); }
  public emit(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
}
async function flush(): Promise<void> { for (let i = 0; i < 150; i += 1) await Promise.resolve(); }

// Real content bootstrap, route tracker, consent controller and message router;
// only DOM observations, Chrome message delivery and storage are controlled fakes.
function harness(pathname = "/quiz", search = "?question_id=first", frozenSenderUrl = false) {
  const window = new Window();
  const document = window.document as unknown as Document;
  const location = { origin: "https://qb.medilink-study.com", pathname, search, hash: "" };
  const initialSenderUrl = `${location.origin}${pathname}${search}`;
  const navigation = new RouteEvents();
  const windowEvents = new RouteEvents();
  let stored: unknown;
  let routeStored: unknown;
  let listener: BootstrapListener | undefined;
  let inspect: (() => void) | undefined;
  let observation: AttemptDomObservation = { kind: "pending", question_key: "119A1" };
  let eventNumber = 0;
  let sessionNumber = 0;
  let holdNextAck = false;
  let releaseAck: (() => void) | undefined;
  let heldDeliveryKind: BootstrapMessage["kind"] | undefined;
  let releaseDelivery: (() => void) | undefined;
  let afterRouteRead: (() => void) | undefined;
  const sent: BootstrapMessage[] = [];
  const accepted: Array<{ candidate: AttemptCandidateMessageV1; context: StudyCaptureContext }> = [];
  const starts: string[] = [];
  const sender = (): ConsentSenderContext => ({
    tab_id: 7, window_id: 3, tab_active: true, frame_id: 0,
    origin: location.origin, url: frozenSenderUrl ? initialSenderUrl : `${location.origin}${location.pathname}${location.search}`,
    document_id: "same-browser-document",
  });
  const command = (message: unknown): CommandResponseV1 | undefined => {
    let response: CommandResponseV1 | undefined;
    listener?.(message, {}, (value) => { response = value; });
    return response;
  };
  const routes = new StudyRouteContext({
    store: { read: async () => {
      const state = structuredClone(routeStored);
      const callback = afterRouteRead; afterRouteRead = undefined; callback?.();
      return state;
    }, write: async (state) => { routeStored = structuredClone(state); } },
    isCurrent: async (source, route) => source.document_id === "same-browser-document"
      && command({ kind: "qb_page_route_probe_v1",
        ...(route === undefined ? { expected_url: source.url } : { expected_route: route }),
      })?.ok === true,
    lookup: async (id) => id === "review-set"
      ? { study_mode: "review", review_plan_id: PLAN } : { study_mode: "normal" },
  });
  const consent = new ConsentController({
    store: { read: async () => structuredClone(stored), write: async (state) => { stored = structuredClone(state); } },
    ui: { isTabActive: async () => true, showAttention: async () => undefined,
      clearAttention: async () => undefined, showCapturing: async () => undefined, openPopup: async () => false },
    routes, automatic: { resolveStudyContext: (input) => routes.resolve(input.sender) },
    capture: {
      probe: async (session) => session.document_id === "same-browser-document"
        && command({ kind: "qb_quiz_consent_probe_v1", page_session_id: session.page_session_id })?.ok === true,
      start: async (session) => {
        starts.push(session.page_session_id);
        return command({ kind: "start_capture_v1", page_session_id: session.page_session_id })?.ok === true;
      },
      stop: async (session) => command({ kind: "stop_capture_v1", page_session_id: session.page_session_id })?.ok === true,
    },
  });
  const router = new BackgroundMessageRouter({ handleMessage: async (message, studyMode, reviewPlanId) => {
    const candidate = message as AttemptCandidateMessageV1;
    if (candidate.kind === "attempt_candidate_v1") accepted.push({ candidate,
      context: { study_mode: studyMode ?? "unclassified", ...(reviewPlanId === undefined ? {} : { review_plan_id: reviewPlanId }) } });
    return { ok: true, code: candidate.kind === "attempt_candidate_v1" ? "candidate_enqueued" : "capture_observing" };
  } }, consent);
  const handle = startQbQuizBootstrap({
    document, location, navigation, windowEvents,
    MutationObserver: class {
      public constructor(callback: () => void) { inspect = callback; }
      public observe(): void { /* The test controls observations. */ }
      public disconnect(): void { inspect = undefined; }
    },
    createController: () => new CaptureController({ observedAttributeNames: [], inspect: () => observation }, {
      createEventId: () => `20000000-0000-4000-8000-${String(++eventNumber).padStart(12, "0")}`,
      now: () => new Date("2026-10-19T00:00:00.000Z"),
    }),
    createPageSessionId: () => `10000000-0000-4000-8000-${String(++sessionNumber).padStart(12, "0")}`,
    runtime: {
      onMessage: { addListener: (next) => { listener = next; }, removeListener: () => { listener = undefined; } },
      sendMessage: async (message) => {
        sent.push(message);
        // Chrome sender metadata belongs to the send, even when delivery is delayed.
        const source = sender();
        if (message.kind === heldDeliveryKind) {
          heldDeliveryKind = undefined;
          await new Promise<void>((resolve) => { releaseDelivery = resolve; });
        }
        const hold = message.kind === "qb_page_route_v1" && holdNextAck;
        if (hold) holdNextAck = false;
        const response = await router.handleMessage(message, { consent_context: source, extension_page: false });
        if (hold) await new Promise<void>((resolve) => { releaseAck = resolve; });
        return response;
      },
    },
  });
  cleanups.push(async () => { releaseAck?.(); releaseDelivery?.(); handle.disconnect(); await flush(); await window.happyDOM.close(); });
  return {
    handle, consent, accepted, sent, starts, windowEvents,
    sender,
    send: (message: unknown, source = sender()) => router.handleMessage(message, { consent_context: source, extension_page: false }),
    routeState: () => structuredClone(routeStored),
    afterNextRouteRead: (callback: () => void) => { afterRouteRead = callback; },
    setLocation: (path: string, query = "") => { location.pathname = path; location.search = query; },
    holdNextDelivery: (kind: BootstrapMessage["kind"]) => { heldDeliveryKind = kind; },
    deliveryIsHeld: () => releaseDelivery !== undefined,
    releaseDelivery: () => { const release = releaseDelivery; releaseDelivery = undefined; release?.(); },
    holdNextRouteAck: () => { holdNextAck = true; },
    routeAckIsHeld: () => releaseAck !== undefined,
    releaseRouteAck: () => { const release = releaseAck; releaseAck = undefined; release?.(); },
    probe: (id = handle.pageSessionId) => command({ kind: "qb_quiz_consent_probe_v1", page_session_id: id }),
    start: (id = handle.pageSessionId) => command({ kind: "start_capture_v1", page_session_id: id }),
    move: (path: string, query = "") => { location.pathname = path; location.search = query; navigation.emit("currententrychange"); },
    render: (next: AttemptDomObservation) => { observation = next; inspect?.(); },
    popup: () => router.handleMessage({ kind: "get_tab_consent_status_v1", tab_id: 7 }, { consent_context: null, extension_page: true }),
  };
}
const pending = (questionKey: string): AttemptDomObservation => ({ kind: "pending", question_key: questionKey });
const resolved = (questionKey: string): AttemptDomObservation => ({ kind: "resolved", question_key: questionKey, result: "correct", selected_option_indices: [1] });

describe("quiz route and document session continuity", () => {
  it("starts and keeps recording after SPA navigation when Chrome sender URL remains the original search", async () => {
    const h = harness("/search", "?questionSetId=review-set", true);
    await flush();
    h.move("/quiz", "?question_id=first"); await flush();
    expect(await h.popup()).toMatchObject({ state: "capturing", study_mode: "review" });
    h.render(resolved("119A1")); await flush();
    h.move("/quiz", "?question_id=second"); await flush();
    h.render(pending("119A2")); h.render(resolved("119A2")); await flush();
    expect(h.accepted.map((entry) => entry.candidate.question_key)).toEqual(["119A1", "119A2"]);
    expect(h.accepted.every((entry) => entry.context.study_mode === "review" && entry.context.review_plan_id === PLAN)).toBe(true);
    h.move("/search", "?questionSetId=other"); await flush();
    expect(h.probe()).toBeUndefined();
  });

  it.each(["old_document", "subframe", "foreign_origin", "foreign_url", "credentials_url", "missing_origin", "missing_document"] as const)(
    "rejects route, READY, and candidate messages from %s even with a matching descriptor", async (boundary) => {
      const h = harness("/search", "?questionSetId=review-set", true); await flush();
      h.move("/quiz", "?question_id=first"); await flush();
      const before = h.routeState();
      const source: ConsentSenderContext = {
        tab_id: 7, window_id: 3, tab_active: true, frame_id: boundary === "subframe" ? 1 : 0,
        ...(boundary === "missing_origin" ? {} : { origin: boundary === "foreign_origin"
          ? "https://example.test" : "https://qb.medilink-study.com" }),
        url: boundary === "foreign_url" ? "https://example.test/quiz" : boundary === "credentials_url"
          ? "https://user@qb.medilink-study.com/quiz" : "https://qb.medilink-study.com/search?questionSetId=review-set",
        ...(boundary === "missing_document" ? {} : { document_id: boundary === "old_document"
          ? "previous-browser-document" : "same-browser-document" }),
      };
      expect(await h.send({ kind: "qb_page_route_v1", route: { route_kind: "quiz", question_id: "first" } }, source))
        .toMatchObject({ ok: false });
      expect(await h.send({ kind: "qb_quiz_bootstrap_ready_v1", page_session_id: h.handle.pageSessionId }, source))
        .toMatchObject({ ok: false });
      expect(await h.send({ kind: "qb_quiz_capture_message_v1", page_session_id: h.handle.pageSessionId,
        message: { kind: "attempt_candidate_v1", event_id: "20000000-0000-4000-8000-000000000099",
          question_key: "119A1", answered_at: "2026-10-19T00:00:00.000Z", result: "correct", selected_option_indices: [1] },
      }, source)).toMatchObject({ ok: false });
      expect(h.routeState()).toEqual(before);
      expect(h.accepted).toHaveLength(0);
      expect(await h.popup()).toMatchObject({ state: "capturing", study_mode: "review" });
    },
  );

  it("rejects an old search delivered after another set starts without changing its normal context", async () => {
    const h = harness("/search", "?questionSetId=review-set", true); await flush();
    h.move("/quiz", "?question_id=first"); await flush();
    h.holdNextDelivery("qb_page_route_v1");
    h.move("/search", "?questionSetId=review-set"); await flush();
    expect(h.deliveryIsHeld()).toBe(true);
    h.move("/search", "?questionSetId=normal-set"); await flush();
    h.render(pending("119A2"));
    h.move("/quiz", "?question_id=second"); await flush();
    const before = h.routeState();
    expect(await h.popup()).toMatchObject({ state: "capturing", study_mode: "normal" });
    h.releaseDelivery(); await flush();
    expect(h.routeState()).toEqual(before);
    h.render(resolved("119A2")); await flush();
    expect(h.accepted).toHaveLength(1);
    expect(h.accepted[0]?.context).toEqual({ study_mode: "normal" });
  });

  it("rechecks a matching descriptor after storage access before replacing the stored route", async () => {
    const h = harness("/search", "?questionSetId=review-set", true); await flush();
    h.move("/quiz", "?question_id=first"); await flush();
    const before = h.routeState();
    h.afterNextRouteRead(() => h.setLocation("/search", "?questionSetId=normal-set"));
    expect(await h.send({ kind: "qb_page_route_v1", route: { route_kind: "quiz", question_id: "first" } }))
      .toEqual({ ok: false, code: "study_route_unavailable" });
    expect(h.routeState()).toEqual(before);
    expect(h.probe()).toBeUndefined();
  });

  it("rejects a candidate delayed before authentication when the quiz has already been left", async () => {
    const h = harness("/search", "?questionSetId=review-set", true); await flush();
    h.move("/quiz", "?question_id=first"); await flush();
    h.holdNextDelivery("qb_quiz_capture_message_v1");
    h.render(resolved("119A1")); await flush();
    expect(h.deliveryIsHeld()).toBe(true);
    expect(h.accepted).toHaveLength(0);
    h.move("/search"); await flush();
    h.releaseDelivery(); await flush();
    expect(h.accepted).toHaveLength(0);
    expect(h.probe()).toBeUndefined();
  });

  it("keeps capture and the exact review context when reconciliation races a next-question route ACK", async () => {
    const h = harness("/search", "?questionSetId=review-set");
    await flush();
    h.move("/quiz", "?question_id=first"); await flush();
    h.render(resolved("119A1")); await flush();
    expect(h.accepted).toHaveLength(1);
    const id = h.handle.pageSessionId;
    h.holdNextRouteAck(); h.move("/quiz", "?question_id=second"); await flush();
    expect(h.routeAckIsHeld()).toBe(true);
    expect(await h.consent.reconcileTabDocument(7)).toMatchObject({ code: "consent_session_retained" });
    // Capture remains authenticated before the latest route ACK is delivered.
    h.render(pending("119A2")); h.render(resolved("119A2")); await flush();
    h.releaseRouteAck(); await flush();
    h.move("/quiz", "?question_id=third"); await flush();
    h.render(pending("119A3")); h.render(resolved("119A3")); await flush();
    expect(h.accepted).toHaveLength(3);
    expect(new Set(h.accepted.map(({ candidate }) => candidate.event_id)).size).toBe(3);
    expect(h.accepted.every(({ context }) => context.study_mode === "review" && context.review_plan_id === PLAN)).toBe(true);
    expect(h.handle.pageSessionId).toBe(id);
    expect(h.starts).toHaveLength(1);
    expect(await h.popup()).toMatchObject({ state: "capturing", study_mode: "review" });
  });

  it("does not confirm or start a fresh quiz before its first route ACK", async () => {
    const h = harness("/search"); await flush();
    h.holdNextRouteAck(); h.move("/quiz", "?question_id=first"); await flush();
    expect(h.routeAckIsHeld()).toBe(true);
    expect(h.probe()).toEqual({ ok: false, code: "consent_document_unavailable" });
    expect(h.start()).toEqual({ ok: false, code: "capture_start_location_blocked" });
    expect(h.starts).toHaveLength(0);
    h.releaseRouteAck(); await flush();
    expect(h.probe()).toEqual({ ok: true, code: "consent_document_present" });
    h.render(resolved("119A1")); await flush();
    expect(h.accepted).toHaveLength(1);
    expect(h.accepted[0]?.context).toEqual({ study_mode: "normal" });
  });

  it("preserves an explicit pause through next-question reconciliation and does not restart on its ACK", async () => {
    const h = harness(); await flush();
    const id = h.handle.pageSessionId;
    expect(id).not.toBeNull();
    await h.consent.stopCapture(7, id ?? "");
    h.holdNextRouteAck(); h.move("/quiz", "?question_id=second"); await flush();
    expect(await h.consent.reconcileTabDocument(7)).toMatchObject({ code: "consent_session_retained" });
    h.render(pending("119A2")); h.render(resolved("119A2"));
    h.releaseRouteAck(); await flush();
    expect(h.starts).toHaveLength(1);
    expect(h.accepted).toHaveLength(0);
    expect(await h.popup()).toMatchObject({ state: "paused" });
  });

  it.each(["leave", "pagehide"] as const)("rejects the old session after real %s while a route ACK is pending", async (exit) => {
    const h = harness(); await flush();
    const oldId = h.handle.pageSessionId;
    h.holdNextRouteAck(); h.move("/quiz", "?question_id=second"); await flush();
    if (exit === "leave") h.move("/search");
    else h.windowEvents.emit("pagehide");
    expect(h.probe(oldId)).toBeUndefined();
    expect(h.start(oldId)).toBeUndefined();
    expect(await h.consent.reconcileTabDocument(7)).toMatchObject({ code: "consent_session_cleared" });
    h.releaseRouteAck(); await flush();
    h.render(resolved("119A2")); await flush();
    expect(h.accepted).toHaveLength(0);
    expect(await h.popup()).toMatchObject({ state: "unavailable" });
  });

  it("defaults an unacknowledged new set origin to normal without reusing the old review purpose", async () => {
    const h = harness("/search", "?questionSetId=review-set"); await flush();
    h.move("/quiz", "?question_id=first"); await flush();
    const oldId = h.handle.pageSessionId;
    h.holdNextRouteAck(); h.move("/search", "?questionSetId=another-set"); await flush();
    expect(h.routeAckIsHeld()).toBe(true);
    h.render(pending("119A2"));
    h.move("/quiz", "?question_id=second"); await flush();
    expect(h.handle.pageSessionId).not.toBe(oldId);
    h.releaseRouteAck(); await flush();
    h.render(resolved("119A2")); await flush();
    expect(h.accepted).toHaveLength(1);
    expect(h.accepted[0]?.context).toEqual({ study_mode: "normal" });
  });

  it("starts a new session on quiz reentry and cannot carry a prior review context into normal study", async () => {
    const h = harness("/search", "?questionSetId=review-set"); await flush();
    h.move("/quiz", "?question_id=first"); await flush();
    const oldId = h.handle.pageSessionId;
    h.move("/search"); await flush();
    h.render(pending("119A2"));
    h.move("/quiz", "?question_id=second"); await flush();
    expect(h.handle.pageSessionId).not.toBe(oldId);
    expect(h.probe(oldId)).toBeUndefined();
    expect(await h.send({ kind: "qb_quiz_bootstrap_ready_v1", page_session_id: oldId }))
      .toMatchObject({ ok: false });
    expect(await h.send({ kind: "qb_quiz_capture_message_v1", page_session_id: oldId,
      message: { kind: "attempt_candidate_v1", event_id: "20000000-0000-4000-8000-000000000098",
        question_key: "119A1", answered_at: "2026-10-19T00:00:00.000Z", result: "correct", selected_option_indices: [1] },
    })).toMatchObject({ ok: false });
    expect(await h.popup()).toMatchObject({ state: "capturing", study_mode: "normal" });
    h.render(resolved("119A2")); await flush();
    expect(h.accepted).toHaveLength(1);
    expect(h.accepted[0]?.context).toEqual({ study_mode: "normal" });
  });
});
