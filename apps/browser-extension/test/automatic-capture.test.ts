import { describe, expect, it, vi } from "vitest";
import { ConsentController, type ConsentDocumentSessionV1, type ConsentSenderContext,
  type ConsentSessionStateV1, type ConsentReadyInput } from "../src/background/consent-controller.js";
import type { StudyCaptureContext } from "../src/background/study-context.js";

const PAGE_A = "10000000-0000-4000-8000-000000000001";
const PAGE_B = "10000000-0000-4000-8000-000000000002";
const PLAN = "20000000-0000-4000-8000-000000000001";
const sender: ConsentSenderContext = { tab_id: 7, window_id: 3, tab_active: false,
  frame_id: 0, origin: "https://qb.medilink-study.com", url: "https://qb.medilink-study.com/quiz",
  document_id: "same-browser-document" };

function setup(resolveStudyContext?: (input: ConsentReadyInput) => Promise<StudyCaptureContext>) {
  let stored: unknown;
  let currentPage = PAGE_A;
  let stopSucceeds = true;
  let failWrite = false;
  let now = 1_000_000;
  const starts: ConsentDocumentSessionV1[] = [];
  const stops: ConsentDocumentSessionV1[] = [];
  const openPopup = vi.fn(async () => true);
  const ports = {
    now: () => now,
    store: { read: async () => structuredClone(stored), write: async (state: ConsentSessionStateV1) => {
      if (failWrite) throw new Error("unavailable");
      stored = structuredClone(state);
    } },
    ui: { isTabActive: async () => true, showAttention: async () => undefined,
      clearAttention: async () => undefined, openPopup },
    capture: { probe: async (session: ConsentDocumentSessionV1) => session.page_session_id === currentPage,
      start: async (session: ConsentDocumentSessionV1) => { starts.push(session); return true; },
      stop: async (session: ConsentDocumentSessionV1) => { stops.push(session); return stopSucceeds; } },
    automatic: resolveStudyContext ? { resolveStudyContext } : {},
  };
  const controller = new ConsentController(ports);
  return { controller, ports, starts, stops, openPopup,
    get stored() { return stored; }, set stored(value: unknown) { stored = value; },
    set currentPage(value: string) { currentPage = value; },
    set stopSucceeds(value: boolean) { stopSucceeds = value; },
    set failWrite(value: boolean) { failWrite = value; },
    set now(value: number) { now = value; },
    ready: (page = PAGE_A) => controller.handleReady({ page_session_id: page, sender }),
    context: (page = PAGE_A) => controller.getSenderStudyContext({ ...sender, page_session_id: page }),
  };
}

describe("automatic document capture", () => {
  it("starts normal capture without a popup or foreground requirement and deduplicates READY", async () => {
    const test = setup();
    test.ports.ui.isTabActive = async () => false;
    expect(await test.ready()).toEqual({ ok: true, code: "consent_capture_started" });
    expect(await test.context()).toEqual({ study_mode: "normal" });
    expect(await test.ready()).toEqual({ ok: true, code: "consent_ready_duplicate" });
    expect(test.starts).toHaveLength(1);
    expect(test.openPopup).not.toHaveBeenCalled();
  });

  it("starts observation before lookup finishes and holds early candidates for the exact classification", async () => {
    let resolveLookup!: (value: StudyCaptureContext) => void;
    let signalLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { signalLookup = resolve; });
    const lookup = new Promise<StudyCaptureContext>((resolve) => { resolveLookup = resolve; });
    const test = setup(async () => { signalLookup(); return await lookup; });
    const ready = test.ready();
    await lookupStarted;
    expect(test.starts).toHaveLength(1);
    expect((test.stored as ConsentSessionStateV1).sessions[0]).toMatchObject({ classification_pending: true });
    let candidateResolved = false;
    const candidate = test.context().then((value) => { candidateResolved = true; return value; });
    await Promise.resolve();
    expect(candidateResolved).toBe(false);
    resolveLookup({ study_mode: "review", review_plan_id: PLAN });
    await ready;
    expect(await candidate).toEqual({ study_mode: "review", review_plan_id: PLAN });
  });

  it("does not silently turn a failed review lookup into normal study", async () => {
    const test = setup(async () => { throw new Error("lookup unavailable"); });
    await test.ready();
    expect(await test.context()).toEqual({ study_mode: "unclassified" });
  });

  it("retries an unknown purpose after its persisted deadline without holding new answers", async () => {
    let finishRetry!: (context: StudyCaptureContext) => void;
    const retryResult = new Promise<StudyCaptureContext>((resolve) => { finishRetry = resolve; });
    const lookup = vi.fn(async (): Promise<StudyCaptureContext> => lookup.mock.calls.length === 1
      ? { study_mode: "unclassified" } : await retryResult);
    const test = setup(lookup);
    await test.ready();
    test.now = 1_064_999;
    await test.ready();
    expect(lookup).toHaveBeenCalledTimes(1);
    const restarted = new ConsentController(test.ports);
    await restarted.handleReady({ page_session_id: PAGE_A, sender });
    expect(lookup).toHaveBeenCalledTimes(1);
    test.now = 1_065_000;
    expect(await restarted.handleReady({ page_session_id: PAGE_A, sender }))
      .toEqual({ ok: true, code: "consent_ready_duplicate" });
    expect(lookup).toHaveBeenCalledTimes(2);
    await restarted.handleReady({ page_session_id: PAGE_A, sender });
    expect(lookup).toHaveBeenCalledTimes(2);
    const candidateSender = { ...sender, page_session_id: PAGE_A };
    const accepted = await restarted.getAcceptedCandidateContext(candidateSender);
    expect(accepted).toEqual({ study_mode: "unclassified" });
    expect((test.stored as ConsentSessionStateV1).sessions[0]?.classification_pending).toBe(false);
    finishRetry({ study_mode: "review", review_plan_id: PLAN });
    await vi.waitFor(async () => expect((await restarted.getTabStatus(7))?.study_mode).toBe("review"));
    expect(accepted).toEqual({ study_mode: "unclassified" });
    expect(await restarted.getAcceptedCandidateContext(candidateSender)).toEqual({ study_mode: "review", review_plan_id: PLAN });
    test.now = 9_000_000;
    await restarted.handleReady({ page_session_id: PAGE_A, sender });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(test.starts).toHaveLength(1);
  });

  it("backs off repeated unknown results through 65, 130, 260 and 300 seconds", async () => {
    const lookup = vi.fn(async (): Promise<StudyCaptureContext> => ({ study_mode: "unclassified" }));
    const test = setup(lookup);
    await test.ready();
    let now = 1_000_000;
    for (const [index, delay] of [65_000, 130_000, 260_000, 300_000, 300_000].entries()) {
      expect((test.stored as ConsentSessionStateV1).sessions[0]?.classification_retry_after).toBe(now + delay);
      test.now = now + delay - 1;
      await test.ready();
      expect(lookup).toHaveBeenCalledTimes(index + 1);
      now += delay;
      test.now = now;
      await test.ready();
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(index + 2));
      // The lookup and serialized completion settle before the next health message.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      await vi.waitFor(() => expect((test.stored as ConsentSessionStateV1).sessions[0]?.classification_retry_after)
        .toBe(now + ([130_000, 260_000, 300_000, 300_000, 300_000][index] ?? 300_000)));
    }
  });

  it.each(["paused", "left", "replaced", "classified"] as const)(
    "discards a retry result when the session has been %s", async (change) => {
      let finishRetry!: (context: StudyCaptureContext) => void;
      const retryResult = new Promise<StudyCaptureContext>((resolve) => { finishRetry = resolve; });
      const lookup = vi.fn(async (input: ConsentReadyInput): Promise<StudyCaptureContext> => {
        if (input.page_session_id === PAGE_B) return { study_mode: "normal" };
        return lookup.mock.calls.length === 1 ? { study_mode: "unclassified" } : await retryResult;
      });
      const test = setup(lookup);
      await test.ready();
      test.now = 1_065_000;
      await test.ready();
      if (change === "paused") await test.controller.stopCapture(7, PAGE_A);
      else if (change === "left") test.currentPage = PAGE_B;
      else if (change === "replaced") { test.currentPage = PAGE_B; await test.ready(PAGE_B); }
      else {
        const state = test.stored as ConsentSessionStateV1;
        test.stored = { ...state, sessions: state.sessions.map((session) => ({ ...session, study_mode: "normal" })) };
      }
      finishRetry({ study_mode: "review", review_plan_id: PLAN });
      // Enqueue a status read after the completion continuation is scheduled.
      await Promise.resolve();
      await Promise.resolve();
      await test.controller.getTabStatus(7);
      expect((await test.controller.getTabStatus(7))?.study_mode)
        .toBe(change === "replaced" || change === "classified" ? "normal" : "unclassified");
      expect((await test.controller.getTabStatus(7))?.review_plan_id).toBeUndefined();
      if (change === "paused") {
        await test.ready();
        expect(lookup).toHaveBeenCalledTimes(2);
        expect((await test.controller.getTabStatus(7))?.capture_state).toBe("paused");
      }
    },
  );

  it("accepts a stale search sender URL only with a registered quiz document and current session probe", async () => {
    const test = setup();
    let registered = true;
    const controller = new ConsentController({ ...test.ports, routes: {
      handleRoute: async () => true, removeTab: async () => undefined,
      hasRegisteredQuizRoute: async () => registered,
    } });
    const staleSender = { ...sender, url: "https://qb.medilink-study.com/search?questionSetId=set1" };
    expect(await controller.handleReady({ page_session_id: PAGE_A, sender: staleSender }))
      .toEqual({ ok: true, code: "consent_capture_started" });
    expect(await controller.getAcceptedCandidateContext({ ...staleSender, page_session_id: PAGE_A }))
      .toEqual({ study_mode: "normal" });
    registered = false;
    expect(await controller.getAcceptedCandidateContext({ ...staleSender, page_session_id: PAGE_A })).toBeNull();
    registered = true;
    test.currentPage = PAGE_B;
    expect(await controller.getAcceptedCandidateContext({ ...staleSender, page_session_id: PAGE_A })).toBeNull();
    expect(await controller.getSenderStudyContext({ ...staleSender, page_session_id: PAGE_A })).toBeNull();
    test.currentPage = PAGE_A;
    const missingDocument = { ...staleSender, page_session_id: PAGE_A };
    delete (missingDocument as { document_id?: string }).document_id;
    expect(await controller.getAcceptedCandidateContext(missingDocument)).toBeNull();
    for (const patch of [{ frame_id: 1 }, { origin: "https://example.test" },
      { url: "https://example.test/search" }, { document_id: "other-document" }]) {
      expect(await controller.getAcceptedCandidateContext({ ...staleSender, ...patch, page_session_id: PAGE_A })).toBeNull();
    }
  });

  it("recovers a classification interrupted by worker restart before accepting a candidate", async () => {
    const test = setup(async () => ({ study_mode: "review", review_plan_id: PLAN }));
    test.stored = { version: 1, sessions: [{ tab_id: 7, window_id: 3, page_session_id: PAGE_A,
      document_id: sender.document_id, decision: "consented", capture_state: "starting",
      auto_popup_state: "suppressed", study_mode: "unclassified", classification_pending: true }] };
    expect(await test.context()).toEqual({ study_mode: "review", review_plan_id: PLAN });
    expect(test.starts).toHaveLength(0);
  });

  it("keeps another tab READY and STOP responsive during a slow classification", async () => {
    let resolveLookup!: (value: StudyCaptureContext) => void;
    let signalLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { signalLookup = resolve; });
    const lookup = new Promise<StudyCaptureContext>((resolve) => { resolveLookup = resolve; });
    const test = setup(async (input) => {
      if (input.sender.tab_id !== 7) return {study_mode: "normal"};
      signalLookup();
      return await lookup;
    });
    const firstReady = test.ready();
    await lookupStarted;
    expect(await test.controller.handleReady({page_session_id: PAGE_A, sender: {...sender, tab_id: 8}}))
      .toEqual({ok: true, code: "consent_capture_started"});
    expect(test.starts.map((session) => session.tab_id)).toEqual([7, 8]);
    expect(await test.controller.stopCapture(7, PAGE_A)).toEqual({ok: true, code: "consent_capture_paused"});
    resolveLookup({study_mode: "review", review_plan_id: PLAN});
    await firstReady;
    expect(await test.context()).toBeNull();
    expect((await test.controller.getTabStatus(7))?.capture_state).toBe("paused");
  });

  it("retains an authenticated early answer across a route change while refusing later stale messages", async () => {
    let resolveLookup!: (value: StudyCaptureContext) => void;
    let signalLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { signalLookup = resolve; });
    const lookup = new Promise<StudyCaptureContext>((resolve) => { resolveLookup = resolve; });
    const test = setup(async (input) => {
      if (input.page_session_id === PAGE_B) return {study_mode: "normal"};
      signalLookup();
      return await lookup;
    });
    const firstReady = test.ready();
    await lookupStarted;
    const oldSender = {...sender, page_session_id: PAGE_A};
    const accepted = test.controller.getAcceptedCandidateContext(oldSender);
    const oldStatusContext = test.controller.getSenderStudyContext(oldSender);
    await test.controller.getTabStatus(7); // Wait until the earlier candidate has authenticated.
    test.currentPage = PAGE_B;
    await test.ready(PAGE_B);
    expect(await test.controller.getAcceptedCandidateContext(oldSender)).toBeNull();
    resolveLookup({study_mode: "review", review_plan_id: PLAN});
    await firstReady;
    expect(await accepted).toEqual({study_mode: "review", review_plan_id: PLAN});
    expect(await oldStatusContext).toBeNull();
    expect(await test.context(PAGE_B)).toEqual({study_mode: "normal"});
  });

  it("preserves a confirmed purpose across worker restart without reclassifying it", async () => {
    const test = setup(async () => ({ study_mode: "review", review_plan_id: PLAN }));
    await test.ready();
    const restarted = new ConsentController({ ...test.ports,
      automatic: { resolveStudyContext: async () => ({ study_mode: "normal" }) } });
    await restarted.handleReady({ page_session_id: PAGE_A, sender });
    expect(await restarted.getSenderStudyContext({ ...sender, page_session_id: PAGE_A }))
      .toEqual({ study_mode: "review", review_plan_id: PLAN });
    expect(test.starts).toHaveLength(1);
  });

  it("recognizes a new SPA session inside the same browser document and rejects stale READY", async () => {
    const test = setup();
    await test.ready();
    test.currentPage = PAGE_B;
    await test.ready(PAGE_B);
    expect(await test.ready(PAGE_A)).toEqual({ ok: false, code: "consent_document_unavailable" });
    expect((await test.controller.getTabStatus(7))?.page_session_id).toBe(PAGE_B);
    expect(test.starts).toHaveLength(2);
    expect(await test.context(PAGE_A)).toBeNull();
  });

  it("keeps a pause through READY and worker restart, then resumes with the same purpose", async () => {
    const test = setup(async () => ({ study_mode: "review", review_plan_id: PLAN }));
    await test.ready();
    expect(await test.controller.stopCapture(7, PAGE_A)).toEqual({ ok: true, code: "consent_capture_paused" });
    expect(await test.context()).toBeNull();
    await test.ready();
    const restarted = new ConsentController(test.ports);
    await restarted.handleReady({ page_session_id: PAGE_A, sender });
    expect(test.starts).toHaveLength(1);
    await restarted.startCapture(7, PAGE_A, "normal");
    expect(await restarted.getSenderStudyContext({ ...sender, page_session_id: PAGE_A }))
      .toEqual({ study_mode: "review", review_plan_id: PLAN });
    expect(test.starts).toHaveLength(2);
  });

  it("revokes acceptance even when STOP acknowledgement is lost", async () => {
    const test = setup();
    await test.ready();
    test.stopSucceeds = false;
    expect(await test.controller.stopCapture(7, PAGE_A)).toEqual({ ok: false, code: "consent_capture_stop_blocked" });
    expect(await test.context()).toBeNull();
    await test.ready();
    expect(test.starts).toHaveLength(1);
  });

  it("does not begin observation when the session cannot be persisted", async () => {
    const test = setup();
    test.failWrite = true;
    expect(await test.ready()).toEqual({ ok: false, code: "consent_storage_blocked" });
    expect(test.starts).toHaveLength(0);
  });
});


describe("manual study-mode choice", () => {
  it("changes future answers, preserves accepted context, and survives restart and pause/resume", async () => {
    const test = setup(async () => ({ study_mode: "unclassified" }));
    await test.ready();
    const source = { ...sender, page_session_id: PAGE_A };
    const before = await test.controller.getAcceptedCandidateContext(source);
    expect(await test.controller.setStudyMode(7, PAGE_A, "review"))
      .toEqual({ ok: true, code: "study_mode_changed" });
    expect(before).toEqual({ study_mode: "unclassified" });
    expect(await test.controller.getAcceptedCandidateContext(source)).toEqual({ study_mode: "review" });
    expect((test.stored as ConsentSessionStateV1).sessions[0]?.classification_retry_after).toBeUndefined();
    await test.controller.stopCapture(7, PAGE_A);
    expect(await test.controller.setStudyMode(7, PAGE_A, "normal")).toMatchObject({ ok: true });
    expect(await test.controller.getAcceptedCandidateContext(source)).toBeNull();
    const restarted = new ConsentController(test.ports);
    expect((await restarted.getTabStatus(7))?.capture_state).toBe("paused");
    await restarted.startCapture(7, PAGE_A);
    expect(await restarted.getAcceptedCandidateContext(source)).toEqual({ study_mode: "normal" });
    expect(test.starts).toHaveLength(2);
  });

  it("retains verified plan evidence only for the existing review classification", async () => {
    const test = setup(async () => ({ study_mode: "review", review_plan_id: PLAN }));
    await test.ready();
    await test.controller.setStudyMode(7, PAGE_A, "review");
    expect(await test.context()).toEqual({ study_mode: "review", review_plan_id: PLAN });
    await test.controller.setStudyMode(7, PAGE_A, "normal");
    expect(await test.context()).toEqual({ study_mode: "normal" });
    await test.controller.setStudyMode(7, PAGE_A, "review");
    expect(await test.context()).toEqual({ study_mode: "review" });
  });

  it.each(["initial", "retry"] as const)("does not let a late %s lookup overwrite manual selection", async (phase) => {
    let finish!: (context: StudyCaptureContext) => void;
    const pending = new Promise<StudyCaptureContext>((resolve) => { finish = resolve; });
    const lookup = vi.fn(async (): Promise<StudyCaptureContext> =>
      phase === "retry" && lookup.mock.calls.length === 1 ? { study_mode: "unclassified" } : await pending);
    const test = setup(lookup);
    const first = test.ready();
    if (phase === "retry") { await first; test.now = 1_065_000; await test.ready(); }
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(phase === "retry" ? 2 : 1));
    const source = { ...sender, page_session_id: PAGE_A };
    const before = test.controller.getAcceptedCandidateContext(source);
    // Enqueueing the choice after acceptance fixes their ordering without waiting for lookup.
    expect(await test.controller.setStudyMode(7, PAGE_A, "normal")).toMatchObject({ ok: true });
    expect(await test.controller.getAcceptedCandidateContext(source)).toEqual({ study_mode: "normal" });
    finish({ study_mode: "review", review_plan_id: PLAN });
    await first;
    expect(await before).toEqual(phase === "initial" ? { study_mode: "review", review_plan_id: PLAN } : { study_mode: "unclassified" });
    await Promise.resolve();
    expect(await test.context()).toEqual({ study_mode: "normal" });
    const restarted = new ConsentController(test.ports);
    test.now = 9_000_000;
    await restarted.handleReady({ sender, page_session_id: PAGE_A });
    expect(await restarted.getAcceptedCandidateContext(source)).toEqual({ study_mode: "normal" });
    expect(lookup).toHaveBeenCalledTimes(phase === "retry" ? 2 : 1);
  });

  it("rejects inactive, departed, stale or unrelated sessions without changing persisted state", async () => {
    const test = setup();
    await test.ready();
    const before = test.stored;
    for (const [tab, page] of [[8, PAGE_A], [7, PAGE_B]] as const) {
      expect(await test.controller.setStudyMode(tab, page, "review")).toMatchObject({ ok: false });
    }
    test.ports.ui.isTabActive = async () => false;
    expect(await test.controller.setStudyMode(7, PAGE_A, "review")).toMatchObject({ ok: false });
    test.ports.ui.isTabActive = async () => true;
    test.currentPage = PAGE_B;
    expect(await test.controller.setStudyMode(7, PAGE_A, "review")).toMatchObject({ ok: false });
    expect(test.stored).toEqual(before);
  });

  it("does not carry the chosen mode into a new session or another tab", async () => {
    const test = setup();
    await test.ready();
    await test.controller.setStudyMode(7, PAGE_A, "review");
    const other = { ...sender, tab_id: 8 };
    await test.controller.handleReady({ sender: other, page_session_id: PAGE_A });
    expect(await test.controller.getAcceptedCandidateContext({ ...other, page_session_id: PAGE_A })).toEqual({ study_mode: "normal" });
    test.currentPage = PAGE_B;
    await test.ready(PAGE_B);
    expect(await test.context(PAGE_B)).toEqual({ study_mode: "normal" });
    expect(await test.controller.setStudyMode(7, PAGE_A, "review")).toMatchObject({ ok: false });
  });

  it("reports a failed save without applying the requested choice", async () => {
    const test = setup();
    await test.ready();
    test.failWrite = true;
    expect(await test.controller.setStudyMode(7, PAGE_A, "review"))
      .toEqual({ ok: false, code: "consent_storage_blocked" });
    expect(await test.context()).toEqual({ study_mode: "normal" });
  });
});
