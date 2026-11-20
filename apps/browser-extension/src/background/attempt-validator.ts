import type { AttemptEventV1 } from "@qb-study/contracts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const QUESTION_KEY = /^[0-9]{3}[A-Z][1-9][0-9]{0,2}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9@._:/+%#=~-]*$/u;
const CANONICAL_UTC_TIMESTAMP =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => allowed.has(key));
}

function isSafeIdentifier(value: unknown, maximumLength: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximumLength
    && SAFE_IDENTIFIER.test(value);
}

export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isProvenance(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["producer", "producer_version", "source_system", "recorded_at"],
    ["source_record_id"],
  )) {
    return false;
  }
  return isSafeIdentifier(value.producer, 100)
    && isSafeIdentifier(value.producer_version, 100)
    && isSafeIdentifier(value.source_system, 100)
    && (
      value.source_record_id === undefined
      || isSafeIdentifier(value.source_record_id, 255)
    )
    && isCanonicalUtcTimestamp(value.recorded_at);
}

function isAttemptQuality(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, [
      "acquisition_method",
      "temporal_precision",
      "state_precision",
    ])
    && value.acquisition_method === "direct_capture"
    && value.temporal_precision === "exact"
    && value.state_precision === "exact";
}

/**
 * Runtime-safe validation for the canonical subset produced by this extension.
 * The official contracts validator is used in Node tests to prove compatibility.
 * Keeping runtime imports type-only avoids Ajv code generation in the MV3 worker.
 */
export function isCanonicalAttemptEventV1(value: unknown): value is AttemptEventV1 {
  if (!isRecord(value) || !hasExactKeys(
    value,
    [
      "schema_version",
      "record_type",
      "event_id",
      "question_key",
      "answered_at",
      "result",
      "selected_option_indices",
      "provenance",
      "quality",
    ],
    ["question_group_id"],
  )) {
    return false;
  }

  if (
    value.schema_version !== "1"
    || value.record_type !== "attempt_event"
    || typeof value.event_id !== "string"
    || !UUID.test(value.event_id)
    || typeof value.question_key !== "string"
    || !QUESTION_KEY.test(value.question_key)
    || !isCanonicalUtcTimestamp(value.answered_at)
    || !(value.result === "correct" || value.result === "incorrect" || value.result === "unknown")
    || !Array.isArray(value.selected_option_indices)
    || value.selected_option_indices.length === 0
    || !value.selected_option_indices.every(
      (index) => Number.isSafeInteger(index) && index >= 1,
    )
    || new Set(value.selected_option_indices).size !== value.selected_option_indices.length
    || !isProvenance(value.provenance)
    || !isAttemptQuality(value.quality)
  ) {
    return false;
  }

  return value.question_group_id === undefined
    || isSafeIdentifier(value.question_group_id, 255);
}
