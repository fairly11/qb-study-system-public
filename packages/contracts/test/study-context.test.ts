import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  validateAttemptEventV1, validateStudyAttemptEnvelopeV1, validateStudyContextV1,
  compileContractSchema, StudyContextV1Schema,
} from "../src/index.js";

const attempt = JSON.parse(readFileSync(new URL(
  "../../../tests/fixtures/contracts/valid-attempt-event-v1.json", import.meta.url,
), "utf8")) as unknown;
if (!validateAttemptEventV1(attempt)) throw new Error("invalid test fixture");
const context = { schema_version: "1", record_type: "study_context", event_id: attempt.event_id,
  study_mode: "review" } as const;

describe("separate study context contract", () => {
  it("preserves the strict V1 original while accepting a separately linked purpose", () => {
    expect(validateAttemptEventV1(attempt)).toBe(true);
    expect(validateAttemptEventV1({ ...attempt, study_mode: "review" })).toBe(false);
    expect(validateStudyAttemptEnvelopeV1({ attempt, context })).toBe(true);
    expect(validateStudyAttemptEnvelopeV1({ attempt, context: { ...context,
      event_id: "90000000-0000-4000-8000-000000000001" } })).toBe(false);
  });

  it("allows an explicit review plan only for review and rejects unrequested text", () => {
    const withPlan = { ...context, review_plan_id: "90000000-0000-4000-8000-000000000001" };
    expect(validateStudyContextV1(withPlan)).toBe(true);
    expect(validateStudyContextV1({ ...withPlan, study_mode: "normal" })).toBe(false);
    expect(compileContractSchema(StudyContextV1Schema)({ ...withPlan, study_mode: "unclassified" }))
      .toBe(false);
    expect(validateStudyContextV1({ ...context, question_text: "not collected" })).toBe(false);
    expect(validateStudyContextV1({ ...context, study_mode: "inferred_review" })).toBe(false);
  });
});
