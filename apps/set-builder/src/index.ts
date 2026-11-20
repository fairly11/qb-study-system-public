export interface SetManifest {
  readonly plan_id: string;
  readonly target_date: string;
  readonly name: string;
  readonly question_ids: readonly string[];
  readonly order: "added_oldest_first";
}
const QUESTION = /^[0-9]{3}[A-Z][1-9][0-9]{0,2}$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** A manifest is a selection, never a fabricated answer or an API request. */
export function createSetManifest(input: {
  readonly plan_id: string;
  readonly target_date: string;
  readonly items: readonly {readonly question_key: string; readonly position: number}[];
}): SetManifest {
  if (!UUID.test(input.plan_id) || !/^\d{4}-\d{2}-\d{2}$/u.test(input.target_date)
    || input.items.length > 100 || new Set(input.items.map((item) => item.question_key)).size !== input.items.length
    || input.items.some((item, index) => !QUESTION.test(item.question_key) || item.position !== index + 1)) {
    throw new Error("REVIEW_MANIFEST_INVALID");
  }
  return {
    plan_id: input.plan_id, target_date: input.target_date,
    name: `QB復習_${input.target_date}_${input.plan_id.slice(0, 8)}`,
    question_ids: input.items.map((item) => item.question_key), order: "added_oldest_first",
  };
}
export function verifySetMembership(manifest: SetManifest, observed: readonly string[]): {
  readonly verified: boolean;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly duplicates: readonly string[];
  readonly order_matches: boolean;
} {
  if (observed.some((id) => !QUESTION.test(id))) throw new Error("REVIEW_OBSERVED_ID_INVALID");
  const expected = new Set(manifest.question_ids);
  const actual = new Set(observed);
  const missing = manifest.question_ids.filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  const duplicates = [...actual].filter((id) => observed.filter((entry) => entry === id).length > 1);
  const order_matches = observed.length === manifest.question_ids.length
    && observed.every((id, index) => id === manifest.question_ids[index]);
  return { verified: !missing.length && !unexpected.length && !duplicates.length && order_matches,
    missing, unexpected, duplicates, order_matches };
}
/** Resume only when the saved set is exactly a prefix of the intended order. */
export function remainingSetItems(manifest: SetManifest, observed: readonly string[]): readonly string[] {
  if (observed.length > manifest.question_ids.length
    || observed.some((id, index) => id !== manifest.question_ids[index])) {
    throw new Error("REVIEW_SET_RESUME_MISMATCH");
  }
  return manifest.question_ids.slice(observed.length);
}
