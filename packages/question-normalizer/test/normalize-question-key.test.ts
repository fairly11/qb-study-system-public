import { describe, expect, it } from "vitest";

import { normalizeQuestionKey } from "../src/index.js";

describe("normalizeQuestionKey", () => {
  it.each([
    "119A12",
    "119-A-12",
    "119 A 12",
    "１１９Ａ１２",
    "１１９　Ａ　１２",
    "119 a 12",
    "119 - A - 12",
  ])("normalizes %s to the canonical key", (input) => {
    expect(normalizeQuestionKey(input)).toEqual({ ok: true, question_key: "119A12" });
  });

  it.each([
    "11565",
    "119AA12",
    "119/A/12",
    "119--A--12",
    "119  A  12",
    "119 -  A - 12",
    "119- A --12",
    "119\tA\t12",
    "119\nA12",
    " 119-A-12 ",
    "11-9A12",
    "119A012",
    "119A0",
    "119A",
    "A11912",
    "",
  ])("rejects %s without guessing", (input) => {
    expect(normalizeQuestionKey(input)).toEqual({ ok: false, code: "invalid_format" });
  });

  it("returns no inferred question group", () => {
    const result = normalizeQuestionKey("119A12");
    expect(result).not.toHaveProperty("question_group_id");
  });
});
