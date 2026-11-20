import { Type, type Static } from "@sinclair/typebox";

import { AttemptEventV1Schema } from "./schemas-v1.js";
import { compileContractSchema } from "./validators.js";

export const StudyModeSchema = Type.Union([
  Type.Literal("normal"), Type.Literal("review"), Type.Literal("unclassified"),
]);
export type StudyMode = Static<typeof StudyModeSchema>;

/** Purpose is separate evidence; the immutable AttemptEventV1 stays unchanged. */
export const StudyContextV1Schema = Type.Object({
  schema_version: Type.Literal("1"),
  record_type: Type.Literal("study_context"),
  event_id: Type.String({ format: "uuid" }),
  study_mode: StudyModeSchema,
  review_plan_id: Type.Optional(Type.String({ format: "uuid" })),
}, {
  $id: "https://schemas.qb-study.local/v1/study-context.schema.json",
  allOf: [{
    if: { properties: { review_plan_id: {} }, required: ["review_plan_id"] },
    then: { properties: { study_mode: { const: "review" } } },
  }],
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
});
export type StudyContextV1 = Static<typeof StudyContextV1Schema>;

export const StudyAttemptEnvelopeV1Schema = Type.Object({
  attempt: AttemptEventV1Schema,
  context: StudyContextV1Schema,
}, {
  $id: "https://schemas.qb-study.local/v1/study-attempt-envelope.schema.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
});
export type StudyAttemptEnvelopeV1 = Static<typeof StudyAttemptEnvelopeV1Schema>;

const contextValidator = compileContractSchema(StudyContextV1Schema);
const envelopeValidator = compileContractSchema(StudyAttemptEnvelopeV1Schema);

export function validateStudyContextV1(value: unknown): value is StudyContextV1 {
  if (!contextValidator(value)) return false;
  const context = value as StudyContextV1;
  return context.review_plan_id === undefined || context.study_mode === "review";
}

export function validateStudyAttemptEnvelopeV1(value: unknown): value is StudyAttemptEnvelopeV1 {
  if (!envelopeValidator(value)) return false;
  const envelope = value as StudyAttemptEnvelopeV1;
  return validateStudyContextV1(envelope.context)
    && envelope.context.event_id === envelope.attempt.event_id;
}

export const studySchemaRegistryV1 = [
  { fileName: "study-context.schema.json", schema: StudyContextV1Schema },
  { fileName: "study-attempt-envelope.schema.json", schema: StudyAttemptEnvelopeV1Schema },
] as const;
