import { describe, expect, it, vi } from "vitest";
import { safeSummary, startBackground } from "../src/background.js";
import { EVENT_PREFIX, NATIVE_APP, type MessageSender, type SafariBrowser } from "../src/protocol.js";
import { MemoryStorage, staged } from "./helpers.js";

async function setup(initial = false) {
  const storage = new MemoryStorage(); const value = staged();
  if (initial) await storage.set({ [`${EVENT_PREFIX}${value.event.event_id}`]: value });
  let listener: ((message: unknown, sender: MessageSender) => Promise<unknown> | undefined) | undefined;
  const operations: string[] = [];
  const send = vi.fn(async (_app: string, message: unknown) => {
    const command = (message as { command: string }).command; operations.push(command);
    return command === "ingest" || command === "status"
      ? { protocol_version: 1, ok: true, status: "local_saved", event_id: value.event.event_id, saved: 1, pending: 1, confirmed: 0, blocked: 0 }
      : { protocol_version: 1, ok: true, saved: 1, pending: 1, confirmed: 0, blocked: 0 };
  });
  const browser = { runtime: { id: "extension", getURL: (path: string) => `safari-web-extension://extension/${path}`, sendNativeMessage: send,
    onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } }, storage: { local: storage } } as unknown as SafariBrowser;
  startBackground(browser);
  const content = { id: "extension", url: "https://qb.medilink-study.com/quiz", frameId: 0, tab: { id: 1 } };
  const popup = { id: "extension", url: "safari-web-extension://extension/popup.html" };
  await listener!({ command: "wake" }, popup);
  return { storage, send, operations, content, popup, listener: listener! };
}
describe("Safari background/native boundary", () => {
  it("finishes each wake after its requested pass even while later foreground wake requests continue", async () => {
    const storage = new MemoryStorage();
    let listener: ((message: unknown, sender: MessageSender) => Promise<unknown> | undefined) | undefined;
    const started = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
    let syncIndex = 0;
    const browser = { runtime: { id: "extension", getURL: (path: string) => `safari-web-extension://extension/${path}`,
      sendNativeMessage: async () => {
        const index = syncIndex++; started[index]!.resolve(); await gates[index]!.promise;
        return { protocol_version: 1, ok: true };
      },
      onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } }, storage: { local: storage } } as unknown as SafariBrowser;
    const sender = { id: "extension", url: "safari-web-extension://extension/popup.html" };
    startBackground(browser);
    let firstFinished = false; let secondFinished = false;
    const first = listener!({ command: "wake" }, sender)!.then(() => { firstFinished = true; });
    await started[0]!.promise;
    const second = listener!({ command: "wake" }, sender)!.then(() => { secondFinished = true; });
    gates[0]!.resolve(); await started[1]!.promise;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const firstFinishedBeforeNextSync = firstFinished;
    const third = listener!({ command: "wake" }, sender)!;
    gates[1]!.resolve(); await started[2]!.promise;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const secondFinishedBeforeNextSync = secondFinished;
    gates[2]!.resolve(); await Promise.all([first, second, third]);
    expect(firstFinishedBeforeNextSync).toBe(true);
    expect(secondFinishedBeforeNextSync).toBe(true);
  });
  it.each([false, true])("delivers an answer staged during an active sync before its wake completes (sync failure: %s)", async (failSync) => {
    const storage = new MemoryStorage(); const value = staged();
    let listener: ((message: unknown, sender: MessageSender) => Promise<unknown> | undefined) | undefined;
    let releaseSync!: () => void;
    let startedSync!: () => void;
    const syncStarted = new Promise<void>((resolve) => { startedSync = resolve; });
    const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
    const operations: string[] = [];
    const send = vi.fn(async (_app: string, message: unknown) => {
      const command = (message as { command: string }).command; operations.push(command);
      if (operations.length === 1) {
        startedSync(); await syncGate;
        if (failSync) throw new Error("SYNTHETIC_SYNC_FAILURE");
      }
      return { protocol_version: 1, ok: true, status: "local_saved", event_id: value.event.event_id };
    });
    const browser = { runtime: { id: "extension", getURL: (path: string) => `safari-web-extension://extension/${path}`, sendNativeMessage: send,
      onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } }, storage: { local: storage } } as unknown as SafariBrowser;
    startBackground(browser);
    await syncStarted;
    await storage.set({ [`${EVENT_PREFIX}${value.event.event_id}`]: value });
    const delivery = listener!({ command: "wake" }, { id: "extension", url: "https://qb.medilink-study.com/quiz", frameId: 0, tab: { id: 1 } });
    releaseSync(); await delivery;
    expect(operations).toEqual(["sync", "ingest", "sync"]);
    expect(storage.data[`${EVENT_PREFIX}${value.event.event_id}`]).toBeUndefined();
  });
  it("restarts by saving durable staged events before initiating Notion sync", async () => {
    const env = await setup(true);
    expect(env.operations).toEqual(["ingest", "sync"]);
    expect(env.send.mock.calls.every(([app]) => app === NATIVE_APP)).toBe(true);
    expect(Object.keys(env.storage.data).some((key) => key.startsWith(EVENT_PREFIX))).toBe(false);
  });
  it("rejects subframes, other extensions, unrelated URLs and arbitrary native command forwarding", async () => {
    const env = await setup(); env.send.mockClear();
    for (const sender of [{ ...env.content, frameId: 1 }, { ...env.content, id: "other" }, { ...env.content, url: "https://example.org/quiz" }, { ...env.content, tab: { id: -1 } }, { ...env.popup, url: "safari-web-extension://extension/other.html" }]) expect(env.listener({ command: "wake" }, sender)).toBeUndefined();
    expect(env.listener({ command: "ingest", event: staged().event }, env.content)).toBeUndefined();
    expect(env.listener({ command: "configure", token: "synthetic" }, env.popup)).toBeUndefined();
    expect(env.listener({ command: "wake", additional: true }, env.content)).toBeUndefined();
    expect(env.send).not.toHaveBeenCalled();
  });
  it("serves only safe counts to popup and bound receipt to the trusted top-frame recorder", async () => {
    const env = await setup();
    expect(env.listener({ command: "status" }, env.content)).toBeUndefined();
    expect(await env.listener({ command: "status" }, env.popup)).toEqual({ ok: true, saved: 1, pending: 1, confirmed: 0, blocked: 0 });
    expect(await env.listener({ command: "event_status", event_id: staged().event.event_id }, env.content)).toMatchObject({ status: "local_saved", event_id: staged().event.event_id });
  });
  it("allows only popup classification previews and returns an allowlisted mode", async () => {
    const env = await setup(); env.send.mockClear();
    const message = { command: "study_mode", route: staged().route };
    expect(env.listener(message, env.content)).toBeUndefined();
    expect(env.listener({ ...message, route: { ...staged().route, manual_study_mode: "invented" } }, env.popup)).toBeUndefined();
    env.send.mockResolvedValueOnce({ protocol_version: 1, ok: true, study_mode: "review", token: "synthetic" } as never);
    expect(await env.listener(message, env.popup)).toEqual({ ok: true, study_mode: "review" });
    expect(env.send).toHaveBeenCalledWith(NATIVE_APP, { protocol_version: 1, command: "study_mode", route: staged().route });
    env.send.mockResolvedValueOnce({ protocol_version: 1, ok: true, study_mode: "invented" } as never);
    expect(await env.listener(message, env.popup)).toEqual({ ok: false });
  });
  it("never exposes native free-form data or accepts invalid counters", () => {
    expect(safeSummary({ protocol_version: 1, ok: true, saved: 1, pending: 1, confirmed: 0, blocked: 0, token: "synthetic", log: "synthetic" })).toEqual({ ok: true, saved: 1, pending: 1, confirmed: 0, blocked: 0 });
    expect(safeSummary({ protocol_version: 1, ok: true, saved: -1, pending: 1, confirmed: 0, blocked: 0 })).toEqual({ ok: false });
  });
});
