import { readFileSync } from "node:fs";
import { Window as TestWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QbQuizAttemptAdapter } from "../../browser-extension/src/adapters/qb-quiz-adapter.js";
import { QB_QUIZ_DOM_CONTRACT } from "../../browser-extension/src/adapters/qb-quiz-dom-contract.js";
import { isTrustedQbSubmission } from "../../browser-extension/src/adapters/qb-quiz-submit.js";
import { startContent } from "../src/content.js";
import { EVENT_PREFIX, RECEIPT_PREFIX, type MessageSender, type SafariBrowser } from "../src/protocol.js";
import { MemoryStorage } from "./helpers.js";

const windows: TestWindow[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const window of windows.splice(0)) await window.happyDOM.close(); });
function fixture(name: string): string { return readFileSync(new URL(`../../../tests/fixtures/browser-extension/qb-quiz-${name}.html`, import.meta.url), "utf8"); }
function setup(path = "/quiz", initial = "pending") {
  const window = new TestWindow({ url: `https://qb.medilink-study.com${path}` }); windows.push(window);
  const document = window.document as unknown as Document;
  document.write(fixture(initial));
  const attachShadow = window.HTMLElement.prototype.attachShadow;
  vi.spyOn(window.HTMLElement.prototype, "attachShadow").mockImplementation(function (this: typeof window.document.body, init) {
    return attachShadow.call(this, { ...init, mode: "open" });
  });
  const storageListeners = new Set<() => void>();
  const storage = new MemoryStorage();
  const messages: unknown[] = [];
  let listener: ((message: unknown, sender: MessageSender) => Promise<unknown> | undefined) | undefined;
  const browser = {
    runtime: { id: "synthetic-extension", getURL: (path: string) => `safari-web-extension://synthetic-extension/${path}`,
      onMessage: { addListener: (value: typeof listener) => { listener = value; }, removeListener: () => { listener = undefined; } }, sendMessage: async (message: unknown) => { messages.push(message); return { ok: true }; } },
    storage: { local: storage, onChanged: { addListener: (listener: () => void) => { storageListeners.add(listener); }, removeListener: (listener: () => void) => { storageListeners.delete(listener); } } },
  } as unknown as SafariBrowser;
  let counter = 0;
  let trust = true;
  const handle = startContent({ window: window as unknown as Window, document, browser,
    newId: () => `10000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    now: () => new Date("2026-10-25T00:00:00Z"),
    // Synthetic events cannot forge isTrusted in a real browser. The recognizer
    // below is verified separately against browser-owned trust metadata.
    trustedSubmission: (doc, event) => isTrustedQbSubmission(doc, { type: event.type, target: event.target, isTrusted: trust } as Event),
  });
  const render = (name: string): void => { document.body.innerHTML = new window.DOMParser().parseFromString(fixture(name), "text/html").body.innerHTML; };
  return { window, document, storage, messages, handle, render,
    command: (message: unknown, sender: MessageSender = { id: "synthetic-extension", url: "safari-web-extension://synthetic-extension/popup.html" }) => listener?.(message, sender),
    status: () => document.querySelector("[data-qb-ios-status]")?.shadowRoot?.querySelector("span")?.textContent,
    storageChanged: () => { for (const listener of storageListeners) listener(); },
    trust: (value: boolean) => { trust = value; } };
}
function submit(document: Document): HTMLButtonElement {
  const card = document.querySelector(QB_QUIZ_DOM_CONTRACT.selectors.questionCard)!;
  card.querySelectorAll("button")[1]!.classList.add("border-qb-green", "text-qb-green");
  const layout = document.createElement("div"); layout.className = "grid grid-cols-3 p-1 py-3";
  const wrapper = document.createElement("div"); const button = document.createElement("button"); button.textContent = "解答する";
  wrapper.append(button); layout.append(wrapper); card.parentElement!.append(layout); return button;
}
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe("Safari document lifecycle", () => {
  it("auto-starts on SPA quiz entry, captures continuous answers, and allows same-question genuine retry", async () => {
    const env = setup("/search?questionSetId=synthetic-set");
    env.window.history.pushState({}, "", "/quiz?questionId=1");
    submit(env.document).click(); env.render("correct"); env.handle.inspect(); await flush();
    env.render("next-pending"); submit(env.document).click(); env.render("next-correct"); env.handle.inspect(); await flush();
    env.render("next-pending"); submit(env.document).click(); env.render("next-correct"); env.handle.inspect(); await flush();
    const events = Object.entries(env.storage.data).filter(([key]) => key.startsWith(EVENT_PREFIX)).map(([, value]) => value);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ route: { entry_source: "observed_navigation", set_id: "synthetic-set" }, event: { question_key: "119A12" } });
    expect(events[1]).toMatchObject({ event: { question_key: "119A13" } });
    expect(events[2]).toMatchObject({ event: { question_key: "119A13" } });
    env.handle.disconnect();
  });
  it("accepts manual selection only from the popup for the current exercise and snapshots each submission", async () => {
    const env = setup();
    const first = await env.command({ command: "study_route" }) as { route: { quiz_id: string } };
    const command = { command: "set_study_mode", quiz_id: first.route.quiz_id, study_mode: "review" };
    expect(env.command(command, { id: "other", url: "safari-web-extension://synthetic-extension/popup.html" })).toBeUndefined();
    expect(env.command(command, { id: "synthetic-extension", url: "https://qb.medilink-study.com/quiz", tab: { id: 1 } })).toBeUndefined();
    expect(env.command({ ...command, study_mode: "unclassified" })).toBeUndefined();
    expect(await env.command({ ...command, quiz_id: "stale" })).toEqual({ ok: false });
    expect(await env.command(command)).toMatchObject({ ok: true, route: { manual_study_mode: "review" } });
    submit(env.document).click();
    await env.command({ ...command, study_mode: "normal" });
    env.render("correct"); env.handle.inspect(); await flush();
    env.render("next-pending"); submit(env.document).click(); env.render("next-correct"); env.handle.inspect(); await flush();
    const events = Object.values(env.storage.data);
    expect(events[0]).toMatchObject({ route: { manual_study_mode: "review", classification_policy: "normal_default_v1" } });
    expect(events[1]).toMatchObject({ route: { manual_study_mode: "normal" } });
    env.window.history.pushState({}, "", "/search?questionSetId=next"); env.handle.inspect();
    env.window.history.pushState({}, "", "/quiz"); env.handle.inspect();
    expect(await env.command(command)).toEqual({ ok: false });
    expect(await env.command({ command: "study_route" })).not.toMatchObject({ route: { manual_study_mode: "normal" } });
    env.handle.disconnect();
  });
  it("requests durable storage before pagehide completes and does not clear the pending write", async () => {
    const env = setup(); let resolve: (() => void) | undefined;
    const write = vi.spyOn(env.storage, "set").mockImplementation((value) => {
      return new Promise<void>((complete) => { resolve = () => { Object.assign(env.storage.data, value); complete(); }; });
    });
    submit(env.document).click(); env.render("correct");
    env.window.dispatchEvent(new env.window.Event("pagehide"));
    expect(write).toHaveBeenCalledTimes(1);
    expect(Object.keys(env.storage.data)).toHaveLength(0);
    resolve!(); await flush(); expect(Object.keys(env.storage.data)).toHaveLength(1);
    env.window.dispatchEvent(new env.window.Event("pageshow")); env.handle.inspect(); await flush();
    expect(write).toHaveBeenCalledTimes(1); env.handle.disconnect();
  });
  it("keeps an older unsaved answer visible through retry and clears it only after durable storage succeeds", async () => {
    const env = setup(); const write = vi.spyOn(env.storage, "set");
    env.storage.failWrite = true;
    submit(env.document).click(); env.render("correct"); env.handle.inspect(); await flush();
    expect(env.status()).toContain("保存失敗");
    const failedKey = Object.keys(write.mock.calls[0]![0])[0]!;
    env.storage.failWrite = false;
    env.render("next-pending"); submit(env.document).click(); env.render("next-correct"); env.handle.inspect(); await flush();
    expect(env.status()).toContain("Safari保存済み・アプリへ転送待ち");
    expect(env.status()).toContain("未保存の解答が1件あります");
    expect(Object.hasOwn(env.storage.data, failedKey)).toBe(false);
    const latestId = Object.keys(env.storage.data).find((key) => key.startsWith(EVENT_PREFIX))!.slice(EVENT_PREFIX.length);
    await env.storage.set({ [`${RECEIPT_PREFIX}${latestId}`]: { protocol_version: 1, ok: true, event_id: latestId, status: "notion_confirmed" } });
    env.storageChanged(); await flush();
    expect(env.status()).toContain("Notion確認済み");
    expect(env.status()).toContain("未保存の解答が1件あります");
    env.window.history.pushState({}, "", "/search"); env.handle.inspect();
    expect(env.document.querySelector<HTMLElement>("[data-qb-ios-status]")!.hidden).toBe(false);
    expect(env.status()).toContain("未保存の解答が1件あります");
    env.window.history.pushState({}, "", "/quiz"); env.handle.inspect();
    const persist = MemoryStorage.prototype.set.bind(env.storage);
    let finishWrite: (() => Promise<void>) | undefined;
    write.mockImplementationOnce((items) => new Promise<void>((resolve) => {
      finishWrite = async () => { await persist(items); resolve(); };
    }));
    env.window.dispatchEvent(new env.window.Event("pageshow")); await flush();
    expect(env.status()).toContain("Notion確認済み");
    expect(env.status()).toContain("未保存の解答が1件あります");
    expect(Object.hasOwn(env.storage.data, failedKey)).toBe(false);
    await finishWrite!(); await flush();
    expect(Object.hasOwn(env.storage.data, failedKey)).toBe(true);
    expect(env.status()).toBe("Notion確認済み");
    env.handle.disconnect();
  });
  it("does not regress the displayed Notion confirmation when an older receipt read finishes later", async () => {
    const env = setup();
    submit(env.document).click(); env.render("correct"); env.handle.inspect(); await flush();
    const eventId = Object.keys(env.storage.data).find((key) => key.startsWith(EVENT_PREFIX))!.slice(EVENT_PREFIX.length);
    const key = `${RECEIPT_PREFIX}${eventId}`;
    const oldReceipt = { protocol_version: 1, ok: true, event_id: eventId, status: "local_saved" };
    let finishRead: (() => void) | undefined;
    vi.spyOn(env.storage, "get").mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = () => { resolve({ [key]: oldReceipt }); };
    }));
    env.storageChanged();
    await env.storage.set({ [key]: { ...oldReceipt, status: "notion_confirmed" } });
    env.storageChanged(); await flush();
    expect(env.status()).toBe("Notion確認済み");
    finishRead!(); await flush();
    expect(env.status()).toBe("Notion確認済み");
    env.handle.disconnect();
  });
  it("does not record reentry/redraw/forged-click results or reuse old set context", async () => {
    const env = setup("/quiz", "correct"); env.handle.inspect();
    env.render("pending"); env.trust(false); submit(env.document).click(); env.render("correct"); env.handle.inspect();
    env.window.dispatchEvent(new env.window.Event("pagehide"));
    env.window.dispatchEvent(new env.window.Event("pageshow")); await flush();
    expect(Object.keys(env.storage.data)).toHaveLength(0);
    env.render("pending"); env.trust(true); submit(env.document).click(); env.render("correct"); env.handle.inspect(); await flush();
    expect(Object.values(env.storage.data)[0]).toMatchObject({ route: { entry_source: "unresolved" } });
    env.handle.disconnect();
  });
  it("resumes an armed same-document submission whose result arrived while Safari was suspended", async () => {
    const env = setup(); submit(env.document).click();
    env.window.dispatchEvent(new env.window.Event("pagehide")); env.render("correct"); env.handle.inspect();
    expect(Object.keys(env.storage.data)).toHaveLength(0);
    env.window.dispatchEvent(new env.window.Event("pageshow")); await flush();
    expect(Object.keys(env.storage.data)).toHaveLength(1);
    env.window.dispatchEvent(new env.window.Event("pageshow")); await flush();
    expect(Object.keys(env.storage.data)).toHaveLength(1); env.handle.disconnect();
  });
  it("does not read question body, option text, explanation or images", () => {
    const env = setup();
    const button = submit(env.document);
    const forbidden = env.document.createElement("div"); forbidden.id = "synthetic-question-body";
    env.document.querySelector(QB_QUIZ_DOM_CONTRACT.selectors.questionCard)!.append(forbidden);
    const getters = [...env.document.querySelectorAll("button.text-left"), forbidden].map((element) => vi.spyOn(element, "textContent", "get").mockImplementation(() => { throw new Error("CONTENT_ACCESS_FORBIDDEN"); }));
    expect(isTrustedQbSubmission(env.document, { type: "click", target: button, isTrusted: true } as unknown as Event)).toBe(true);
    expect(new QbQuizAttemptAdapter().inspect(env.document).kind).toBe("pending");
    for (const getter of getters) expect(getter).not.toHaveBeenCalled();
    env.render("correct");
    const resultGetters = [...env.document.querySelectorAll('button.text-left, [data-testid="explanation-box-title"]')].map((element) => vi.spyOn(element, "textContent", "get").mockImplementation(() => { throw new Error("RESULT_CONTENT_ACCESS_FORBIDDEN"); }));
    expect(new QbQuizAttemptAdapter().inspect(env.document).kind).toBe("resolved");
    for (const getter of resultGetters) expect(getter).not.toHaveBeenCalled();
    env.handle.disconnect();
  });
  it("fails closed for an unreviewed mobile layout even when a control has the familiar label", async () => {
    const env = setup();
    env.document.body.innerHTML = '<main><section class="unreviewed-mobile-layout"><span>119A12</span><button>解答する</button></section></main>';
    env.document.querySelector("button")!.click();
    env.document.querySelector("section")!.append(env.document.createElement("div"));
    env.handle.inspect(); await flush();
    expect(Object.keys(env.storage.data)).toHaveLength(0);
    expect(env.document.querySelector("[data-qb-ios-status]")).not.toBeNull();
    env.handle.disconnect();
  });
});
