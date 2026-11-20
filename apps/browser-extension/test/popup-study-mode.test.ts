import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { GET_POPUP_STATUS_MESSAGE_KIND, GET_TAB_CONSENT_STATUS_MESSAGE_KIND,
  SET_TAB_CONSENT_MESSAGE_KIND, STOP_TAB_CAPTURE_MESSAGE_KIND, SET_STUDY_MODE_MESSAGE_KIND,
  type TabConsentStatusV1, type PopupRequestMessageV1 } from "../src/shared/protocol.js";

const windows: Window[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.resetModules();
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

async function openPopup(mode: "normal" | "review" | "unclassified", initialState: "capturing" | "unavailable" = "capturing") {
  const window = new Window(); windows.push(window);
  window.document.write(readFileSync(new URL("../popup.html", import.meta.url), "utf8"));
  vi.stubGlobal("document", window.document);
  for (const name of ["HTMLSpanElement", "HTMLInputElement", "HTMLParagraphElement",
    "HTMLButtonElement", "HTMLUListElement"] as const) vi.stubGlobal(name, window[name]);
  const pageId = "10000000-0000-4000-8000-000000000001";
  const sent: PopupRequestMessageV1[] = [];
  let state: TabConsentStatusV1["state"] = initialState;
  vi.stubGlobal("chrome", {
    tabs: { query: async () => [{ id: 7 }] },
    runtime: { sendMessage: async (message: PopupRequestMessageV1) => {
      sent.push(message);
      if (message.kind === GET_POPUP_STATUS_MESSAGE_KIND) return {
        capture_state: "observing", outbox_count: 0,
        collector_endpoint: "http://127.0.0.1:8765/v2/attempt-events", delivery_state: "idle",
        last_diagnostic_code: null, last_capture_issue_code: null, recent_attempts: [],
      };
      if (message.kind === GET_TAB_CONSENT_STATUS_MESSAGE_KIND) return {
        state, page_session_id: state === "unavailable" ? null : pageId, ...(state === "unavailable" ? {} : { study_mode: mode }),
      };
      if (message.kind === SET_STUDY_MODE_MESSAGE_KIND) {
        mode = message.study_mode;
        return { ok: true, code: "study_mode_changed" };
      }
      state = message.kind === STOP_TAB_CAPTURE_MESSAGE_KIND ? "paused" : "capturing";
      return { ok: true, code: "capture_command_completed" };
    } },
  });
  await import("../src/popup/index.js");
  const start = window.document.getElementById("start-capture") as unknown as HTMLButtonElement;
  const stop = window.document.getElementById("stop-capture") as unknown as HTMLButtonElement;
  if (initialState === "unavailable") {
    await vi.waitFor(() => expect(window.document.querySelector("#consent-state")?.textContent).toContain("記録状態を確認できません"));
  } else {
    await vi.waitFor(() => expect(stop.disabled).toBe(false));
  }
  return { window, start, stop, sent, pageId };
}

it("shows automatic review and pauses/resumes without requiring a mode choice", async () => {
  const { window, start, stop, sent, pageId } = await openPopup("review");
  expect(window.document.querySelector("select")).toBeNull();
  expect(window.document.querySelector("#consent-state")?.textContent).toContain("復習課題");
  expect(start.disabled).toBe(true);
  stop.click();
  await vi.waitFor(() => expect(start.disabled).toBe(false));
  expect(window.document.querySelector("#consent-state")?.textContent).toContain("一時停止");
  start.click();
  await vi.waitFor(() => expect(stop.disabled).toBe(false));
  expect(sent.filter((message) => message.kind === STOP_TAB_CAPTURE_MESSAGE_KIND)).toEqual([
    { kind: STOP_TAB_CAPTURE_MESSAGE_KIND, tab_id: 7, page_session_id: pageId },
  ]);
  expect(sent.filter((message) => message.kind === SET_TAB_CONSENT_MESSAGE_KIND)).toEqual([
    { kind: SET_TAB_CONSENT_MESSAGE_KIND, tab_id: 7, page_session_id: pageId, decision: "start" },
  ]);
});

it.each([["normal", "通常学習"], ["unclassified", "判定未確認"]] as const)(
  "displays the automatic %s classification truthfully", async (mode, label) => {
    const { window } = await openPopup(mode);
    expect(window.document.querySelector("#consent-state")?.textContent).toContain(label);
  },
);

it("does not claim the user left QB when its recording session is unavailable", async () => {
  const { window, start, stop } = await openPopup("normal", "unavailable");
  await vi.waitFor(() => expect(window.document.querySelector("#command-status")?.textContent).toBe("popup_ready"));
  const text = window.document.querySelector("#consent-state")?.textContent;
  expect(text).toContain("記録状態を確認できません");
  expect(text).not.toContain("対象のQB /quizページではありません");
  expect(start.disabled).toBe(true);
  expect(stop.disabled).toBe(true);
});


it.each(["normal", "review"] as const)("lets an unknown session choose %s for future answers", async (mode) => {
  const { window, sent, pageId } = await openPopup("unclassified");
  const button = window.document.getElementById(mode === "normal" ? "set-normal-study" : "set-review-study") as unknown as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  button.click();
  expect(button.disabled).toBe(true);
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(sent.filter((message) => message.kind === SET_STUDY_MODE_MESSAGE_KIND)).toEqual([
    { kind: SET_STUDY_MODE_MESSAGE_KIND, tab_id: 7, page_session_id: pageId, study_mode: mode },
  ]);
  expect(window.document.querySelector("#consent-state")?.textContent).toContain(mode === "normal" ? "通常学習" : "復習課題");
  expect(window.document.querySelector("#command-status")?.textContent).toContain("これからの解答");
  expect(button.getAttribute("aria-pressed")).toBe("true");
});

it("allows correction while paused without resuming capture", async () => {
  const { window, stop, start, sent } = await openPopup("normal");
  stop.click();
  await vi.waitFor(() => expect(start.disabled).toBe(false));
  const review = window.document.getElementById("set-review-study") as unknown as HTMLButtonElement;
  review.click();
  await vi.waitFor(() => expect(review.disabled).toBe(false));
  expect(window.document.querySelector("#consent-state")?.textContent).toContain("一時停止中");
  expect(window.document.querySelector("#consent-state")?.textContent).toContain("復習課題");
  expect(sent.filter((message) => message.kind === SET_TAB_CONSENT_MESSAGE_KIND)).toHaveLength(0);
});

it("disables both choices when the active recording session is unavailable", async () => {
  const { window, sent } = await openPopup("normal", "unavailable");
  for (const id of ["set-normal-study", "set-review-study"]) {
    const button = window.document.getElementById(id) as unknown as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.click();
  }
  expect(sent.filter((message) => message.kind === SET_STUDY_MODE_MESSAGE_KIND)).toHaveLength(0);
});
