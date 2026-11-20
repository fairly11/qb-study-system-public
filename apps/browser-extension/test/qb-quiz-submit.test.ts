import { readFileSync } from "node:fs";

import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QbQuizAttemptAdapter } from "../src/adapters/qb-quiz-adapter.js";
import { QB_QUIZ_DOM_CONTRACT } from "../src/adapters/qb-quiz-dom-contract.js";
import { isTrustedQbSubmission } from "../src/adapters/qb-quiz-submit.js";
import { CaptureController } from "../src/capture-controller.js";
import { startContentScript } from "../src/content-script.js";
import type { CaptureDocumentPayloadV1 } from "../src/shared/protocol.js";

const windows: Window[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const window of windows.splice(0)) await window.happyDOM.close(); });

function fixture(name: string): string {
  return readFileSync(new URL(`../../../tests/fixtures/browser-extension/${name}`, import.meta.url), "utf8");
}

function documentWithFixture(name = "qb-quiz-pending.html"): Document {
  const window = new Window({ url: "https://qb.medilink-study.com/quiz" });
  windows.push(window);
  window.document.write(fixture(name));
  return window.document as unknown as Document;
}

function addSubmitControl(document: Document, selected = true): HTMLButtonElement {
  const card = document.querySelector(QB_QUIZ_DOM_CONTRACT.selectors.questionCard)!;
  if (selected) card.querySelector(QB_QUIZ_DOM_CONTRACT.selectors.option)!.classList.add("border-qb-green", "text-qb-green");
  const layout = document.createElement("div");
  layout.className = "grid grid-cols-3 p-1 py-3";
  const wrapper = document.createElement("div");
  const button = document.createElement("button");
  button.textContent = "解答する";
  wrapper.append(button); layout.append(wrapper); card.parentElement!.append(layout);
  return button;
}

// Unit fixture for the browser-owned event boundary; production cannot forge isTrusted.
function click(target: EventTarget, trusted = true): Event {
  return { type: "click", target, isTrusted: trusted } as unknown as Event;
}

describe("verified QB submit control", () => {
  it("accepts only the trusted active control with a valid pending selected question without modifying the page", () => {
    const document = documentWithFixture();
    const button = addSubmitControl(document);
    const child = document.createElement("span"); child.textContent = "解答する";
    button.textContent = ""; button.append(child);
    const before = document.documentElement.outerHTML;
    expect(isTrustedQbSubmission(document, click(child))).toBe(true);
    expect(isTrustedQbSubmission(document, click(child, false))).toBe(false);
    expect(isTrustedQbSubmission(document, { ...click(child), type: "pointerdown" } as Event)).toBe(false);
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it.each(["disabled", "aria-disabled", "different-control", "unselected", "partial-selection", "duplicate", "wrong-root", "wrong-layout", "result"])(
    "does not arm from %s", (reason) => {
      const document = documentWithFixture(reason === "result" ? "qb-quiz-correct.html" : undefined);
      const button = addSubmitControl(document, reason !== "unselected");
      if (reason === "disabled") button.disabled = true;
      if (reason === "aria-disabled") button.setAttribute("aria-disabled", "true");
      if (reason === "different-control") button.textContent = "次の問題";
      if (reason === "partial-selection") document.querySelector(QB_QUIZ_DOM_CONTRACT.selectors.option)!.classList.remove("text-qb-green");
      if (reason === "duplicate") button.parentElement!.append(button.cloneNode(true));
      if (reason === "wrong-root") document.body.append(button.parentElement!.parentElement!);
      if (reason === "wrong-layout") button.parentElement!.parentElement!.classList.add("unreviewed");
      expect(isTrustedQbSubmission(document, click(button))).toBe(false);
    },
  );

  it("rejects a script-dispatched native click", () => {
    const document = documentWithFixture();
    const button = addSubmitControl(document);
    const results: boolean[] = [];
    document.addEventListener("click", (event) => { results.push(isTrustedQbSubmission(document, event)); });
    button.click();
    expect(results).toEqual([false]);
  });

  it("does not read option text while rejecting an option click or checking the submit control", () => {
    const document = documentWithFixture();
    const button = addSubmitControl(document);
    const option = document.querySelector(QB_QUIZ_DOM_CONTRACT.selectors.option)!;
    const content = vi.spyOn(option, "textContent", "get").mockImplementation(() => { throw new Error("OPTION_TEXT_MUST_NOT_BE_READ"); });
    expect(isTrustedQbSubmission(document, click(option))).toBe(false);
    expect(isTrustedQbSubmission(document, click(button))).toBe(true);
    expect(content).not.toHaveBeenCalled();
  });
});

describe("content submission wiring", () => {
  it("requires a verified click for ambiguous redraw, captures once afterward, and removes the listener on stop", () => {
    const document = documentWithFixture("qb-quiz-correct.html");
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    let inspect: (() => void) | undefined;
    let active = true;
    const messages: CaptureDocumentPayloadV1[] = [];
    const controller = new CaptureController(new QbQuizAttemptAdapter(), {
      createEventId: () => "10000000-0000-4000-8000-000000000001", now: () => new Date("2026-10-19T00:00:00Z"),
    });
    const confirmed = vi.spyOn(controller, "confirmSubmission");
    const handle = startContentScript({ document, controller, isActive: () => active,
      MutationObserver: class {
        public constructor(callback: () => void) { inspect = callback; }
        public observe(): void { /* controlled mutation */ }
        public disconnect(): void { inspect = undefined; }
      },
      sendMessage: (message) => { messages.push(message); return { ok: true, code: "candidate_enqueued" }; },
    });
    const listener = add.mock.calls.find(([type]) => type === "click")?.[1];
    if (typeof listener !== "function") throw new Error("MISSING_CLICK_LISTENER");
    expect(add).toHaveBeenCalledWith("click", listener, true);
    const render = (name: string): void => { document.documentElement.innerHTML = fixture(name); inspect?.(); };
    const candidates = (): readonly CaptureDocumentPayloadV1[] => messages.filter(({ kind }) => kind === "attempt_candidate_v1");
    render("qb-quiz-next-correct.html");
    render("qb-quiz-next-pending.html");
    let button = addSubmitControl(document);
    listener.call(document, click(button, false));
    render("qb-quiz-next-correct.html");
    expect(candidates()).toHaveLength(0);
    expect(confirmed).not.toHaveBeenCalled();

    render("qb-quiz-next-pending.html"); button = addSubmitControl(document);
    active = false; listener.call(document, click(button));
    expect(confirmed).not.toHaveBeenCalled();
    active = true; listener.call(document, click(button));
    expect(confirmed).toHaveReturnedWith(true);
    expect(candidates()).toHaveLength(0);
    render("qb-quiz-next-correct.html"); inspect?.();
    expect(candidates()).toHaveLength(1);
    expect(candidates()[0]).toMatchObject({ question_key: "119A13", selected_option_indices: [4] });
    handle.disconnect();
    expect(remove).toHaveBeenCalledWith("click", listener, true);
    listener.call(document, click(button));
    expect(confirmed).toHaveBeenCalledTimes(1);
  });
});
