import { readFileSync } from "fs";

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { SyntheticFixtureAttemptAdapter } from "../src/adapters/index.js";

function fixtureDocument(name: string): Document {
  const html = readFileSync(
    new URL(`../../../tests/fixtures/browser-extension/${name}`, import.meta.url),
    "utf8",
  );
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
}

describe("SyntheticFixtureAttemptAdapter", () => {
  const adapter = new SyntheticFixtureAttemptAdapter();

  it("parses a pending state without inventing an attempt", () => {
    expect(adapter.inspect(fixtureDocument("pending.html"))).toEqual({
      kind: "pending",
      question_key: "119A12",
    });
  });

  it("parses a correct result and canonicalizes explicit option indices", () => {
    expect(adapter.inspect(fixtureDocument("correct.html"))).toEqual({
      kind: "resolved",
      question_key: "119A12",
      result: "correct",
      selected_option_indices: [1, 3],
    });
  });

  it("parses an incorrect result", () => {
    expect(adapter.inspect(fixtureDocument("incorrect.html"))).toEqual({
      kind: "resolved",
      question_key: "119A12",
      result: "incorrect",
      selected_option_indices: [2],
    });
  });

  it("parses an explicitly unknown result", () => {
    expect(adapter.inspect(fixtureDocument("unknown.html"))).toEqual({
      kind: "resolved",
      question_key: "119A12",
      result: "unknown",
      selected_option_indices: [4],
    });
  });

  it("fails closed for a DOM outside the synthetic fixture vocabulary", () => {
    expect(adapter.inspect(fixtureDocument("unsupported.html"))).toEqual({
      kind: "unsupported",
      reason: "fixture_root_missing",
    });
  });

  it("does not infer a malformed question key", () => {
    expect(adapter.inspect(fixtureDocument("invalid-question-key.html"))).toEqual({
      kind: "unsupported",
      reason: "question_key_invalid",
    });
  });

  it.each([
    ["invalid-selected-option.html", "selected_option_invalid"],
    ["unsafe-selected-option.html", "selected_option_invalid"],
    ["duplicate-selected-option.html", "selected_option_duplicate"],
  ] as const)("rejects non-contract option indices in %s", (fixture, reason) => {
    expect(adapter.inspect(fixtureDocument(fixture))).toEqual({
      kind: "unsupported",
      reason,
    });
  });

  it("requires at least one explicit selected option for a resolved state", () => {
    expect(adapter.inspect(fixtureDocument("missing-selected-option.html"))).toEqual({
      kind: "unsupported",
      reason: "selected_option_missing",
    });
  });
});
