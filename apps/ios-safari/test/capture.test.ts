import { describe, expect, it } from "vitest";
import { validateAttemptEventV1 } from "@qb-study/contracts";
import type { AttemptDomObservation } from "../../browser-extension/src/adapters/types.js";
import { SafariCapture } from "../src/capture.js";
import { SESSION } from "./helpers.js";

describe("trusted submission capture lifecycle", () => {
  const route = { quiz_id: SESSION, entry_source: "unresolved" as const };
  const pending = { kind: "pending", question_key: "119A12" } as const;
  const resolved = { kind: "resolved", question_key: "119A12", result: "correct", selected_option_indices: [2] } as const;
  const root = {} as ParentNode;
  function setup(initial: AttemptDomObservation = pending) {
    let observation = initial; let count = 0;
    const capture = new SafariCapture({ observedAttributeNames: [], inspect: () => observation },
      () => `10000000-0000-4000-8000-${String(++count).padStart(12, "0")}`, () => new Date("2026-10-25T00:00:00Z"));
    return { capture, show: (value: AttemptDomObservation) => { observation = value; } };
  }
  it("does not record old results, transient pending, or resolved redraw without a submission", () => {
    const { capture, show } = setup(resolved);
    expect(capture.inspect(root, route).staged).toBeUndefined();
    show(pending); capture.inspect(root, route); show(resolved);
    expect(capture.inspect(root, route).staged).toBeUndefined();
  });
  it("records one V1-compatible event per actual same-question resubmission and deduplicates redraws", () => {
    const { capture, show } = setup();
    capture.submit(root, route); capture.submit(root, route);
    show(resolved);
    const first = capture.inspect(root, route).staged!;
    expect(validateAttemptEventV1(first.event)).toBe(true);
    expect(capture.inspect(root, route).staged).toBeUndefined();
    show(pending); capture.inspect(root, route); show(resolved);
    expect(capture.inspect(root, route).staged).toBeUndefined();
    show(pending); capture.submit(root, route); show(resolved);
    const second = capture.inspect(root, route).staged!;
    expect(second.event.event_id).not.toBe(first.event.event_id);
    expect(second.event.question_key).toBe(first.event.question_key);
  });
  it("records continuous questions only after each trusted submission", () => {
    const { capture, show } = setup();
    capture.submit(root, route); show(resolved); expect(capture.inspect(root, route).staged).toBeDefined();
    show({ ...pending, question_key: "119A13" }); capture.submit(root, route);
    show({ ...resolved, question_key: "119A13" }); expect(capture.inspect(root, route).staged?.event.question_key).toBe("119A13");
  });
  it("retains submission through partial rendering but discards different-question and different-session results", () => {
    const { capture, show } = setup(); capture.submit(root, route);
    show({ kind: "unsupported", reason: "main_missing" }); expect(capture.inspect(root, route).state).toBe("unsupported");
    show(resolved); expect(capture.inspect(root, route).staged).toBeDefined();
    show(pending); capture.submit(root, route); show({ ...resolved, question_key: "119A13" });
    expect(capture.inspect(root, route).staged).toBeUndefined(); show(resolved); expect(capture.inspect(root, route).staged).toBeUndefined();
    show(pending); capture.submit(root, route); show(resolved);
    expect(capture.inspect(root, { ...route, quiz_id: "20000000-0000-4000-8000-000000000002" }).staged).toBeUndefined();
  });
  it("never invents selections or captures a result from a session that has ended", () => {
    const { capture, show } = setup(); capture.submit(root, route);
    show({ kind: "resolved_without_selection", question_key: "119A12" }); expect(capture.inspect(root, route).staged).toBeUndefined();
    show(pending); capture.submit(root, route); capture.reset(); show(resolved);
    expect(capture.inspect(root, route).staged).toBeUndefined();
  });
  it("waits for selection classes to mount after the trusted answer's result marker", () => {
    const { capture, show } = setup(); capture.submit(root, route);
    show({ kind: "resolved_without_selection", question_key: "119A12" }); expect(capture.inspect(root, route).staged).toBeUndefined();
    show(resolved); expect(capture.inspect(root, route).staged?.event.selected_option_indices).toEqual([2]);
  });
});
