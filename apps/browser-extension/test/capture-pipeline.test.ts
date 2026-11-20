import { readFileSync } from "node:fs";

import { validateAttemptEventV1 } from "@qb-study/contracts";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { SyntheticFixtureAttemptAdapter } from "../src/adapters/index.js";
import { buildAttemptEventV1 } from "../src/background/attempt-event.js";
import { CaptureController } from "../src/capture-controller.js";

const ANSWERED_AT = "2026-08-25T03:04:05.006Z";
const RECORDED_AT = Date.parse("2026-08-25T03:05:00.000Z");

function fixtureDocument(name: string): Document {
  const html = readFileSync(
    new URL(`../../../tests/fixtures/browser-extension/${name}`, import.meta.url),
    "utf8",
  );
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
}

describe("synthetic capture pipeline", () => {
  it.each([
    {
      fixture: "correct.html",
      eventId: "10000000-0000-4000-8000-000000000001",
      result: "correct",
      selectedOptionIndices: [1, 3],
    },
    {
      fixture: "incorrect.html",
      eventId: "10000000-0000-4000-8000-000000000002",
      result: "incorrect",
      selectedOptionIndices: [2],
    },
  ] as const)(
    "creates one validated AttemptEventV1 from a $result result transition",
    ({ fixture, eventId, result, selectedOptionIndices }) => {
      const controller = new CaptureController(
        new SyntheticFixtureAttemptAdapter(),
        {
          createEventId: () => eventId,
          now: () => new Date(ANSWERED_AT),
        },
      );
      controller.observe(fixtureDocument("pending.html"));
      const output = controller.observe(fixtureDocument(fixture));
      expect(output.candidate).toBeDefined();
      if (output.candidate === undefined) {
        return;
      }
      expect(Object.isFrozen(output.candidate)).toBe(true);
      expect(Object.isFrozen(output.candidate.selected_option_indices)).toBe(true);

      const built = buildAttemptEventV1(output.candidate, RECORDED_AT);
      expect(built.ok).toBe(true);
      if (!built.ok) {
        return;
      }
      expect(validateAttemptEventV1(built.event)).toBe(true);
      expect(built.event).toMatchObject({
        event_id: eventId,
        result,
        selected_option_indices: selectedOptionIndices,
      });
      expect(controller.observe(fixtureDocument(fixture)).candidate).toBeUndefined();
    },
  );
});
