import { readFileSync } from "fs";

import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { CaptureController } from "../src/capture-controller.js";
import {
  QB_QUIZ_DOM_CONTRACT,
  QbQuizAttemptAdapter,
  SyntheticFixtureAttemptAdapter,
} from "../src/adapters/index.js";
import {
  startContentScript,
  startQbQuizBootstrap,
  type StartContentScriptOptions,
  type StartQbQuizBootstrapOptions,
} from "../src/content-script.js";
import type {
  AttemptCandidateMessageV1,
  CaptureStatusMessageV1,
} from "../src/shared/protocol.js";

type ContentScriptMessage = AttemptCandidateMessageV1 | CaptureStatusMessageV1;

function fixtureDocument(name: string, url?: string): Document {
  const html = readFileSync(
    new URL(`../../../tests/fixtures/browser-extension/${name}`, import.meta.url),
    "utf8",
  );
  const window = new Window(url === undefined ? undefined : { url });
  window.document.write(html);
  return window.document as unknown as Document;
}

class ManualMutationObserver {
  static latest: ManualMutationObserver | undefined;

  readonly #callback: () => void;
  public observedOptions: MutationObserverInit | undefined;
  public disconnected = false;

  public constructor(callback: () => void) {
    this.#callback = callback;
    ManualMutationObserver.latest = this;
  }

  public observe(_target: Node, options?: MutationObserverInit): void {
    this.observedOptions = options;
  }

  public disconnect(): void {
    this.disconnected = true;
  }

  public trigger(): void {
    this.#callback();
  }
}

function fixedController(): CaptureController {
  return new CaptureController(new SyntheticFixtureAttemptAdapter(), {
    createEventId: () => "10000000-0000-4000-8000-000000000001",
    now: () => new Date("2026-08-25T03:04:05.006Z"),
  });
}

describe("content script", () => {
  it("observes read-only DOM transitions and does not duplicate a redraw", () => {
    const document = fixtureDocument("pending.html");
    const beforeStart = document.documentElement.outerHTML;
    const messages: ContentScriptMessage[] = [];

    const handle = startContentScript({
      document,
      MutationObserver: ManualMutationObserver,
      sendMessage: (message) => {
        messages.push(message);
        return message.kind === "attempt_candidate_v1"
          ? { ok: true, code: "candidate_enqueued" }
          : { ok: true, code: message.code };
      },
      controller: fixedController(),
    } satisfies StartContentScriptOptions);

    expect(document.documentElement.outerHTML).toBe(beforeStart);
    expect(messages).toEqual([
      {
        kind: "capture_status_v1",
        state: "observing",
        code: "capture_observing",
      },
    ]);

    const resolved = fixtureDocument("correct.html");
    document.documentElement.innerHTML = resolved.documentElement.innerHTML;
    const observer = ManualMutationObserver.latest;
    if (observer === undefined) {
      throw new TypeError("manual observer was not installed");
    }
    observer.trigger();
    observer.trigger();

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      kind: "attempt_candidate_v1",
      event_id: "10000000-0000-4000-8000-000000000001",
      question_key: "119A12",
      answered_at: "2026-08-25T03:04:05.006Z",
      result: "correct",
      selected_option_indices: [1, 3],
    });
    expect(observer.observedOptions).toMatchObject({
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    handle.disconnect();
    expect(observer.disconnected).toBe(true);
  });

  it("never sends a candidate for no-selection, then captures the next question once", () => {
    const qbUrl = "https://qb.medilink-study.com/quiz";
    const document = fixtureDocument("qb-quiz-pending.html", qbUrl);
    const messages: ContentScriptMessage[] = [];
    const scheduleRetry = vi.fn();
    const controller = new CaptureController(new QbQuizAttemptAdapter(), {
      createEventId: () => "10000000-0000-4000-8000-000000000001",
      now: () => new Date("2026-08-25T03:04:05.006Z"),
    });
    const handle = startContentScript({
      document,
      MutationObserver: ManualMutationObserver,
      controller,
      sendMessage: (message) => {
        messages.push(message);
        return message.kind === "attempt_candidate_v1"
          ? { ok: true, code: "candidate_enqueued" }
          : { ok: true, code: message.code };
      },
      scheduleRetry,
    });
    const observer = ManualMutationObserver.latest;
    if (observer === undefined) {
      throw new TypeError("manual observer was not installed");
    }

    const noSelection = fixtureDocument(
      "qb-quiz-resolved-without-selection.html",
      qbUrl,
    );
    document.documentElement.innerHTML = noSelection.documentElement.innerHTML;
    observer.trigger();
    observer.trigger();
    expect(messages.filter(({ kind }) => kind === "attempt_candidate_v1")).toEqual([]);
    expect(scheduleRetry).not.toHaveBeenCalled();

    const nextPending = fixtureDocument("qb-quiz-next-pending.html", qbUrl);
    document.documentElement.innerHTML = nextPending.documentElement.innerHTML;
    observer.trigger();
    const nextCorrect = fixtureDocument("qb-quiz-next-correct.html", qbUrl);
    document.documentElement.innerHTML = nextCorrect.documentElement.innerHTML;
    observer.trigger();
    observer.trigger();

    expect(messages.filter(({ kind }) => kind === "attempt_candidate_v1")).toEqual([{
      kind: "attempt_candidate_v1",
      event_id: "10000000-0000-4000-8000-000000000001",
      question_key: "119A13",
      answered_at: "2026-08-25T03:04:05.006Z",
      result: "correct",
      selected_option_indices: [4],
    }]);
    handle.disconnect();
  });

  it("captures a reviewed two-digit legacy QB result with a canonical key", () => {
    const qbUrl = "https://qb.medilink-study.com/quiz";
    const document = fixtureDocument("qb-quiz-pending.html", qbUrl);
    const questionKey = document.querySelector("span.font-semibold.text-qb-blue");
    if (questionKey === null) {
      throw new TypeError("question key fixture element missing");
    }
    questionKey.textContent = "80A1";
    const messages: ContentScriptMessage[] = [];
    const controller = new CaptureController(new QbQuizAttemptAdapter(), {
      createEventId: () => "10000000-0000-4000-8000-000000000080",
      now: () => new Date("2026-08-27T02:00:00.000Z"),
    });
    const handle = startContentScript({
      document,
      MutationObserver: ManualMutationObserver,
      controller,
      sendMessage: (message) => {
        messages.push(message);
        return message.kind === "attempt_candidate_v1"
          ? { ok: true, code: "candidate_enqueued" }
          : { ok: true, code: message.code };
      },
    });
    const observer = ManualMutationObserver.latest;
    if (observer === undefined) {
      throw new TypeError("manual observer was not installed");
    }

    const resolved = fixtureDocument("qb-quiz-legacy-result.html", qbUrl);
    const resolvedQuestionKey = resolved.querySelector(
      QB_QUIZ_DOM_CONTRACT.selectors.questionKey,
    );
    const resolvedStatus = resolved.querySelectorAll(
      QB_QUIZ_DOM_CONTRACT.selectors.legacyResultCell,
    ).item(3);
    if (resolvedQuestionKey === null || resolvedStatus === null) {
      throw new TypeError("legacy result fixture element missing");
    }
    resolvedQuestionKey.textContent = "80A1";
    const functionalRoot = resolved.querySelectorAll(
      QB_QUIZ_DOM_CONTRACT.selectors.quizRoot,
    ).item(1);
    if (functionalRoot === null) {
      throw new TypeError("functional quiz root fixture element missing");
    }
    const firstMarker = resolved.createElement("div");
    firstMarker.setAttribute("data-testid", "explanation-box-title");
    const secondMarker = resolved.createElement("div");
    secondMarker.setAttribute("data-testid", "explanation-box-title");
    functionalRoot.append(firstMarker, secondMarker);
    document.documentElement.innerHTML = resolved.documentElement.innerHTML;
    observer.trigger();
    expect(messages.filter(({ kind }) => kind === "attempt_candidate_v1")).toEqual([]);

    const mountedStatus = document.querySelectorAll(
      QB_QUIZ_DOM_CONTRACT.selectors.legacyResultCell,
    ).item(3);
    if (mountedStatus === null) {
      throw new TypeError("mounted legacy result status fixture element missing");
    }
    mountedStatus.textContent = "不正解";
    observer.trigger();
    observer.trigger();

    expect(messages.filter(({ kind }) => kind === "attempt_candidate_v1")).toEqual([{
      kind: "attempt_candidate_v1",
      event_id: "10000000-0000-4000-8000-000000000080",
      question_key: "080A1",
      answered_at: "2026-08-27T02:00:00.000Z",
      result: "incorrect",
      selected_option_indices: [1],
    }]);
    handle.disconnect();
  });

  it("uses an always-Unsupported adapter in the packaged default path", () => {
    const document = fixtureDocument("correct.html");
    const messages: ContentScriptMessage[] = [];

    const handle = startContentScript({
      document,
      MutationObserver: ManualMutationObserver,
      sendMessage: (message) => {
        messages.push(message);
        return { ok: true, code: "capture_unsupported_dom" };
      },
    });

    const observer = ManualMutationObserver.latest;
    if (observer === undefined) {
      throw new TypeError("manual observer was not installed");
    }
    observer.trigger();

    expect(messages).toEqual([{
      kind: "capture_status_v1",
      state: "unsupported",
      code: "capture_unsupported_dom:production_adapter_unavailable",
    }]);
    expect(observer.observedOptions?.attributeFilter).toEqual([]);
    handle.disconnect();
  });

  it("retains and resends the same candidate until background persistence is acknowledged", async () => {
    const document = fixtureDocument("pending.html");
    const messages: ContentScriptMessage[] = [];
    const retries: Array<{
      readonly callback: () => void;
      readonly delayMilliseconds: number;
    }> = [];
    let candidateAttempts = 0;

    const handle = startContentScript({
      document,
      MutationObserver: ManualMutationObserver,
      controller: fixedController(),
      sendMessage: (message) => {
        messages.push(message);
        if (message.kind !== "attempt_candidate_v1") {
          return { ok: true, code: message.code };
        }
        candidateAttempts += 1;
        if (candidateAttempts === 1) {
          return Promise.reject(new Error("worker unavailable"));
        }
        if (candidateAttempts === 2) {
          return { ok: false, code: "storage_write_blocked" };
        }
        return { ok: true, code: "candidate_duplicate" };
      },
      scheduleRetry: (callback, delayMilliseconds) => {
        retries.push({ callback, delayMilliseconds });
        return retries.length;
      },
      cancelRetry: () => undefined,
    });

    const resolved = fixtureDocument("correct.html");
    document.documentElement.innerHTML = resolved.documentElement.innerHTML;
    const observer = ManualMutationObserver.latest;
    if (observer === undefined) {
      throw new TypeError("manual observer was not installed");
    }
    observer.trigger();
    await Promise.resolve();
    await Promise.resolve();

    expect(retries).toHaveLength(1);
    expect(retries[0]?.delayMilliseconds).toBe(1_000);
    retries.shift()?.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(retries).toHaveLength(1);
    retries.shift()?.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(retries).toHaveLength(0);
    const candidateMessages = messages.filter(
      (message): message is AttemptCandidateMessageV1 => (
        message.kind === "attempt_candidate_v1"
      ),
    );
    expect(candidateMessages).toHaveLength(3);
    expect(candidateMessages[1]).toEqual(candidateMessages[0]);
    expect(candidateMessages[2]).toEqual(candidateMessages[0]);
    handle.disconnect();
  });
});

class ManualRouteEvents {
  readonly listeners = new Map<string, Set<() => void>>();

  public addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

type BootstrapMessage = Parameters<StartQbQuizBootstrapOptions["runtime"]["sendMessage"]>[0];
type BootstrapListener = Parameters<
  StartQbQuizBootstrapOptions["runtime"]["onMessage"]["addListener"]
>[0];

async function flushMessages(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function bootstrapHarness(options: {
  readonly pathname?: string;
  readonly onSend?: (message: BootstrapMessage, defaultResponse: unknown) => unknown;
  readonly navigationAvailable?: boolean;
  readonly autoStart?: boolean;
  readonly navigationEntries?: readonly unknown[];
  readonly navigationReadThrows?: boolean;
  readonly referrer?: string;
} = {}) {
  const document = fixtureDocument("pending.html");
  if (options.referrer !== undefined) {
    Object.defineProperty(document, "referrer", { value: options.referrer, configurable: true });
  }
  const getEntriesByType = vi.fn(() => {
    if (options.navigationReadThrows === true) throw new Error("navigation metadata unavailable");
    return options.navigationEntries ?? [];
  });
  const location = {
    origin: "https://qb.medilink-study.com",
    pathname: options.pathname ?? "/quiz",
    search: "", hash: "",
  };
  const navigation = new ManualRouteEvents();
  const windowEvents = new ManualRouteEvents();
  const retries: Array<{ callback: () => void; delay: number }> = [];
  const canceled: unknown[] = [];
  const sent: BootstrapMessage[] = [];
  let listener: BootstrapListener | undefined;
  let nextSession = 0;
  let nextEvent = 0;
  let locationCheck: (() => void) | undefined;
  const cancelLocationCheck = vi.fn();
  const createController = vi.fn(() => new CaptureController(
    new SyntheticFixtureAttemptAdapter(), {
      createEventId: () => `20000000-0000-4000-8000-${String(++nextEvent).padStart(12, "0")}`,
      now: () => new Date("2026-08-25T03:04:05.006Z"),
    },
  ));
  ManualMutationObserver.latest = undefined;
  const handle = startQbQuizBootstrap({
    document, location, MutationObserver: ManualMutationObserver,
    ...(options.navigationAvailable === false ? {} : { navigation }),
    windowEvents,
    performance: { getEntriesByType },
    createController,
    createPageSessionId: () => `10000000-0000-4000-8000-${String(++nextSession).padStart(12, "0")}`,
    runtime: {
      sendMessage: (message) => {
        sent.push(message);
        const defaultResponse = message.kind === "qb_page_route_v1"
          ? { ok: true, code: "study_route_registered" }
          : message.kind === "qb_quiz_bootstrap_ready_v1"
            ? { ok: true, code: "consent_capture_started" }
            : { ok: true, code: "candidate_enqueued" };
        if (message.kind === "qb_quiz_bootstrap_ready_v1" && options.autoStart === true) {
          listener?.({ kind: "start_capture_v1", page_session_id: message.page_session_id }, {}, () => undefined);
        }
        return options.onSend === undefined
          ? defaultResponse : options.onSend(message, defaultResponse);
      },
      onMessage: {
        addListener: (nextListener) => { listener = nextListener; },
        removeListener: () => { listener = undefined; },
      },
    },
    scheduleReadyRetry: (callback, delay) => {
      const entry = { callback, delay };
      retries.push(entry);
      return entry;
    },
    cancelReadyRetry: (timer) => { canceled.push(timer); },
    scheduleLocationCheck: (callback) => { locationCheck = callback; return "location-check"; },
    cancelLocationCheck,
  });
  const command = (kind: string, pageSessionId = handle.pageSessionId): unknown => {
    let response: unknown;
    listener?.({ kind, page_session_id: pageSessionId }, {}, (value) => { response = value; });
    return response;
  };
  return {
    handle, sent, document, location, navigation, windowEvents,
    retries, canceled, createController, command, cancelLocationCheck, getEntriesByType,
    pollLocation: () => locationCheck?.(),
    probeRoute: (url: string): unknown => {
      let response: unknown;
      listener?.({ kind: "qb_page_route_probe_v1", expected_url: url }, {}, (value) => { response = value; });
      return response;
    },
    move: (pathname: string, search = "") => {
      location.pathname = pathname;
      location.search = search;
      navigation.emit("currententrychange");
    },
    render: (fixture: string, questionKey?: string) => {
      document.documentElement.innerHTML = fixtureDocument(fixture).documentElement.innerHTML;
      if (questionKey !== undefined) {
        document.querySelector('[data-qb-study-field="question-key"]')
          ?.setAttribute("data-qb-study-value", questionKey);
      }
      ManualMutationObserver.latest?.trigger();
    },
    candidates: () => sent.filter((message) => message.kind === "qb_quiz_capture_message_v1"
      && message.message.kind === "attempt_candidate_v1"),
  };
}

describe("QB SPA bootstrap", () => {
  it.each([
    ["navigate", "navigate"], ["reload", "reload"], ["back_forward", "back_forward"],
    ["prerender", "unknown"], [undefined, "unknown"],
  ] as const)("normalizes initial navigation type %s without reading any timing or URL fields", (type, expected) => {
    const entry = {
      type,
      get name(): never { throw new Error("the navigation URL must not be read"); },
      get startTime(): never { throw new Error("navigation timing must not be read"); },
    };
    const harness = bootstrapHarness({ navigationEntries: [entry] });
    expect(harness.sent[0]).toEqual({ kind: "qb_page_route_v1", route: expect.any(Object), first_document_navigation: expected });
    expect(harness.getEntriesByType).toHaveBeenCalledExactlyOnceWith("navigation");
    harness.handle.disconnect();
  });

  it.each([
    { navigationEntries: [] },
    { navigationEntries: [{ type: "reload" }, { type: "reload" }] },
    { navigationReadThrows: true },
  ])("does not infer a reload from missing or ambiguous navigation evidence: %j", (options) => {
    const harness = bootstrapHarness(options);
    expect(harness.sent[0]).toEqual({ kind: "qb_page_route_v1", route: expect.any(Object), first_document_navigation: "unknown" });
    harness.handle.disconnect();
  });

  it("sends the same initial browser evidence on retry, then never reuses it for SPA routes or BFCache restore", async () => {
    let fail = true;
    const harness = bootstrapHarness({
      navigationEntries: [{ type: "reload" }],
      referrer: "https://qb.medilink-study.com/search?questionSetId=known_Set-123&operation=OR#unused",
      onSend: (message, response) => message.kind === "qb_page_route_v1" && fail
        ? { ok: false, code: "study_route_unavailable" } : response,
    });
    await flushMessages();
    expect(harness.sent[0]).toEqual({ kind: "qb_page_route_v1",
      route: expect.any(Object), first_document_navigation: "reload", referrer_set_id: "known_Set-123" });
    fail = false;
    harness.retries.shift()?.callback();
    await flushMessages();
    expect(harness.sent[1]).toEqual(harness.sent[0]);
    harness.move("/quiz", "?question_id=second");
    await flushMessages();
    harness.move("/search", "?questionSetId=different");
    await flushMessages();
    harness.move("/quiz", "?question_id=third");
    await flushMessages();
    harness.windowEvents.emit("pagehide");
    harness.windowEvents.emit("pageshow");
    await flushMessages();
    const subsequentRoutes = harness.sent.slice(2).filter(({ kind }) => kind === "qb_page_route_v1");
    expect(subsequentRoutes).toHaveLength(4);
    for (const message of subsequentRoutes) {
      expect(message).not.toHaveProperty("first_document_navigation");
      expect(message).not.toHaveProperty("referrer_set_id");
    }
    expect(harness.getEntriesByType).toHaveBeenCalledExactlyOnceWith("navigation");
    harness.handle.disconnect();
  });

  it.each([
    "", "not a URL", "https://example.invalid/search?questionSetId=known",
    "http://qb.medilink-study.com/search?questionSetId=known",
    "https://qb.medilink-study.com/search/?questionSetId=known",
    "https://qb.medilink-study.com/quiz?questionSetId=known",
    "https://qb.medilink-study.com/search?questionSetId=known&questionSetId=known",
    "https://qb.medilink-study.com/search?questionSetId=",
    "https://qb.medilink-study.com/search?questionSetId=bad%2Fid",
    `https://qb.medilink-study.com/search?questionSetId=${"a".repeat(101)}`,
    "https://ignored@qb.medilink-study.com/search?questionSetId=known",
    "https://qb.medilink-study.com/search?name=known",
  ])("does not send a set ID from an unqualified referrer: %s", (referrer) => {
    const harness = bootstrapHarness({ navigationEntries: [{ type: "navigate" }], referrer });
    expect(harness.sent[0]).toEqual({ kind: "qb_page_route_v1", route: expect.any(Object), first_document_navigation: "navigate" });
    harness.handle.disconnect();
  });

  it("registers the route before READY and stays DOM-inactive until matching START", async () => {
    let resolveRoute: ((response: unknown) => void) | undefined;
    const harness = bootstrapHarness({
      onSend: (message, response) => message.kind === "qb_page_route_v1"
        ? new Promise((resolve) => { resolveRoute = resolve; }) : response,
    });
    expect(harness.sent).toEqual([{ kind: "qb_page_route_v1", route: expect.any(Object), first_document_navigation: "unknown" }]);
    expect(harness.createController).not.toHaveBeenCalled();
    expect(ManualMutationObserver.latest).toBeUndefined();
    expect(harness.command("qb_quiz_consent_probe_v1")).toEqual({ ok: false, code: "consent_document_unavailable" });
    expect(harness.command("start_capture_v1")).toEqual({ ok: false, code: "capture_start_location_blocked" });
    resolveRoute?.({ ok: true, code: "study_route_registered" });
    await flushMessages();
    expect(harness.sent[1]).toEqual({ kind: "qb_quiz_bootstrap_ready_v1", page_session_id: harness.handle.pageSessionId });
    expect(harness.command("qb_quiz_consent_probe_v1")).toEqual({ ok: true, code: "consent_document_present" });
    expect(harness.command("start_capture_v1", "10000000-0000-4000-8000-000000000099")).toBeUndefined();
    expect(harness.command("start_capture_v1")).toEqual({ ok: true, code: "capture_started" });
    expect(harness.command("start_capture_v1")).toEqual({ ok: true, code: "capture_already_started" });
    expect(harness.createController).toHaveBeenCalledOnce();
    harness.handle.disconnect();
  });

  it("answers exact route probes outside quiz and before READY without inspecting DOM", async () => {
    const harness = bootstrapHarness({ pathname: "/search", onSend: () => new Promise(() => undefined) });
    const initialMessages = harness.sent.length;
    expect(harness.probeRoute("https://qb.medilink-study.com/search"))
      .toEqual({ ok: true, code: "study_route_current" });
    expect(harness.probeRoute("https://qb.medilink-study.com/search?questionSetId=old"))
      .toEqual({ ok: false, code: "study_route_unavailable" });
    expect(harness.sent).toHaveLength(initialMessages);
    expect(harness.createController).not.toHaveBeenCalled();
    expect(ManualMutationObserver.latest).toBeUndefined();
    harness.move("/quiz", "?question_id=new");
    await flushMessages();
    expect(harness.probeRoute("https://qb.medilink-study.com/search"))
      .toEqual({ ok: false, code: "study_route_unavailable" });
    expect(harness.probeRoute("https://qb.medilink-study.com/quiz?question_id=new"))
      .toEqual({ ok: true, code: "study_route_current" });
    expect(harness.command("qb_quiz_consent_probe_v1"))
      .toEqual({ ok: false, code: "consent_document_unavailable" });
    expect(harness.createController).not.toHaveBeenCalled();
    harness.handle.disconnect();
    expect(harness.probeRoute("https://qb.medilink-study.com/quiz?question_id=new")).toBeUndefined();
  });

  it("bootstraps search-to-quiz without reload and keeps one controller across question URLs", async () => {
    const harness = bootstrapHarness({ pathname: "/search", autoStart: true });
    await flushMessages();
    expect(harness.handle.pageSessionId).toBeNull();
    expect(harness.sent).toEqual([{ kind: "qb_page_route_v1", route: expect.any(Object), first_document_navigation: "unknown" }]);
    expect(harness.createController).not.toHaveBeenCalled();
    expect(ManualMutationObserver.latest).toBeUndefined();
    harness.move("/quiz", "?question_id=first");
    await flushMessages();
    const firstSession = harness.handle.pageSessionId;
    harness.render("correct.html");
    expect(harness.candidates()).toHaveLength(1);
    harness.move("/quiz", "?question_id=second");
    await flushMessages();
    harness.navigation.emit("currententrychange");
    await flushMessages();
    harness.render("pending.html");
    harness.render("correct.html");
    expect(harness.handle.pageSessionId).toBe(firstSession);
    expect(harness.createController).toHaveBeenCalledOnce();
    expect(harness.candidates()).toHaveLength(1);
    harness.render("pending.html", "119A13");
    harness.render("resolved-other-question.html");
    expect(harness.candidates()).toHaveLength(2);
    harness.handle.disconnect();
  });

  it("stops on exit, rejects delayed START and creates a fresh session on same-URL reentry", async () => {
    const harness = bootstrapHarness({ autoStart: true });
    await flushMessages();
    const firstSession = harness.handle.pageSessionId;
    const oldObserver = ManualMutationObserver.latest;
    harness.render("correct.html");
    harness.move("/search");
    expect(harness.handle.pageSessionId).toBeNull();
    expect(oldObserver?.disconnected).toBe(true);
    harness.render("pending.html");
    harness.render("correct.html");
    oldObserver?.trigger();
    expect(harness.candidates()).toHaveLength(1);
    expect(harness.command("start_capture_v1", firstSession)).toBeUndefined();
    await flushMessages();
    harness.move("/quiz");
    await flushMessages();
    expect(harness.handle.pageSessionId).not.toBe(firstSession);
    expect(harness.createController).toHaveBeenCalledTimes(2);
    // Returning to an already-resolved page is not a new answer.
    expect(harness.candidates()).toHaveLength(1);
    harness.render("pending.html");
    harness.render("correct.html");
    expect(harness.candidates()).toHaveLength(1);
    harness.handle.disconnect();
  });

  it("retires old READY results and retries without settling a later session", async () => {
    let rejectOldReady: ((reason: unknown) => void) | undefined;
    let readyCount = 0;
    const harness = bootstrapHarness({ onSend: (message, response) => {
      if (message.kind !== "qb_quiz_bootstrap_ready_v1") return response;
      readyCount += 1;
      return readyCount === 1 ? new Promise((_resolve, reject) => { rejectOldReady = reject; })
        : { ok: false, code: "background_internal_blocked" };
    } });
    await flushMessages();
    const oldSession = harness.handle.pageSessionId;
    harness.move("/search");
    await flushMessages();
    harness.move("/quiz");
    await flushMessages();
    const newSession = harness.handle.pageSessionId;
    rejectOldReady?.(new Error("worker restarted"));
    await flushMessages();
    expect(harness.retries).toHaveLength(1);
    expect(harness.retries[0]?.delay).toBe(1_000);
    harness.retries.shift()?.callback();
    await flushMessages();
    const ready = harness.sent.filter((message) => message.kind === "qb_quiz_bootstrap_ready_v1");
    expect(ready.map((message) => message.page_session_id)).toEqual([oldSession, newSession, newSession]);
    expect(harness.createController).not.toHaveBeenCalled();
    harness.handle.disconnect();
  });

  it("retries failed route registration before READY and cancels obsolete route callbacks", async () => {
    let fail = true;
    const harness = bootstrapHarness({ onSend: (message, response) => (
      message.kind === "qb_page_route_v1" && fail
        ? { ok: false, code: "study_route_unavailable" } : response
    ) });
    await flushMessages();
    expect(harness.sent).toEqual([{ kind: "qb_page_route_v1", route: expect.any(Object), first_document_navigation: "unknown" }]);
    expect(harness.retries).toHaveLength(1);
    fail = false;
    harness.retries.shift()?.callback();
    await flushMessages();
    expect(harness.sent.map(({ kind }) => kind)).toEqual([
      "qb_page_route_v1", "qb_page_route_v1", "qb_quiz_bootstrap_ready_v1",
    ]);
    fail = true;
    harness.move("/search");
    await flushMessages();
    const oldRetry = harness.retries[0];
    harness.move("/other");
    expect(harness.canceled).toContain(oldRetry);
    const count = harness.sent.length;
    oldRetry?.callback();
    expect(harness.sent).toHaveLength(count);
    harness.handle.disconnect();
  });

  it("marks lost source context instead of guessing normal or review after a failed search notification", async () => {
    let resolveSearch: ((response: unknown) => void) | undefined;
    let calls = 0;
    const harness = bootstrapHarness({ pathname: "/search", autoStart: true,
      onSend: (message, response) => {
        if (message.kind === "qb_page_route_v1" && ++calls === 1) {
          return new Promise((resolve) => { resolveSearch = resolve; });
        }
        return response;
      },
    });
    harness.move("/quiz", "?question_id=first");
    await flushMessages();
    expect(harness.sent[1]).toEqual({ kind: "qb_page_route_v1", route: { route_kind: "quiz", question_id: "first" }, context_lost: true });
    expect(harness.createController).toHaveBeenCalledOnce();
    resolveSearch?.({ ok: true, code: "study_route_registered" });
    await flushMessages();
    harness.move("/quiz", "?question_id=second");
    await flushMessages();
    expect(harness.sent.at(-1)).toEqual({ kind: "qb_page_route_v1", route: { route_kind: "quiz", question_id: "second" }, context_lost: true });
    expect(harness.createController).toHaveBeenCalledOnce();
    harness.handle.disconnect();
  });

  it("stops and resumes the same session without recording a result displayed while paused", async () => {
    const harness = bootstrapHarness({ autoStart: true });
    await flushMessages();
    const session = harness.handle.pageSessionId;
    const oldObserver = ManualMutationObserver.latest;
    expect(harness.command("stop_capture_v1")).toEqual({ ok: true, code: "capture_stopped" });
    expect(oldObserver?.disconnected).toBe(true);
    harness.render("correct.html");
    oldObserver?.trigger();
    expect(harness.candidates()).toHaveLength(0);
    expect(harness.command("start_capture_v1")).toEqual({ ok: true, code: "capture_started" });
    expect(harness.handle.pageSessionId).toBe(session);
    expect(harness.createController).toHaveBeenCalledOnce();
    harness.render("pending.html");
    harness.render("correct.html");
    expect(harness.candidates()).toHaveLength(0);
    harness.render("pending.html", "119A13");
    harness.render("resolved-other-question.html");
    expect(harness.candidates()).toHaveLength(1);
    harness.handle.disconnect();
  });

  it("cancels unacknowledged candidate retries on exit and does not reuse them in another session", async () => {
    vi.useFakeTimers();
    try {
      const harness = bootstrapHarness({ autoStart: true, onSend: (message, response) => (
        message.kind === "qb_quiz_capture_message_v1" && message.message.kind === "attempt_candidate_v1"
          ? Promise.reject(new Error("worker unavailable")) : response
      ) });
      await flushMessages();
      harness.render("correct.html");
      await flushMessages();
      expect(vi.getTimerCount()).toBe(1);
      harness.move("/search");
      await flushMessages();
      expect(vi.getTimerCount()).toBe(0);
      harness.move("/quiz");
      await flushMessages();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.candidates()).toHaveLength(1);
      harness.handle.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gates capture immediately when URL changes before a navigation callback", async () => {
    const harness = bootstrapHarness({ autoStart: true });
    await flushMessages();
    harness.location.pathname = "/search";
    harness.render("correct.html");
    expect(harness.candidates()).toHaveLength(0);
    expect(harness.handle.pageSessionId).toBeNull();
    harness.handle.disconnect();
  });

  it("handles back/forward and BFCache restore, and removes lifecycle listeners on disconnect", async () => {
    const harness = bootstrapHarness({ autoStart: true });
    await flushMessages();
    const firstSession = harness.handle.pageSessionId;
    harness.windowEvents.emit("pagehide");
    harness.render("correct.html");
    expect(harness.candidates()).toHaveLength(0);
    expect(harness.handle.pageSessionId).toBeNull();
    harness.windowEvents.emit("pageshow");
    await flushMessages();
    expect(harness.handle.pageSessionId).not.toBe(firstSession);
    expect(harness.candidates()).toHaveLength(0);
    harness.location.pathname = "/search";
    harness.windowEvents.emit("popstate");
    expect(harness.handle.pageSessionId).toBeNull();
    harness.location.pathname = "/quiz";
    harness.windowEvents.emit("popstate");
    await flushMessages();
    expect(harness.createController).toHaveBeenCalledTimes(3);
    harness.handle.disconnect();
    const count = harness.sent.length;
    harness.move("/search");
    harness.windowEvents.emit("pageshow");
    expect(harness.sent).toHaveLength(count);
    expect([...harness.navigation.listeners.values()].every((set) => set.size === 0)).toBe(true);
    expect([...harness.windowEvents.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  it("uses a URL-only fallback when Navigation API is unavailable", async () => {
    const harness = bootstrapHarness({ pathname: "/search", navigationAvailable: false, autoStart: true });
    await flushMessages();
    expect(ManualMutationObserver.latest).toBeUndefined();
    harness.location.pathname = "/quiz";
    harness.pollLocation();
    await flushMessages();
    expect(harness.createController).toHaveBeenCalledOnce();
    harness.handle.disconnect();
    expect(harness.cancelLocationCheck).toHaveBeenCalledWith("location-check");
  });

  it("ignores other origins even when their pathname is /quiz", () => {
    const sendMessage = vi.fn();
    const addListener = vi.fn();
    const handle = startQbQuizBootstrap({
      location: { origin: "https://example.invalid", pathname: "/quiz" },
      document: fixtureDocument("pending.html"), MutationObserver: ManualMutationObserver,
      runtime: { sendMessage, onMessage: { addListener, removeListener: vi.fn() } },
    });
    expect(handle.pageSessionId).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
  });
});


describe("current route evidence and session health", () => {
  it("detects URL changes even when an available Navigation API emits no event", async () => {
    const h = bootstrapHarness({ pathname: "/search", autoStart: true });
    await flushMessages();
    h.location.pathname = "/quiz";
    h.location.search = "?question_id=next";
    h.pollLocation();
    await flushMessages();
    expect(h.handle.pageSessionId).not.toBeNull();
    expect(h.createController).toHaveBeenCalledTimes(1);
    expect(h.sent).toContainEqual({ kind: "qb_page_route_v1", route: { route_kind: "quiz", question_id: "next" } });
    h.handle.disconnect();
  });

  it("reannounces only a running session after 30 seconds and keeps a user pause", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const h = bootstrapHarness({ autoStart: true });
    await flushMessages();
    const readyCount = () => h.sent.filter((message) => message.kind === "qb_quiz_bootstrap_ready_v1").length;
    expect(readyCount()).toBe(1);
    now.mockReturnValue(30_999); h.pollLocation(); await flushMessages();
    expect(readyCount()).toBe(1);
    now.mockReturnValue(31_000); h.pollLocation(); await flushMessages();
    expect(readyCount()).toBe(2);
    expect(h.createController).toHaveBeenCalledTimes(1);
    expect(h.command("stop_capture_v1")).toEqual({ ok: true, code: "capture_stopped" });
    now.mockReturnValue(100_000); h.pollLocation(); await flushMessages();
    expect(readyCount()).toBe(2);
    h.handle.disconnect(); now.mockRestore();
  });
});
