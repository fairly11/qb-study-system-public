import { createHash } from "node:crypto";

import {
  isValidLocalDate,
  normalizeExactTimestamp as normalizeContractExactTimestamp,
  type AttemptEventV1,
  type HistorySnapshotV1,
} from "@qb-study/contracts";

import { StorageValidationError, UnsafeLogFieldError } from "./errors.js";
import type { SystemLogEntry } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const QUESTION_KEY = /^\d{3}[A-Z][1-9]\d{0,2}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9@._:/+%#=~-]*$/u;
const LOG_COMPONENT = /^[a-z][a-z0-9_-]{0,63}$/u;
const EVENT_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const COUNTER_NAME = /^[a-z][a-z0-9_]{0,63}$/u;

const ATTEMPT_KEYS = new Set([
  "schema_version",
  "record_type",
  "event_id",
  "question_key",
  "question_group_id",
  "answered_at",
  "result",
  "selected_option_indices",
  "provenance",
  "quality",
]);

const SNAPSHOT_KEYS = new Set([
  "schema_version",
  "record_type",
  "snapshot_id",
  "snapshot_run_id",
  "question_key",
  "question_group_id",
  "observed_at",
  "final_state",
  "attempt_count",
  "last_attempted_at",
  "last_attempted_on",
  "provenance",
  "quality",
]);

const PROVENANCE_KEYS = new Set([
  "producer",
  "producer_version",
  "source_system",
  "source_record_id",
  "recorded_at",
]);

const QUALITY_KEYS = new Set([
  "acquisition_method",
  "temporal_precision",
  "state_precision",
]);

const LOG_KEYS = new Set([
  "log_id",
  "occurred_at",
  "severity",
  "component",
  "event_code",
  "run_id",
  "correlation_id",
  "record_id",
  "question_key",
  "counters",
]);

type PreparedProvenance = {
  readonly producer: string;
  readonly producer_version: string;
  readonly source_system: string;
  readonly source_record_id: string | null;
  readonly recorded_at: string;
};

type PreparedQuality = {
  readonly acquisition_method: string;
  readonly temporal_precision: string;
  readonly state_precision: string;
};

export interface PreparedAttempt {
  readonly event_id: string;
  readonly schema_version: "1";
  readonly record_type: "attempt_event";
  readonly question_key: string;
  readonly question_group_id: string | null;
  readonly answered_at: string;
  readonly result: "correct" | "incorrect" | "unknown";
  readonly selected_option_indices: readonly number[];
  readonly provenance: PreparedProvenance;
  readonly quality: PreparedQuality;
  readonly payload_checksum: string;
}

export interface PreparedSnapshot {
  readonly snapshot_id: string;
  readonly schema_version: "1";
  readonly record_type: "history_snapshot";
  readonly snapshot_run_id: string;
  readonly question_key: string;
  readonly question_group_id: string | null;
  readonly observed_at: string;
  readonly final_state: "correct" | "incorrect" | "unknown" | "unattempted";
  readonly attempt_count: number | null;
  readonly last_attempted_at: string | null;
  readonly last_attempted_on: string | null;
  readonly provenance: PreparedProvenance;
  readonly quality: PreparedQuality;
  readonly payload_checksum: string;
}

export interface PreparedSystemLog {
  readonly log_id: string;
  readonly occurred_at: string;
  readonly severity: "debug" | "info" | "warn" | "error";
  readonly component: string;
  readonly event_code: string;
  readonly run_id: string | null;
  readonly correlation_id: string | null;
  readonly record_id: string | null;
  readonly question_key: string | null;
  readonly counters: Readonly<Record<string, number>>;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageValidationError(`${label} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new StorageValidationError(`${label} contains an unsupported field`);
    }
  }
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new StorageValidationError(`${field} must be a UUID`);
  }
}

function assertQuestionKey(value: unknown, field = "question_key"): asserts value is string {
  if (typeof value !== "string" || !QUESTION_KEY.test(value)) {
    throw new StorageValidationError(`${field} must be a normalized question key`);
  }
}

function assertSafeToken(value: unknown, field: string, maxLength = 200): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !SAFE_TOKEN.test(value)
  ) {
    throw new StorageValidationError(`${field} must be a bounded safe identifier`);
  }
}

function optionalSafeToken(
  value: unknown,
  field: string,
  maxLength = 200,
): string | null {
  if (value === undefined) {
    return null;
  }
  assertSafeToken(value, field, maxLength);
  return value;
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new StorageValidationError(`${field} has an unsupported value`);
  }
}

export function normalizeExactTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new StorageValidationError(`${field} must be an ISO 8601 timestamp with an offset`);
  }
  const normalized = normalizeContractExactTimestamp(value);
  if (!normalized.ok) {
    throw new StorageValidationError(`${field} is not a valid timestamp`);
  }
  return normalized.value;
}

export function validateDateOnly(value: unknown, field: string): string {
  if (typeof value !== "string" || !isValidLocalDate(value)) {
    throw new StorageValidationError(`${field} is not a valid calendar date`);
  }
  return value;
}

function prepareProvenance(value: unknown): PreparedProvenance {
  assertObject(value, "provenance");
  assertExactKeys(value, PROVENANCE_KEYS, "provenance");
  assertSafeToken(value.producer, "provenance.producer", 100);
  assertSafeToken(value.producer_version, "provenance.producer_version", 100);
  assertSafeToken(value.source_system, "provenance.source_system", 100);
  return {
    producer: value.producer,
    producer_version: value.producer_version,
    source_system: value.source_system,
    source_record_id: optionalSafeToken(
      value.source_record_id,
      "provenance.source_record_id",
      255,
    ),
    recorded_at: normalizeExactTimestamp(value.recorded_at, "provenance.recorded_at"),
  };
}

function prepareQuality(value: unknown): PreparedQuality {
  assertObject(value, "quality");
  assertExactKeys(value, QUALITY_KEYS, "quality");
  assertEnum(
    value.acquisition_method,
    ["direct_capture", "imported_baseline", "derived", "manual"],
    "quality.acquisition_method",
  );
  assertEnum(
    value.temporal_precision,
    ["exact", "date_only", "not_applicable"],
    "quality.temporal_precision",
  );
  assertEnum(
    value.state_precision,
    ["exact", "final_state_only", "not_applicable"],
    "quality.state_precision",
  );
  return {
    acquisition_method: value.acquisition_method,
    temporal_precision: value.temporal_precision,
    state_precision: value.state_precision,
  };
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function prepareAttempt(input: AttemptEventV1): PreparedAttempt {
  assertObject(input, "AttemptEventV1");
  assertExactKeys(input, ATTEMPT_KEYS, "AttemptEventV1");
  if (input.schema_version !== "1" || input.record_type !== "attempt_event") {
    throw new StorageValidationError("AttemptEventV1 discriminator is invalid");
  }
  assertUuid(input.event_id, "event_id");
  assertQuestionKey(input.question_key);
  const questionGroupId = optionalSafeToken(
    input.question_group_id,
    "question_group_id",
    255,
  );
  assertEnum(input.result, ["correct", "incorrect", "unknown"], "result");
  if (!Array.isArray(input.selected_option_indices)) {
    throw new StorageValidationError("selected_option_indices must be an array");
  }
  const selections = [...input.selected_option_indices];
  if (
    selections.length === 0 ||
    selections.some((selection) => !Number.isSafeInteger(selection) || selection < 1) ||
    new Set(selections).size !== selections.length
  ) {
    throw new StorageValidationError(
      "selected_option_indices must contain unique positive integers",
    );
  }
  selections.sort((left, right) => left - right);

  const provenance = prepareProvenance(input.provenance);
  const quality = prepareQuality(input.quality);
  if (
    quality.acquisition_method !== "direct_capture" ||
    quality.temporal_precision !== "exact" ||
    quality.state_precision !== "exact"
  ) {
    throw new StorageValidationError(
      "AttemptEventV1 quality must be direct_capture/exact/exact",
    );
  }
  const payload = {
    schema_version: input.schema_version,
    record_type: input.record_type,
    question_key: input.question_key,
    question_group_id: questionGroupId,
    answered_at: normalizeExactTimestamp(input.answered_at, "answered_at"),
    result: input.result,
    selected_option_indices: selections,
    provenance,
    quality,
  } as const;

  return {
    event_id: input.event_id,
    ...payload,
    payload_checksum: checksum(payload),
  };
}

export function prepareSnapshot(input: HistorySnapshotV1): PreparedSnapshot {
  assertObject(input, "HistorySnapshotV1");
  assertExactKeys(input, SNAPSHOT_KEYS, "HistorySnapshotV1");
  if (input.schema_version !== "1" || input.record_type !== "history_snapshot") {
    throw new StorageValidationError("HistorySnapshotV1 discriminator is invalid");
  }
  assertUuid(input.snapshot_id, "snapshot_id");
  assertUuid(input.snapshot_run_id, "snapshot_run_id");
  assertQuestionKey(input.question_key);
  const questionGroupId = optionalSafeToken(
    input.question_group_id,
    "question_group_id",
    255,
  );
  assertEnum(
    input.final_state,
    ["correct", "incorrect", "unknown", "unattempted"],
    "final_state",
  );
  if (
    input.attempt_count !== undefined &&
    (!Number.isSafeInteger(input.attempt_count) || input.attempt_count < 0)
  ) {
    throw new StorageValidationError("attempt_count must be a non-negative integer");
  }
  if (input.last_attempted_at !== undefined && input.last_attempted_on !== undefined) {
    throw new StorageValidationError(
      "HistorySnapshotV1 cannot contain both last_attempted_at and last_attempted_on",
    );
  }

  const provenance = prepareProvenance(input.provenance);
  const quality = prepareQuality(input.quality);
  if (
    (quality.temporal_precision === "exact" && input.last_attempted_at === undefined) ||
    (quality.temporal_precision === "date_only" && input.last_attempted_on === undefined) ||
    (quality.temporal_precision === "not_applicable" &&
      (input.last_attempted_at !== undefined || input.last_attempted_on !== undefined))
  ) {
    throw new StorageValidationError(
      "HistorySnapshotV1 temporal precision must match its last-attempt field",
    );
  }
  const payload = {
    schema_version: input.schema_version,
    record_type: input.record_type,
    snapshot_run_id: input.snapshot_run_id,
    question_key: input.question_key,
    question_group_id: questionGroupId,
    observed_at: normalizeExactTimestamp(input.observed_at, "observed_at"),
    final_state: input.final_state,
    attempt_count: input.attempt_count ?? null,
    last_attempted_at:
      input.last_attempted_at === undefined
        ? null
        : normalizeExactTimestamp(input.last_attempted_at, "last_attempted_at"),
    last_attempted_on:
      input.last_attempted_on === undefined
        ? null
        : validateDateOnly(input.last_attempted_on, "last_attempted_on"),
    provenance,
    quality,
  } as const;

  return {
    snapshot_id: input.snapshot_id,
    ...payload,
    payload_checksum: checksum(payload),
  };
}

export function prepareSystemLog(input: SystemLogEntry): PreparedSystemLog {
  assertObject(input, "SystemLogEntry");
  for (const key of Object.keys(input)) {
    if (!LOG_KEYS.has(key)) {
      throw new UnsafeLogFieldError();
    }
  }
  assertUuid(input.log_id, "log_id");
  assertEnum(input.severity, ["debug", "info", "warn", "error"], "severity");
  if (!LOG_COMPONENT.test(input.component)) {
    throw new StorageValidationError("component must be a safe component identifier");
  }
  if (!EVENT_CODE.test(input.event_code)) {
    throw new StorageValidationError("event_code must be an uppercase safe code");
  }

  const optionalIdentifier = (value: unknown, field: string): string | null => {
    if (value === undefined) {
      return null;
    }
    assertUuid(value, field);
    return value;
  };
  const questionKey = input.question_key;
  if (questionKey !== undefined) {
    assertQuestionKey(questionKey);
  }

  const counters = input.counters ?? {};
  assertObject(counters, "counters");
  for (const [name, value] of Object.entries(counters)) {
    if (!COUNTER_NAME.test(name)) {
      throw new StorageValidationError("counter name must be a safe identifier");
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new StorageValidationError("counter value must be a non-negative finite number");
    }
  }

  return {
    log_id: input.log_id,
    occurred_at: normalizeExactTimestamp(input.occurred_at, "occurred_at"),
    severity: input.severity,
    component: input.component,
    event_code: input.event_code,
    run_id: optionalIdentifier(input.run_id, "run_id"),
    correlation_id: optionalIdentifier(input.correlation_id, "correlation_id"),
    record_id: optionalIdentifier(input.record_id, "record_id"),
    question_key: questionKey ?? null,
    counters,
  };
}
