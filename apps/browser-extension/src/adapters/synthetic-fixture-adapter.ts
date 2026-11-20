import { normalizeQuestionKey } from "@qb-study/question-normalizer";

import type {
  AttemptDomAdapter,
  AttemptDomObservation,
  UnsupportedDomReason,
} from "./types.js";

const FIXTURE_ATTRIBUTES = Object.freeze({
  marker: "data-qb-study-synthetic-fixture",
  field: "data-qb-study-field",
  value: "data-qb-study-value",
});

const FIXTURE_SELECTORS = Object.freeze({
  attemptRoot: `[${FIXTURE_ATTRIBUTES.marker}="attempt-v1"]`,
  questionKey: `[${FIXTURE_ATTRIBUTES.field}="question-key"]`,
  answerState: `[${FIXTURE_ATTRIBUTES.field}="answer-state"]`,
  selectedOption: `[${FIXTURE_ATTRIBUTES.field}="selected-option"]`,
});

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;

type ExactElementResult =
  | { readonly ok: true; readonly element: Element }
  | { readonly ok: false; readonly missing: boolean };

function exactElement(root: ParentNode, selector: string): ExactElementResult {
  const elements = root.querySelectorAll(selector);
  if (elements.length === 1) {
    const element = elements.item(0);
    if (element !== null) {
      return { ok: true, element };
    }
  }

  return { ok: false, missing: elements.length === 0 };
}

function unsupported(reason: UnsupportedDomReason): AttemptDomObservation {
  return { kind: "unsupported", reason };
}

function parseSelectedOptionIndices(root: ParentNode):
  | { readonly ok: true; readonly indices: readonly number[] }
  | { readonly ok: false; readonly reason: UnsupportedDomReason } {
  const elements = root.querySelectorAll(FIXTURE_SELECTORS.selectedOption);
  if (elements.length === 0) {
    return { ok: false, reason: "selected_option_missing" };
  }

  const indices: number[] = [];
  for (const element of elements) {
    const rawValue = element.getAttribute(FIXTURE_ATTRIBUTES.value);
    if (rawValue === null || !POSITIVE_INTEGER_PATTERN.test(rawValue)) {
      return { ok: false, reason: "selected_option_invalid" };
    }

    const index = Number(rawValue);
    if (!Number.isSafeInteger(index) || index < 1) {
      return { ok: false, reason: "selected_option_invalid" };
    }
    indices.push(index);
  }

  if (new Set(indices).size !== indices.length) {
    return { ok: false, reason: "selected_option_duplicate" };
  }

  indices.sort((left, right) => left - right);
  return { ok: true, indices };
}

/**
 * Parses only the repository's explicitly synthetic fixture vocabulary.
 * No selector in this adapter is intended to describe the real QB site.
 */
export class SyntheticFixtureAttemptAdapter implements AttemptDomAdapter {
  public readonly observedAttributeNames = Object.freeze([
    FIXTURE_ATTRIBUTES.marker,
    FIXTURE_ATTRIBUTES.field,
    FIXTURE_ATTRIBUTES.value,
  ]);

  public inspect(root: ParentNode): AttemptDomObservation {
    const attemptRoot = exactElement(root, FIXTURE_SELECTORS.attemptRoot);
    if (!attemptRoot.ok) {
      return unsupported(
        attemptRoot.missing ? "fixture_root_missing" : "fixture_root_ambiguous",
      );
    }

    const questionKeyElement = exactElement(
      attemptRoot.element,
      FIXTURE_SELECTORS.questionKey,
    );
    if (!questionKeyElement.ok) {
      return unsupported(
        questionKeyElement.missing ? "question_key_missing" : "question_key_ambiguous",
      );
    }

    const rawQuestionKey = questionKeyElement.element.getAttribute(FIXTURE_ATTRIBUTES.value);
    if (rawQuestionKey === null) {
      return unsupported("question_key_invalid");
    }
    const normalizedQuestionKey = normalizeQuestionKey(rawQuestionKey);
    if (!normalizedQuestionKey.ok) {
      return unsupported("question_key_invalid");
    }

    const answerStateElement = exactElement(
      attemptRoot.element,
      FIXTURE_SELECTORS.answerState,
    );
    if (!answerStateElement.ok) {
      return unsupported(
        answerStateElement.missing ? "answer_state_missing" : "answer_state_ambiguous",
      );
    }

    const answerState = answerStateElement.element.getAttribute(FIXTURE_ATTRIBUTES.value);
    if (answerState === "pending") {
      return {
        kind: "pending",
        question_key: normalizedQuestionKey.question_key,
      };
    }
    if (answerState !== "correct" && answerState !== "incorrect" && answerState !== "unknown") {
      return unsupported("answer_state_invalid");
    }

    const selectedOptionIndices = parseSelectedOptionIndices(attemptRoot.element);
    if (!selectedOptionIndices.ok) {
      return unsupported(selectedOptionIndices.reason);
    }

    return {
      kind: "resolved",
      question_key: normalizedQuestionKey.question_key,
      result: answerState,
      selected_option_indices: selectedOptionIndices.indices,
    };
  }
}
