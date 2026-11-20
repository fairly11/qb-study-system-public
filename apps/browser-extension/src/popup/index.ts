import {
  GET_POPUP_STATUS_MESSAGE_KIND,
  GET_TAB_CONSENT_STATUS_MESSAGE_KIND,
  RETRY_OUTBOX_MESSAGE_KIND,
  SET_COLLECTOR_ENDPOINT_MESSAGE_KIND,
  SET_TAB_CONSENT_MESSAGE_KIND,
  SET_STUDY_MODE_MESSAGE_KIND,
  STOP_TAB_CAPTURE_MESSAGE_KIND,
  isPopupStatusV1,
  isTabConsentStatusV1,
  type PopupRequestMessageV1,
  type PopupStatusV1,
  type TabConsentStatusV1,
} from "../shared/protocol.js";
import { runPopupCommand } from "./command-runner.js";
import { renderRecentAttempts } from "./recent-attempts-view.js";

const captureState = requireElement("capture-state", HTMLSpanElement);
const outboxCount = requireElement("outbox-count", HTMLSpanElement);
const collectorEndpoint = requireElement("collector-endpoint", HTMLInputElement);
const deliveryState = requireElement("delivery-state", HTMLSpanElement);
const lastDiagnosticCode = requireElement(
  "last-diagnostic-code",
  HTMLSpanElement,
);
const lastCaptureIssueCode = requireElement(
  "last-capture-issue-code",
  HTMLSpanElement,
);
const consentState = requireElement("consent-state", HTMLParagraphElement);
const startCaptureButton = requireElement("start-capture", HTMLButtonElement);
const stopCaptureButton = requireElement("stop-capture", HTMLButtonElement);
const normalStudyButton = requireElement("set-normal-study", HTMLButtonElement);
const reviewStudyButton = requireElement("set-review-study", HTMLButtonElement);
const retryOutboxButton = requireElement("retry-outbox", HTMLButtonElement);
const saveEndpointButton = requireElement("save-endpoint", HTMLButtonElement);
const commandStatus = requireElement("command-status", HTMLParagraphElement);
const recentAttempts = requireElement("recent-attempts", HTMLUListElement);
const recentAttemptsEmpty = requireElement(
  "recent-attempts-empty",
  HTMLParagraphElement,
);

const commandControls = [
  startCaptureButton,
  stopCaptureButton,
  normalStudyButton,
  reviewStudyButton,
  retryOutboxButton,
  saveEndpointButton,
] as const;

let popupBusy = true;
let activeTabId: number | undefined;
let currentConsentStatus: TabConsentStatusV1 = {
  state: "unavailable",
  page_session_id: null,
};

function requireElement<T extends HTMLElement>(
  id: string,
  constructor: { new (): T },
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new TypeError(`Missing popup control: ${id}`);
  }
  return element;
}

function renderStatus(status: PopupStatusV1): void {
  captureState.textContent = status.capture_state;
  outboxCount.textContent = String(status.outbox_count);
  collectorEndpoint.value = status.collector_endpoint;
  deliveryState.textContent = status.delivery_state;
  lastDiagnosticCode.textContent = status.last_diagnostic_code ?? "none";
  lastCaptureIssueCode.textContent = status.last_capture_issue_code ?? "none";
  renderRecentAttempts({
    document,
    list: recentAttempts,
    emptyState: recentAttemptsEmpty,
  }, status);
}

function studyModeLabel(mode: TabConsentStatusV1["study_mode"]): string {
  return mode === "review" ? "復習課題" : mode === "normal" ? "通常学習" : "判定未確認";
}

function renderConsent(status: TabConsentStatusV1): void {
  currentConsentStatus = status;
  switch (status.state) {
    case "pending":
      consentState.textContent = "記録の開始を確認しています。開始できない場合は「記録を再開」を押してください。";
      break;
    case "declined":
    case "paused":
      consentState.textContent = `この演習の記録は一時停止中です。学習区分：${studyModeLabel(status.study_mode)}。「記録を再開」で再開できます。`;
      break;
    case "capturing": {
      const label = studyModeLabel(status.study_mode);
      consentState.textContent = `このページの解答結果を「${label}」として自動記録中です。`;
      break;
    }
    case "unavailable":
      consentState.textContent = "このタブの記録状態を確認できません。QBの問題画面を開いている場合は、ページを再読み込みして状態を確認してください。";
      break;
  }
  updateControls();
}

function renderCommandCode(code: string): void {
  commandStatus.textContent = code === "study_mode_changed"
    ? "学習区分を変更しました。これからの解答に適用します。" : code;
}

function updateControls(): void {
  collectorEndpoint.disabled = popupBusy;
  retryOutboxButton.disabled = popupBusy;
  saveEndpointButton.disabled = popupBusy;
  const consentUnavailable = currentConsentStatus.state === "unavailable"
    || currentConsentStatus.state === "capturing";
  startCaptureButton.disabled = popupBusy || consentUnavailable;
  stopCaptureButton.disabled = popupBusy || currentConsentStatus.state !== "capturing";
  const canChoose = currentConsentStatus.state === "capturing" || currentConsentStatus.state === "paused";
  normalStudyButton.disabled = popupBusy || !canChoose;
  reviewStudyButton.disabled = popupBusy || !canChoose;
  normalStudyButton.setAttribute("aria-pressed", String(currentConsentStatus.study_mode === "normal"));
  reviewStudyButton.setAttribute("aria-pressed", String(currentConsentStatus.study_mode === "review"));
}

function setBusy(busy: boolean): void {
  popupBusy = busy;
  for (const control of commandControls) {
    control.disabled = busy;
  }
  updateControls();
}

async function sendRuntimeMessage(
  message: PopupRequestMessageV1,
): Promise<unknown> {
  return await chrome.runtime.sendMessage(message) as unknown;
}

async function getActiveTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs.length === 1 ? tabs[0]?.id : undefined;
  if (tabId === undefined || !Number.isSafeInteger(tabId) || tabId < 0) {
    throw new TypeError("ACTIVE_TAB_UNAVAILABLE");
  }
  return tabId;
}

async function refreshDeliveryStatus(): Promise<boolean> {
  try {
    const response = await sendRuntimeMessage({
      kind: GET_POPUP_STATUS_MESSAGE_KIND,
    });
    if (!isPopupStatusV1(response)) {
      renderCommandCode("popup_status_response_invalid");
      return false;
    }
    renderStatus(response);
    return true;
  } catch {
    renderCommandCode("popup_runtime_unavailable");
    return false;
  }
}

async function refreshConsentStatus(): Promise<boolean> {
  if (activeTabId === undefined) {
    renderConsent({ state: "unavailable", page_session_id: null });
    return false;
  }
  try {
    const response = await sendRuntimeMessage({
      kind: GET_TAB_CONSENT_STATUS_MESSAGE_KIND,
      tab_id: activeTabId,
    });
    if (!isTabConsentStatusV1(response)) {
      renderConsent({ state: "unavailable", page_session_id: null });
      renderCommandCode("consent_status_response_invalid");
      return false;
    }
    renderConsent(response);
    return true;
  } catch {
    renderConsent({ state: "unavailable", page_session_id: null });
    renderCommandCode("popup_runtime_unavailable");
    return false;
  }
}

async function refreshAllStatus(): Promise<boolean> {
  const [deliveryReady, consentReady] = await Promise.all([
    refreshDeliveryStatus(),
    refreshConsentStatus(),
  ]);
  return deliveryReady && consentReady;
}

async function runCommand(message: PopupRequestMessageV1): Promise<void> {
  await runPopupCommand(message, {
    setBusy,
    renderCode: renderCommandCode,
    sendMessage: sendRuntimeMessage,
    refreshAllStatus,
  });
}

function consentCommand(decision: "start" | "stop"): void {
  if (activeTabId === undefined || currentConsentStatus.page_session_id === null
    || currentConsentStatus.state === "unavailable") {
    renderCommandCode("capture_consent_unavailable");
    return;
  }
  if (decision === "stop") {
    void runCommand({ kind: STOP_TAB_CAPTURE_MESSAGE_KIND, tab_id: activeTabId,
      page_session_id: currentConsentStatus.page_session_id });
    return;
  }
  void runCommand({ kind: SET_TAB_CONSENT_MESSAGE_KIND, tab_id: activeTabId,
    page_session_id: currentConsentStatus.page_session_id, decision: "start" });
}

function chooseStudyMode(mode: "normal" | "review"): void {
  if (popupBusy || activeTabId === undefined || currentConsentStatus.page_session_id === null
    || (currentConsentStatus.state !== "capturing" && currentConsentStatus.state !== "paused")) return;
  void runCommand({ kind: SET_STUDY_MODE_MESSAGE_KIND, tab_id: activeTabId,
    page_session_id: currentConsentStatus.page_session_id, study_mode: mode });
}

normalStudyButton.addEventListener("click", () => { chooseStudyMode("normal"); });
reviewStudyButton.addEventListener("click", () => { chooseStudyMode("review"); });
startCaptureButton.addEventListener("click", () => { consentCommand("start"); });
stopCaptureButton.addEventListener("click", () => { consentCommand("stop"); });

retryOutboxButton.addEventListener("click", () => {
  void runCommand({ kind: RETRY_OUTBOX_MESSAGE_KIND });
});

saveEndpointButton.addEventListener("click", () => {
  void runCommand({
    kind: SET_COLLECTOR_ENDPOINT_MESSAGE_KIND,
    endpoint: collectorEndpoint.value.trim(),
  });
});

setBusy(true);
void (async () => {
  try {
    activeTabId = await getActiveTabId();
  } catch {
    activeTabId = undefined;
  }
  if (await refreshAllStatus()) {
    renderCommandCode("popup_ready");
  }
})().finally(() => {
  setBusy(false);
});
