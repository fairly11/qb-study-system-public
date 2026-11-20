import { NativeOutbox } from "./outbox.js";
import { NATIVE_APP, keys, record, trustedQbSender, uuid, validRoute, type MessageSender, type SafariBrowser } from "./protocol.js";

function popupSender(sender: MessageSender, browser: SafariBrowser): boolean {
  return sender.id === browser.runtime.id && sender.tab === undefined
    && sender.url === browser.runtime.getURL("popup.html");
}
export function startBackground(browser: SafariBrowser): void {
  const native = async (message: unknown): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([browser.runtime.sendNativeMessage(NATIVE_APP, message), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error("NATIVE_UNAVAILABLE")); }, 15_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const outbox = new NativeOutbox(browser.storage.local, native);
  let waking = false;
  const wakeWaiters: (() => void)[] = [];
  const wake = (): Promise<void> => {
    const requested = new Promise<void>((resolve) => { wakeWaiters.push(resolve); });
    if (!waking) {
      waking = true;
      // Each pass includes only the requests queued before its storage snapshot.
      // Later requests still get another pass, but cannot indefinitely delay the
      // response to a popup or recorder whose own pass has already completed.
      void Promise.resolve().then(async () => {
        try {
          while (wakeWaiters.length > 0) {
            const current = wakeWaiters.splice(0);
            try {
              await outbox.drain();
              // Durable ingest receipts do not depend on the network request.
              await native({ protocol_version: 1, command: "sync" });
            } catch { /* Preserve staged data; only a fresh wake requests another pass. */ }
            finally { for (const complete of current) complete(); }
          }
        } finally {
          // Clear inside the worker so no wake can join an already finished pass.
          waking = false;
        }
      });
    }
    return requested;
  };
  browser.runtime.onMessage.addListener((message, sender) => {
    if (!record(message) || !trustedQbSender(sender, browser.runtime.id) && !popupSender(sender, browser)) return undefined;
    if (message.command === "wake" && keys(message, ["command"])) {
      return wake().then(() => ({ ok: true }));
    }
    if (message.command === "event_status" && keys(message, ["command", "event_id"]) && uuid(message.event_id)) {
      return outbox.eventStatus(message.event_id).catch(() => undefined);
    }
    if (popupSender(sender, browser) && message.command === "study_mode" && keys(message, ["command", "route"]) && validRoute(message.route)) {
      return native({ protocol_version: 1, command: "study_mode", route: message.route }).then((response) => {
        if (!record(response) || response.ok !== true || response.protocol_version !== 1
          || !["normal", "review", "unclassified"].includes(String(response.study_mode))) return { ok: false };
        return { ok: true, study_mode: response.study_mode };
      }).catch(() => ({ ok: false }));
    }
    if (popupSender(sender, browser) && message.command === "status" && keys(message, ["command"])) {
      return native({ protocol_version: 1, command: "status" }).then(safeSummary).catch(() => ({ ok: false }));
    }
    return undefined;
  });
  // Background pages may be destroyed between calls. All pending events live
  // in storage, and a new page begins by replaying them with their original IDs.
  void wake();
}
export function safeSummary(value: unknown): unknown {
  const fields = ["saved", "pending", "confirmed", "blocked"] as const;
  if (!record(value) || value.protocol_version !== 1 || value.ok !== true
    || !fields.every((key) => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0)) return { ok: false };
  return { ok: true, saved: value.saved, pending: value.pending, confirmed: value.confirmed, blocked: value.blocked };
}
const global = globalThis as { browser?: SafariBrowser };
if (global.browser !== undefined) startBackground(global.browser);
