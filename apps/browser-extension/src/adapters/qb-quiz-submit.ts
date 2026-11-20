import { QbQuizAttemptAdapter } from "./qb-quiz-adapter.js";
import { QB_QUIZ_DOM_CONTRACT, isSupportedQbQuizLocation } from "./qb-quiz-dom-contract.js";

/** Reads only the reviewed submit control, selection classes and pending question identity. */
export function isTrustedQbSubmission(document: Document, event: Event): boolean {
  if (event.type !== "click" || event.isTrusted !== true || !isSupportedQbQuizLocation(document.location)) return false;
  const ElementClass = document.defaultView?.Element;
  if (ElementClass === undefined || !(event.target instanceof ElementClass)) return false;
  const button = event.target.closest("button");
  if (button === null || button.ownerDocument !== document || !button.isConnected
    || button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true"
    || button.closest("[inert]") !== null || button.closest("fieldset[disabled]") !== null) return false;

  // This exact control and its layout were observed without solving a question.
  // A similarly named control outside the active question's quiz root is insufficient.
  const wrapper = button.parentElement;
  const layout = wrapper?.parentElement;
  if (wrapper?.tagName !== "DIV" || wrapper.classList.length !== 0
    || layout === undefined || layout === null || !layout.matches(QB_QUIZ_DOM_CONTRACT.selectors.submitLayout)
    || layout.classList.length !== 4) return false;
  const main = document.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.main);
  if (main.length !== 1 || !main[0]?.contains(button)) return false;
  const cards = main[0].querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.questionCard);
  if (cards.length !== 1) return false;
  const card = cards[0]!;
  const quizRoot = card.parentElement?.closest(QB_QUIZ_DOM_CONTRACT.selectors.quizRoot);
  if (quizRoot === undefined || quizRoot === null || layout.parentElement !== quizRoot) return false;
  const layouts = quizRoot.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.submitLayout);
  if (layouts.length !== 1 || layouts[0] !== layout) return false;
  // Read labels only after identifying the separate action-control layout;
  // choice buttons and their text are never included in this query.
  const submitButtons = [...layout.querySelectorAll("button")].filter((candidate) => (
    candidate.textContent?.trim() === QB_QUIZ_DOM_CONTRACT.submitButtonLabel
  ));
  if (submitButtons.length !== 1 || submitButtons[0] !== button) return false;

  const options = [...card.querySelectorAll(QB_QUIZ_DOM_CONTRACT.selectors.option)];
  if (!QB_QUIZ_DOM_CONTRACT.optionCounts.includes(options.length)) return false;
  let selected = 0;
  for (const option of options) {
    const border = option.classList.contains(QB_QUIZ_DOM_CONTRACT.classNames.selectedBorder);
    const text = option.classList.contains(QB_QUIZ_DOM_CONTRACT.classNames.selectedText);
    if (border !== text) return false;
    if (border) selected++;
  }
  return selected > 0 && new QbQuizAttemptAdapter().inspect(document).kind === "pending";
}
