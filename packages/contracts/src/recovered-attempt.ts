import { Type, type Static } from "@sinclair/typebox";

import { normalizeExactTimestamp, toTokyoDate } from "./time.js";
import { compileContractSchema } from "./validators.js";

const EvidenceIdentifier = Type.String({ minLength: 1, maxLength: 255, pattern: "^[A-Za-z0-9_.:-]+$" });

/** Confirmed answer with a known day, but no directly captured answer instant or selection. */
export const RecoveredAttemptV1Schema = Type.Object({
  schema_version: Type.Literal("1"),
  record_type: Type.Literal("recovered_attempt"),
  recovery_id: Type.String({ format: "uuid" }),
  question_key: Type.String({ pattern: "^[0-9]{3}[A-Z][1-9][0-9]{0,2}$" }),
  answered_on: Type.String({ format: "date" }),
  result: Type.Union([Type.Literal("correct"), Type.Literal("incorrect")]),
  observed_at: Type.String({ format: "date-time" }),
  recovered_at: Type.String({ format: "date-time" }),
  study_mode: Type.Literal("unclassified"),
  selected_option_indices: Type.Null(),
  source_system: Type.Literal("computer-history"),
  source_event_id: EvidenceIdentifier,
  source_segment: EvidenceIdentifier,
}, {
  $id: "https://schemas.qb-study.local/v1/recovered-attempt.schema.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
});

export type RecoveredAttemptV1 = Static<typeof RecoveredAttemptV1Schema>;
const validator = compileContractSchema(RecoveredAttemptV1Schema);

export function validateRecoveredAttemptV1(value: unknown): value is RecoveredAttemptV1 {
  if (!validator(value)) return false;
  const recovery = value as RecoveredAttemptV1;
  const observed = normalizeExactTimestamp(recovery.observed_at);
  const recorded = normalizeExactTimestamp(recovery.recovered_at);
  try {
    return observed.ok && recorded.ok && observed.value <= recorded.value
      && recovery.answered_on <= toTokyoDate(observed.value);
  } catch {
    return false;
  }
}

export const recoveredSchemaRegistryV1 = [
  { fileName: "recovered-attempt.schema.json", schema: RecoveredAttemptV1Schema },
] as const;
