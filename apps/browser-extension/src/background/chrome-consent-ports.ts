import type {
  ConsentCaptureStartPort,
  ConsentDocumentSessionV1,
  ConsentSessionStateV1,
  ConsentSessionStorePort,
  ConsentUiPort,
  ConsentSenderContext,
} from "./consent-controller.js";
import {
  QB_QUIZ_CONSENT_PROBE_MESSAGE_KIND,
  START_CAPTURE_MESSAGE_KIND,
  STOP_CAPTURE_MESSAGE_KIND,
  QB_PAGE_ROUTE_PROBE_MESSAGE_KIND,
  type QbPageRouteDescriptor,
  type QbPageRouteProbeMessageV1,
} from "../shared/protocol.js";
import type { StudyRouteState, StudyRouteStore } from "./study-route-context.js";

export const CONSENT_SESSION_STORAGE_KEY = "qb_study_consent_sessions_v1";
export const CONSENT_PROBE_MESSAGE_KIND = QB_QUIZ_CONSENT_PROBE_MESSAGE_KIND;
export const CONSENT_START_CAPTURE_MESSAGE_KIND = START_CAPTURE_MESSAGE_KIND;
export const CONSENT_STOP_CAPTURE_MESSAGE_KIND = STOP_CAPTURE_MESSAGE_KIND;
export const STUDY_ROUTE_STORAGE_KEY = "qb_study_route_context_v1";
export const CONSENT_ATTENTION_BADGE_TEXT = "!";
export const CONSENT_ATTENTION_TITLE = "QB記録: 記録状態の確認が必要";
export const DEFAULT_ACTION_TITLE = "QB capture status";

interface ConsentProbeMessageV1 {
  readonly kind: typeof CONSENT_PROBE_MESSAGE_KIND;
  readonly page_session_id: string;
}

interface ConsentStartCaptureMessageV1 {
  readonly kind: typeof CONSENT_START_CAPTURE_MESSAGE_KIND;
  readonly page_session_id: string;
}
interface ConsentStopCaptureMessageV1 {
  readonly kind: typeof CONSENT_STOP_CAPTURE_MESSAGE_KIND;
  readonly page_session_id: string;
}

type ConsentContentCommandMessageV1 =
  | ConsentProbeMessageV1
  | ConsentStartCaptureMessageV1
  | ConsentStopCaptureMessageV1;

interface ConsentContentCommandResponseV1 {
  readonly ok: true;
  readonly code:
    | "consent_document_present"
    | "capture_started"
    | "capture_already_started"
    | "capture_stopped"
    | "capture_already_stopped";
}

interface StorageAreaLike {
  get(
    keys: string,
    callback: (items: Record<string, unknown>) => void,
  ): void;
  set(items: Record<string, unknown>, callback: () => void): void;
  setAccessLevel(options: {
    readonly accessLevel: "TRUSTED_CONTEXTS";
  }): Promise<void>;
}

interface ActionApiLike {
  readonly openPopup?: (
    options?: chrome.action.OpenPopupOptions,
  ) => Promise<void>;
  setBadgeText(details: chrome.action.BadgeTextDetails): Promise<void>;
  setBadgeBackgroundColor(
    details: chrome.action.BadgeColorDetails,
  ): Promise<void>;
  setTitle(details: chrome.action.TitleDetails): Promise<void>;
}

interface TabsQueryApiLike {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
}

interface TabsMessageApiLike {
  sendMessage(
    tabId: number,
    message: ConsentContentCommandMessageV1,
    options: chrome.tabs.MessageSendOptions,
  ): Promise<unknown>;
}

interface RouteProbeTabsApiLike {
  sendMessage(tabId: number, message: QbPageRouteProbeMessageV1, options: chrome.tabs.MessageSendOptions): Promise<unknown>;
}

function chromeOperationError(): Error {
  return new Error("CHROME_CONSENT_OPERATION_BLOCKED");
}

function runtimeHasLastError(): boolean {
  return typeof chrome !== "undefined"
    && chrome.runtime !== undefined
    && chrome.runtime.lastError !== undefined;
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

function isConsentContentResponse(
  value: unknown,
  expectedCodes: readonly ConsentContentCommandResponseV1["code"][],
): value is ConsentContentCommandResponseV1 {
  return isRecord(value)
    && hasExactKeys(value, ["ok", "code"])
    && value.ok === true
    && typeof value.code === "string"
    && expectedCodes.includes(value.code as ConsentContentCommandResponseV1["code"]);
}

function messageTarget(
  session: ConsentDocumentSessionV1,
): chrome.tabs.MessageSendOptions {
  return session.document_id === null
    ? { frameId: 0 }
    : { documentId: session.document_id };
}

export function consentSenderContextFromChrome(
  sender: chrome.runtime.MessageSender,
  pageSessionId?: string,
): ConsentSenderContext | null {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  const tabActive = sender.tab?.active;
  const frameId = sender.frameId;
  if (
    tabId === undefined
    || windowId === undefined
    || tabActive === undefined
    || frameId === undefined
  ) {
    return null;
  }
  return {
    tab_id: tabId,
    window_id: windowId,
    tab_active: tabActive,
    frame_id: frameId,
    ...(sender.origin === undefined ? {} : { origin: sender.origin }),
    ...(sender.url === undefined ? {} : { url: sender.url }),
    ...(sender.documentId === undefined ? {} : { document_id: sender.documentId }),
    ...(pageSessionId === undefined ? {} : { page_session_id: pageSessionId }),
  };
}

export function createChromeConsentSessionStorePort(
  storageArea: StorageAreaLike = chrome.storage.session,
): ConsentSessionStorePort {
  return {
    read(): Promise<unknown> {
      return new Promise((resolve, reject) => {
        storageArea.get(CONSENT_SESSION_STORAGE_KEY, (items) => {
          if (runtimeHasLastError()) {
            reject(chromeOperationError());
            return;
          }
          resolve(items[CONSENT_SESSION_STORAGE_KEY]);
        });
      });
    },
    write(state: ConsentSessionStateV1): Promise<void> {
      return new Promise((resolve, reject) => {
        storageArea.set({ [CONSENT_SESSION_STORAGE_KEY]: state }, () => {
          if (runtimeHasLastError()) {
            reject(chromeOperationError());
            return;
          }
          resolve();
        });
      });
    },
  };
}

export async function restrictChromeConsentStorageToTrustedContexts(
  storageArea: Pick<StorageAreaLike, "setAccessLevel"> = chrome.storage.session,
): Promise<void> {
  await storageArea.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

export function createChromeStudyRouteStorePort(
  storageArea: StorageAreaLike = chrome.storage.session,
): StudyRouteStore {
  return {
    read: () => new Promise((resolve, reject) => {
      storageArea.get(STUDY_ROUTE_STORAGE_KEY, (items) => {
        if (runtimeHasLastError()) reject(chromeOperationError());
        else resolve(items[STUDY_ROUTE_STORAGE_KEY]);
      });
    }),
    write: (state: StudyRouteState) => new Promise((resolve, reject) => {
      storageArea.set({ [STUDY_ROUTE_STORAGE_KEY]: state }, () => {
        if (runtimeHasLastError()) reject(chromeOperationError());
        else resolve();
      });
    }),
  };
}

/** Uses the already injected content script; does not require access to tabs.Tab.url. */
export function createChromeStudyRouteProbePort(
  tabsApi: RouteProbeTabsApiLike = chrome.tabs,
): (sender: ConsentSenderContext, route?: QbPageRouteDescriptor) => Promise<boolean> {
  return async (sender, route) => {
    if (sender.url === undefined || sender.frame_id !== 0
      || (route !== undefined && sender.document_id === undefined)) return false;
    try {
      const result = await tabsApi.sendMessage(sender.tab_id, {
        kind: QB_PAGE_ROUTE_PROBE_MESSAGE_KIND,
        ...(route === undefined ? { expected_url: sender.url } : { expected_route: route }),
      }, sender.document_id === undefined ? { frameId: 0 } : { documentId: sender.document_id });
      return isRecord(result) && hasExactKeys(result, ["ok", "code"])
        && result.ok === true && result.code === "study_route_current";
    } catch { return false; }
  };
}

export function createChromeConsentUiPort(
  actionApi: ActionApiLike = chrome.action,
  tabsApi: TabsQueryApiLike = chrome.tabs,
): ConsentUiPort {
  return {
    async isTabActive(tabId: number, windowId: number): Promise<boolean> {
      const tabs = await tabsApi.query({ active: true, windowId });
      return tabs.length === 1 && tabs[0]?.id === tabId;
    },
    async showAttention(tabId: number): Promise<void> {
      await Promise.all([
        actionApi.setBadgeText({
          tabId,
          text: CONSENT_ATTENTION_BADGE_TEXT,
        }),
        actionApi.setBadgeBackgroundColor({
          tabId,
          color: "#b45309",
        }),
        actionApi.setTitle({
          tabId,
          title: CONSENT_ATTENTION_TITLE,
        }),
      ]);
    },
    async clearAttention(tabId: number): Promise<void> {
      await Promise.all([
        actionApi.setBadgeText({ tabId, text: "" }),
        actionApi.setTitle({ tabId, title: DEFAULT_ACTION_TITLE }),
      ]);
    },
    async showCapturing(tabId, mode): Promise<void> {
      const label = mode === "review" ? "復習" : mode === "normal" ? "記録" : "?";
      await Promise.all([
        actionApi.setBadgeText({ tabId, text: label }),
        actionApi.setBadgeBackgroundColor({ tabId, color: mode === "unclassified" ? "#b45309" : "#047857" }),
        actionApi.setTitle({ tabId, title: mode === "review" ? "QB記録: 復習として記録中"
          : mode === "normal" ? "QB記録: 通常学習として記録中" : "QB記録: 目的を確認できないため未分類で記録中" }),
      ]);
    },
    async openPopup(windowId: number): Promise<boolean> {
      const openPopup = actionApi.openPopup;
      if (typeof openPopup !== "function") {
        return false;
      }
      try {
        await openPopup.call(actionApi, { windowId });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createChromeConsentCaptureStartPort(
  tabsApi: TabsMessageApiLike = chrome.tabs,
): ConsentCaptureStartPort {
  const send = async (
    session: ConsentDocumentSessionV1,
    message: ConsentContentCommandMessageV1,
  ): Promise<unknown> => await tabsApi.sendMessage(
    session.tab_id,
    message,
    messageTarget(session),
  );

  return {
    async probe(session: ConsentDocumentSessionV1): Promise<boolean> {
      try {
        const result = await send(session, {
          kind: CONSENT_PROBE_MESSAGE_KIND,
          page_session_id: session.page_session_id,
        });
        return isConsentContentResponse(
          result,
          ["consent_document_present"],
        );
      } catch {
        return false;
      }
    },
    async start(session: ConsentDocumentSessionV1): Promise<boolean> {
      try {
        const result = await send(session, {
          kind: CONSENT_START_CAPTURE_MESSAGE_KIND,
          page_session_id: session.page_session_id,
        });
        return isConsentContentResponse(
          result,
          ["capture_started", "capture_already_started"],
        );
      } catch {
        return false;
      }
    },
    async stop(session: ConsentDocumentSessionV1): Promise<boolean> {
      try {
        const result = await send(session, {
          kind: CONSENT_STOP_CAPTURE_MESSAGE_KIND,
          page_session_id: session.page_session_id,
        });
        return isConsentContentResponse(result, ["capture_stopped", "capture_already_stopped"]);
      } catch { return false; }
    },
  };
}
