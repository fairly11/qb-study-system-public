import { Window as TestWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeStudyControls } from "../src/popup.js";
import type { SafariBrowser } from "../src/protocol.js";
import { SESSION } from "./helpers.js";

const windows: TestWindow[] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });
function setup(set = false) {
  const window = new TestWindow(); windows.push(window);
  const document = window.document as unknown as Document;
  document.body.innerHTML = '<p id="study-status"></p><button id="study-normal" disabled></button><button id="study-review" disabled></button>';
  const route = { quiz_id: SESSION, entry_source: "observed_navigation", classification_policy: "normal_default_v1", ...(set ? { set_id: "synthetic-set" } : {}) };
  const query = vi.fn(async () => [{ id: 7 }]);
  const send = vi.fn(async (_tab: number, message: unknown): Promise<unknown> => {
    const value = message as { command: string; study_mode?: string };
    return { ok: true, route: value.command === "study_route" ? route : { ...route, manual_study_mode: value.study_mode } };
  });
  const native = vi.fn(async (): Promise<unknown> => ({ ok: false }));
  const browser = { tabs: { query, sendMessage: send }, runtime: { sendMessage: native } } as unknown as SafariBrowser;
  const normal = document.querySelector<HTMLButtonElement>("#study-normal")!;
  const review = document.querySelector<HTMLButtonElement>("#study-review")!;
  const status = (): string | null => document.querySelector("#study-status")!.textContent;
  return { document, browser, query, send, native, normal, review, status };
}
describe("Safari study mode popup", () => {
  it("defaults an ordinary exercise to normal and sends a scoped manual review command", async () => {
    const env = setup(); await initializeStudyControls(env.document, env.browser);
    expect(env.status()).toContain("通常学習"); expect(env.native).not.toHaveBeenCalled();
    env.review.click();
    await vi.waitFor(() => expect(env.status()).toContain("復習課題（手動選択）"));
    expect(env.send).toHaveBeenLastCalledWith(7, { command: "set_study_mode", quiz_id: SESSION, study_mode: "review" }, { frameId: 0 });
    expect(env.review.getAttribute("aria-pressed")).toBe("true");
  });
  it("keeps buttons usable while lookup is pending and ignores a late automatic answer", async () => {
    const env = setup(true); const pending = Promise.withResolvers<unknown>();
    env.native.mockImplementationOnce(() => pending.promise);
    const initialize = initializeStudyControls(env.document, env.browser);
    await vi.waitFor(() => expect(env.status()).toContain("判定未確認"));
    expect(env.normal.disabled).toBe(false);
    env.normal.click(); await vi.waitFor(() => expect(env.status()).toContain("通常学習（手動選択）"));
    pending.resolve({ ok: true, study_mode: "review" }); await initialize;
    expect(env.status()).toContain("通常学習（手動選択）");
  });
  it("does not display an automatic result after the exercise changed during lookup", async () => {
    const env = setup(true); const pending = Promise.withResolvers<unknown>();
    env.native.mockImplementationOnce(() => pending.promise);
    const initialize = initializeStudyControls(env.document, env.browser);
    await vi.waitFor(() => expect(env.status()).toContain("判定未確認"));
    env.send.mockResolvedValueOnce({ ok: false });
    pending.resolve({ ok: true, study_mode: "review" }); await initialize;
    expect(env.status()).toContain("演習画面が変わりました");
    expect(env.review.disabled).toBe(true);
  });
  it("does not send a manual selection after the active tab changes", async () => {
    const env = setup(); await initializeStudyControls(env.document, env.browser);
    env.query.mockResolvedValueOnce([{ id: 8 }]); env.send.mockClear();
    env.review.click(); await vi.waitFor(() => expect(env.status()).toContain("開き直してください"));
    expect(env.send).not.toHaveBeenCalled(); expect(env.normal.disabled).toBe(true);
  });
  it("does not claim success if the page rejected a stale session", async () => {
    const env = setup(); await initializeStudyControls(env.document, env.browser);
    env.send.mockResolvedValueOnce({ ok: false }); env.review.click();
    await vi.waitFor(() => expect(env.status()).toContain("選択を確認できません"));
    expect(env.review.getAttribute("aria-pressed")).toBe("false");
    expect(env.normal.disabled).toBe(true);
  });
  it("does not enable selection when the current tab has no recorder", async () => {
    const env = setup(); env.send.mockRejectedValueOnce(new Error("NO_CONTENT"));
    await initializeStudyControls(env.document, env.browser);
    expect(env.normal.disabled).toBe(true); expect(env.review.disabled).toBe(true);
    expect(env.status()).toContain("QBの問題画面を開くと");
  });
});
