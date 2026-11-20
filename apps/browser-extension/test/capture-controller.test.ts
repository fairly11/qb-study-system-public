import { readFileSync } from "fs";

import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import {
  QB_QUIZ_DOM_CONTRACT,
  QbQuizAttemptAdapter,
  SyntheticFixtureAttemptAdapter,
  type AttemptDomAdapter,
  type UnsupportedDomReason,
} from "../src/adapters/index.js";
import {
  CaptureController,
  type CaptureControllerDependencies,
} from "../src/capture-controller.js";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ANSWERED_AT = "2026-08-25T03:04:05.006Z";

function fixtureDocument(name: string, url?: string): Document {
  const html = readFileSync(
    new URL(`../../../tests/fixtures/browser-extension/${name}`, import.meta.url),
    "utf8",
  );
  const window = new Window(url === undefined ? undefined : { url });
  window.document.write(html);
  return window.document as unknown as Document;
}

function controller(
  overrides: Partial<CaptureControllerDependencies> = {},
): CaptureController {
  return new CaptureController(new SyntheticFixtureAttemptAdapter(), {
    createEventId: overrides.createEventId ?? (() => EVENT_ID),
    now: overrides.now ?? (() => new Date(ANSWERED_AT)),
  });
}

function syntheticPending(questionKey: string): Document {
  const document = fixtureDocument("pending.html");
  const key = document.querySelector('[data-qb-study-field="question-key"]');
  if (key === null) throw new Error("fixture question identifier missing");
  key.setAttribute("data-qb-study-value", questionKey);
  return document;
}

describe("CaptureController", () => {
  it("resets the observation baseline without capturing a result displayed while paused", () => {
    const capture = controller();
    capture.observe(fixtureDocument("pending.html"));
    capture.resetObservationBaseline();
    expect(capture.observe(fixtureDocument("correct.html"))).not.toHaveProperty("candidate");
    capture.observe(fixtureDocument("pending.html"));
    expect(capture.observe(fixtureDocument("correct.html"))).not.toHaveProperty("candidate");
  });

  it("keeps the terminal question guard across pause and resume", () => {
    const capture = controller();
    capture.observe(fixtureDocument("pending.html"));
    expect(capture.observe(fixtureDocument("correct.html"))).toHaveProperty("candidate");
    capture.resetObservationBaseline();
    capture.observe(fixtureDocument("pending.html"));
    expect(capture.observe(fixtureDocument("correct.html"))).not.toHaveProperty("candidate");
  });

  it("discards pending evidence on reset even while the DOM is temporarily unsupported", () => {
    const capture = controller();
    capture.observe(fixtureDocument("pending.html"));
    capture.observe(fixtureDocument("unsupported.html"));
    capture.resetObservationBaseline();
    capture.observe(fixtureDocument("unsupported.html"));
    expect(capture.observe(fixtureDocument("correct.html"))).not.toHaveProperty("candidate");
  });

  it("does not carry a pending answer through an explicitly unsupported quiz location", () => {
    const capture = new CaptureController(new QbQuizAttemptAdapter());
    const qbUrl = "https://qb.medilink-study.com/quiz";
    capture.observe(fixtureDocument("qb-quiz-pending.html", qbUrl));
    expect(capture.observe(fixtureDocument("qb-quiz-pending.html", "https://qb.medilink-study.com/search")))
      .toHaveProperty("status.code", "capture_unsupported_dom:qb_location_unsupported");
    expect(capture.observe(fixtureDocument("qb-quiz-correct.html", qbUrl))).not.toHaveProperty("candidate");
  });

  it("does not emit an event for an initially resolved DOM", () => {
    const capture = controller();

    expect(capture.observe(fixtureDocument("correct.html"))).toEqual({
      status: {
        kind: "capture_status_v1",
        state: "observing",
        code: "capture_observing",
      },
    });
    expect(capture.observe(fixtureDocument("correct.html"))).toEqual({});
  });

  it.each([
    ["correct.html", "correct", [1, 3]],
    ["incorrect.html", "incorrect", [2]],
    ["unknown.html", "unknown", [4]],
  ] as const)(
    "emits one exact candidate for a pending to %s transition",
    (fixture, result, selectedOptionIndices) => {
      const capture = controller();
      expect(capture.observe(fixtureDocument("pending.html"))).toHaveProperty(
        "status.code",
        "capture_observing",
      );

      const resolvedDocument = fixtureDocument(fixture);
      expect(capture.observe(resolvedDocument)).toEqual({
        candidate: {
          kind: "attempt_candidate_v1",
          event_id: EVENT_ID,
          question_key: "119A12",
          answered_at: ANSWERED_AT,
          result,
          selected_option_indices: selectedOptionIndices,
        },
      });

      expect(capture.observe(resolvedDocument)).toEqual({});
    },
  );

  it("does not treat a different question's resolved DOM as the pending attempt", () => {
    const capture = controller();
    capture.observe(fixtureDocument("pending.html"));

    expect(capture.observe(fixtureDocument("resolved-other-question.html"))).toEqual({
      status: {
        kind: "capture_status_v1",
        state: "unsupported",
        code: "capture_candidate_rejected",
      },
    });
  });

  it("retains a matching pending observation through an unsupported intermediate DOM", () => {
    const capture = controller();
    capture.observe(fixtureDocument("pending.html"));

    expect(capture.observe(fixtureDocument("unsupported.html"))).toHaveProperty(
      "status.code",
      "capture_unsupported_dom:fixture_root_missing",
    );
    expect(capture.observe(fixtureDocument("correct.html"))).toEqual({
      candidate: {
        kind: "attempt_candidate_v1",
        event_id: EVENT_ID,
        question_key: "119A12",
        answered_at: ANSWERED_AT,
        result: "correct",
        selected_option_indices: [1, 3],
      },
      status: {
        kind: "capture_status_v1",
        state: "observing",
        code: "capture_observing",
      },
    });
    expect(capture.observe(fixtureDocument("correct.html"))).toEqual({});
  });

  it.each(["qb-quiz-correct.html", "qb-quiz-resolved-without-selection.html"])(
    "does not consume the next question when its identifier mounts over %s", (intermediateFixture) => {
      let sequence = 0;
      const createEventId = vi.fn(() => `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
      const capture = new CaptureController(new QbQuizAttemptAdapter(), {
        createEventId, now: () => new Date(ANSWERED_AT),
      });
      const qbUrl = "https://qb.medilink-study.com/quiz";
      capture.observe(fixtureDocument("qb-quiz-pending.html", qbUrl));
      expect(capture.observe(fixtureDocument("qb-quiz-correct.html", qbUrl)).candidate?.question_key).toBe("119A12");

      const intermediate = fixtureDocument(intermediateFixture, qbUrl);
      const questionKey = intermediate.querySelector(QB_QUIZ_DOM_CONTRACT.selectors.questionKey);
      if (questionKey === null) throw new Error("fixture question identifier missing");
      questionKey.textContent = "119A13";
      expect(capture.observe(intermediate)).not.toHaveProperty("candidate");
      expect(capture.observe(intermediate)).not.toHaveProperty("candidate");
      const pending = fixtureDocument("qb-quiz-next-pending.html", qbUrl);
      expect(capture.observe(pending)).not.toHaveProperty("candidate");
      expect(capture.confirmSubmission(pending)).toBe(true);
      expect(capture.observe(fixtureDocument("unsupported.html", qbUrl))).toHaveProperty("status.state", "unsupported");
      const resolved = fixtureDocument("qb-quiz-next-correct.html", qbUrl);
      expect(capture.observe(resolved).candidate).toMatchObject({
        event_id: "10000000-0000-4000-8000-000000000002",
        question_key: "119A13", result: "correct", selected_option_indices: [4],
      });
      expect(capture.observe(resolved)).not.toHaveProperty("candidate");
      capture.observe(fixtureDocument("qb-quiz-next-pending.html", qbUrl));
      expect(capture.observe(resolved)).not.toHaveProperty("candidate");
      expect(createEventId).toHaveBeenCalledTimes(2);
    },
  );

  it("does not join unsupported recovery to a different pending question or consume its later answer", () => {
    const capture = controller();
    capture.observe(fixtureDocument("pending.html"));
    capture.observe(fixtureDocument("unsupported.html"));
    const otherResolved = fixtureDocument("resolved-other-question.html");
    expect(capture.observe(otherResolved)).toHaveProperty("status.code", "capture_candidate_rejected");
    expect(capture.observe(otherResolved)).not.toHaveProperty("candidate");
    const otherPending = syntheticPending("119A13");
    capture.observe(otherPending);
    expect(capture.confirmSubmission(otherPending)).toBe(true);
    expect(capture.observe(otherResolved).candidate?.question_key).toBe("119A13");
  });

  describe("submission evidence for an ambiguous next question", () => {
    function setupAmbiguousQuestion() {
      const createEventId = vi.fn(() => EVENT_ID);
      const now = vi.fn(() => new Date(ANSWERED_AT));
      const capture = controller({createEventId, now});
      const pending = syntheticPending("119A13");
      const resolved = fixtureDocument("resolved-other-question.html");
      capture.observe(fixtureDocument("correct.html"));
      capture.observe(resolved);
      return {capture, pending, resolved, createEventId, now};
    }

    it("does not capture an old result redrawn through pending without a verified submission", () => {
      const test = setupAmbiguousQuestion();
      for (let redraw = 0; redraw < 3; redraw += 1) {
        expect(test.capture.observe(test.pending)).not.toHaveProperty("candidate");
        test.capture.observe(fixtureDocument("unsupported.html"));
        expect(test.capture.observe(test.resolved)).not.toHaveProperty("candidate");
      }
      expect(test.createEventId).not.toHaveBeenCalled();
      expect(test.now).not.toHaveBeenCalled();
    });

    it("still requires submission after a different question briefly appears between ambiguous renders", () => {
      const test = setupAmbiguousQuestion();
      test.capture.observe(fixtureDocument("pending.html"));
      test.capture.observe(test.pending);
      expect(test.capture.observe(test.resolved)).not.toHaveProperty("candidate");
      expect(test.createEventId).not.toHaveBeenCalled();
      test.capture.observe(test.pending);
      expect(test.capture.confirmSubmission(test.pending)).toBe(true);
      expect(test.capture.observe(test.resolved).candidate?.question_key).toBe("119A13");
      expect(test.createEventId).toHaveBeenCalledOnce();
    });

    it("requires fresh submission when returning to an initially resolved question after answering another", () => {
      const createEventId = vi.fn(() => EVENT_ID);
      const capture = controller({createEventId});
      const originalPending = fixtureDocument("pending.html");
      const originalResolved = fixtureDocument("correct.html");
      capture.observe(originalResolved);
      capture.observe(syntheticPending("119A13"));
      expect(capture.observe(fixtureDocument("resolved-other-question.html")).candidate?.question_key).toBe("119A13");
      capture.observe(originalPending);
      expect(capture.observe(originalResolved)).not.toHaveProperty("candidate");
      expect(createEventId).toHaveBeenCalledOnce();
      capture.observe(originalPending);
      expect(capture.confirmSubmission(originalPending)).toBe(true);
      expect(capture.observe(originalResolved).candidate?.question_key).toBe("119A12");
      expect(createEventId).toHaveBeenCalledTimes(2);
      expect(capture.observe(originalResolved)).not.toHaveProperty("candidate");
    });

    it("requires fresh submission evidence after an armed ambiguous question is interrupted by another question", () => {
      const test = setupAmbiguousQuestion();
      test.capture.observe(test.pending);
      expect(test.capture.confirmSubmission(test.pending)).toBe(true);
      test.capture.observe(fixtureDocument("pending.html"));
      test.capture.observe(test.pending);
      expect(test.capture.observe(test.resolved)).not.toHaveProperty("candidate");
      expect(test.createEventId).not.toHaveBeenCalled();
      test.capture.observe(test.pending);
      expect(test.capture.confirmSubmission(test.pending)).toBe(true);
      expect(test.capture.observe(test.resolved).candidate?.question_key).toBe("119A13");
      expect(test.createEventId).toHaveBeenCalledOnce();
    });

    it("emits the same sequence once only when a matching pending submission is confirmed", () => {
      const test = setupAmbiguousQuestion();
      test.capture.observe(test.pending);
      expect(test.capture.confirmSubmission(test.pending)).toBe(true);
      test.capture.observe(fixtureDocument("unsupported.html"));
      expect(test.capture.observe(test.resolved).candidate).toEqual({
        kind: "attempt_candidate_v1", event_id: EVENT_ID, question_key: "119A13",
        answered_at: ANSWERED_AT, result: "correct", selected_option_indices: [1],
      });
      test.capture.observe(test.pending);
      expect(test.capture.confirmSubmission(test.pending)).toBe(false);
      expect(test.capture.observe(test.resolved)).not.toHaveProperty("candidate");
      expect(test.createEventId).toHaveBeenCalledOnce();
      expect(test.now).toHaveBeenCalledOnce();
    });

    it("can confirm current pending DOM before its mutation observation has been delivered", () => {
      const test = setupAmbiguousQuestion();
      expect(test.capture.confirmSubmission(test.pending)).toBe(true);
      expect(test.capture.observe(test.resolved).candidate?.question_key).toBe("119A13");
    });

    it.each(["different question", "resolved result", "unsupported DOM"] as const)(
      "does not authorize the ambiguous question from %s", (condition) => {
        const test = setupAmbiguousQuestion();
        test.capture.observe(test.pending);
        const supplied = condition === "different question" ? syntheticPending("119A14")
          : condition === "resolved result" ? test.resolved : fixtureDocument("unsupported.html");
        expect(test.capture.confirmSubmission(supplied)).toBe(false);
        expect(test.capture.observe(test.resolved)).not.toHaveProperty("candidate");
        expect(test.createEventId).not.toHaveBeenCalled();
      },
    );

    it.each(["initial result", "already captured"] as const)(
      "does not rearm the same question after %s", (condition) => {
        const createEventId = vi.fn(() => EVENT_ID);
        const capture = controller({createEventId});
        const pending = fixtureDocument("pending.html");
        const resolved = fixtureDocument("correct.html");
        if (condition === "already captured") capture.observe(pending);
        capture.observe(resolved);
        capture.observe(pending);
        expect(capture.confirmSubmission(pending)).toBe(false);
        expect(capture.observe(resolved)).not.toHaveProperty("candidate");
        expect(createEventId).toHaveBeenCalledTimes(condition === "already captured" ? 1 : 0);
      },
    );

    it.each(["reset", "quiz departure"] as const)(
      "discards a confirmed submission after %s", (boundary) => {
        const createEventId = vi.fn(() => EVENT_ID);
        const capture = new CaptureController(new QbQuizAttemptAdapter(), {
          createEventId, now: () => new Date(ANSWERED_AT),
        });
        const qbUrl = "https://qb.medilink-study.com/quiz";
        const pending = fixtureDocument("qb-quiz-next-pending.html", qbUrl);
        const resolved = fixtureDocument("qb-quiz-next-correct.html", qbUrl);
        capture.observe(fixtureDocument("qb-quiz-correct.html", qbUrl));
        capture.observe(resolved);
        capture.observe(pending);
        expect(capture.confirmSubmission(pending)).toBe(true);
        if (boundary === "reset") capture.resetObservationBaseline();
        else capture.observe(fixtureDocument("qb-quiz-next-pending.html", "https://qb.medilink-study.com/search"));
        expect(capture.confirmSubmission(pending)).toBe(false);
        expect(capture.observe(resolved)).not.toHaveProperty("candidate");
        expect(createEventId).not.toHaveBeenCalled();
      },
    );

    it("does not transfer confirmed submission evidence to another ambiguous question", () => {
      const test = setupAmbiguousQuestion();
      test.capture.observe(test.pending);
      expect(test.capture.confirmSubmission(test.pending)).toBe(true);
      const otherResolved = fixtureDocument("resolved-other-question.html");
      const key = otherResolved.querySelector('[data-qb-study-field="question-key"]');
      if (key === null) throw new Error("fixture question identifier missing");
      key.setAttribute("data-qb-study-value", "119A14");
      expect(test.capture.observe(otherResolved)).not.toHaveProperty("candidate");
      test.capture.observe(syntheticPending("119A14"));
      expect(test.capture.observe(otherResolved)).not.toHaveProperty("candidate");
      expect(test.createEventId).not.toHaveBeenCalled();
    });
  });

  it("reports a changed Unsupported reason while suppressing only duplicates", () => {
    let reason: UnsupportedDomReason = "main_missing";
    const adapter: AttemptDomAdapter = {
      observedAttributeNames: [],
      inspect: () => ({ kind: "unsupported", reason }),
    };
    const capture = new CaptureController(adapter);
    const document = fixtureDocument("unsupported.html");

    expect(capture.observe(document)).toHaveProperty(
      "status.code",
      "capture_unsupported_dom:main_missing",
    );
    expect(capture.observe(document)).toEqual({});

    reason = "quiz_root_count_invalid";
    expect(capture.observe(document)).toHaveProperty(
      "status.code",
      "capture_unsupported_dom:quiz_root_count_invalid",
    );
    expect(capture.observe(document)).toEqual({});
  });

  it("fails closed when candidate metadata cannot be generated", () => {
    const capture = controller({ createEventId: () => "not-a-uuid" });
    capture.observe(fixtureDocument("pending.html"));

    expect(capture.observe(fixtureDocument("correct.html"))).toEqual({
      status: {
        kind: "capture_status_v1",
        state: "unsupported",
        code: "capture_candidate_rejected",
      },
    });
  });

  it("never creates candidate metadata after a no-selection resolution on the same question", () => {
    const createEventId = vi.fn(() => EVENT_ID);
    const now = vi.fn(() => new Date(ANSWERED_AT));
    const capture = new CaptureController(new QbQuizAttemptAdapter(), {
      createEventId,
      now,
    });
    const qbUrl = "https://qb.medilink-study.com/quiz";

    expect(capture.observe(fixtureDocument("qb-quiz-pending.html", qbUrl))).toHaveProperty(
      "status.code",
      "capture_observing",
    );
    expect(capture.observe(
      fixtureDocument("qb-quiz-resolved-without-selection.html", qbUrl),
    )).toEqual({});
    expect(capture.observe(
      fixtureDocument("qb-quiz-resolved-without-selection.html", qbUrl),
    )).toEqual({});

    expect(capture.observe(fixtureDocument("unsupported.html", qbUrl))).toHaveProperty(
      "status.code",
      "capture_unsupported_dom:main_missing",
    );
    expect(capture.observe(fixtureDocument("qb-quiz-pending.html", qbUrl))).toHaveProperty(
      "status.code",
      "capture_observing",
    );
    expect(capture.observe(fixtureDocument("qb-quiz-correct.html", qbUrl))).toEqual({});
    expect(createEventId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();

    expect(capture.observe(fixtureDocument("qb-quiz-next-pending.html", qbUrl))).toEqual({});
    expect(capture.observe(fixtureDocument("qb-quiz-next-correct.html", qbUrl))).toEqual({
      candidate: {
        kind: "attempt_candidate_v1",
        event_id: EVENT_ID,
        question_key: "119A13",
        answered_at: ANSWERED_AT,
        result: "correct",
        selected_option_indices: [4],
      },
    });
    expect(createEventId).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
  });

  it("does not create metadata for an initially resolved no-selection DOM", () => {
    const createEventId = vi.fn(() => EVENT_ID);
    const now = vi.fn(() => new Date(ANSWERED_AT));
    const capture = new CaptureController(new QbQuizAttemptAdapter(), {
      createEventId,
      now,
    });
    const document = fixtureDocument(
      "qb-quiz-resolved-without-selection.html",
      "https://qb.medilink-study.com/quiz",
    );

    expect(capture.observe(document)).toEqual({
      status: {
        kind: "capture_status_v1",
        state: "observing",
        code: "capture_observing",
      },
    });
    expect(capture.observe(document)).toEqual({});
    expect(createEventId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it("emits one candidate from the reviewed live marker structure", () => {
    const createEventId = vi.fn(() => EVENT_ID);
    const now = vi.fn(() => new Date(ANSWERED_AT));
    const capture = new CaptureController(new QbQuizAttemptAdapter(), {
      createEventId,
      now,
    });
    const qbUrl = "https://qb.medilink-study.com/quiz";
    const resolved = fixtureDocument("qb-quiz-correct.html", qbUrl);

    expect(capture.observe(
      fixtureDocument("qb-quiz-pending.html", qbUrl),
    )).toHaveProperty("status.code", "capture_observing");
    expect(capture.observe(resolved)).toEqual({
      candidate: {
        kind: "attempt_candidate_v1",
        event_id: EVENT_ID,
        question_key: "119A12",
        answered_at: ANSWERED_AT,
        result: "correct",
        selected_option_indices: [2],
      },
    });
    expect(capture.observe(resolved)).toEqual({});
    expect(createEventId).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
  });

  it("does not create a candidate for a deduplicated-marker relation diagnostic", () => {
    const createEventId = vi.fn(() => EVENT_ID);
    const now = vi.fn(() => new Date(ANSWERED_AT));
    const capture = new CaptureController(new QbQuizAttemptAdapter(), {
      createEventId,
      now,
    });
    const qbUrl = "https://qb.medilink-study.com/quiz";
    const resolved = fixtureDocument(
      "qb-quiz-correct-marker-duplicate.html",
      qbUrl,
    );
    const options = resolved.querySelectorAll(
      QB_QUIZ_DOM_CONTRACT.selectors.option,
    );
    options.item(0)?.classList.remove("border-qb-green", "text-qb-green");
    options.item(1)?.classList.add("border-qb-green", "text-qb-green");

    expect(capture.observe(
      fixtureDocument("qb-quiz-pending.html", qbUrl),
    )).toHaveProperty("status.code", "capture_observing");
    expect(capture.observe(resolved)).toEqual({
      status: {
        kind: "capture_status_v1",
        state: "unsupported",
        code: "capture_unsupported_dom:correct_markers_deduplicated_mapping_disjoint_from_selection",
      },
    });
    expect(createEventId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it("does not emit when the nearest quiz root drifts after an outer-only marker", () => {
    const createEventId = vi.fn(() => EVENT_ID);
    const now = vi.fn(() => new Date(ANSWERED_AT));
    const capture = new CaptureController(new QbQuizAttemptAdapter(), {
      createEventId,
      now,
    });
    const document = fixtureDocument(
      "qb-quiz-pending.html",
      "https://qb.medilink-study.com/quiz",
    );
    const card = document.querySelector(QB_QUIZ_DOM_CONTRACT.selectors.questionCard);
    if (card === null) {
      throw new TypeError("fixture question card missing");
    }
    const containingRoots = [
      ...document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.quizRoot),
    ].filter((root) => root.contains(card));
    const outerRoot = containingRoots.find((root) => (
      containingRoots.some((other) => other !== root && root.contains(other))
    ));
    const nearestRoot = card.parentElement?.closest(
      QB_QUIZ_DOM_CONTRACT.selectors.quizRoot,
    );
    if (outerRoot === undefined || nearestRoot === null || nearestRoot === undefined) {
      throw new TypeError("fixture quiz-root hierarchy missing");
    }
    const outerMarker = document.createElement("div");
    outerMarker.setAttribute("data-testid", "explanation-box-title");
    outerRoot.append(outerMarker);

    expect(capture.observe(document)).toHaveProperty(
      "status.code",
      "capture_observing",
    );
    nearestRoot.classList.remove("gap-2");
    expect(capture.observe(document)).toEqual({
      status: {
        kind: "capture_status_v1",
        state: "unsupported",
        code: "capture_unsupported_dom:quiz_root_count_invalid",
      },
    });
    expect(createEventId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it("emits every attempt across more than 99 consecutive questions", () => {
    const questionCount = 120;
    let questionNumber = 1;
    let nextObservation: "pending" | "resolved" = "pending";
    const adapter: AttemptDomAdapter = {
      observedAttributeNames: [],
      inspect: () => {
        const questionKey = `119A${questionNumber}`;
        if (nextObservation === "pending") {
          nextObservation = "resolved";
          return {
            kind: "pending",
            question_key: questionKey,
          };
        }

        nextObservation = "pending";
        questionNumber += 1;
        return {
          kind: "resolved",
          question_key: questionKey,
          result: "correct",
          selected_option_indices: [1],
        };
      },
    };
    let eventSequence = 0;
    const createEventId = vi.fn(() => {
      eventSequence += 1;
      return `10000000-0000-4000-8000-${String(eventSequence).padStart(12, "0")}`;
    });
    const capture = new CaptureController(adapter, {
      createEventId,
      now: () => new Date(ANSWERED_AT),
    });
    const root = fixtureDocument("pending.html");
    const emittedQuestionKeys: string[] = [];
    const emittedEventIds = new Set<string>();

    for (let index = 0; index < questionCount; index += 1) {
      expect(capture.observe(root)).not.toHaveProperty("candidate");

      const output = capture.observe(root);
      expect(output.candidate?.question_key).toBe(`119A${index + 1}`);
      if (output.candidate === undefined) {
        throw new Error(`missing candidate for sequential question ${index + 1}`);
      }
      emittedQuestionKeys.push(output.candidate.question_key);
      emittedEventIds.add(output.candidate.event_id);
    }

    expect(emittedQuestionKeys).toHaveLength(questionCount);
    expect(emittedQuestionKeys.at(-1)).toBe("119A120");
    expect(emittedEventIds).toHaveLength(questionCount);
    expect(createEventId).toHaveBeenCalledTimes(questionCount);
  });
});
