import { describe, expect, it } from "vitest";

import { validateAttemptEventV1, validateRecoveredAttemptV1, type RecoveredAttemptV1 } from "../src/index.js";

const recovery: RecoveredAttemptV1 = {
  schema_version: "1", record_type: "recovered_attempt", recovery_id: "00000000-0000-4000-8000-000000000001",
  question_key: "119A12", answered_on: "2026-10-18", result: "incorrect",
  observed_at: "2026-10-18T00:01:23+09:00", recovered_at: "2026-10-19T00:00:00Z",
  study_mode: "unclassified", selected_option_indices: null, source_system: "computer-history",
  source_event_id: "fixture-event:1", source_segment: "fixture-segment:1",
};

describe("RecoveredAttemptV1", () => {
  it("keeps date-only answers separate from direct attempts and retains the observation instant", () => {
    expect(validateRecoveredAttemptV1(recovery)).toBe(true);
    expect(validateAttemptEventV1(recovery)).toBe(false);
    expect(validateRecoveredAttemptV1({ ...recovery, observed_at: "2026-10-17T15:01:23Z" })).toBe(true);
  });

  it.each([
    { answered_on: "2026-02-30" }, { answered_on: "2026-10-19" },
    { observed_at: "2026-10-18T00:01:23" }, { recovered_at: "2026-10-17T15:00:00Z" },
    { selected_option_indices: [] }, { selected_option_indices: [1] }, { study_mode: "review" },
    { result: "unknown" }, { source_system: "qb-web-dom" }, { source_event_id: "question text\n" },
    { source_segment: "https://example.invalid/path" }, { source_segment: "x".repeat(256) },
    { answered_at: "2026-10-18T00:01:23+09:00" }, { question_key: "119A012" },
  ])("rejects invented or inconsistent evidence %j", (change) => {
    expect(validateRecoveredAttemptV1({ ...recovery, ...change })).toBe(false);
  });
});
