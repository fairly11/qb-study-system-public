import {
  createChromeRetrySchedulerPort,
  createChromeStoragePort,
  createFetchCollectorTransportPort,
  restrictChromeStorageToTrustedContexts,
  createSystemClockPort,
} from "./chrome-ports.js";
import {
  consentSenderContextFromChrome,
  createChromeConsentCaptureStartPort,
  createChromeConsentSessionStorePort,
  createChromeConsentUiPort,
  createChromeStudyRouteStorePort,
  createChromeStudyRouteProbePort,
  restrictChromeConsentStorageToTrustedContexts,
} from "./chrome-consent-ports.js";
import {
  ConsentController,
  isConsentDocumentLifecycleStatus,
} from "./consent-controller.js";
import { BackgroundCore } from "./core.js";
import { BackgroundMessageRouter } from "./message-router.js";
import { createRetryableReadiness } from "./readiness.js";
import { createBoundedRecovery } from "./runtime-recovery.js";
import { RETRY_ALARM_NAME } from "./types.js";
import { StudyRouteContext } from "./study-route-context.js";
import { createReviewSetLookup } from "./review-set-lookup.js";
import {
  GET_TAB_CONSENT_STATUS_MESSAGE_KIND,
  SET_TAB_CONSENT_MESSAGE_KIND,
  STOP_TAB_CAPTURE_MESSAGE_KIND,
  isQbPageRouteMessageV1,
  isPopupRequestMessageV1,
  isQbQuizBootstrapReadyMessageV1,
  isQbQuizCaptureMessageV1,
} from "../shared/protocol.js";

const core = new BackgroundCore({
  storage: createChromeStoragePort(),
  clock: createSystemClockPort(),
  scheduler: createChromeRetrySchedulerPort(),
  transport: createFetchCollectorTransportPort(),
});
const routes = new StudyRouteContext({
  store: createChromeStudyRouteStorePort(),
  isCurrent: createChromeStudyRouteProbePort(),
  lookup: createReviewSetLookup(async () => (await core.getPopupStatus()).collector_endpoint),
});
const consent = new ConsentController({
  store: createChromeConsentSessionStorePort(),
  ui: createChromeConsentUiPort(),
  capture: createChromeConsentCaptureStartPort(),
  routes,
  automatic: { resolveStudyContext: async ({ sender }) => await routes.resolve(sender) },
});
const messageRouter = new BackgroundMessageRouter(core, consent);

function isStorageBlockedResponse(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && "ok" in value
    && value.ok === false
    && "code" in value
    && value.code === "storage_state_blocked";
}

const ensureConsentReady = createRetryableReadiness(
  async (): Promise<boolean> => {
    try {
      await restrictChromeConsentStorageToTrustedContexts();
      return true;
    } catch {
      return false;
    }
  },
);

const ensureCoreReady = createRetryableReadiness(
  async (): Promise<boolean> => {
    try {
      await restrictChromeStorageToTrustedContexts();
      const initialized = await core.initialize();
      return initialized.ok;
    } catch {
      return false;
    }
  },
);

async function ensureReady(): Promise<boolean> {
  const [consentReady, coreReady] = await Promise.all([
    ensureConsentReady(),
    ensureCoreReady(),
  ]);
  return consentReady && coreReady;
}

async function ensureMessageReady(message: unknown): Promise<boolean> {
  if (isQbQuizBootstrapReadyMessageV1(message) || isQbPageRouteMessageV1(message)) {
    return await ensureReady();
  }
  if (isQbQuizCaptureMessageV1(message)) {
    return await ensureReady();
  }
  if (isPopupRequestMessageV1(message)) {
    if (message.kind === GET_TAB_CONSENT_STATUS_MESSAGE_KIND) {
      return await ensureConsentReady();
    }
    if (message.kind === STOP_TAB_CAPTURE_MESSAGE_KIND) return await ensureConsentReady();
    if (
      message.kind === SET_TAB_CONSENT_MESSAGE_KIND
      && message.decision === "decline"
    ) {
      return await ensureConsentReady();
    }
    if (message.kind === SET_TAB_CONSENT_MESSAGE_KIND) {
      return await ensureReady();
    }
  }
  return await ensureCoreReady();
}

const requestSchedulerRecovery = createBoundedRecovery(
  async (): Promise<boolean> => {
    if (!await ensureReady()) {
      return false;
    }
    const initialized = await core.initialize();
    return initialized.ok;
  },
  {
    delayMilliseconds: 1_000,
    maxAttempts: 3,
    schedule: (callback, delayMilliseconds) => (
      globalThis.setTimeout(callback, delayMilliseconds)
    ),
  },
);

void ensureReady().then((ready) => {
  if (!ready) {
    requestSchedulerRecovery();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void ensureMessageReady(message).then((ready) => (
    ready
      ? messageRouter.handleMessage(message, {
        consent_context: consentSenderContextFromChrome(sender),
        extension_page: sender.tab === undefined && sender.id === chrome.runtime.id,
      })
      : { ok: false as const, code: "background_internal_blocked" }
  )).then(
    (messageResponse) => {
      if (isStorageBlockedResponse(messageResponse)) {
        requestSchedulerRecovery();
      }
      sendResponse(messageResponse);
    },
    () => {
      requestSchedulerRecovery();
      sendResponse({ ok: false, code: "background_internal_blocked" });
    },
  );
  return true;
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void ensureConsentReady().then(async (ready) => {
    if (ready) {
      await consent.handleTabActivated(tabId, windowId);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!isConsentDocumentLifecycleStatus(changeInfo.status)) {
    return;
  }
  void ensureConsentReady().then(async (ready) => {
    if (ready) {
      await consent.reconcileTabDocument(tabId);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ensureConsentReady().then(async (ready) => {
    if (ready) {
      await consent.handleTabRemoved(tabId);
    }
  });
});

chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
  void ensureConsentReady().then(async (ready) => {
    if (ready) {
      await consent.handleTabRemoved(removedTabId);
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM_NAME) {
    void ensureReady().then(async (ready) => {
      if (!ready) {
        requestSchedulerRecovery();
        return;
      }
      const result = await core.processDueOutbox();
      if (!result.ok) {
        requestSchedulerRecovery();
      }
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureReady().then((ready) => {
    if (!ready) {
      requestSchedulerRecovery();
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  void ensureReady().then((ready) => {
    if (!ready) {
      requestSchedulerRecovery();
    }
  });
});
