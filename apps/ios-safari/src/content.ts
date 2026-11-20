import { QbQuizAttemptAdapter } from "../../browser-extension/src/adapters/qb-quiz-adapter.js";
import { isTrustedQbSubmission } from "../../browser-extension/src/adapters/qb-quiz-submit.js";
import { SafariCapture } from "./capture.js";
import { StagingWriter, type DeliveryState } from "./outbox.js";
import { QB_ORIGIN, RECEIPT_PREFIX, keys, record, receipt, type MessageSender, type SafariBrowser } from "./protocol.js";
import { RouteTracker } from "./routes.js";

const labels: Record<DeliveryState, string> = {
  saving: "保存処理中（未確認）",
  web_saved: "Safari保存済み・アプリへ転送待ち",
  local_saved: "端末保存済み・Notion送信待ち",
  notion_confirmed: "Notion確認済み",
  save_failed: "保存失敗・この画面で再試行中",
};
export interface ContentOptions {
  readonly document: Document;
  readonly window: Window;
  readonly browser: SafariBrowser;
  readonly newId?: () => string;
  readonly now?: () => Date;
  readonly trustedSubmission?: (document: Document, event: Event) => boolean;
}
export function startContent(options: ContentOptions): { disconnect(): void; inspect(): void } {
  const { document, window, browser } = options;
  if (window.location.origin !== QB_ORIGIN || window.top !== window) return { disconnect: () => undefined, inspect: () => undefined };
  const navigation = window.performance.getEntriesByType("navigation");
  const firstNavigation = navigation.length === 1 ? navigation[0] as PerformanceNavigationTiming | undefined : undefined;
  const routes = new RouteTracker(options.newId ?? (() => crypto.randomUUID()), {
    referrer: document.referrer, navigationType: firstNavigation?.type ?? "unknown",
  });
  const adapter = new QbQuizAttemptAdapter();
  const capture = new SafariCapture(adapter, options.newId, options.now);
  let hidden = false;
  let stopped = false;
  let latestId: string | undefined;
  let latestDelivery: DeliveryState | undefined;
  const unsavedIds = new Set<string>();
  let unsupported = false;
  let host: HTMLDivElement | undefined;
  let label: HTMLSpanElement | undefined;
  const draw = (): void => {
    if (document.body === null) return;
    if (host === undefined || !host.isConnected) {
      host = document.createElement("div");
      host.setAttribute("data-qb-ios-status", "");
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = ":host{all:initial;position:fixed;right:8px;bottom:max(8px,env(safe-area-inset-bottom));z-index:2147483647;pointer-events:none}span{display:block;max-width:80vw;padding:5px 9px;background:#172d40;color:white;border-radius:8px;font:12px/1.4 -apple-system,sans-serif;box-shadow:0 2px 8px #0003}";
      label = document.createElement("span");
      label.setAttribute("role", "status");
      shadow.append(style, label);
      document.body.append(host);
    }
    const active = window.location.pathname === "/quiz";
    host.hidden = !active && unsavedIds.size === 0;
    const text = [unsupported ? "画面形式を確認できません" : latestDelivery === undefined ? "QB記録：解答を待機中" : "",
      latestDelivery === undefined ? "" : labels[latestDelivery],
      unsavedIds.size === 0 ? "" : `未保存の解答が${unsavedIds.size}件あります。この画面を閉じないでください`].filter(Boolean).join(" ／ ");
    if (label !== undefined && label.textContent !== text) label.textContent = text;
  };
  const wake = (): Promise<unknown> => browser.runtime.sendMessage({ command: "wake" });
  const writer = new StagingWriter(browser.storage.local, wake, (eventId, state) => {
    // A later answer or a retry beginning cannot acknowledge an older write.
    if (state === "web_saved") unsavedIds.delete(eventId);
    else if (state === "saving" || state === "save_failed") unsavedIds.add(eventId);
    if (eventId === latestId && latestDelivery !== "notion_confirmed"
      && !(latestDelivery === "local_saved" && state !== "notion_confirmed")) latestDelivery = state;
    draw();
  });
  const updateReceipt = async (): Promise<void> => {
    const eventId = latestId;
    if (eventId === undefined) return;
    try {
      const key = `${RECEIPT_PREFIX}${eventId}`;
      const value = (await browser.storage.local.get(key))[key];
      if (receipt(value, eventId) && eventId === latestId && latestDelivery !== "notion_confirmed") { latestDelivery = value.status; draw(); }
    } catch { /* An unreadable receipt never changes the last confirmed status. */ }
  };
  const inspect = (): void => {
    if (hidden || stopped) return;
    const route = routes.update(window.location.href);
    if (route === undefined) { capture.reset(); draw(); return; }
    const output = capture.inspect(document, route);
    unsupported = output.state === "unsupported";
    if (output.staged !== undefined) {
      latestId = output.staged.event.event_id; latestDelivery = undefined;
      void writer.stage(output.staged).catch(() => undefined);
    }
    draw();
  };
  const onMessage = (message: unknown, sender: MessageSender): Promise<unknown> | undefined => {
    if (stopped || hidden || sender.id !== browser.runtime.id || sender.tab !== undefined
      || sender.url !== browser.runtime.getURL("popup.html") || !record(message)) return undefined;
    const route = routes.update(window.location.href);
    if (message.command === "study_route" && keys(message, ["command"])) {
      return Promise.resolve(route === undefined ? { ok: false } : { ok: true, route });
    }
    if (message.command !== "set_study_mode" || !keys(message, ["command", "quiz_id", "study_mode"])
      || (message.study_mode !== "normal" && message.study_mode !== "review")) return undefined;
    if (route === undefined || route.quiz_id !== message.quiz_id) return Promise.resolve({ ok: false });
    routes.setStudyMode(route.quiz_id, message.study_mode);
    return Promise.resolve({ ok: true, route: routes.update(window.location.href) });
  };
  const onClick = (event: Event): void => {
    if (hidden || stopped) return;
    const route = routes.update(window.location.href);
    if (route !== undefined && (options.trustedSubmission ?? isTrustedQbSubmission)(document, event)) capture.submit(document, route);
  };
  const onHide = (): void => {
    // Resolve and start storage synchronously if the answer mounted immediately
    // before pagehide. No pending storage promise or retry entry is cleared.
    inspect(); hidden = true;
    // BFCache keeps this isolated document and its trusted-submit evidence.
    // Resume checks the route and question again before using it. A new document
    // starts a new controller and never inherits an armed submission.
  };
  const resume = (): void => {
    hidden = false; inspect();
    void writer.retry();
    void wake().catch(() => undefined);
    void updateReceipt();
  };
  const onVisibility = (): void => { if (document.visibilityState === "visible") resume(); else inspect(); };
  const onStorage = (): void => { void updateReceipt(); };
  const Observer = document.defaultView?.MutationObserver;
  if (Observer === undefined) return { disconnect: () => undefined, inspect: () => undefined };
  const observer = new Observer(inspect);
  observer.observe(document.documentElement ?? document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...adapter.observedAttributeNames] });
  browser.runtime.onMessage.addListener(onMessage);
  document.addEventListener("click", onClick, true);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", resume);
  window.addEventListener("popstate", inspect);
  window.addEventListener("hashchange", inspect);
  browser.storage.onChanged.addListener(onStorage);
  const locationTimer = window.setInterval(inspect, 1_000);
  const retryTimer = window.setInterval(() => {
    if (hidden || document.visibilityState === "hidden") return;
    void writer.retry();
    void wake().catch(() => undefined);
    if (latestId !== undefined) void browser.runtime.sendMessage({ command: "event_status", event_id: latestId }).catch(() => undefined);
  }, 15_000);
  resume();
  return { inspect, disconnect: () => {
    stopped = true; observer.disconnect();
    browser.runtime.onMessage.removeListener?.(onMessage);
    window.clearInterval(locationTimer); window.clearInterval(retryTimer);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onHide); window.removeEventListener("pageshow", resume);
    window.removeEventListener("popstate", inspect); window.removeEventListener("hashchange", inspect);
    browser.storage.onChanged.removeListener(onStorage);
    host?.remove();
  } };
}
const global = globalThis as { browser?: SafariBrowser; document?: Document; window?: Window; qbIosRecorderStarted?: boolean };
if (global.browser !== undefined && global.document !== undefined && global.window !== undefined && global.qbIosRecorderStarted !== true) {
  global.qbIosRecorderStarted = true;
  startContent({ browser: global.browser, document: global.document, window: global.window });
}
