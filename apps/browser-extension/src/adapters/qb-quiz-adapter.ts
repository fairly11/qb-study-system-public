import { normalizeQuestionKey } from "@qb-study/question-normalizer";

import {
  QB_QUIZ_DOM_CONTRACT,
  isSupportedQbQuizLocation,
} from "./qb-quiz-dom-contract.js";
import type {
  AttemptDomAdapter,
  AttemptDomObservation,
  UnsupportedDomReason,
} from "./types.js";

type ExactElementResult =
  | { readonly ok: true; readonly element: Element }
  | { readonly ok: false; readonly missing: boolean };

type CorrectIndicesResult =
  | { readonly ok: true; readonly indices: readonly number[] }
  | { readonly ok: false; readonly reason: UnsupportedDomReason };

type MarkerPartitionResult =
  | { readonly ok: true; readonly correctMarkers: readonly Element[] }
  | { readonly ok: false; readonly reason: UnsupportedDomReason };

type LegacyResultState =
  | { readonly kind: "missing" }
  | { readonly kind: "mounting" }
  | { readonly kind: "resolved"; readonly result: "correct" | "incorrect" }
  | { readonly kind: "unsupported"; readonly reason: UnsupportedDomReason };

const MAX_QUESTION_KEY_SOURCE_LENGTH = 13;
const TWO_DIGIT_QB_QUESTION_KEY = /^([0-9]{2})([A-Z])([1-9][0-9]{0,2})$/u;

function normalizeQbDisplayQuestionKey(
  input: string,
): ReturnType<typeof normalizeQuestionKey> {
  const normalized = normalizeQuestionKey(input);
  if (normalized.ok) {
    return normalized;
  }

  // QB displays historical examinations below 100 without the leading zero
  // required by the canonical V1 question key (for example, 80A1). Accept
  // only that exact compact form and delegate the canonical result back to
  // the shared normalizer. All other variants remain fail closed.
  const displayMatch = TWO_DIGIT_QB_QUESTION_KEY.exec(
    input.normalize("NFKC").toUpperCase(),
  );
  if (displayMatch === null) {
    return normalized;
  }

  const [, examination, section, number] = displayMatch;
  return normalizeQuestionKey(`0${examination}${section}${number}`);
}

function unsupported(reason: UnsupportedDomReason): AttemptDomObservation {
  return { kind: "unsupported", reason };
}

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

function ownerDocument(root: ParentNode): Document | null {
  const node = root as Node;
  if (node.nodeType === 9) {
    return root as Document;
  }
  return node.ownerDocument;
}

function directText(element: Element): string {
  let value = "";
  for (const child of element.childNodes) {
    if (child.nodeType === 3) {
      value += child.nodeValue ?? "";
    }
  }
  return value.trim();
}

function hasExactClassNames(
  element: Element,
  expected: readonly string[],
): boolean {
  return element.classList.length === expected.length
    && expected.every((className) => element.classList.contains(className));
}

function isBoundedQuestionKey(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0
    && trimmed.length <= MAX_QUESTION_KEY_SOURCE_LENGTH
    && normalizeQbDisplayQuestionKey(trimmed).ok;
}

function descendantTextValues(element: Element): readonly string[] {
  const values: string[] = [];
  const visit = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const value = (child.nodeValue ?? "").trim();
        if (value.length > 0) {
          values.push(value);
        }
      } else if (child.nodeType === 1) {
        visit(child);
      }
    }
  };
  visit(element);
  return values;
}

function diagnoseInvalidQuestionKey(element: Element): UnsupportedDomReason {
  const direct = directText(element);
  const descendant = element.textContent?.trim() ?? "";

  if (isBoundedQuestionKey(descendant)) {
    return "question_key_nested_text_valid";
  }

  const candidateCount = descendantTextValues(element).filter(
    isBoundedQuestionKey,
  ).length;
  if (candidateCount === 1) {
    return "question_key_unique_descendant_candidate";
  }
  if (candidateCount > 1) {
    return "question_key_candidate_ambiguous";
  }
  if (direct.length > 0) {
    return "question_key_direct_text_invalid";
  }
  return "question_key_candidate_missing";
}

function closestContainingElement(
  boundary: Element,
  selector: string,
  contained: Element,
): Element | null {
  // Reviewed layout wrappers may repeat the root class set. The closest
  // matching ancestor is the root structurally associated with this card.
  const closest = contained.parentElement?.closest(selector) ?? null;
  return closest !== null && boundary.contains(closest) ? closest : null;
}

function containingElements(
  boundary: Element,
  selector: string,
  contained: Element,
): readonly Element[] {
  return [...boundary.querySelectorAll(selector)].filter((element) => (
    element.contains(contained)
  ));
}

function parseSelectedIndices(
  options: readonly Element[],
):
  | { readonly ok: true; readonly indices: readonly number[] }
  | { readonly ok: false } {
  const indices: number[] = [];
  for (const [offset, option] of options.entries()) {
    const hasBorder = option.classList.contains(
      QB_QUIZ_DOM_CONTRACT.classNames.selectedBorder,
    );
    const hasText = option.classList.contains(
      QB_QUIZ_DOM_CONTRACT.classNames.selectedText,
    );
    if (hasBorder !== hasText) {
      return { ok: false };
    }
    if (hasBorder) {
      indices.push(offset + 1);
    }
  }
  return { ok: true, indices: Object.freeze(indices) };
}

function parseLegacyResultState(quizRoot: Element): LegacyResultState {
  const tables = [...quizRoot.querySelectorAll(
    QB_QUIZ_DOM_CONTRACT.selectors.legacyResultTable,
  )];
  if (tables.length === 0) {
    return { kind: "missing" };
  }
  if (tables.length !== 1) {
    return { kind: "unsupported", reason: "answer_state_ambiguous" };
  }

  const table = tables[0];
  if (table === undefined) {
    return { kind: "unsupported", reason: "answer_state_missing" };
  }
  const cells = [...table.querySelectorAll(
    QB_QUIZ_DOM_CONTRACT.selectors.legacyResultCell,
  )];
  const statusCells = cells.filter((cell) => {
    const value = directText(cell);
    return value === "正解" || value === "不正解";
  });
  if (statusCells.length === 0) {
    // The reviewed legacy table is mounted before its status text during a
    // normal result render. With no exact status there is still no evidence of
    // a resolved answer, so remain pending and wait for the character-data or
    // child-list mutation. This can never emit an event on its own.
    return { kind: "mounting" };
  }
  if (statusCells.length !== 1) {
    return { kind: "unsupported", reason: "answer_state_ambiguous" };
  }

  const statusCell = statusCells[0];
  const panel = table.parentElement;
  const layout = panel?.parentElement ?? null;
  const statusExtraClasses = statusCell === undefined
    ? []
    : [...statusCell.classList].filter((className) => (
      !QB_QUIZ_DOM_CONTRACT.legacyResultCellBaseClassNames.includes(className)
    ));
  if (
    statusCell === undefined
    || cells.length !== QB_QUIZ_DOM_CONTRACT.legacyResultCellCount
    || statusCell.tagName !== "TD"
    || statusCell.parentElement?.tagName !== "TR"
    || statusCell.closest(QB_QUIZ_DOM_CONTRACT.selectors.legacyResultTable) !== table
    || !QB_QUIZ_DOM_CONTRACT.legacyResultCellBaseClassNames.every(
      (className) => statusCell.classList.contains(className),
    )
    || statusCell.classList.length
      !== QB_QUIZ_DOM_CONTRACT.legacyResultCellBaseClassNames.length + 1
    || statusExtraClasses.length !== 1
    || !/^text-qb-[a-z0-9-]+$/u.test(statusExtraClasses[0] ?? "")
    || !hasExactClassNames(
      table,
      QB_QUIZ_DOM_CONTRACT.legacyResultTableClassNames,
    )
    || panel === null
    || !panel.matches(QB_QUIZ_DOM_CONTRACT.selectors.legacyResultPanel)
    || !hasExactClassNames(
      panel,
      QB_QUIZ_DOM_CONTRACT.legacyResultPanelClassNames,
    )
    || layout === null
    || !layout.matches(QB_QUIZ_DOM_CONTRACT.selectors.legacyResultLayout)
    || !hasExactClassNames(
      layout,
      QB_QUIZ_DOM_CONTRACT.legacyResultLayoutClassNames,
    )
    || !quizRoot.contains(layout)
  ) {
    return { kind: "unsupported", reason: "answer_state_invalid" };
  }

  return {
    kind: "resolved",
    result: directText(statusCell) === "正解" ? "correct" : "incorrect",
  };
}

function partitionReviewedSkyMarkers(
  questionCard: Element,
  options: readonly Element[],
): MarkerPartitionResult {
  const skyMarkers = [...questionCard.querySelectorAll(
    QB_QUIZ_DOM_CONTRACT.selectors.skyMarker,
  )];
  const correctMarkers: Element[] = [];
  const progressCounts = new Map<Element, number>(
    options.map((option) => [option, 0]),
  );

  for (const marker of skyMarkers) {
    if (marker.matches(QB_QUIZ_DOM_CONTRACT.selectors.correctMarker)) {
      if (options.includes(marker)) {
        return { ok: false, reason: "correct_marker_is_option" };
      }
      if (
        marker.tagName !== "DIV"
        || !hasExactClassNames(
          marker,
          QB_QUIZ_DOM_CONTRACT.correctMarkerClassNames,
        )
      ) {
        return { ok: false, reason: "correct_marker_invalid" };
      }
      correctMarkers.push(marker);
      continue;
    }
    if (!marker.matches(QB_QUIZ_DOM_CONTRACT.selectors.optionProgressFill)) {
      return {
        ok: false,
        reason: "correct_marker_unclassified_sky_element",
      };
    }

    const progressContainer = marker.parentElement;
    const optionContent = progressContainer?.parentElement ?? null;
    const option = optionContent?.parentElement ?? null;
    if (
      progressContainer === null
      || marker.tagName !== "DIV"
      || !hasExactClassNames(
        marker,
        QB_QUIZ_DOM_CONTRACT.optionProgressFillClassNames,
      )
      || progressContainer.tagName !== "DIV"
      || !progressContainer.matches(
        QB_QUIZ_DOM_CONTRACT.selectors.optionProgressContainer,
      )
      || !hasExactClassNames(
        progressContainer,
        QB_QUIZ_DOM_CONTRACT.optionProgressContainerClassNames,
      )
      || optionContent === null
      || optionContent.tagName !== "DIV"
      || !optionContent.matches(QB_QUIZ_DOM_CONTRACT.selectors.optionContent)
      || !hasExactClassNames(
        optionContent,
        QB_QUIZ_DOM_CONTRACT.optionContentClassNames,
      )
      || option === null
      || !options.includes(option)
    ) {
      return {
        ok: false,
        reason: "correct_marker_progress_structure_invalid",
      };
    }
    progressCounts.set(option, (progressCounts.get(option) ?? 0) + 1);
  }

  if ([...progressCounts.values()].some((count) => count !== 1)) {
    return {
      ok: false,
      reason: "correct_marker_progress_structure_invalid",
    };
  }

  return { ok: true, correctMarkers: Object.freeze(correctMarkers) };
}

function parseCorrectIndices(
  markerElements: readonly Element[],
  options: readonly Element[],
  selectedIndices: readonly number[],
): CorrectIndicesResult {
  if (markerElements.length === 0) {
    return { ok: false, reason: "correct_marker_missing" };
  }

  const correctOptions: Element[] = [];
  let hasDuplicateOptionMapping = false;
  let hasUnreviewedPosition = false;
  for (const marker of markerElements) {
    if (options.includes(marker)) {
      return { ok: false, reason: "correct_marker_is_option" };
    }
    const containingOptions = options.filter((option) => option.contains(marker));
    if (containingOptions.length === 0) {
      return { ok: false, reason: "correct_marker_option_ancestor_missing" };
    }
    if (containingOptions.length > 1) {
      return { ok: false, reason: "correct_marker_option_ancestor_ambiguous" };
    }
    const containingOption = containingOptions[0];
    if (containingOption === undefined) {
      return { ok: false, reason: "correct_marker_option_ancestor_missing" };
    }
    if (correctOptions.includes(containingOption)) {
      hasDuplicateOptionMapping = true;
    } else {
      correctOptions.push(containingOption);
    }
    if (
      marker.parentElement !== containingOption
      || containingOption.firstElementChild !== marker
    ) {
      hasUnreviewedPosition = true;
    }
  }

  if (hasDuplicateOptionMapping) {
    const correctOptionSet = new Set(correctOptions);
    const selectedOptions = new Set<Element>();
    for (const selectedIndex of selectedIndices) {
      const selectedOption = options[selectedIndex - 1];
      if (selectedOption !== undefined) {
        selectedOptions.add(selectedOption);
      }
    }

    const selectedIsSubset = [...selectedOptions].every((option) => (
      correctOptionSet.has(option)
    ));
    const correctIsSubset = correctOptions.every((option) => (
      selectedOptions.has(option)
    ));
    if (
      selectedOptions.size === correctOptionSet.size
      && selectedIsSubset
    ) {
      return {
        ok: false,
        reason: "correct_markers_deduplicated_mapping_matches_selection",
      };
    }
    if (
      selectedIsSubset
      && correctOptionSet.size > selectedOptions.size
    ) {
      return {
        ok: false,
        reason: "correct_markers_deduplicated_mapping_strict_superset_of_selection",
      };
    }
    if (
      correctIsSubset
      && correctOptionSet.size < selectedOptions.size
    ) {
      return {
        ok: false,
        reason: "correct_markers_deduplicated_mapping_strict_subset_of_selection",
      };
    }

    const overlapCount = correctOptions.filter((option) => (
      selectedOptions.has(option)
    )).length;
    if (overlapCount === 0) {
      return {
        ok: false,
        reason: "correct_markers_deduplicated_mapping_disjoint_from_selection",
      };
    }
    return {
      ok: false,
      reason: correctOptionSet.size === selectedOptions.size
        ? "correct_markers_deduplicated_mapping_same_cardinality_partial_overlap_with_selection"
        : "correct_markers_deduplicated_mapping_different_cardinality_partial_overlap_with_selection",
    };
  }

  if (hasUnreviewedPosition) {
    return { ok: false, reason: "correct_markers_unique_option_mapping" };
  }

  const indices = correctOptions.map((option) => options.indexOf(option) + 1);
  indices.sort((left, right) => left - right);
  return { ok: true, indices: Object.freeze(indices) };
}

/**
 * Parses only the reviewed DOM contract for the QB quiz page.
 * It never returns question content, explanation content, or correct-option indices.
 */
export class QbQuizAttemptAdapter implements AttemptDomAdapter {
  public readonly observedAttributeNames = QB_QUIZ_DOM_CONTRACT.observedAttributeNames;

  public inspect(root: ParentNode): AttemptDomObservation {
    const document = ownerDocument(root);
    if (
      document === null
      || !isSupportedQbQuizLocation(document.location)
    ) {
      return unsupported("qb_location_unsupported");
    }

    const main = exactElement(root, QB_QUIZ_DOM_CONTRACT.selectors.main);
    if (!main.ok) {
      return unsupported(main.missing ? "main_missing" : "main_ambiguous");
    }

    const questionKeyElement = exactElement(
      main.element,
      QB_QUIZ_DOM_CONTRACT.selectors.questionKey,
    );
    if (!questionKeyElement.ok) {
      return unsupported(
        questionKeyElement.missing ? "question_key_missing" : "question_key_ambiguous",
      );
    }
    const normalizedQuestionKey = normalizeQbDisplayQuestionKey(
      directText(questionKeyElement.element),
    );
    if (!normalizedQuestionKey.ok) {
      return unsupported(diagnoseInvalidQuestionKey(questionKeyElement.element));
    }

    const questionCard = exactElement(
      main.element,
      QB_QUIZ_DOM_CONTRACT.selectors.questionCard,
    );
    if (!questionCard.ok) {
      return unsupported(
        questionCard.missing ? "question_card_missing" : "question_card_ambiguous",
      );
    }
    if (!questionCard.element.contains(questionKeyElement.element)) {
      return unsupported("question_card_missing");
    }

    const containingQuizRoots = containingElements(
      main.element,
      QB_QUIZ_DOM_CONTRACT.selectors.quizRoot,
      questionCard.element,
    );
    if (containingQuizRoots.length === 0) {
      return unsupported("quiz_root_missing");
    }
    if (
      containingQuizRoots.length
      !== QB_QUIZ_DOM_CONTRACT.quizRootAncestorCount
    ) {
      return unsupported("quiz_root_count_invalid");
    }
    const quizRoot = closestContainingElement(
      main.element,
      QB_QUIZ_DOM_CONTRACT.selectors.quizRoot,
      questionCard.element,
    );
    if (quizRoot === null) {
      return unsupported("quiz_root_missing");
    }

    const options = [...questionCard.element.querySelectorAll(
      QB_QUIZ_DOM_CONTRACT.selectors.option,
    )];
    if (!QB_QUIZ_DOM_CONTRACT.optionCounts.includes(options.length)) {
      return unsupported("option_count_invalid");
    }

    const resultMarkers = quizRoot.querySelectorAll(
      QB_QUIZ_DOM_CONTRACT.selectors.resultMarker,
    );
    const legacyResult = parseLegacyResultState(quizRoot);
    if (legacyResult.kind === "mounting") {
      return {
        kind: "pending",
        question_key: normalizedQuestionKey.question_key,
      };
    }
    if (
      legacyResult.kind === "unsupported"
      && resultMarkers.length === 0
    ) {
      return unsupported(legacyResult.reason);
    }
    if (resultMarkers.length === 0 && legacyResult.kind === "missing") {
      return {
        kind: "pending",
        question_key: normalizedQuestionKey.question_key,
      };
    }

    const selected = parseSelectedIndices(options);
    if (!selected.ok) {
      return unsupported("selected_marker_invalid");
    }

    if (legacyResult.kind === "resolved") {
      if (selected.indices.length === 0) {
        return {
          kind: "resolved_without_selection",
          question_key: normalizedQuestionKey.question_key,
        };
      }
      return {
        kind: "resolved",
        question_key: normalizedQuestionKey.question_key,
        result: legacyResult.result,
        selected_option_indices: selected.indices,
      };
    }

    const markerPartition = partitionReviewedSkyMarkers(
      questionCard.element,
      options,
    );
    if (!markerPartition.ok) {
      return unsupported(markerPartition.reason);
    }

    if (selected.indices.length === 0) {
      if (markerPartition.correctMarkers.length === 0) {
        return unsupported("correct_marker_missing");
      }
      return {
        kind: "resolved_without_selection",
        question_key: normalizedQuestionKey.question_key,
      };
    }

    const correct = parseCorrectIndices(
      markerPartition.correctMarkers,
      options,
      selected.indices,
    );
    if (!correct.ok) {
      return unsupported(correct.reason);
    }

    const correctSet = new Set(correct.indices);
    const result = selected.indices.length === correctSet.size
      && selected.indices.every((index) => correctSet.has(index))
      ? "correct"
      : "incorrect";

    return {
      kind: "resolved",
      question_key: normalizedQuestionKey.question_key,
      result,
      selected_option_indices: selected.indices,
    };
  }
}
