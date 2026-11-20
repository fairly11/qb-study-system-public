import type { StudyMode } from "@qb-study/contracts";
import { isStudyCaptureContext, isStudyMode, type StudyCaptureContext } from "./study-context.js";
import type { StudyRouteEvidence } from "../shared/protocol.js";

export const QB_ORIGIN = "https://qb.medilink-study.com";
export const QB_QUIZ_PATHNAME = "/quiz";

const PAGE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_DOCUMENT_ID_LENGTH = 256;
const CLASSIFICATION_RETRY_DELAYS_MS = [65_000, 130_000, 260_000, 300_000] as const;

export type ConsentDecisionV1 = "undecided" | "declined" | "consented";
export type ConsentCaptureStateV1 = "not_started" | "starting" | "observing" | "paused";
export type ConsentAutoPopupStateV1 =
  | "pending"
  | "attempted"
  | "opened"
  | "failed"
  | "suppressed";

export interface ConsentDocumentSessionV1 {
  readonly tab_id: number;
  readonly window_id: number;
  readonly page_session_id: string;
  readonly document_id: string | null;
  readonly decision: ConsentDecisionV1;
  readonly capture_state: ConsentCaptureStateV1;
  readonly auto_popup_state: ConsentAutoPopupStateV1;
  readonly study_mode?: StudyMode;
  readonly review_plan_id?: string;
  readonly classification_pending?: boolean;
  readonly classification_attempts?: number;
  readonly classification_retry_after?: number;
}

export interface ConsentSessionStateV1 {
  readonly version: 1;
  readonly sessions: readonly ConsentDocumentSessionV1[];
}

export interface ConsentSenderContext {
  readonly tab_id: number;
  readonly window_id: number;
  readonly tab_active: boolean;
  readonly frame_id: number;
  readonly origin?: string;
  readonly url?: string;
  readonly document_id?: string;
  readonly page_session_id?: string;
}

export interface ConsentReadyInput {
  readonly page_session_id: string;
  readonly sender: ConsentSenderContext;
}

export interface ConsentSessionStorePort {
  read(): Promise<unknown>;
  write(state: ConsentSessionStateV1): Promise<void>;
}

export interface ConsentUiPort {
  isTabActive(tabId: number, windowId: number): Promise<boolean>;
  showAttention(tabId: number): Promise<void>;
  clearAttention(tabId: number): Promise<void>;
  showCapturing?(tabId: number, mode: StudyMode): Promise<void>;
  openPopup(windowId: number): Promise<boolean>;
}

export interface ConsentCaptureStartPort {
  probe(session: ConsentDocumentSessionV1): Promise<boolean>;
  start(session: ConsentDocumentSessionV1): Promise<boolean>;
  stop?(session: ConsentDocumentSessionV1): Promise<boolean>;
}

export interface ConsentControllerPorts {
  readonly now?: () => number;
  readonly store: ConsentSessionStorePort;
  readonly ui: ConsentUiPort;
  readonly capture: ConsentCaptureStartPort;
  /** Omit only for the legacy manual-consent flow. A resolver failure stays unclassified. */
  readonly automatic?: {
    readonly resolveStudyContext?: (input: ConsentReadyInput) => Promise<StudyCaptureContext>;
  };
  readonly routes?: {
    handleRoute(sender: ConsentSenderContext, contextLost?: boolean, evidence?: StudyRouteEvidence): Promise<boolean>;
    hasRegisteredQuizRoute?(sender: ConsentSenderContext): Promise<boolean>;
    removeTab(tabId: number): Promise<void>;
  };
}

export function isConsentDocumentLifecycleStatus(
  value: unknown,
): value is "loading" | "complete" {
  return value === "loading" || value === "complete";
}

export interface ConsentTabStatusV1 {
  readonly tab_id: number;
  readonly page_session_id: string;
  readonly decision: ConsentDecisionV1;
  readonly capture_state: ConsentCaptureStateV1;
  readonly auto_popup_state: ConsentAutoPopupStateV1;
  readonly study_mode?: StudyMode;
  readonly review_plan_id?: string;
}

export type ConsentCommandCode =
  | "consent_ready_registered"
  | "consent_ready_duplicate"
  | "consent_ready_rejected"
  | "consent_popup_opened"
  | "consent_popup_failed"
  | "consent_activation_ignored"
  | "consent_document_unavailable"
  | "consent_session_cleared"
  | "consent_session_retained"
  | "consent_session_not_found"
  | "consent_declined"
  | "consent_decline_blocked"
  | "consent_capture_started"
  | "consent_capture_already_started"
  | "consent_capture_start_blocked"
  | "consent_capture_paused"
  | "consent_capture_stop_blocked"
  | "study_route_registered"
  | "study_route_unavailable"
  | "consent_storage_blocked"
  | "study_mode_changed"
  | "study_mode_change_blocked";

export type ConsentCommandResponse =
  | { readonly ok: true; readonly code: ConsentCommandCode }
  | { readonly ok: false; readonly code: ConsentCommandCode };

function response(ok: boolean, code: ConsentCommandCode): ConsentCommandResponse {
  return ok ? { ok: true, code } : { ok: false, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function isSafeChromeId(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isPageSessionId(value: unknown): value is string {
  return typeof value === "string" && PAGE_SESSION_ID_PATTERN.test(value);
}

function isDocumentId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_DOCUMENT_ID_LENGTH
    && [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
    });
}

function isDecision(value: unknown): value is ConsentDecisionV1 {
  return value === "undecided" || value === "declined" || value === "consented";
}

function isCaptureState(value: unknown): value is ConsentCaptureStateV1 {
  return value === "not_started" || value === "starting" || value === "observing" || value === "paused";
}

function isAutoPopupState(value: unknown): value is ConsentAutoPopupStateV1 {
  return value === "pending"
    || value === "attempted"
    || value === "opened"
    || value === "failed"
    || value === "suppressed";
}

function isSession(value: unknown): value is ConsentDocumentSessionV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "tab_id",
    "window_id",
    "page_session_id",
    "document_id",
    "decision",
    "capture_state",
    "auto_popup_state",
    ...(Object.hasOwn(value, "study_mode") ? ["study_mode"] : []),
    ...(Object.hasOwn(value, "review_plan_id") ? ["review_plan_id"] : []),
    ...(Object.hasOwn(value, "classification_pending") ? ["classification_pending"] : []),
    ...(Object.hasOwn(value, "classification_attempts") ? ["classification_attempts"] : []),
    ...(Object.hasOwn(value, "classification_retry_after") ? ["classification_retry_after"] : []),
  ])) {
    return false;
  }

  return isSafeChromeId(value.tab_id)
    && isSafeChromeId(value.window_id)
    && isPageSessionId(value.page_session_id)
    && (value.document_id === null || isDocumentId(value.document_id))
    && isDecision(value.decision)
    && isCaptureState(value.capture_state)
    && isAutoPopupState(value.auto_popup_state)
    && (value.study_mode === undefined || isStudyMode(value.study_mode))
    && (value.review_plan_id === undefined || (isPageSessionId(value.review_plan_id) && value.study_mode === "review"))
    && (value.classification_pending === undefined || typeof value.classification_pending === "boolean")
    && ((value.classification_attempts === undefined && value.classification_retry_after === undefined)
      || (typeof value.classification_attempts === "number" && Number.isInteger(value.classification_attempts)
        && value.classification_attempts >= 1 && value.classification_attempts <= CLASSIFICATION_RETRY_DELAYS_MS.length
        && typeof value.classification_retry_after === "number" && Number.isSafeInteger(value.classification_retry_after)
        && value.classification_retry_after >= 0));
}

export function restoreConsentSessionState(
  value: unknown,
): ConsentSessionStateV1 | null {
  if (value === undefined) {
    return Object.freeze({ version: 1, sessions: Object.freeze([]) });
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["version", "sessions"])
    || value.version !== 1
    || !Array.isArray(value.sessions)
    || !value.sessions.every(isSession)
  ) {
    return null;
  }

  const sessions = value.sessions as readonly ConsentDocumentSessionV1[];
  if (new Set(sessions.map(({ tab_id: tabId }) => tabId)).size !== sessions.length) {
    return null;
  }
  return immutableConsentState({ version: 1, sessions });
}

export function immutableConsentState(
  state: ConsentSessionStateV1,
): ConsentSessionStateV1 {
  return Object.freeze({
    version: 1,
    sessions: Object.freeze(state.sessions.map((session) => Object.freeze({ ...session, study_mode: session.study_mode ?? "unclassified" }))),
  });
}

function supportedSender(sender: ConsentSenderContext, registeredRoute = false): boolean {
  if (
    !isSafeChromeId(sender.tab_id)
    || !isSafeChromeId(sender.window_id)
    || typeof sender.tab_active !== "boolean"
    || sender.frame_id !== 0
    || sender.origin !== QB_ORIGIN
    || typeof sender.url !== "string"
    || (sender.document_id !== undefined && !isDocumentId(sender.document_id))
    || (registeredRoute && !isDocumentId(sender.document_id))
  ) {
    return false;
  }

  try {
    const url = new URL(sender.url);
    return url.origin === QB_ORIGIN
      && (registeredRoute || url.pathname === QB_QUIZ_PATHNAME)
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function sameDocument(
  session: ConsentDocumentSessionV1,
  input: ConsentReadyInput,
): boolean {
  if (
    session.tab_id !== input.sender.tab_id
    || session.window_id !== input.sender.window_id
    || session.page_session_id !== input.page_session_id
  ) {
    return false;
  }
  if (session.document_id !== null && input.sender.document_id !== undefined) {
    return session.document_id === input.sender.document_id;
  }
  return session.document_id === null
    && input.sender.document_id === undefined
    && session.page_session_id === input.page_session_id;
}

function senderMatchesSession(
  sender: ConsentSenderContext,
  session: ConsentDocumentSessionV1,
): boolean {
  if (
    sender.tab_id !== session.tab_id
    || sender.window_id !== session.window_id
    || sender.page_session_id !== session.page_session_id
  ) {
    return false;
  }
  if (session.document_id !== null) {
    return sender.document_id === session.document_id;
  }
  return sender.document_id === undefined;
}

function replaceSession(
  state: ConsentSessionStateV1,
  replacement: ConsentDocumentSessionV1,
): ConsentSessionStateV1 {
  return immutableConsentState({
    version: 1,
    sessions: [
      ...state.sessions.filter(({ tab_id: tabId }) => tabId !== replacement.tab_id),
      replacement,
    ],
  });
}

function removeSession(
  state: ConsentSessionStateV1,
  tabId: number,
): ConsentSessionStateV1 {
  return immutableConsentState({
    version: 1,
    sessions: state.sessions.filter(({ tab_id: storedTabId }) => storedTabId !== tabId),
  });
}

function popupStatus(session: ConsentDocumentSessionV1): ConsentTabStatusV1 {
  return Object.freeze({
    tab_id: session.tab_id,
    page_session_id: session.page_session_id,
    decision: session.decision,
    capture_state: session.capture_state,
    auto_popup_state: session.auto_popup_state,
    study_mode: session.study_mode ?? "unclassified",
    ...(session.review_plan_id === undefined ? {} : { review_plan_id: session.review_plan_id }),
  });
}

export class ConsentController {
  readonly #ports: ConsentControllerPorts;
  readonly #classifications = new Map<string, {
    readonly context: Promise<StudyCaptureContext>;
    readonly completion: Promise<ConsentCommandResponse>;
  }>();
  #operationTail: Promise<void> = Promise.resolve();

  public constructor(ports: ConsentControllerPorts) {
    this.#ports = ports;
  }

  public handlePageRoute(sender: ConsentSenderContext, contextLost?: boolean, evidence?: StudyRouteEvidence): Promise<ConsentCommandResponse> {
    return this.#serialize(async () => {
      try {
        return await this.#ports.routes?.handleRoute(sender, contextLost, evidence)
          ? response(true, "study_route_registered")
          : response(false, "study_route_unavailable");
      } catch {
        return response(false, "study_route_unavailable");
      }
    });
  }

  public async handleReady(input: ConsentReadyInput): Promise<ConsentCommandResponse> {
    const prepared = await this.#serialize<ConsentCommandResponse | {completion: Promise<ConsentCommandResponse>}>(async () => {
      if (!isPageSessionId(input.page_session_id) || !await this.#senderHasQuizRoute(input.sender)) {
        return response(false, "consent_ready_rejected");
      }

      const state = await this.#readState();
      if (state === null) {
        return response(false, "consent_storage_blocked");
      }
      const existing = state.sessions.find(
        ({ tab_id: tabId }) => tabId === input.sender.tab_id,
      );
      if (existing !== undefined && sameDocument(existing, input)) {
        if (this.#ports.automatic !== undefined) {
          if (!await this.#documentIsCurrent(existing, false)) return response(false, "consent_document_unavailable");
          if (existing.decision === "declined" || existing.capture_state === "paused") {
            return response(true, "consent_ready_duplicate");
          }
          if (existing.capture_state === "observing" && !existing.classification_pending) {
            return await this.#retryClassification(state, existing, input);
          }
          const pending = existing.classification_pending || existing.decision === "undecided";
          return await this.#startAutomatic(state,
            pending ? { ...existing, classification_pending: true } : existing, input);
        }
        if (
          existing.decision === "undecided"
          && existing.auto_popup_state === "pending"
        ) {
          return await this.#attemptAutoPopup(state, existing);
        }
        return response(true, "consent_ready_duplicate");
      }

      const session: ConsentDocumentSessionV1 = Object.freeze({
        tab_id: input.sender.tab_id,
        window_id: input.sender.window_id,
        page_session_id: input.page_session_id,
        document_id: input.sender.document_id ?? null,
        decision: "undecided",
        capture_state: "not_started",
        auto_popup_state: this.#ports.automatic === undefined ? "pending" : "suppressed",
        ...(this.#ports.automatic === undefined ? {} : { classification_pending: true }),
      });
      // A delayed READY from a previous SPA route must not replace the current route.
      if (!await this.#documentIsCurrent(session, false)) {
        return response(false, "consent_document_unavailable");
      }
      if (existing !== undefined) {
        await this.#clearAttentionBestEffort(existing.tab_id);
      }
      const next = replaceSession(state, session);
      if (!await this.#writeState(next)) {
        return response(false, "consent_storage_blocked");
      }
      return this.#ports.automatic === undefined
        ? await this.#attemptAutoPopup(next, session)
        : await this.#startAutomatic(next, session, input);
    });
    return "completion" in prepared ? await prepared.completion : prepared;
  }

  public handleTabActivated(
    tabId: number,
    windowId: number,
  ): Promise<ConsentCommandResponse> {
    return this.#serialize(async () => {
      if (!isSafeChromeId(tabId) || !isSafeChromeId(windowId)) {
        return response(false, "consent_activation_ignored");
      }
      if (this.#ports.automatic !== undefined) {
        return response(true, "consent_activation_ignored");
      }
      const state = await this.#readState();
      if (state === null) {
        return response(false, "consent_storage_blocked");
      }
      const session = state.sessions.find(({ tab_id: storedTabId }) => storedTabId === tabId);
      if (
        session === undefined
        || session.window_id !== windowId
        || session.decision !== "undecided"
        || session.auto_popup_state !== "pending"
      ) {
        return response(true, "consent_activation_ignored");
      }
      return await this.#attemptAutoPopup(state, session);
    });
  }

  public reconcileTabDocument(tabId: number): Promise<ConsentCommandResponse> {
    return this.#serialize(async () => {
      if (!isSafeChromeId(tabId)) {
        return response(false, "consent_session_not_found");
      }
      const state = await this.#readState();
      if (state === null) {
        return response(false, "consent_storage_blocked");
      }
      const session = state.sessions.find(
        ({ tab_id: storedTabId }) => storedTabId === tabId,
      );
      if (session === undefined) {
        return response(true, "consent_session_not_found");
      }

      let present: boolean;
      try {
        present = await this.#ports.capture.probe(session);
      } catch {
        present = false;
      }
      if (present) {
        return response(true, "consent_session_retained");
      }
      if (!await this.#writeState(removeSession(state, tabId))) {
        return response(false, "consent_storage_blocked");
      }
      await this.#clearAttentionBestEffort(tabId);
      return response(true, "consent_session_cleared");
    });
  }

  public handleTabRemoved(tabId: number): Promise<ConsentCommandResponse> {
    return this.#clearTab(tabId).then(async (result) => {
      try { await this.#ports.routes?.removeTab(tabId); }
      catch { return response(false, "consent_storage_blocked"); }
      return result;
    });
  }

  public getTabStatus(tabId: number): Promise<ConsentTabStatusV1 | null> {
    return this.#serialize(async () => {
      if (!isSafeChromeId(tabId)) {
        return null;
      }
      const state = await this.#readState();
      const session = state?.sessions.find(
        ({ tab_id: storedTabId }) => storedTabId === tabId,
      );
      return session === undefined ? null : popupStatus(session);
    });
  }

  public declineCapture(
    tabId: number,
    pageSessionId: string,
  ): Promise<ConsentCommandResponse> {
    return this.#serialize(async () => {
      const located = await this.#locateCurrentSession(tabId, pageSessionId);
      if (located === null) {
        return response(false, "consent_session_not_found");
      }
      if (located === "storage_blocked") {
        return response(false, "consent_storage_blocked");
      }
      if (located.session.capture_state !== "not_started" || located.session.decision === "consented") {
        return response(false, "consent_decline_blocked");
      }
      if (!await this.#documentIsCurrent(located.session)) {
        return response(false, "consent_document_unavailable");
      }

      const declined: ConsentDocumentSessionV1 = Object.freeze({
        ...located.session,
        decision: "declined",
        auto_popup_state: "suppressed",
      });
      if (!await this.#writeState(replaceSession(located.state, declined))) {
        return response(false, "consent_storage_blocked");
      }
      await this.#clearAttentionBestEffort(tabId);
      return response(true, "consent_declined");
    });
  }

  public startCapture(
    tabId: number,
    pageSessionId: string,
    studyMode: StudyMode = "unclassified",
  ): Promise<ConsentCommandResponse> {
    return this.#serialize(async () => {
      if (!isStudyMode(studyMode)) return response(false, "consent_capture_start_blocked");
      const located = await this.#locateCurrentSession(tabId, pageSessionId);
      if (located === null) {
        return response(false, "consent_session_not_found");
      }
      if (located === "storage_blocked") {
        return response(false, "consent_storage_blocked");
      }
      return await this.#startSession(located.state, located.session, studyMode, true);
    });
  }

  /** Changes only future answers in this current session; accepted evidence is immutable. */
  public setStudyMode(tabId: number, pageSessionId: string, mode: "normal" | "review"): Promise<ConsentCommandResponse> {
    return this.#serialize(async () => {
      if (mode !== "normal" && mode !== "review") return response(false, "study_mode_change_blocked");
      const located = await this.#locateCurrentSession(tabId, pageSessionId);
      if (located === null) return response(false, "consent_session_not_found");
      if (located === "storage_blocked") return response(false, "consent_storage_blocked");
      const session = located.session;
      if (session.decision !== "consented"
        || (session.capture_state !== "observing" && session.capture_state !== "paused")) {
        return response(false, "study_mode_change_blocked");
      }
      if (!await this.#documentIsCurrent(session)) return response(false, "consent_document_unavailable");
      const next = { ...session, study_mode: mode, classification_pending: false };
      // Retain a verified plan only when the existing review classification is retained.
      if (mode !== "review" || session.study_mode !== "review") delete next.review_plan_id;
      delete next.classification_attempts;
      delete next.classification_retry_after;
      if (!await this.#writeState(replaceSession(located.state, next))) return response(false, "consent_storage_blocked");
      // Pending initial/retry lookup completions already check these persisted conditions.
      if (next.capture_state === "observing") {
        try { await this.#ports.ui.showCapturing?.(tabId, mode); } catch { /* Advisory only. */ }
      }
      return response(true, "study_mode_changed");
    });
  }

  public stopCapture(tabId: number, pageSessionId: string): Promise<ConsentCommandResponse> {
    return this.#serialize(async () => {
      const located = await this.#locateCurrentSession(tabId, pageSessionId);
      if (located === null) return response(false, "consent_session_not_found");
      if (located === "storage_blocked") return response(false, "consent_storage_blocked");
      if (!await this.#documentIsCurrent(located.session)) return response(false, "consent_document_unavailable");
      if (located.session.decision !== "consented" || this.#ports.capture.stop === undefined) {
        return response(false, "consent_capture_stop_blocked");
      }
      const paused: ConsentDocumentSessionV1 = Object.freeze({
        ...located.session, capture_state: "paused", auto_popup_state: "suppressed",
      });
      // Revoke event acceptance before stopping the observer. A lost STOP response cannot resume it.
      if (!await this.#writeState(replaceSession(located.state, paused))) return response(false, "consent_storage_blocked");
      let stopped = false;
      try { stopped = await this.#ports.capture.stop(paused); } catch { /* Keep the persisted pause. */ }
      if (!stopped) {
        await this.#showAttentionBestEffort(tabId);
        return response(false, "consent_capture_stop_blocked");
      }
      await this.#clearAttentionBestEffort(tabId);
      return response(true, "consent_capture_paused");
    });
  }

  async #startSession(
    initialState: ConsentSessionStateV1,
    session: ConsentDocumentSessionV1,
    studyMode: StudyMode,
    requireActive: boolean,
  ): Promise<ConsentCommandResponse> {
      if (session.capture_state === "observing" && !session.classification_pending) {
        return response(true, "consent_capture_already_started");
      }
      if (!await this.#documentIsCurrent(session, requireActive)) {
        return response(false, "consent_document_unavailable");
      }

      const starting: ConsentDocumentSessionV1 = Object.freeze({
        ...session,
        study_mode: session.decision === "consented"
          ? session.study_mode ?? "unclassified" : studyMode,
        decision: "consented",
        capture_state: "starting",
        auto_popup_state: "suppressed",
      });
      let state = replaceSession(initialState, starting);
      if (!await this.#writeState(state)) {
        return response(false, "consent_storage_blocked");
      }

      let started: boolean;
      try {
        started = await this.#ports.capture.start(starting);
      } catch {
        started = false;
      }
      const settled: ConsentDocumentSessionV1 = Object.freeze({
        ...starting,
        capture_state: started ? "observing" : "not_started",
      });
      state = replaceSession(state, settled);
      if (!await this.#writeState(state)) {
        return response(false, "consent_storage_blocked");
      }
      if (!started) {
        await this.#showAttentionBestEffort(session.tab_id);
        return response(false, "consent_capture_start_blocked");
      }
      await this.#clearAttentionBestEffort(session.tab_id);
      try { await this.#ports.ui.showCapturing?.(session.tab_id, settled.study_mode ?? "unclassified"); }
      catch { /* The status badge is advisory. */ }
      return response(true, "consent_capture_started");
  }

  async #startAutomatic(
    state: ConsentSessionStateV1, session: ConsentDocumentSessionV1, input: ConsentReadyInput,
  ): Promise<ConsentCommandResponse | {completion: Promise<ConsentCommandResponse>}> {
    const started = await this.#startSession(state, session, session.study_mode ?? "unclassified", false);
    if (!started.ok || !session.classification_pending) return started;
    return { completion: this.#queueClassification(input).completion };
  }

  async #retryClassification(
    state: ConsentSessionStateV1, session: ConsentDocumentSessionV1, input: ConsentReadyInput,
  ): Promise<ConsentCommandResponse> {
    if (session.study_mode !== "unclassified" || session.decision !== "consented"
      || this.#classifications.has(`${input.sender.tab_id}:${input.page_session_id}`)
      || (session.classification_retry_after ?? 0) > this.#now()) {
      return response(true, "consent_ready_duplicate");
    }
    const attempts = Math.min((session.classification_attempts ?? 0) + 1, CLASSIFICATION_RETRY_DELAYS_MS.length);
    // Persist the deadline before lookup so worker restarts cannot turn health messages into a tight retry loop.
    const retry = { ...session, classification_attempts: attempts,
      classification_retry_after: this.#now() + this.#retryDelay(attempts) };
    if (!await this.#writeState(replaceSession(state, retry))) return response(false, "consent_storage_blocked");
    // Keep candidate acceptance on its current immutable context while this optional refresh runs.
    void this.#queueClassification(input, true).completion.catch(() => undefined);
    return response(true, "consent_ready_duplicate");
  }

  #queueClassification(input: ConsentReadyInput, retry = false): {
    readonly context: Promise<StudyCaptureContext>;
    readonly completion: Promise<ConsentCommandResponse>;
  } {
    const key = `${input.sender.tab_id}:${input.page_session_id}`;
    const existing = this.#classifications.get(key);
    if (existing !== undefined) return existing;
    const context = this.#resolveAutomaticContext(input);
    const task = context.then((context) => this.#serialize(async () => {
      const state = await this.#readState();
      if (state === null) return response(false, "consent_storage_blocked");
      const session = state.sessions.find(({ tab_id }) => tab_id === input.sender.tab_id);
      if (session === undefined || !sameDocument(session, input)) return response(false, "consent_document_unavailable");
      if (retry) {
        if (session.classification_pending || session.decision !== "consented"
          || session.capture_state !== "observing" || session.study_mode !== "unclassified") {
          return response(true, "consent_ready_duplicate");
        }
        if (!await this.#senderHasQuizRoute(input.sender) || !await this.#documentIsCurrent(session, false)) {
          return response(false, "consent_document_unavailable");
        }
      } else if (!session.classification_pending) return response(true, "consent_ready_duplicate");
      const settled = { ...session, study_mode: context.study_mode, classification_pending: false };
      // Remove any previous provisional plan association before assigning the resolved one.
      delete (settled as {review_plan_id?: string}).review_plan_id;
      delete settled.classification_attempts;
      delete settled.classification_retry_after;
      const attempts = retry ? session.classification_attempts ?? 1 : 1;
      const next = { ...settled, ...(context.review_plan_id === undefined ? {} : {review_plan_id: context.review_plan_id}),
        ...(context.study_mode === "unclassified" ? { classification_attempts: attempts,
          classification_retry_after: this.#now() + this.#retryDelay(attempts) } : {}) };
      if (!await this.#writeState(replaceSession(state, next))) return response(false, "consent_storage_blocked");
      if (next.capture_state === "observing") {
        try { await this.#ports.ui.showCapturing?.(next.tab_id, next.study_mode); } catch { /* Advisory only. */ }
      }
      return response(true, next.capture_state === "paused" ? "consent_ready_duplicate" : "consent_capture_started");
    }));
    const completion = task.finally(() => {
      if (this.#classifications.get(key)?.completion === completion) this.#classifications.delete(key);
    });
    const classification = { context, completion };
    this.#classifications.set(key, classification);
    return classification;
  }

  async #resolveAutomaticContext(input: ConsentReadyInput): Promise<StudyCaptureContext> {
    try {
      const resolver = this.#ports.automatic?.resolveStudyContext;
      if (resolver === undefined) return { study_mode: "normal" };
      const context = await resolver(input);
      return isStudyCaptureContext(context) ? context : { study_mode: "unclassified" };
    } catch { return { study_mode: "unclassified" }; }
  }

  #now(): number {
    return this.#ports.now?.() ?? Date.now();
  }

  #retryDelay(attempts: number): number {
    return CLASSIFICATION_RETRY_DELAYS_MS[attempts - 1] ?? 300_000;
  }

  async #senderHasQuizRoute(sender: ConsentSenderContext): Promise<boolean> {
    const registered = this.#ports.routes?.hasRegisteredQuizRoute;
    if (registered === undefined) return supportedSender(sender);
    if (!supportedSender(sender, true)) return false;
    try { return await registered.call(this.#ports.routes, sender); }
    catch { return false; }
  }

  public async isSenderConsented(sender: ConsentSenderContext): Promise<boolean> {
    return await this.getSenderStudyMode(sender) !== null;
  }

  public async getSenderStudyMode(sender: ConsentSenderContext): Promise<StudyMode | null> {
    return (await this.getSenderStudyContext(sender))?.study_mode ?? null;
  }

  public async getSenderStudyContext(sender: ConsentSenderContext): Promise<StudyCaptureContext | null> {
    const read = async (allowResolution: boolean): Promise<StudyCaptureContext | null | {completion: Promise<ConsentCommandResponse>}> => {
      if (!await this.#senderHasQuizRoute(sender)) return null;
      const state = await this.#readState();
      const session = state?.sessions.find(({ tab_id: tabId }) => tabId === sender.tab_id);
      if (session === undefined || !senderMatchesSession(sender, session) || session.decision !== "consented"
        || (session.capture_state !== "starting" && session.capture_state !== "observing")) return null;
      if (!await this.#documentIsCurrent(session, false)) return null;
      if (session.classification_pending) {
        return allowResolution ? { completion: this.#queueClassification({ sender, page_session_id: session.page_session_id }).completion } : null;
      }
      return { study_mode: session.study_mode ?? "unclassified",
        ...(session.review_plan_id === undefined ? {} : { review_plan_id: session.review_plan_id }) };
    };
    const initial = await this.#serialize(() => read(true));
    if (initial === null || !("completion" in initial)) return initial;
    await initial.completion;
    const settled = await this.#serialize(() => read(false));
    return settled === null || !("completion" in settled) ? settled : null;
  }

  /** Authenticate at arrival, then retain that context even if the page leaves during lookup. */
  public async getAcceptedCandidateContext(sender: ConsentSenderContext): Promise<StudyCaptureContext | null> {
    const accepted = await this.#serialize(async () => {
      if (!await this.#senderHasQuizRoute(sender)) return null;
      const state = await this.#readState();
      const session = state?.sessions.find(({ tab_id }) => tab_id === sender.tab_id);
      if (session === undefined || !senderMatchesSession(sender, session) || session.decision !== "consented"
        || (session.capture_state !== "starting" && session.capture_state !== "observing")) return null;
      if (!await this.#documentIsCurrent(session, false)) return null;
      if (session.classification_pending) {
        return this.#queueClassification({ sender, page_session_id: session.page_session_id });
      }
      return { study_mode: session.study_mode ?? "unclassified",
        ...(session.review_plan_id === undefined ? {} : {review_plan_id: session.review_plan_id}) };
    });
    if (accepted === null || !("context" in accepted)) return accepted;
    const context = await accepted.context;
    const settled = await accepted.completion;
    // A later route can remove this session, but cannot revoke an already authenticated answer.
    if (!settled.ok && settled.code !== "consent_document_unavailable") return null;
    return context;
  }

  async #attemptAutoPopup(
    state: ConsentSessionStateV1,
    session: ConsentDocumentSessionV1,
  ): Promise<ConsentCommandResponse> {
    let active: boolean;
    try {
      active = await this.#ports.ui.isTabActive(session.tab_id, session.window_id);
    } catch {
      active = false;
    }
    if (!active) {
      return response(true, "consent_ready_registered");
    }

    let present: boolean;
    try {
      present = await this.#ports.capture.probe(session);
    } catch {
      present = false;
    }
    if (!present) {
      const next = removeSession(state, session.tab_id);
      if (!await this.#writeState(next)) {
        return response(false, "consent_storage_blocked");
      }
      await this.#clearAttentionBestEffort(session.tab_id);
      return response(false, "consent_document_unavailable");
    }

    const attempted: ConsentDocumentSessionV1 = Object.freeze({
      ...session,
      auto_popup_state: "attempted",
    });
    let next = replaceSession(state, attempted);
    if (!await this.#writeState(next)) {
      return response(false, "consent_storage_blocked");
    }
    await this.#showAttentionBestEffort(session.tab_id);

    let stillActive: boolean;
    try {
      stillActive = await this.#ports.ui.isTabActive(session.tab_id, session.window_id);
    } catch {
      stillActive = false;
    }
    if (!stillActive) {
      const pending: ConsentDocumentSessionV1 = Object.freeze({
        ...attempted,
        auto_popup_state: "pending",
      });
      next = replaceSession(next, pending);
      if (!await this.#writeState(next)) {
        return response(false, "consent_storage_blocked");
      }
      await this.#clearAttentionBestEffort(session.tab_id);
      return response(true, "consent_ready_registered");
    }

    let opened: boolean;
    try {
      opened = await this.#ports.ui.openPopup(session.window_id);
    } catch {
      opened = false;
    }
    const settled: ConsentDocumentSessionV1 = Object.freeze({
      ...attempted,
      auto_popup_state: opened ? "opened" : "failed",
    });
    next = replaceSession(next, settled);
    if (!await this.#writeState(next)) {
      return response(false, "consent_storage_blocked");
    }
    if (opened) {
      await this.#clearAttentionBestEffort(session.tab_id);
      return response(true, "consent_popup_opened");
    }
    await this.#showAttentionBestEffort(session.tab_id);
    return response(false, "consent_popup_failed");
  }

  async #documentIsCurrent(session: ConsentDocumentSessionV1, requireActive = true): Promise<boolean> {
    try {
      if (requireActive && !await this.#ports.ui.isTabActive(session.tab_id, session.window_id)) {
        return false;
      }
      return await this.#ports.capture.probe(session);
    } catch {
      return false;
    }
  }

  async #locateCurrentSession(
    tabId: number,
    pageSessionId: string,
  ): Promise<
    | { readonly state: ConsentSessionStateV1; readonly session: ConsentDocumentSessionV1 }
    | "storage_blocked"
    | null
  > {
    if (!isSafeChromeId(tabId) || !isPageSessionId(pageSessionId)) {
      return null;
    }
    const state = await this.#readState();
    if (state === null) {
      return "storage_blocked";
    }
    const session = state.sessions.find(
      ({ tab_id: storedTabId }) => storedTabId === tabId,
    );
    return session?.page_session_id === pageSessionId
      ? { state, session }
      : null;
  }

  #clearTab(tabId: number): Promise<ConsentCommandResponse> {
    return this.#serialize(async () => {
      if (!isSafeChromeId(tabId)) {
        return response(false, "consent_session_not_found");
      }
      const state = await this.#readState();
      if (state === null) {
        return response(false, "consent_storage_blocked");
      }
      const exists = state.sessions.some(({ tab_id: storedTabId }) => storedTabId === tabId);
      if (!exists) {
        return response(true, "consent_session_not_found");
      }
      if (!await this.#writeState(removeSession(state, tabId))) {
        return response(false, "consent_storage_blocked");
      }
      await this.#clearAttentionBestEffort(tabId);
      return response(true, "consent_session_cleared");
    });
  }

  async #readState(): Promise<ConsentSessionStateV1 | null> {
    try {
      return restoreConsentSessionState(await this.#ports.store.read());
    } catch {
      return null;
    }
  }

  async #writeState(state: ConsentSessionStateV1): Promise<boolean> {
    try {
      await this.#ports.store.write(immutableConsentState(state));
      return true;
    } catch {
      return false;
    }
  }

  async #showAttentionBestEffort(tabId: number): Promise<void> {
    try {
      await this.#ports.ui.showAttention(tabId);
    } catch {
      // An unavailable toolbar surface must never start capture or widen permissions.
    }
  }

  async #clearAttentionBestEffort(tabId: number): Promise<void> {
    try {
      await this.#ports.ui.clearAttention(tabId);
    } catch {
      // Tab-specific action state is advisory and must not weaken the consent gate.
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
