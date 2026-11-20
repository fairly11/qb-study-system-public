import { readFileSync } from "node:fs";

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import {
  QB_QUIZ_DOM_CONTRACT,
  QbQuizAttemptAdapter,
} from "../src/adapters/index.js";

const QB_QUIZ_URL = "https://qb.medilink-study.com/quiz?synthetic=1#fixture";

function fixtureDocument(name: string, url = QB_QUIZ_URL): Document {
  const html = readFileSync(
    new URL(`../../../tests/fixtures/browser-extension/${name}`, import.meta.url),
    "utf8",
  );
  const window = new Window({ url });
  window.document.write(html);
  return window.document as unknown as Document;
}

function requiredElement(document: Document, selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new TypeError(`fixture element missing: ${selector}`);
  }
  return element;
}

function legacyResultDocument(status = "不正解"): Document {
  const document = fixtureDocument("qb-quiz-legacy-result.html");
  requiredElement(
    document,
    QB_QUIZ_DOM_CONTRACT.selectors.questionKey,
  ).textContent = "80A1";
  const statusCell = document.querySelectorAll(
    QB_QUIZ_DOM_CONTRACT.selectors.legacyResultCell,
  ).item(3);
  if (statusCell === null) {
    throw new TypeError("legacy result status fixture element missing");
  }
  statusCell.textContent = status;
  return document;
}

function reviewedCorrectMarker(document: Document): Element {
  const marker = document.createElement("div");
  marker.className = QB_QUIZ_DOM_CONTRACT.correctMarkerClassNames.join(" ");
  return marker;
}

function reviewedOptionProgress(document: Document): Element {
  const content = document.createElement("div");
  content.className = QB_QUIZ_DOM_CONTRACT.optionContentClassNames.join(" ");
  const container = document.createElement("div");
  container.className = QB_QUIZ_DOM_CONTRACT.optionProgressContainerClassNames.join(" ");
  const fill = document.createElement("div");
  fill.className = QB_QUIZ_DOM_CONTRACT.optionProgressFillClassNames.join(" ");
  container.append(fill);
  content.append(container);
  return content;
}

describe("QbQuizAttemptAdapter", () => {
  const adapter = new QbQuizAttemptAdapter();

  it("observes only the reviewed mutation attributes", () => {
    expect(adapter.observedAttributeNames).toEqual(["class", "data-testid"]);
  });

  it("parses a pending question without reading an attempt", () => {
    expect(adapter.inspect(fixtureDocument("qb-quiz-pending.html"))).toEqual({
      kind: "pending",
      question_key: "119A12",
    });
  });

  it("zero-pads the reviewed compact two-digit QB examination key", () => {
    const document = fixtureDocument("qb-quiz-pending.html");
    requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.questionKey,
    ).textContent = "80A1";

    expect(adapter.inspect(document)).toEqual({
      kind: "pending",
      question_key: "080A1",
    });
  });

  it("keeps two-digit QB examination keys canonical after resolution", () => {
    const document = fixtureDocument("qb-quiz-incorrect.html");
    requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.questionKey,
    ).textContent = "80A1";

    expect(adapter.inspect(document)).toEqual({
      kind: "resolved",
      question_key: "080A1",
      result: "incorrect",
      selected_option_indices: [1],
    });
  });

  it.each([
    "8A1",
    "80-A-1",
    "80AA1",
    "80A0",
    "80A01",
  ])("rejects unsupported two-digit QB key variant %s", (questionKey) => {
    const document = fixtureDocument("qb-quiz-pending.html");
    requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.questionKey,
    ).textContent = questionKey;

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "question_key_direct_text_invalid",
    });
  });

  it.each([
    ["不正解", "text-qb-pink", "incorrect"],
    ["正解", "text-qb-green", "correct"],
  ] as const)(
    "parses the reviewed legacy result status %s without reading answer content",
    (status, colorClass, result) => {
      const document = legacyResultDocument(status);
      const statusCell = requiredElement(
        document,
        `${QB_QUIZ_DOM_CONTRACT.selectors.legacyResultCell}.text-qb-pink`,
      );
      statusCell.classList.remove("text-qb-pink");
      statusCell.classList.add(colorClass);

      expect(adapter.inspect(document)).toEqual({
        kind: "resolved",
        question_key: "080A1",
        result,
        selected_option_indices: [1],
      });
    },
  );

  it("prefers an exact legacy status when explanation markers coexist", () => {
    const document = legacyResultDocument();
    const quizRoot = requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.quizRoot,
    ).querySelector(QB_QUIZ_DOM_CONTRACT.selectors.quizRoot);
    if (quizRoot === null) {
      throw new TypeError("functional quiz root fixture element missing");
    }
    const firstMarker = document.createElement("div");
    firstMarker.setAttribute("data-testid", "explanation-box-title");
    const secondMarker = document.createElement("div");
    secondMarker.setAttribute("data-testid", "explanation-box-title");
    quizRoot.append(firstMarker, secondMarker);

    expect(adapter.inspect(document)).toEqual({
      kind: "resolved",
      question_key: "080A1",
      result: "incorrect",
      selected_option_indices: [1],
    });
  });

  it("waits for a mounting legacy status before using explanation markers", () => {
    const document = legacyResultDocument("");
    const quizRoots = document.querySelectorAll(
      QB_QUIZ_DOM_CONTRACT.selectors.quizRoot,
    );
    const quizRoot = quizRoots.item(quizRoots.length - 1);
    if (quizRoot === null) {
      throw new TypeError("functional quiz root fixture element missing");
    }
    const firstMarker = document.createElement("div");
    firstMarker.setAttribute("data-testid", "explanation-box-title");
    const secondMarker = document.createElement("div");
    secondMarker.setAttribute("data-testid", "explanation-box-title");
    quizRoot.append(firstMarker, secondMarker);

    expect(adapter.inspect(document)).toEqual({
      kind: "pending",
      question_key: "080A1",
    });
  });

  it("treats a reviewed legacy result without a selection as non-attempt", () => {
    const document = legacyResultDocument();
    requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.option,
    ).classList.remove("border-qb-green", "text-qb-green");

    expect(adapter.inspect(document)).toEqual({
      kind: "resolved_without_selection",
      question_key: "080A1",
    });
  });

  it("fails closed for ambiguous or drifted legacy result structures", () => {
    const ambiguous = legacyResultDocument();
    const ambiguousStatus = requiredElement(
      ambiguous,
      `${QB_QUIZ_DOM_CONTRACT.selectors.legacyResultCell}.text-qb-pink`,
    );
    ambiguousStatus.parentElement?.append(ambiguousStatus.cloneNode(true));
    expect(adapter.inspect(ambiguous)).toEqual({
      kind: "unsupported",
      reason: "answer_state_ambiguous",
    });

    const invalid = legacyResultDocument();
    requiredElement(
      invalid,
      QB_QUIZ_DOM_CONTRACT.selectors.legacyResultCell,
    ).remove();
    expect(adapter.inspect(invalid)).toEqual({
      kind: "unsupported",
      reason: "answer_state_invalid",
    });

    const missing = legacyResultDocument();
    requiredElement(
      missing,
      `${QB_QUIZ_DOM_CONTRACT.selectors.legacyResultCell}.text-qb-pink`,
    ).textContent = "";
    expect(adapter.inspect(missing)).toEqual({
      kind: "pending",
      question_key: "080A1",
    });
  });

  it("reports a structurally nested valid key without accepting it", () => {
    expect(adapter.inspect(
      fixtureDocument("qb-quiz-question-key-nested.html"),
    )).toEqual({
      kind: "unsupported",
      reason: "question_key_nested_text_valid",
    });
  });

  it("classifies bounded descendant key candidates without exposing text", () => {
    const unique = fixtureDocument("qb-quiz-pending.html");
    const uniqueKey = requiredElement(
      unique,
      QB_QUIZ_DOM_CONTRACT.selectors.questionKey,
    );
    uniqueKey.replaceChildren(
      unique.createTextNode("label"),
      Object.assign(unique.createElement("span"), { textContent: "119A12" }),
    );
    expect(adapter.inspect(unique)).toEqual({
      kind: "unsupported",
      reason: "question_key_unique_descendant_candidate",
    });

    const ambiguous = fixtureDocument("qb-quiz-pending.html");
    const ambiguousKey = requiredElement(
      ambiguous,
      QB_QUIZ_DOM_CONTRACT.selectors.questionKey,
    );
    const first = ambiguous.createElement("span");
    first.textContent = "119A12";
    const second = ambiguous.createElement("span");
    second.textContent = "120B3";
    ambiguousKey.replaceChildren(first, second);
    expect(adapter.inspect(ambiguous)).toEqual({
      kind: "unsupported",
      reason: "question_key_candidate_ambiguous",
    });
  });

  it("distinguishes invalid direct text from a missing candidate", () => {
    const invalid = fixtureDocument("qb-quiz-pending.html");
    requiredElement(
      invalid,
      QB_QUIZ_DOM_CONTRACT.selectors.questionKey,
    ).textContent = "invalid";
    expect(adapter.inspect(invalid)).toEqual({
      kind: "unsupported",
      reason: "question_key_direct_text_invalid",
    });

    const missing = fixtureDocument("qb-quiz-pending.html");
    requiredElement(
      missing,
      QB_QUIZ_DOM_CONTRACT.selectors.questionKey,
    ).replaceChildren();
    expect(adapter.inspect(missing)).toEqual({
      kind: "unsupported",
      reason: "question_key_candidate_missing",
    });
  });

  it.each([
    ["qb-quiz-correct.html", "correct", [2]],
    ["qb-quiz-incorrect.html", "incorrect", [1]],
  ] as const)("parses %s with one-based selected indices", (fixture, result, indices) => {
    expect(adapter.inspect(fixtureDocument(fixture))).toEqual({
      kind: "resolved",
      question_key: "119A12",
      result,
      selected_option_indices: indices,
    });
  });

  it("accepts the reviewed correct-marker class set in any token order", () => {
    const document = fixtureDocument("qb-quiz-correct.html");
    const marker = requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.correctMarker,
    );
    marker.className = [...QB_QUIZ_DOM_CONTRACT.correctMarkerClassNames]
      .reverse()
      .join(" ");

    expect(adapter.inspect(document)).toEqual({
      kind: "resolved",
      question_key: "119A12",
      result: "correct",
      selected_option_indices: [2],
    });
  });

  it.each([
    ["missing required class", (_document: Document, marker: Element) => {
      marker.classList.remove("text-white");
    }, "correct_marker_unclassified_sky_element"],
    ["extra class", (_document: Document, marker: Element) => {
      marker.classList.add("unexpected-marker-class");
    }, "correct_marker_invalid"],
    ["wrong tag", (document: Document, marker: Element) => {
      const replacement = document.createElement("span");
      replacement.className = marker.className;
      marker.replaceWith(replacement);
    }, "correct_marker_invalid"],
  ] as const)("fails closed for a correct marker with %s", (_label, mutate, reason) => {
    const document = fixtureDocument("qb-quiz-correct.html");
    const marker = requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.correctMarker,
    );
    mutate(document, marker);

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason,
    });
  });

  it("rejects an unclassified sky element instead of silently ignoring it", () => {
    const document = fixtureDocument("qb-quiz-correct.html");
    const unknown = document.createElement("div");
    unknown.className = "bg-qb-sky";
    requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.questionCard,
    ).append(unknown);

    const observation = adapter.inspect(document);
    expect(observation).toEqual({
      kind: "unsupported",
      reason: "correct_marker_unclassified_sky_element",
    });
    expect(Object.keys(observation).sort()).toEqual(["kind", "reason"]);
  });

  it.each([
    ["missing", (document: Document) => {
      requiredElement(
        document,
        QB_QUIZ_DOM_CONTRACT.selectors.optionProgressFill,
      ).remove();
    }],
    ["duplicate", (document: Document) => {
      const fill = requiredElement(
        document,
        QB_QUIZ_DOM_CONTRACT.selectors.optionProgressFill,
      );
      fill.parentElement?.append(fill.cloneNode(true));
    }],
    ["wrong direct path", (document: Document) => {
      const fill = requiredElement(
        document,
        QB_QUIZ_DOM_CONTRACT.selectors.optionProgressFill,
      );
      const container = fill.parentElement;
      const content = container?.parentElement;
      if (container === null || container === undefined || content === null) {
        throw new TypeError("fixture progress path missing");
      }
      const wrapper = document.createElement("div");
      container.replaceWith(wrapper);
      wrapper.append(container);
    }],
  ] as const)("fails closed when an option progress marker is %s", (_label, mutate) => {
    const document = fixtureDocument("qb-quiz-correct.html");
    mutate(document);

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_marker_progress_structure_invalid",
    });
  });

  it("compares multiple selections as sets", () => {
    const document = fixtureDocument("qb-quiz-correct.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    options.item(0)?.classList.add("border-qb-green", "text-qb-green");
    options.item(0)?.prepend(reviewedCorrectMarker(document));

    expect(adapter.inspect(document)).toEqual({
      kind: "resolved",
      question_key: "119A12",
      result: "correct",
      selected_option_indices: [1, 2],
    });
  });

  it("represents a resolved result with no selection as a non-attempt state", () => {
    const observation = adapter.inspect(
      fixtureDocument("qb-quiz-resolved-without-selection.html"),
    );

    expect(observation).toEqual({
      kind: "resolved_without_selection",
      question_key: "119A12",
    });
    expect(Object.keys(observation).sort()).toEqual(["kind", "question_key"]);
    expect(JSON.stringify(observation)).not.toMatch(
      /selected_option_indices|correct_option_indices|answered_at|event_id/iu,
    );
  });

  it("does not inspect correct-option structure after confirming no selection", () => {
    const document = fixtureDocument("qb-quiz-resolved-without-selection.html");
    const malformedMarker = reviewedCorrectMarker(document);
    requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.questionCard,
    ).append(malformedMarker);

    expect(adapter.inspect(document)).toEqual({
      kind: "resolved_without_selection",
      question_key: "119A12",
    });
  });

  it("requires reviewed progress structure before a no-selection terminal state", () => {
    const document = fixtureDocument("qb-quiz-resolved-without-selection.html");
    requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.optionProgressFill,
    ).remove();

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_marker_progress_structure_invalid",
    });
  });

  it("does not treat option progress fills alone as a no-selection answer", () => {
    const document = fixtureDocument("qb-quiz-resolved-without-selection.html");
    requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.correctMarker,
    ).remove();

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_marker_missing",
    });
  });

  it.each([
    ["https://example.invalid/quiz", "qb_location_unsupported"],
    ["https://qb.medilink-study.com/other", "qb_location_unsupported"],
  ] as const)("fails closed outside the exact QB quiz location: %s", (url, reason) => {
    expect(adapter.inspect(fixtureDocument("qb-quiz-pending.html", url))).toEqual({
      kind: "unsupported",
      reason,
    });
  });

  it("requires exactly one main and question card", () => {
    const ambiguousMain = fixtureDocument("qb-quiz-pending.html");
    ambiguousMain.body.append(ambiguousMain.createElement("main"));
    expect(adapter.inspect(ambiguousMain)).toEqual({
      kind: "unsupported",
      reason: "main_ambiguous",
    });

    const ambiguousCard = fixtureDocument("qb-quiz-pending.html");
    const card = requiredElement(
      ambiguousCard,
      QB_QUIZ_DOM_CONTRACT.selectors.questionCard,
    );
    const clonedCard = card.cloneNode(true) as Element;
    clonedCard.querySelector(QB_QUIZ_DOM_CONTRACT.selectors.questionKey)?.remove();
    card.parentElement?.append(clonedCard);
    expect(adapter.inspect(ambiguousCard)).toEqual({
      kind: "unsupported",
      reason: "question_card_ambiguous",
    });
  });

  it("selects the nearest reviewed quiz root inside a matching layout wrapper", () => {
    const document = fixtureDocument("qb-quiz-correct.html");
    const card = requiredElement(document, QB_QUIZ_DOM_CONTRACT.selectors.questionCard);
    const containingRoots = [
      ...document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.quizRoot),
    ].filter((root) => root.contains(card));

    expect(containingRoots).toHaveLength(2);
    expect(adapter.inspect(document)).toEqual({
      kind: "resolved",
      question_key: "119A12",
      result: "correct",
      selected_option_indices: [2],
    });
  });

  it("ignores a result marker outside the nearest reviewed quiz root", () => {
    const document = fixtureDocument("qb-quiz-pending.html");
    const card = requiredElement(document, QB_QUIZ_DOM_CONTRACT.selectors.questionCard);
    const containingRoots = [
      ...document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.quizRoot),
    ].filter((root) => root.contains(card));
    const outerRoot = containingRoots.find((root) => (
      containingRoots.some((other) => other !== root && root.contains(other))
    ));
    if (outerRoot === undefined) {
      throw new TypeError("fixture outer quiz layout missing");
    }
    const unrelatedMarker = document.createElement("div");
    unrelatedMarker.setAttribute("data-testid", "explanation-box-title");
    outerRoot.append(unrelatedMarker);

    expect(adapter.inspect(document)).toEqual({
      kind: "pending",
      question_key: "119A12",
    });
  });

  it("fails closed instead of falling back when the nearest quiz root drifts", () => {
    const document = fixtureDocument("qb-quiz-correct.html");
    const card = requiredElement(document, QB_QUIZ_DOM_CONTRACT.selectors.questionCard);
    const nearestRoot = card.parentElement?.closest(
      QB_QUIZ_DOM_CONTRACT.selectors.quizRoot,
    );
    if (nearestRoot === null || nearestRoot === undefined) {
      throw new TypeError("fixture nearest quiz root missing");
    }
    nearestRoot.classList.remove("gap-2");

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "quiz_root_count_invalid",
    });
  });

  it("fails closed when the outer matching layout wrapper drifts", () => {
    const document = fixtureDocument("qb-quiz-pending.html");
    const card = requiredElement(document, QB_QUIZ_DOM_CONTRACT.selectors.questionCard);
    const containingRoots = [
      ...document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.quizRoot),
    ].filter((root) => root.contains(card));
    const outerRoot = containingRoots.find((root) => (
      containingRoots.some((other) => other !== root && root.contains(other))
    ));
    if (outerRoot === undefined) {
      throw new TypeError("fixture outer quiz layout missing");
    }
    outerRoot.classList.remove("gap-2");

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "quiz_root_count_invalid",
    });
  });

  it("fails closed when an extra matching quiz-root ancestor appears", () => {
    const document = fixtureDocument("qb-quiz-pending.html");
    const card = requiredElement(document, QB_QUIZ_DOM_CONTRACT.selectors.questionCard);
    const extraRoot = document.createElement("div");
    extraRoot.className = "flex flex-col gap-2";
    card.replaceWith(extraRoot);
    extraRoot.append(card);

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "quiz_root_count_invalid",
    });
  });

  it("ignores a matching root that does not contain the question card", () => {
    const document = fixtureDocument("qb-quiz-pending.html");
    const unrelatedRoot = document.createElement("div");
    unrelatedRoot.className = "flex flex-col gap-2";
    requiredElement(document, "main").append(unrelatedRoot);

    expect(adapter.inspect(document)).toEqual({
      kind: "pending",
      question_key: "119A12",
    });
  });

  it("fails closed when no reviewed quiz root contains the question card", () => {
    const document = fixtureDocument("qb-quiz-pending.html");
    for (const root of document.querySelectorAll(
      QB_QUIZ_DOM_CONTRACT.selectors.quizRoot,
    )) {
      root.classList.remove("gap-2");
    }

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "quiz_root_missing",
    });
  });

  it("accepts the reviewed four-option QB structure", () => {
    const document = fixtureDocument("qb-quiz-pending.html");
    requiredElement(document, QB_QUIZ_DOM_CONTRACT.selectors.option).remove();

    expect(adapter.inspect(document)).toEqual({
      kind: "pending",
      question_key: "119A12",
    });
  });

  it("fails closed outside the reviewed four-or-five option counts", () => {
    const three = fixtureDocument("qb-quiz-pending.html");
    requiredElement(three, QB_QUIZ_DOM_CONTRACT.selectors.option).remove();
    requiredElement(three, QB_QUIZ_DOM_CONTRACT.selectors.option).remove();
    expect(adapter.inspect(three)).toEqual({
      kind: "unsupported",
      reason: "option_count_invalid",
    });

    const six = fixtureDocument("qb-quiz-pending.html");
    const option = requiredElement(six, QB_QUIZ_DOM_CONTRACT.selectors.option);
    option.parentElement?.append(option.cloneNode(true));
    expect(adapter.inspect(six)).toEqual({
      kind: "unsupported",
      reason: "option_count_invalid",
    });
  });

  it("fails closed for a partial selected marker", () => {
    const document = fixtureDocument("qb-quiz-correct.html");
    requiredElement(document, QB_QUIZ_DOM_CONTRACT.selectors.option).classList.add(
      "border-qb-green",
    );

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "selected_marker_invalid",
    });
  });

  it.each([
    ["qb-quiz-correct-marker-missing.html", "correct_marker_missing"],
    ["qb-quiz-correct-marker-invalid.html", "correct_marker_option_ancestor_missing"],
  ] as const)("fails closed for an invalid correct-marker structure in %s", (fixture, reason) => {
    expect(adapter.inspect(fixtureDocument(fixture))).toEqual({
      kind: "unsupported",
      reason,
    });
  });

  it("reports when a deduplicated marker mapping matches the selection", () => {
    const observation = adapter.inspect(
      fixtureDocument("qb-quiz-correct-marker-duplicate.html"),
    );
    expect(observation).toEqual({
      kind: "unsupported",
      reason: "correct_markers_deduplicated_mapping_matches_selection",
    });
    expect(Object.keys(observation).sort()).toEqual(["kind", "reason"]);
  });

  it("reports when a deduplicated marker mapping is disjoint from the selection", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-duplicate.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    options.item(0)?.classList.remove("border-qb-green", "text-qb-green");
    options.item(1)?.classList.add("border-qb-green", "text-qb-green");

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_markers_deduplicated_mapping_disjoint_from_selection",
    });
  });

  it("reports disjoint marker and selection sets with different cardinality", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-duplicate.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    options.item(0)?.classList.remove("border-qb-green", "text-qb-green");
    options.item(1)?.classList.add("border-qb-green", "text-qb-green");
    options.item(2)?.classList.add("border-qb-green", "text-qb-green");

    const observation = adapter.inspect(document);
    expect(observation).toEqual({
      kind: "unsupported",
      reason: "correct_markers_deduplicated_mapping_disjoint_from_selection",
    });
    expect(Object.keys(observation).sort()).toEqual(["kind", "reason"]);
  });

  it("reports when a deduplicated marker mapping is a strict superset", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-duplicate.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    const secondWrapper = options.item(1)?.firstElementChild;
    if (secondWrapper === null || secondWrapper === undefined) {
      throw new TypeError("fixture second option wrapper missing");
    }
    const marker = reviewedCorrectMarker(document);
    secondWrapper.append(marker);

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_markers_deduplicated_mapping_strict_superset_of_selection",
    });
  });

  it("reports when a deduplicated marker mapping is a strict subset", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-duplicate.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    options.item(1)?.classList.add("border-qb-green", "text-qb-green");

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_markers_deduplicated_mapping_strict_subset_of_selection",
    });
  });

  it("does not let duplicate mappings mask a later invalid marker", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-duplicate.html");
    const rogueMarker = reviewedCorrectMarker(document);
    requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.questionCard,
    ).append(rogueMarker);

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_marker_option_ancestor_missing",
    });
  });

  it("does not let duplicate mappings mask a later marker option", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-duplicate.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    options.item(1)?.classList.add(
      ...QB_QUIZ_DOM_CONTRACT.correctMarkerClassNames,
    );

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_marker_is_option",
    });
  });

  it("compares deduplicated multi-option mappings as sets", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-duplicate.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    const secondOption = options.item(1);
    const secondWrapper = secondOption?.firstElementChild;
    if (secondOption === null || secondWrapper === null) {
      throw new TypeError("fixture second option missing");
    }
    secondOption.classList.add("border-qb-green", "text-qb-green");
    for (let offset = 0; offset < 2; offset += 1) {
      const marker = reviewedCorrectMarker(document);
      secondWrapper.append(marker);
    }

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_markers_deduplicated_mapping_matches_selection",
    });
  });

  it("detects equal-size deduplicated sets with different options", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-duplicate.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    const secondOption = options.item(1);
    const thirdWrapper = options.item(2)?.firstElementChild;
    if (secondOption === null || thirdWrapper === null) {
      throw new TypeError("fixture comparison options missing");
    }
    secondOption.classList.add("border-qb-green", "text-qb-green");
    const marker = reviewedCorrectMarker(document);
    thirdWrapper.append(marker);

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_markers_deduplicated_mapping_same_cardinality_partial_overlap_with_selection",
    });
  });

  it("detects different-size deduplicated sets with a partial overlap", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-duplicate.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    const secondWrapper = options.item(1)?.firstElementChild;
    if (secondWrapper === null || secondWrapper === undefined) {
      throw new TypeError("fixture second option wrapper missing");
    }
    options.item(0)?.classList.remove("border-qb-green", "text-qb-green");
    for (const offset of [1, 2, 3]) {
      options.item(offset)?.classList.add("border-qb-green", "text-qb-green");
    }
    const marker = reviewedCorrectMarker(document);
    secondWrapper.append(marker);

    const observation = adapter.inspect(document);
    expect(observation).toEqual({
      kind: "unsupported",
      reason: "correct_markers_deduplicated_mapping_different_cardinality_partial_overlap_with_selection",
    });
    expect(Object.keys(observation).sort()).toEqual(["kind", "reason"]);
  });

  it("detects a larger marker set with a partial overlap", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-duplicate.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    const secondWrapper = options.item(1)?.firstElementChild;
    const thirdWrapper = options.item(2)?.firstElementChild;
    if (
      secondWrapper === null
      || secondWrapper === undefined
      || thirdWrapper === null
      || thirdWrapper === undefined
    ) {
      throw new TypeError("fixture marker option wrappers missing");
    }
    options.item(3)?.classList.add("border-qb-green", "text-qb-green");
    for (const wrapper of [secondWrapper, thirdWrapper]) {
      const marker = reviewedCorrectMarker(document);
      wrapper.append(marker);
    }

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_markers_deduplicated_mapping_different_cardinality_partial_overlap_with_selection",
    });
  });

  it.each([
    "qb-quiz-correct-marker-nested.html",
    "qb-quiz-correct-marker-nested-position-invalid.html",
    "qb-quiz-correct-marker-position-invalid.html",
  ])("reports a complete unique option mapping before relaxing %s", (fixture) => {
    expect(adapter.inspect(fixtureDocument(fixture))).toEqual({
      kind: "unsupported",
      reason: "correct_markers_unique_option_mapping",
    });
  });

  it("checks every correct marker before reporting a unique option mapping", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-nested.html");
    const rogueMarker = reviewedCorrectMarker(document);
    requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.questionCard,
    ).append(rogueMarker);

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_marker_option_ancestor_missing",
    });
  });

  it("reports a complete unique mapping across multiple distinct options", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-nested.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    const secondWrapper = options.item(1)?.firstElementChild;
    if (secondWrapper === null || secondWrapper === undefined) {
      throw new TypeError("fixture second option wrapper missing");
    }
    const secondMarker = reviewedCorrectMarker(document);
    secondWrapper.append(secondMarker);

    const observation = adapter.inspect(document);
    expect(observation).toEqual({
      kind: "unsupported",
      reason: "correct_markers_unique_option_mapping",
    });
    expect(Object.keys(observation).sort()).toEqual(["kind", "reason"]);
  });

  it("does not let an early position drift mask a later marker option", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-nested.html");
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    options.item(1)?.classList.add(
      ...QB_QUIZ_DOM_CONTRACT.correctMarkerClassNames,
    );

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_marker_is_option",
    });
  });

  it("does not let an early position drift mask a later ambiguous ancestor", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-nested.html");
    const initialOptions = document.querySelectorAll(
      QB_QUIZ_DOM_CONTRACT.selectors.option,
    );
    const nestedOption = initialOptions.item(1);
    const nestedWrapper = nestedOption?.firstElementChild;
    if (nestedOption === null || nestedWrapper === null) {
      throw new TypeError("fixture nested option missing");
    }
    const ambiguousMarker = reviewedCorrectMarker(document);
    nestedWrapper.append(ambiguousMarker);
    const wrapperOption = document.createElement("button");
    wrapperOption.className = "text-left";
    nestedOption.replaceWith(wrapperOption);
    wrapperOption.append(reviewedOptionProgress(document), nestedOption);
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    options.item(options.length - 1)?.remove();

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_marker_option_ancestor_ambiguous",
    });
  });

  it("rejects duplicate nested markers in the same option", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-nested.html");
    const marker = requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.correctMarker,
    );
    marker.parentElement?.append(marker.cloneNode(true));

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_markers_deduplicated_mapping_matches_selection",
    });
  });

  it("fails closed when the correct marker is an option itself", () => {
    const document = fixtureDocument("qb-quiz-correct.html");
    const selectedOption = requiredElement(
      document,
      `${QB_QUIZ_DOM_CONTRACT.selectors.option}.border-qb-green`,
    );
    selectedOption.firstElementChild?.remove();
    selectedOption.classList.add(
      ...QB_QUIZ_DOM_CONTRACT.correctMarkerClassNames,
    );

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_marker_is_option",
    });
  });

  it("fails closed when multiple reviewed options contain a correct marker", () => {
    const document = fixtureDocument("qb-quiz-correct-marker-nested.html");
    const marker = requiredElement(
      document,
      QB_QUIZ_DOM_CONTRACT.selectors.correctMarker,
    );
    const selectedOption = marker.closest(QB_QUIZ_DOM_CONTRACT.selectors.option);
    if (selectedOption === null) {
      throw new TypeError("fixture selected option missing");
    }
    const wrapperOption = document.createElement("button");
    wrapperOption.className = "text-left";
    selectedOption.replaceWith(wrapperOption);
    wrapperOption.append(reviewedOptionProgress(document), selectedOption);
    const options = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option);
    options.item(options.length - 1)?.remove();

    expect(adapter.inspect(document)).toEqual({
      kind: "unsupported",
      reason: "correct_marker_option_ancestor_ambiguous",
    });
  });

  it("does not mutate the inspected DOM", () => {
    const document = fixtureDocument("qb-quiz-resolved-without-selection.html");
    const before = document.documentElement.outerHTML;

    adapter.inspect(document);

    expect(document.documentElement.outerHTML).toBe(before);
  });
});
