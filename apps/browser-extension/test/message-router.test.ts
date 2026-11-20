import type { StudyMode } from "@qb-study/contracts";
import { readFileSync } from "node:fs";

import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { QbQuizAttemptAdapter } from "../src/adapters/qb-quiz-adapter.js";
import { BackgroundCore } from "../src/background/core.js";
import {
  BackgroundMessageRouter,
  type BackgroundCoreRouterPort,
  type BackgroundRouteSender,
  type ConsentRouterPort,
} from "../src/background/message-router.js";
import { isBackgroundStateV1 } from "../src/background/state.js";
import type {
  BackgroundPorts,
  BackgroundStateV1,
  BackgroundStoragePort,
  CollectorTransportPort,
} from "../src/background/types.js";
import type {
  ConsentCommandResponse,
  ConsentSenderContext,
  ConsentTabStatusV1,
} from "../src/background/consent-controller.js";
import { CaptureController } from "../src/capture-controller.js";
import { startContentScript } from "../src/content-script.js";
import {
  ATTEMPT_CANDIDATE_MESSAGE_KIND,
  CAPTURE_STATUS_MESSAGE_KIND,
  GET_POPUP_STATUS_MESSAGE_KIND,
  GET_TAB_CONSENT_STATUS_MESSAGE_KIND,
  QB_QUIZ_BOOTSTRAP_READY_MESSAGE_KIND,
  QB_QUIZ_CAPTURE_MESSAGE_KIND,
  SET_TAB_CONSENT_MESSAGE_KIND,
  START_STUDY_CAPTURE_MESSAGE_KIND,
  SET_STUDY_MODE_MESSAGE_KIND,
  isPopupRequestMessageV1,
  type AttemptCandidateMessageV1,
  type CaptureStatusMessageV1,
} from "../src/shared/protocol.js";

const PAGE_SESSION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_PAGE_SESSION_ID = "10000000-0000-4000-8000-000000000002";
const EVENT_ID = "20000000-0000-4000-8000-000000000001";

const CANDIDATE = {
  kind: ATTEMPT_CANDIDATE_MESSAGE_KIND,
  event_id: EVENT_ID,
  question_key: "119A12",
  answered_at: "2026-08-26T03:04:05.006Z",
  result: "correct",
  selected_option_indices: [1],
} as const satisfies AttemptCandidateMessageV1;

const CAPTURE_STATUS = {
  kind: CAPTURE_STATUS_MESSAGE_KIND,
  state: "observing",
  code: "capture_observing",
} as const satisfies CaptureStatusMessageV1;

const CONSENT_CONTEXT: ConsentSenderContext = {
  tab_id: 7,
  window_id: 3,
  tab_active: true,
  frame_id: 0,
  origin: "https://qb.medilink-study.com",
  url: "https://qb.medilink-study.com/quiz?ignored=yes",
  document_id: "document-7",
};

const CONTENT_SENDER: BackgroundRouteSender = {
  consent_context: CONSENT_CONTEXT,
  extension_page: false,
};

const POPUP_SENDER: BackgroundRouteSender = {
  consent_context: null,
  extension_page: true,
};

function fixtureDocument(name: string): Document {
  const html = readFileSync(
    new URL(`../../../tests/fixtures/browser-extension/${name}`, import.meta.url),
    "utf8",
  );
  const window = new Window({ url: "https://qb.medilink-study.com/quiz" });
  window.document.write(html);
  return window.document as unknown as Document;
}

class ManualMutationObserver {
  static latest: ManualMutationObserver | undefined;

  readonly #callback: () => void;

  public constructor(callback: () => void) {
    this.#callback = callback;
    ManualMutationObserver.latest = this;
  }

  public observe(): void {
    // The test controls mutation delivery explicitly.
  }

  public disconnect(): void {
    // No platform resource exists in this test double.
  }

  public trigger(): void {
    this.#callback();
  }
}

function response(ok: boolean, code: string): ConsentCommandResponse {
  return ok
    ? { ok: true, code: code as ConsentCommandResponse["code"] }
    : { ok: false, code: code as ConsentCommandResponse["code"] };
}

class RecordingCore implements BackgroundCoreRouterPort {
  public readonly messages: unknown[] = [];
  public readonly modes: (StudyMode | undefined)[] = [];

  public async handleMessage(message: unknown, studyMode?: StudyMode): Promise<unknown> {
    this.messages.push(message);
    this.modes.push(studyMode);
    return { ok: true, code: "core_message_accepted" };
  }
}

class RecordingConsent implements ConsentRouterPort {
  public readonly readyCalls: Array<{
    readonly page_session_id: string;
    readonly sender: ConsentSenderContext;
  }> = [];
  public readonly declineCalls: Array<{
    readonly tabId: number;
    readonly pageSessionId: string;
  }> = [];
  public readonly startCalls: Array<{
    readonly tabId: number;
    readonly pageSessionId: string;
  }> = [];
  public readonly senderChecks: ConsentSenderContext[] = [];
  public tabStatus: ConsentTabStatusV1 | null = null;
  public authorizeSender = false;

  public async handleReady(input: {
    readonly page_session_id: string;
    readonly sender: ConsentSenderContext;
  }): Promise<ConsentCommandResponse> {
    this.readyCalls.push(input);
    return response(true, "consent_ready_registered");
  }

  public async getTabStatus(tabId: number): Promise<ConsentTabStatusV1 | null> {
    void tabId;
    return this.tabStatus;
  }

  public async declineCapture(
    tabId: number,
    pageSessionId: string,
  ): Promise<ConsentCommandResponse> {
    this.declineCalls.push({ tabId, pageSessionId });
    return response(true, "consent_declined");
  }

  public async startCapture(
    tabId: number,
    pageSessionId: string,
  ): Promise<ConsentCommandResponse> {
    this.startCalls.push({ tabId, pageSessionId });
    return response(true, "consent_capture_started");
  }

  public async getSenderStudyMode(sender: ConsentSenderContext): Promise<StudyMode | null> {
    this.senderChecks.push(sender);
    return this.authorizeSender
      && sender.document_id === "document-7"
      && sender.page_session_id === PAGE_SESSION_ID ? "unclassified" : null;
  }
}

function captureEnvelope(
  message: AttemptCandidateMessageV1 | CaptureStatusMessageV1,
  pageSessionId = PAGE_SESSION_ID,
): unknown {
  return {
    kind: QB_QUIZ_CAPTURE_MESSAGE_KIND,
    page_session_id: pageSessionId,
    message,
  };
}

function tabStatus(
  decision: ConsentTabStatusV1["decision"],
  captureState: ConsentTabStatusV1["capture_state"],
): ConsentTabStatusV1 {
  return {
    tab_id: 7,
    page_session_id: PAGE_SESSION_ID,
    decision,
    capture_state: captureState,
    auto_popup_state: "opened",
  };
}

describe("BackgroundMessageRouter READY and popup routing", () => {
  it("routes a valid READY with its sender context and rejects a missing context", async () => {
    const core = new RecordingCore();
    const consent = new RecordingConsent();
    const router = new BackgroundMessageRouter(core, consent);
    const readyMessage = {
      kind: QB_QUIZ_BOOTSTRAP_READY_MESSAGE_KIND,
      page_session_id: PAGE_SESSION_ID,
    } as const;

    expect(await router.handleMessage(readyMessage, CONTENT_SENDER)).toEqual({
      ok: true,
      code: "consent_ready_registered",
    });
    expect(consent.readyCalls).toEqual([{
      page_session_id: PAGE_SESSION_ID,
      sender: CONSENT_CONTEXT,
    }]);
    expect(await router.handleMessage(readyMessage, {
      consent_context: null,
      extension_page: false,
    })).toEqual({ ok: false, code: "consent_ready_rejected" });
    expect(core.messages).toEqual([]);
  });

  it.each([
    [null, { state: "unavailable", page_session_id: null }],
    [
      tabStatus("undecided", "not_started"),
      { state: "pending", page_session_id: PAGE_SESSION_ID },
    ],
    [
      tabStatus("declined", "not_started"),
      { state: "declined", page_session_id: PAGE_SESSION_ID },
    ],
    [
      tabStatus("consented", "starting"),
      { state: "pending", page_session_id: PAGE_SESSION_ID },
    ],
    [
      tabStatus("consented", "observing"),
      { state: "capturing", page_session_id: PAGE_SESSION_ID },
    ],
  ] as const)("maps coordinator status for the popup", async (status, expected) => {
    const core = new RecordingCore();
    const consent = new RecordingConsent();
    consent.tabStatus = status;
    const router = new BackgroundMessageRouter(core, consent);

    expect(await router.handleMessage({
      kind: GET_TAB_CONSENT_STATUS_MESSAGE_KIND,
      tab_id: 7,
    }, POPUP_SENDER)).toEqual(expected);
    expect(core.messages).toEqual([]);
  });

  it("routes explicit start and decline decisions only from an extension page", async () => {
    const core = new RecordingCore();
    const consent = new RecordingConsent();
    const router = new BackgroundMessageRouter(core, consent);

    expect(await router.handleMessage({
      kind: SET_TAB_CONSENT_MESSAGE_KIND,
      tab_id: 7,
      page_session_id: PAGE_SESSION_ID,
      decision: "decline",
    }, POPUP_SENDER)).toEqual({ ok: true, code: "consent_declined" });
    expect(await router.handleMessage({
      kind: SET_TAB_CONSENT_MESSAGE_KIND,
      tab_id: 7,
      page_session_id: PAGE_SESSION_ID,
      decision: "start",
    }, POPUP_SENDER)).toEqual({ ok: true, code: "consent_capture_started" });
    expect(consent.declineCalls).toEqual([{
      tabId: 7,
      pageSessionId: PAGE_SESSION_ID,
    }]);
    expect(consent.startCalls).toEqual([{
      tabId: 7,
      pageSessionId: PAGE_SESSION_ID,
    }]);

    expect(await router.handleMessage({
      kind: SET_TAB_CONSENT_MESSAGE_KIND,
      tab_id: 7,
      page_session_id: PAGE_SESSION_ID,
      decision: "start",
    }, CONTENT_SENDER)).toEqual({ ok: false, code: "popup_sender_rejected" });
    expect(consent.startCalls).toHaveLength(1);
    expect(core.messages).toEqual([]);
  });

  it("keeps popup record status unavailable to content senders", async () => {
    const core = new RecordingCore();
    const consent = new RecordingConsent();
    const router = new BackgroundMessageRouter(core, consent);

    expect(await router.handleMessage({
      kind: GET_POPUP_STATUS_MESSAGE_KIND,
    }, CONTENT_SENDER)).toEqual({
      ok: false,
      code: "popup_sender_rejected",
    });
    expect(core.messages).toEqual([]);
  });
});

describe("BackgroundMessageRouter capture consent boundary", () => {
  it("keeps a pre-consent capture envelope out of the core", async () => {
    const core = new RecordingCore();
    const consent = new RecordingConsent();
    const router = new BackgroundMessageRouter(core, consent);

    expect(await router.handleMessage(
      captureEnvelope(CANDIDATE),
      CONTENT_SENDER,
    )).toEqual({ ok: false, code: "capture_consent_required" });
    expect(consent.senderChecks).toEqual([{
      ...CONSENT_CONTEXT,
      page_session_id: PAGE_SESSION_ID,
    }]);
    expect(core.messages).toEqual([]);
  });

  it("forwards candidate and status only for the consented document and session", async () => {
    const core = new RecordingCore();
    const consent = new RecordingConsent();
    consent.authorizeSender = true;
    const router = new BackgroundMessageRouter(core, consent);

    expect(await router.handleMessage(
      captureEnvelope(CANDIDATE),
      CONTENT_SENDER,
    )).toEqual({ ok: true, code: "core_message_accepted" });
    expect(await router.handleMessage(
      captureEnvelope(CAPTURE_STATUS),
      CONTENT_SENDER,
    )).toEqual({ ok: true, code: "core_message_accepted" });
    expect(core.messages).toEqual([CANDIDATE, CAPTURE_STATUS]);

    expect(await router.handleMessage(
      captureEnvelope(CANDIDATE, OTHER_PAGE_SESSION_ID),
      CONTENT_SENDER,
    )).toEqual({ ok: false, code: "capture_consent_required" });
    expect(await router.handleMessage(
      captureEnvelope(CANDIDATE),
      {
        ...CONTENT_SENDER,
        consent_context: {
          ...CONSENT_CONTEXT,
          document_id: "other-document",
        },
      },
    )).toEqual({ ok: false, code: "capture_consent_required" });
    expect(core.messages).toHaveLength(2);
  });

  it("rejects unwrapped candidate and status messages", async () => {
    const core = new RecordingCore();
    const consent = new RecordingConsent();
    consent.authorizeSender = true;
    const router = new BackgroundMessageRouter(core, consent);

    expect(await router.handleMessage(CANDIDATE, CONTENT_SENDER)).toEqual({
      ok: false,
      code: "capture_consent_required",
    });
    expect(await router.handleMessage(CAPTURE_STATUS, CONTENT_SENDER)).toEqual({
      ok: false,
      code: "capture_consent_required",
    });
    expect(consent.senderChecks).toEqual([]);
    expect(core.messages).toEqual([]);
  });
});

class MemoryStorage implements BackgroundStoragePort {
  public value: unknown;

  public async read(): Promise<unknown> {
    return structuredClone(this.value);
  }

  public async write(state: BackgroundStateV1): Promise<void> {
    this.value = structuredClone(state);
  }

  public snapshot(): BackgroundStateV1 {
    if (!isBackgroundStateV1(this.value)) {
      throw new TypeError("invalid background state");
    }
    return this.value;
  }
}

describe("BackgroundMessageRouter with BackgroundCore", () => {
  it("leaves outbox and transport untouched for a pre-consent candidate", async () => {
    const storage = new MemoryStorage();
    let transportCalls = 0;
    const transport: CollectorTransportPort = {
      postAttempt: () => {
        transportCalls += 1;
        return Promise.resolve({ status: 200, body: null });
      },
    };
    const ports: BackgroundPorts = {
      storage,
      clock: { now: () => Date.parse("2026-08-26T03:05:00.000Z") },
      scheduler: {
        schedule: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
      transport,
    };
    const core = new BackgroundCore(ports);
    expect(await core.initialize()).toEqual({ ok: true, code: "background_initialized" });
    const consent = new RecordingConsent();
    const router = new BackgroundMessageRouter(core, consent);

    expect(await router.handleMessage(
      captureEnvelope(CANDIDATE),
      CONTENT_SENDER,
    )).toEqual({ ok: false, code: "capture_consent_required" });
    expect(storage.snapshot().outbox).toEqual([]);
    expect(storage.snapshot().delivered_events).toEqual([]);
    expect(transportCalls).toBe(0);
  });

  it("keeps an unselected resolved transition out of outbox and HTTP", async () => {
    const storage = new MemoryStorage();
    let transportCalls = 0;
    const core = new BackgroundCore({
      storage,
      clock: { now: () => Date.parse("2026-08-26T03:05:00.000Z") },
      scheduler: {
        schedule: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
      transport: {
        postAttempt: () => {
          transportCalls += 1;
          return Promise.resolve({ status: 200, body: null });
        },
      },
    });
    await core.initialize();
    const consent = new RecordingConsent();
    consent.authorizeSender = true;
    const router = new BackgroundMessageRouter(core, consent);
    const routedMessages: unknown[] = [];
    const routedOperations: Promise<unknown>[] = [];
    const createEventId = vi.fn(() => EVENT_ID);
    const now = vi.fn(() => new Date("2026-08-26T03:04:05.006Z"));
    const document = fixtureDocument("qb-quiz-pending.html");

    const handle = startContentScript({
      document,
      MutationObserver: ManualMutationObserver,
      controller: new CaptureController(new QbQuizAttemptAdapter(), {
        createEventId,
        now,
      }),
      sendMessage: (message) => {
        routedMessages.push(message);
        const operation = router.handleMessage(
          captureEnvelope(message),
          CONTENT_SENDER,
        );
        routedOperations.push(operation);
        return operation;
      },
    });
    await Promise.all(routedOperations);

    const noSelection = fixtureDocument("qb-quiz-resolved-without-selection.html");
    document.documentElement.innerHTML = noSelection.documentElement.innerHTML;
    const observer = ManualMutationObserver.latest;
    if (observer === undefined) {
      throw new TypeError("manual observer was not installed");
    }
    observer.trigger();
    observer.trigger();
    await Promise.all(routedOperations);
    await core.processDueOutbox();

    expect(routedMessages).toEqual([CAPTURE_STATUS]);
    expect(createEventId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(storage.snapshot().outbox).toEqual([]);
    expect(storage.snapshot().delivered_events).toEqual([]);
    expect(transportCalls).toBe(0);
    handle.disconnect();
  });
});


describe("trusted purpose routing", () => {
  it("accepts the explicit purpose only from popup and derives every answer from the authorized session", async () => {
    const consent = new RecordingConsent();
    const core = new RecordingCore();
    const router = new BackgroundMessageRouter(core, consent);
    const start = vi.spyOn(consent, "startCapture");
    const command = { kind: START_STUDY_CAPTURE_MESSAGE_KIND, tab_id: 7,
      page_session_id: PAGE_SESSION_ID, study_mode: "review" };
    expect(await router.handleMessage(command, CONTENT_SENDER))
      .toEqual({ ok: false, code: "popup_sender_rejected" });
    expect(start).not.toHaveBeenCalled();
    await router.handleMessage(command, POPUP_SENDER);
    expect(start).toHaveBeenCalledWith(7, PAGE_SESSION_ID, "review");
    vi.spyOn(consent, "getSenderStudyMode").mockResolvedValue("review");
    await router.handleMessage(captureEnvelope(CANDIDATE), CONTENT_SENDER);
    expect(core.modes).toEqual(["review"]);
    await router.handleMessage({ kind: QB_QUIZ_CAPTURE_MESSAGE_KIND,
      page_session_id: PAGE_SESSION_ID, message: { ...CANDIDATE, study_mode: "normal" } }, CONTENT_SENDER);
    expect(core.messages).toHaveLength(1);
  });
});

describe("automatic capture context routing", () => {
  it("forwards verified plan evidence from the session, never from a page payload", async () => {
    const core = { handleMessage: vi.fn(async () => ({ ok: true, code: "candidate_enqueued" })) };
    const consent = new RecordingConsent();
    const planId = "30000000-0000-4000-8000-000000000001";
    const getSenderStudyContext = vi.fn(async () => ({ study_mode: "review" as const, review_plan_id: planId }));
    const port: ConsentRouterPort = Object.assign(consent, { getSenderStudyContext });
    const router = new BackgroundMessageRouter(core, port);
    await router.handleMessage(captureEnvelope(CANDIDATE), CONTENT_SENDER);
    expect(core.handleMessage).toHaveBeenCalledWith(CANDIDATE, "review", planId);
    await router.handleMessage({ ...captureEnvelope(CANDIDATE) as object, review_plan_id: planId }, CONTENT_SENDER);
    expect(core.handleMessage).toHaveBeenCalledTimes(1);
  });

  it("allows stop only from the extension popup and relays only route context from content", async () => {
    const core = new RecordingCore();
    const consent = new RecordingConsent();
    const stopCapture = vi.fn(async () => response(true, "consent_capture_stopped"));
    const handlePageRoute = vi.fn(async () => ({ ok: true as const, code: "study_route_registered" }));
    const router = new BackgroundMessageRouter(core, Object.assign(consent, { stopCapture, handlePageRoute }));
    const stop = { kind: "stop_tab_capture_v1", tab_id: 7, page_session_id: PAGE_SESSION_ID };
    expect(await router.handleMessage(stop, CONTENT_SENDER)).toEqual({ ok: false, code: "popup_sender_rejected" });
    expect(stopCapture).not.toHaveBeenCalled();
    await router.handleMessage(stop, POPUP_SENDER);
    expect(stopCapture).toHaveBeenCalledWith(7, PAGE_SESSION_ID);
    await router.handleMessage({ kind: "qb_page_route_v1", context_lost: true }, CONTENT_SENDER);
    expect(handlePageRoute).toHaveBeenCalledWith(CONSENT_CONTEXT, true, { kind: "qb_page_route_v1", context_lost: true });
    await router.handleMessage({ kind: "qb_page_route_v1", question_set_id: "forged" }, CONTENT_SENDER);
    expect(handlePageRoute).toHaveBeenCalledTimes(1);
    const evidence = { kind: "qb_page_route_v1", first_document_navigation: "navigate", referrer_set_id: "saved-set" };
    await router.handleMessage(evidence, CONTENT_SENDER);
    expect(handlePageRoute).toHaveBeenLastCalledWith(CONSENT_CONTEXT, undefined, evidence);
    await router.handleMessage({ ...evidence, first_document_navigation: "forged" }, CONTENT_SENDER);
    expect(handlePageRoute).toHaveBeenCalledTimes(2);
  });
});

it("binds answer candidates on arrival while requiring current context for status updates", async () => {
  const core = new RecordingCore();
  const consent = new RecordingConsent();
  const getAcceptedCandidateContext = vi.fn(async () => ({ study_mode: "review" as const }));
  const getSenderStudyContext = vi.fn(async () => null);
  const router = new BackgroundMessageRouter(core, Object.assign(consent, {
    getAcceptedCandidateContext, getSenderStudyContext,
  }));
  await router.handleMessage(captureEnvelope(CANDIDATE), CONTENT_SENDER);
  expect(getAcceptedCandidateContext).toHaveBeenCalledTimes(1);
  expect(core.messages).toEqual([CANDIDATE]);
  expect(await router.handleMessage(captureEnvelope(CAPTURE_STATUS), CONTENT_SENDER))
    .toEqual({ ok: false, code: "capture_consent_required" });
  expect(getSenderStudyContext).toHaveBeenCalledTimes(1);
  expect(core.messages).toEqual([CANDIDATE]);
});


describe("manual study-mode routing", () => {
  it("accepts bounded choices only from the extension popup", async () => {
    const consent = new RecordingConsent();
    const setStudyMode = vi.fn(async () => response(true, "study_mode_changed"));
    const core = new RecordingCore();
    const router = new BackgroundMessageRouter(core, Object.assign(consent, { setStudyMode }));
    const command = { kind: SET_STUDY_MODE_MESSAGE_KIND, tab_id: 7,
      page_session_id: PAGE_SESSION_ID, study_mode: "normal" };
    expect(await router.handleMessage(command, CONTENT_SENDER)).toEqual({ ok: false, code: "popup_sender_rejected" });
    expect(setStudyMode).not.toHaveBeenCalled();
    expect(await router.handleMessage(command, POPUP_SENDER)).toEqual({ ok: true, code: "study_mode_changed" });
    expect(setStudyMode).toHaveBeenCalledWith(7, PAGE_SESSION_ID, "normal");
    for (const invalid of [ { ...command, study_mode: "unclassified" }, { ...command, tab_id: -1 },
      { ...command, page_session_id: "stale" }, { ...command, review_plan_id: PAGE_SESSION_ID } ]) {
      expect(isPopupRequestMessageV1(invalid)).toBe(false);
    }
    expect(core.messages).toHaveLength(0);
  });
});
