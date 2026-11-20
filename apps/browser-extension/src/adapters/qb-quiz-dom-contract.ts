export const QB_QUIZ_ORIGIN = "https://qb.medilink-study.com";
export const QB_QUIZ_PATHNAME = "/quiz";

export function isSupportedQbQuizLocation(
  location: { readonly origin: string; readonly pathname: string },
): boolean {
  return location.origin === QB_QUIZ_ORIGIN
    && location.pathname === QB_QUIZ_PATHNAME;
}

export const QB_QUIZ_DOM_CONTRACT = Object.freeze({
  origin: QB_QUIZ_ORIGIN,
  pathname: QB_QUIZ_PATHNAME,
  optionCounts: Object.freeze([4, 5]),
  quizRootAncestorCount: 2,
  legacyResultCellCount: 4,
  submitButtonLabel: "解答する",
  selectors: Object.freeze({
    main: "main",
    questionKey: "span.font-semibold.text-qb-blue",
    questionCard: "div.rounded-lg.bg-white.p-3.sm\\:p-4.flex.flex-col.gap-3",
    quizRoot: "div.flex.flex-col.gap-2",
    option: "button.text-left",
    submitLayout: "div.grid.grid-cols-3.p-1.py-3",
    resultMarker: '[data-testid="explanation-box-title"]',
    legacyResultCell: "td.border-y.p-1.text-center",
    legacyResultTable: "table.border-collapse.text-gray-600.w-full",
    legacyResultPanel: "div.bg-white.border.grow.p-3.rounded-lg",
    legacyResultLayout: "div.bg-gray-100.flex.flex-wrap.gap-3.rounded-lg.sm\\:flex-nowrap",
    skyMarker: ".bg-qb-sky",
    correctMarker: ".bg-qb-sky.flex.font-semibold.h-6.items-center.justify-center.rounded-full.shrink-0.text-white.w-6",
    optionProgressFill: "div.absolute.bg-qb-sky.bottom-0.left-0.top-0",
    optionProgressContainer: "div.bg-slate-300.flex.h-6.items-center.justify-center.ml-auto.relative.shrink-0.w-16",
    optionContent: "div.flex.flex-1.gap-4.items-center.min-w-0",
  }),
  correctMarkerClassNames: Object.freeze([
    "bg-qb-sky",
    "flex",
    "font-semibold",
    "h-6",
    "items-center",
    "justify-center",
    "rounded-full",
    "shrink-0",
    "text-white",
    "w-6",
  ]),
  optionProgressFillClassNames: Object.freeze([
    "absolute",
    "bg-qb-sky",
    "bottom-0",
    "left-0",
    "top-0",
  ]),
  optionProgressContainerClassNames: Object.freeze([
    "bg-slate-300",
    "flex",
    "h-6",
    "items-center",
    "justify-center",
    "ml-auto",
    "relative",
    "shrink-0",
    "w-16",
  ]),
  optionContentClassNames: Object.freeze([
    "flex",
    "flex-1",
    "gap-4",
    "items-center",
    "min-w-0",
  ]),
  legacyResultCellBaseClassNames: Object.freeze([
    "border-y",
    "p-1",
    "text-center",
  ]),
  legacyResultTableClassNames: Object.freeze([
    "border-collapse",
    "text-gray-600",
    "w-full",
  ]),
  legacyResultPanelClassNames: Object.freeze([
    "bg-white",
    "border",
    "grow",
    "p-3",
    "rounded-lg",
  ]),
  legacyResultLayoutClassNames: Object.freeze([
    "bg-gray-100",
    "flex",
    "flex-wrap",
    "gap-3",
    "rounded-lg",
    "sm:flex-nowrap",
  ]),
  classNames: Object.freeze({
    selectedBorder: "border-qb-green",
    selectedText: "text-qb-green",
    correct: "bg-qb-sky",
  }),
  observedAttributeNames: Object.freeze(["class", "data-testid"]),
});
