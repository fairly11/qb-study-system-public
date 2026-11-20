import type { QuestionKey } from "@qb-study/contracts";

export type NormalizeQuestionKeyResult =
  | { readonly ok: true; readonly question_key: QuestionKey }
  | { readonly ok: false; readonly code: "invalid_format" };

const SECTION_SEPARATOR = "(?: | ?- ?)?";
const QUESTION_KEY_PARTS = new RegExp(
  `^([0-9]{3})${SECTION_SEPARATOR}([A-Z])${SECTION_SEPARATOR}([1-9][0-9]{0,2})$`,
  "u",
);

/**
 * Canonicalizes only explicitly supported typography and separators.
 * It never infers a missing section letter or a question group.
 */
export function normalizeQuestionKey(input: string): NormalizeQuestionKeyResult {
  const compatibilityNormalized = input.normalize("NFKC").toUpperCase();
  const match = QUESTION_KEY_PARTS.exec(compatibilityNormalized);
  if (match === null) {
    return { ok: false, code: "invalid_format" };
  }

  const [, examination, section, number] = match;
  if (examination === undefined || section === undefined || number === undefined) {
    return { ok: false, code: "invalid_format" };
  }

  return {
    ok: true,
    question_key: `${examination}${section}${number}` as QuestionKey,
  };
}
