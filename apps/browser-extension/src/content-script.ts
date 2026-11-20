import { QbQuizAttemptAdapter } from "./adapters/qb-quiz-adapter.js";
import { isTrustedQbSubmission } from "./adapters/qb-quiz-submit.js";
import { QB_QUIZ_ORIGIN, isSupportedQbQuizLocation } from "./adapters/qb-quiz-dom-contract.js";
import { UnsupportedAttemptAdapter } from "./adapters/unsupported-adapter.js";
import { CaptureController } from "./capture-controller.js";
import type {
  AttemptCandidateMessageV1,
  CaptureDocumentPayloadV1,
  CaptureStatusMessageV1,
  CommandResponseV1,
  QbPageRouteMessageV1,
  QbPageRouteDescriptor,
  QbQuizBootstrapReadyMessageV1,
  QbQuizCaptureMessageV1,
} from "./shared/protocol.js";
import {
  QB_PAGE_ROUTE_MESSAGE_KIND,
  qbPageRouteDescriptor,
  sameQbPageRoute,
  QB_QUIZ_BOOTSTRAP_READY_MESSAGE_KIND,
  QB_QUIZ_CAPTURE_MESSAGE_KIND,
  isCandidatePersistedResponseV1,
  isQbQuizConsentProbeMessageV1,
  isQbPageRouteProbeMessageV1,
  isQbQuizBootstrapReadyMessageV1,
  isStartCaptureMessageV1,
  isStopCaptureMessageV1,
} from "./shared/protocol.js";

type ContentScriptMessage = CaptureDocumentPayloadV1;
const CANDIDATE_RETRY_DELAY_MS = 1_000;
const BOOTSTRAP_READY_RETRY_DELAY_MS = 1_000;

interface MutationObserverLike {
  observe(target: Node, options?: MutationObserverInit): void;
  disconnect(): void;
}

type MutationObserverConstructor = new (
  callback: () => void,
) => MutationObserverLike;

export interface StartContentScriptOptions {
  readonly document: Document;
  readonly MutationObserver: MutationObserverConstructor;
  readonly sendMessage: (message: ContentScriptMessage) => unknown;
  readonly controller?: CaptureController;
  readonly isActive?: () => boolean;
  readonly scheduleRetry?: (callback: () => void, delayMilliseconds: number) => unknown;
  readonly cancelRetry?: (handle: unknown) => void;
}

export interface ContentScriptHandle {
  disconnect(): void;
}

interface PendingCandidate {
  readonly message: AttemptCandidateMessageV1;
  inFlight: boolean;
  retryScheduled: boolean;
  retryHandle: unknown;
}

function sendStatusBestEffort(
  sendMessage: StartContentScriptOptions["sendMessage"],
  message: CaptureStatusMessageV1,
): void {
  try {
    const result = sendMessage(message);
    if (
      result !== null
      && typeof result === "object"
      && "catch" in result
      && typeof result.catch === "function"
    ) {
      void result.catch(() => undefined);
    }
  } catch {
    // The background worker may be restarting. Its absence must not mutate the page.
  }
}

export function startContentScript(options: StartContentScriptOptions): ContentScriptHandle {
  const controller = options.controller
    ?? new CaptureController(new UnsupportedAttemptAdapter());
  const scheduleRetry = options.scheduleRetry
    ?? ((callback: () => void, delayMilliseconds: number) => (
      globalThis.setTimeout(callback, delayMilliseconds)
    ));
  const cancelRetry = options.cancelRetry
    ?? ((handle: unknown) => globalThis.clearTimeout(handle as number));
  const pendingCandidates = new Map<string, PendingCandidate>();
  let disconnected = false;
  const isActive = (): boolean => !disconnected && (options.isActive?.() ?? true);

  const scheduleCandidateRetry = (pending: PendingCandidate): void => {
    if (!isActive() || pending.retryScheduled) {
      return;
    }
    pending.retryScheduled = true;
    try {
      pending.retryHandle = scheduleRetry(() => {
        pending.retryScheduled = false;
        sendCandidate(pending);
      }, CANDIDATE_RETRY_DELAY_MS);
    } catch {
      pending.retryScheduled = false;
    }
  };

  const sendCandidate = (pending: PendingCandidate): void => {
    if (!isActive() || pending.inFlight) {
      return;
    }
    pending.inFlight = true;

    let result: unknown;
    try {
      result = options.sendMessage(pending.message);
    } catch {
      pending.inFlight = false;
      scheduleCandidateRetry(pending);
      return;
    }

    void Promise.resolve(result).then(
      (messageResponse) => {
        pending.inFlight = false;
        if (isCandidatePersistedResponseV1(messageResponse)) {
          pendingCandidates.delete(pending.message.event_id);
          return;
        }
        scheduleCandidateRetry(pending);
      },
      () => {
        pending.inFlight = false;
        scheduleCandidateRetry(pending);
      },
    );
  };

  const enqueueCandidate = (message: AttemptCandidateMessageV1): void => {
    if (pendingCandidates.has(message.event_id)) {
      return;
    }
    const pending: PendingCandidate = {
      message,
      inFlight: false,
      retryScheduled: false,
      retryHandle: undefined,
    };
    pendingCandidates.set(message.event_id, pending);
    sendCandidate(pending);
  };

  const inspect = (): void => {
    if (!isActive()) {
      return;
    }
    const output = controller.observe(options.document);
    if (output.status !== undefined) {
      sendStatusBestEffort(options.sendMessage, output.status);
    }
    if (output.candidate !== undefined) {
      enqueueCandidate(output.candidate);
    }
  };

  const observer = new options.MutationObserver(inspect);
  const onSubmit = (event: Event): void => {
    if (isActive() && isTrustedQbSubmission(options.document, event)) {
      controller.confirmSubmission(options.document);
    }
  };
  // Capture phase observes the pending DOM before the application's click handler.
  // It never invokes, cancels, or modifies the user's action.
  options.document.addEventListener("click", onSubmit, true);
  observer.observe(options.document.documentElement ?? options.document, {
    attributes: true,
    attributeFilter: [...controller.observedAttributeNames],
    characterData: true,
    childList: true,
    subtree: true,
  });
  inspect();

  return {
    disconnect: () => {
      disconnected = true;
      options.document.removeEventListener("click", onSubmit, true);
      observer.disconnect();
      for (const pending of pendingCandidates.values()) {
        if (pending.retryScheduled) {
          cancelRetry(pending.retryHandle);
        }
      }
      pendingCandidates.clear();
    },
  };
}

type BootstrapMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: CommandResponseV1) => void,
) => boolean | void;

interface BootstrapRuntimeLike {
  sendMessage(
    message: QbPageRouteMessageV1 | QbQuizBootstrapReadyMessageV1 | QbQuizCaptureMessageV1,
  ): unknown;
  readonly onMessage: {
    addListener(listener: BootstrapMessageListener): void;
    removeListener(listener: BootstrapMessageListener): void;
  };
}

interface RouteEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface NavigationTimingReader {
  getEntriesByType(type: string): readonly unknown[];
}

interface RouteLocation {
  readonly href?: string;
  readonly origin: string;
  readonly pathname: string;
  readonly search?: string;
  readonly hash?: string;
}

export interface StartQbQuizBootstrapOptions {
  readonly location: RouteLocation;
  readonly document: Document;
  readonly MutationObserver: MutationObserverConstructor;
  readonly runtime: BootstrapRuntimeLike;
  readonly navigation?: RouteEventTarget;
  readonly windowEvents?: RouteEventTarget;
  readonly performance?: NavigationTimingReader;
  readonly createPageSessionId?: () => string;
  readonly createController?: () => CaptureController;
  readonly scheduleReadyRetry?: (
    callback: () => void,
    delayMilliseconds: number,
  ) => unknown;
  readonly cancelReadyRetry?: (handle: unknown) => void;
  readonly scheduleLocationCheck?: (
    callback: () => void,
    delayMilliseconds: number,
  ) => unknown;
  readonly cancelLocationCheck?: (handle: unknown) => void;
}

export interface QbQuizBootstrapHandle {
  readonly pageSessionId: string | null;
  disconnect(): void;
}

interface RetriableNotification {
  settled: boolean;
  inFlight: boolean;
  retryScheduled: boolean;
  retryHandle: unknown;
}

type InitialRouteEvidence = Pick<
  QbPageRouteMessageV1, "first_document_navigation" | "referrer_set_id"
>;

interface RouteState extends RetriableNotification {
  readonly key: string;
  readonly descriptor: QbPageRouteDescriptor;
  readonly initialEvidence?: InitialRouteEvidence;
}

interface QuizSession extends RetriableNotification {
  readonly contextLost: boolean;
  readonly readyMessage: QbQuizBootstrapReadyMessageV1;
  initialRouteConfirmed: boolean;
  lastReadySentAt: number;
  controller: CaptureController | undefined;
  capture: ContentScriptHandle | undefined;
  captureActive: boolean;
}

function notificationState(): RetriableNotification {
  return { settled: false, inFlight: false, retryScheduled: false, retryHandle: undefined };
}

function isBootstrapReadySettledResponse(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !("code" in value)) {
    return false;
  }
  return value.code === "consent_ready_registered"
    || value.code === "consent_ready_duplicate"
    || value.code === "consent_popup_opened"
    || value.code === "consent_popup_failed"
    || value.code === "consent_capture_started"
    || value.code === "consent_capture_already_started";
}

function isRouteRegisteredResponse(value: unknown): boolean {
  return value !== null && typeof value === "object"
    && "ok" in value && value.ok === true
    && "code" in value && value.code === "study_route_registered";
}

function initialRouteEvidence(options: StartQbQuizBootstrapOptions): InitialRouteEvidence {
  let navigationType: InitialRouteEvidence["first_document_navigation"] = "unknown";
  try {
    const entries = options.performance?.getEntriesByType("navigation") ?? [];
    const entry = entries.length === 1 ? entries[0] : undefined;
    if (entry !== null && typeof entry === "object" && "type" in entry) {
      const type = entry.type;
      if (type === "navigate" || type === "reload" || type === "back_forward") {
        navigationType = type;
      }
    }
  } catch {
    // Missing or inaccessible browser metadata must not imply a reload.
  }

  let referrerSetId: string | undefined;
  try {
    const referrer = options.document.referrer;
    if (referrer.length > 0 && referrer.length <= 16_384) {
      const url = new URL(referrer);
      const ids = url.searchParams.getAll("questionSetId");
      if (
        url.origin === QB_QUIZ_ORIGIN && url.pathname === "/search"
        && url.username === "" && url.password === ""
        && ids.length === 1 && /^[A-Za-z0-9_-]{1,100}$/u.test(ids[0] ?? "")
      ) {
        referrerSetId = ids[0];
      }
    }
  } catch {
    // The full referrer is neither retained nor sent to the worker.
  }
  return Object.freeze({
    first_document_navigation: navigationType,
    ...(referrerSetId === undefined ? {} : { referrer_set_id: referrerSetId }),
  });
}

export function startQbQuizBootstrap(
  options: StartQbQuizBootstrapOptions,
): QbQuizBootstrapHandle {
  if (options.location.origin !== QB_QUIZ_ORIGIN) {
    return { pageSessionId: null, disconnect: () => undefined };
  }

  let disconnected = false;
  let pageHidden = false;
  let route: RouteState | undefined;
  let session: QuizSession | undefined;
  let firstRouteEvidence: InitialRouteEvidence | undefined = initialRouteEvidence(options);
  const scheduleRetry = options.scheduleReadyRetry
    ?? ((callback: () => void, delayMilliseconds: number) => (
      globalThis.setTimeout(callback, delayMilliseconds)
    ));
  const cancelRetry = options.cancelReadyRetry
    ?? ((handle: unknown) => globalThis.clearTimeout(handle as number));
  const locationKey = (): string => (
    `${options.location.origin}${options.location.pathname}`
    + `${options.location.search ?? ""}${options.location.hash ?? ""}`
  );

  const cancelNotification = (state: RetriableNotification | undefined): void => {
    if (state?.retryScheduled === true) {
      cancelRetry(state.retryHandle);
      state.retryScheduled = false;
    }
  };
  const stopCapture = (current: QuizSession): void => {
    current.captureActive = false;
    current.capture?.disconnect();
    current.capture = undefined;
    // A result displayed while stopped must become a new baseline on resume.
    // Keep the terminal question guard so redraws cannot replay a saved answer.
    current.controller?.resetObservationBaseline();
  };
  const disposeSession = (): void => {
    if (session !== undefined) {
      cancelNotification(session);
      stopCapture(session);
      session = undefined;
    }
  };
  const isCurrentRoute = (current: RouteState): boolean => (
    !disconnected && !pageHidden && route === current && current.key === locationKey()
  );
  const isCurrentSession = (current: QuizSession): boolean => (
    !disconnected && !pageHidden && session === current
    && isSupportedQbQuizLocation(options.location)
  );
  const retry = (
    state: RetriableNotification,
    isCurrent: () => boolean,
    notify: () => void,
  ): void => {
    if (!isCurrent() || state.settled || state.retryScheduled) {
      return;
    }
    state.retryScheduled = true;
    try {
      state.retryHandle = scheduleRetry(() => {
        state.retryScheduled = false;
        if (isCurrent()) {
          notify();
        }
      }, BOOTSTRAP_READY_RETRY_DELAY_MS);
    } catch {
      state.retryScheduled = false;
    }
  };

  const notifyReady = (current: QuizSession): void => {
    if (
      !isCurrentSession(current) || current.settled || current.inFlight
      || route?.settled !== true || !isCurrentRoute(route)
    ) {
      return;
    }
    current.inFlight = true;
    current.lastReadySentAt = Date.now();
    const failed = (): void => {
      current.inFlight = false;
      retry(current, () => isCurrentSession(current), () => notifyReady(current));
    };
    let result: unknown;
    try {
      result = options.runtime.sendMessage(current.readyMessage);
    } catch {
      failed();
      return;
    }
    void Promise.resolve(result).then((response) => {
      current.inFlight = false;
      if (!isCurrentSession(current)) {
        return;
      }
      if (isBootstrapReadySettledResponse(response)) {
        current.settled = true;
        cancelNotification(current);
      } else {
        failed();
      }
    }, failed);
  };

  const notifyRoute = (current: RouteState): void => {
    if (!isCurrentRoute(current) || current.settled || current.inFlight) {
      return;
    }
    current.inFlight = true;
    const failed = (): void => {
      current.inFlight = false;
      retry(current, () => isCurrentRoute(current), () => notifyRoute(current));
    };
    let result: unknown;
    try {
      // Chrome binds origin/frame/document identity; sender.url can retain the
      // initial URL after pushState. Probe this bounded current route separately.
      result = options.runtime.sendMessage({
        kind: QB_PAGE_ROUTE_MESSAGE_KIND,
        route: current.descriptor,
        ...(current.initialEvidence ?? {}),
        ...(session?.contextLost === true ? { context_lost: true } : {}),
      });
    } catch {
      failed();
      return;
    }
    void Promise.resolve(result).then((response) => {
      current.inFlight = false;
      if (!isCurrentRoute(current)) {
        return;
      }
      if (!isRouteRegisteredResponse(response)) {
        failed();
        return;
      }
      current.settled = true;
      cancelNotification(current);
      if (session !== undefined) {
        session.initialRouteConfirmed = true;
        notifyReady(session);
      }
    }, failed);
  };

  const refreshRoute = (force = false): void => {
    if (disconnected || pageHidden) {
      return;
    }
    const key = locationKey();
    if (!force && route?.key === key) {
      return;
    }
    const contextLost = route !== undefined && !route.settled;
    cancelNotification(route);
    route = undefined;
    if (!isSupportedQbQuizLocation(options.location)) {
      disposeSession();
    }
    if (options.location.origin !== QB_QUIZ_ORIGIN) {
      return;
    }
    if (isSupportedQbQuizLocation(options.location) && session === undefined) {
      try {
        const readyMessage: QbQuizBootstrapReadyMessageV1 = {
          kind: QB_QUIZ_BOOTSTRAP_READY_MESSAGE_KIND,
          page_session_id: (options.createPageSessionId ?? (() => (
            globalThis.crypto.randomUUID()
          )))(),
        };
        if (isQbQuizBootstrapReadyMessageV1(readyMessage)) {
          session = {
            ...notificationState(), readyMessage, contextLost, initialRouteConfirmed: false, lastReadySentAt: 0,
            controller: undefined, capture: undefined, captureActive: false,
          };
        }
      } catch {
        // Do not capture without a valid, distinct session identifier.
      }
    }
    route = {
      ...notificationState(), key, descriptor: qbPageRouteDescriptor(options.location)!,
      ...(firstRouteEvidence === undefined ? {} : { initialEvidence: firstRouteEvidence }),
    };
    // document.referrer and navigation timing do not follow SPA transitions.
    // Reuse this evidence only for retries of the initial route notification.
    firstRouteEvidence = undefined;
    notifyRoute(route);
  };

  const listener: BootstrapMessageListener = (message, _sender, sendResponse) => {
    if (disconnected || pageHidden) {
      return false;
    }
    if (isQbPageRouteProbeMessageV1(message)) {
      const currentUrl = options.location.href ?? locationKey();
      const matches = message.expected_route === undefined
        ? message.expected_url === currentUrl
        : sameQbPageRoute(message.expected_route, qbPageRouteDescriptor(options.location));
      sendResponse(options.location.origin === QB_QUIZ_ORIGIN && matches
        ? { ok: true, code: "study_route_current" }
        : { ok: false, code: "study_route_unavailable" });
      return false;
    }
    refreshRoute();
    const current = session;
    if (current === undefined || !isCurrentSession(current)) {
      return false;
    }
    if (
      isQbQuizConsentProbeMessageV1(message)
      && message.page_session_id === current.readyMessage.page_session_id
    ) {
      // A later question route can still be awaiting its ACK inside this same
      // verified quiz session. Presence is independent of that route update.
      // Fresh sessions still need their first route ACK; leaving /quiz disposes
      // the session before this listener can confirm its identity.
      sendResponse(current.initialRouteConfirmed
        ? { ok: true, code: "consent_document_present" }
        : { ok: false, code: "consent_document_unavailable" });
      return false;
    }
    if (
      isStopCaptureMessageV1(message)
      && message.page_session_id === current.readyMessage.page_session_id
    ) {
      current.settled = true;
      cancelNotification(current);
      stopCapture(current);
      sendResponse({ ok: true, code: "capture_stopped" });
      return false;
    }
    if (
      !isStartCaptureMessageV1(message)
      || message.page_session_id !== current.readyMessage.page_session_id
    ) {
      return false;
    }
    if (route?.settled !== true) {
      sendResponse({ ok: false, code: "capture_start_location_blocked" });
      return false;
    }
    if (current.capture !== undefined) {
      sendResponse({ ok: true, code: "capture_already_started" });
      return false;
    }
    try {
      current.controller ??= options.createController?.()
        ?? new CaptureController(new QbQuizAttemptAdapter());
      current.captureActive = true;
      current.capture = startContentScript({
        document: options.document,
        MutationObserver: options.MutationObserver,
        controller: current.controller,
        isActive: () => {
          refreshRoute();
          return isCurrentSession(current) && current.captureActive;
        },
        sendMessage: (captureMessage) => options.runtime.sendMessage({
          kind: QB_QUIZ_CAPTURE_MESSAGE_KIND,
          page_session_id: current.readyMessage.page_session_id,
          message: captureMessage,
        }),
      });
      sendResponse({ ok: true, code: "capture_started" });
    } catch {
      stopCapture(current);
      sendResponse({ ok: false, code: "capture_start_blocked" });
    }
    return false;
  };

  // Navigation API events include history.pushState/replaceState. Listening
  // does not patch page scripts or intercept/change the user's navigation.
  const onEntryChange = (): void => refreshRoute(true);
  const onLocationChange = (): void => refreshRoute();
  const onPageHide = (): void => {
    pageHidden = true;
    cancelNotification(route);
    route = undefined;
    disposeSession();
  };
  const onPageShow = (): void => {
    pageHidden = false;
    refreshRoute();
  };
  options.runtime.onMessage.addListener(listener);
  options.navigation?.addEventListener("currententrychange", onEntryChange);
  options.windowEvents?.addEventListener("popstate", onLocationChange);
  options.windowEvents?.addEventListener("hashchange", onLocationChange);
  options.windowEvents?.addEventListener("pagehide", onPageHide);
  options.windowEvents?.addEventListener("pageshow", onPageShow);
  // URL-only fallback also covers an available Navigation API that misses an
  // event in the isolated world. It never inspects DOM or changes page history.
  const scheduleLocationCheck = options.scheduleLocationCheck
    ?? ((callback: () => void, delay: number) => globalThis.setInterval(callback, delay));
  const pollLocationAndSession = (): void => {
    refreshRoute();
    const current = session;
    if (current !== undefined && isCurrentSession(current) && current.captureActive
      && current.initialRouteConfirmed && current.settled && Date.now() - current.lastReadySentAt >= 30_000) {
      // Reannounce only a running session. A user pause must never be undone.
      current.settled = false;
      notifyReady(current);
    }
  };
  const locationCheck = options.windowEvents !== undefined
    ? scheduleLocationCheck(pollLocationAndSession, 1_000)
    : undefined;
  refreshRoute();

  return {
    get pageSessionId() { return session?.readyMessage.page_session_id ?? null; },
    disconnect: () => {
      disconnected = true;
      options.runtime.onMessage.removeListener(listener);
      options.navigation?.removeEventListener("currententrychange", onEntryChange);
      options.windowEvents?.removeEventListener("popstate", onLocationChange);
      options.windowEvents?.removeEventListener("hashchange", onLocationChange);
      options.windowEvents?.removeEventListener("pagehide", onPageHide);
      options.windowEvents?.removeEventListener("pageshow", onPageShow);
      if (locationCheck !== undefined) {
        (options.cancelLocationCheck ?? ((handle: unknown) => (
          globalThis.clearInterval(handle as number)
        )))(locationCheck);
      }
      cancelNotification(route);
      route = undefined;
      disposeSession();
    },
  };
}

interface ContentScriptGlobals {
  readonly chrome?: { readonly runtime?: BootstrapRuntimeLike };
  readonly document?: Document;
  readonly location?: RouteLocation;
  readonly navigation?: RouteEventTarget;
  readonly window?: RouteEventTarget;
  readonly performance?: NavigationTimingReader;
  readonly MutationObserver?: MutationObserverConstructor;
  qbStudyBootstrapV1Started?: boolean;
}

const globals = globalThis as ContentScriptGlobals;
if (
  globals.chrome?.runtime !== undefined
  && globals.document !== undefined
  && globals.location !== undefined
  && globals.MutationObserver !== undefined
  && globals.qbStudyBootstrapV1Started !== true
) {
  startQbQuizBootstrap({
    location: globals.location,
    document: globals.document,
    MutationObserver: globals.MutationObserver,
    runtime: globals.chrome.runtime,
    ...(globals.navigation === undefined ? {} : { navigation: globals.navigation }),
    ...(globals.window === undefined ? {} : { windowEvents: globals.window }),
    ...(globals.performance === undefined ? {} : { performance: globals.performance }),
  });
  globals.qbStudyBootstrapV1Started = true;
}
