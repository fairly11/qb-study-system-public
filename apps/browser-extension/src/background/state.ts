import type { AttemptEventV1 } from "@qb-study/contracts";

import { createStudyContext, isStoredStudyContext } from "./study-context.js";
import { cloneAttemptEvent } from "./attempt-event.js";
import { isCanonicalAttemptEventV1 } from "./attempt-validator.js";
import { isValidCollectorEndpoint, studyCollectorEndpoint } from "./endpoint.js";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DEFAULT_COLLECTOR_ENDPOINT,
  DIAGNOSTIC_CODES,
  MAX_DELIVERED_EVENTS,
  MAX_DIAGNOSTIC_ENTRIES,
  type AttemptDeliveryAckV1,
  type BackgroundStateV1,
  type DiagnosticCode,
  type DiagnosticEntryV1,
  type OutboxEntryV1,
} from "./types.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIAGNOSTIC_CODE_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return typeof value === "string" && DIAGNOSTIC_CODE_SET.has(value);
}

function isDiagnosticEntry(value: unknown): value is DiagnosticEntryV1 {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["code", "occurred_at"],
    ["event_id"],
  )) {
    return false;
  }
  return isDiagnosticCode(value.code)
    && typeof value.occurred_at === "string"
    && !Number.isNaN(Date.parse(value.occurred_at))
    && (value.event_id === undefined
      || (typeof value.event_id === "string" && UUID.test(value.event_id)));
}

function isOutboxEntry(value: unknown): value is OutboxEntryV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "event",
    "delivery_attempts",
    "next_attempt_at",
    "state",
    "blocked_code",
  ], ["context"])) {
    return false;
  }
  if (
    !isCanonicalAttemptEventV1(value.event)
    || (value.context !== undefined && !isStoredStudyContext(value.context, value.event.event_id))
    || !Number.isSafeInteger(value.delivery_attempts)
    || (value.delivery_attempts as number) < 0
    || !(
      value.next_attempt_at === null
      || (
        typeof value.next_attempt_at === "number"
        && Number.isSafeInteger(value.next_attempt_at)
        && value.next_attempt_at >= 0
      )
    )
    || !(
      value.state === "pending"
      || value.state === "retry_scheduled"
      || value.state === "blocked"
    )
    || !(value.blocked_code === null || isDiagnosticCode(value.blocked_code))
  ) {
    return false;
  }
  if (value.state === "pending") {
    return value.next_attempt_at === null && value.blocked_code === null;
  }
  if (value.state === "retry_scheduled") {
    return typeof value.next_attempt_at === "number" && value.blocked_code === null;
  }
  return value.next_attempt_at === null && value.blocked_code !== null;
}

export function isBackgroundStateV1(value: unknown): value is BackgroundStateV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "collector_endpoint",
    "outbox",
    "delivered_events",
    "capture_state",
    "delivery_state",
    "last_diagnostic_code",
    "diagnostics",
  ])) {
    return false;
  }
  const deliveredEvents = value.delivered_events;
  if (
    value.version !== 1
    || typeof value.collector_endpoint !== "string"
    || !isValidCollectorEndpoint(value.collector_endpoint)
    || !Array.isArray(value.outbox)
    || !value.outbox.every(isOutboxEntry)
    || !Array.isArray(deliveredEvents)
    || deliveredEvents.length > MAX_DELIVERED_EVENTS
    || !deliveredEvents.every(isCanonicalAttemptEventV1)
    || !(value.capture_state === "observing" || value.capture_state === "unsupported")
    || !(
      value.delivery_state === "idle"
      || value.delivery_state === "delivered"
      || value.delivery_state === "retry_scheduled"
      || value.delivery_state === "blocked"
    )
    || !(
      value.last_diagnostic_code === null
      || isDiagnosticCode(value.last_diagnostic_code)
    )
    || !Array.isArray(value.diagnostics)
    || value.diagnostics.length > MAX_DIAGNOSTIC_ENTRIES
    || !value.diagnostics.every(isDiagnosticEntry)
  ) {
    return false;
  }
  const eventIds = value.outbox.map(({ event }) => event.event_id);
  const deliveredEventIds = deliveredEvents.map(({ event_id: eventId }) => eventId);
  return new Set(eventIds).size === eventIds.length
    && new Set(deliveredEventIds).size === deliveredEventIds.length
    && eventIds.every((eventId) => !deliveredEventIds.includes(eventId));
}

function cloneOutboxEntry(entry: OutboxEntryV1): OutboxEntryV1 {
  return Object.freeze({
    event: cloneAttemptEvent(entry.event),
    context: Object.freeze({ ...(entry.context ?? createStudyContext(entry.event.event_id)) }),
    delivery_attempts: entry.delivery_attempts,
    next_attempt_at: entry.next_attempt_at,
    state: entry.state,
    blocked_code: entry.blocked_code,
  });
}

function cloneDiagnostic(entry: DiagnosticEntryV1): DiagnosticEntryV1 {
  return entry.event_id === undefined
    ? Object.freeze({ code: entry.code, occurred_at: entry.occurred_at })
    : Object.freeze({
        code: entry.code,
        occurred_at: entry.occurred_at,
        event_id: entry.event_id,
      });
}

export function immutableState(state: BackgroundStateV1): BackgroundStateV1 {
  return Object.freeze({
    ...state,
    collector_endpoint: studyCollectorEndpoint(state.collector_endpoint),
    outbox: Object.freeze(state.outbox.map(cloneOutboxEntry)),
    delivered_events: Object.freeze(state.delivered_events.map(cloneAttemptEvent)),
    diagnostics: Object.freeze(state.diagnostics.map(cloneDiagnostic)),
  });
}

export function createDefaultBackgroundState(): BackgroundStateV1 {
  return immutableState({
    version: 1,
    collector_endpoint: DEFAULT_COLLECTOR_ENDPOINT,
    outbox: [],
    delivered_events: [],
    capture_state: "unsupported",
    delivery_state: "idle",
    last_diagnostic_code: null,
    diagnostics: [],
  });
}

export function restoreBackgroundState(value: unknown): BackgroundStateV1 | null {
  if (value === undefined) {
    return createDefaultBackgroundState();
  }
  return isBackgroundStateV1(value) ? immutableState(value) : null;
}

export function appendDiagnostic(
  state: BackgroundStateV1,
  code: DiagnosticCode,
  occurredAt: string,
  eventId?: string,
): BackgroundStateV1 {
  const safeEventId = eventId !== undefined && UUID.test(eventId)
    ? eventId
    : undefined;
  const entry: DiagnosticEntryV1 = safeEventId === undefined
    ? { code, occurred_at: occurredAt }
    : { code, occurred_at: occurredAt, event_id: safeEventId };
  const diagnostics = [...state.diagnostics, entry].slice(-MAX_DIAGNOSTIC_ENTRIES);
  return immutableState({
    ...state,
    last_diagnostic_code: code,
    diagnostics,
  });
}

export function calculateBackoffMilliseconds(deliveryAttempts: number): number {
  if (!Number.isSafeInteger(deliveryAttempts) || deliveryAttempts < 1) {
    return BACKOFF_BASE_MS;
  }
  const exponent = Math.min(deliveryAttempts - 1, 30);
  return Math.min(BACKOFF_BASE_MS * (2 ** exponent), BACKOFF_MAX_MS);
}

export function sameAttemptEvent(
  left: AttemptEventV1,
  right: AttemptEventV1,
): boolean {
  const leftSelections = [...left.selected_option_indices].sort(
    (first, second) => first - second,
  );
  const rightSelections = [...right.selected_option_indices].sort(
    (first, second) => first - second,
  );
  return left.schema_version === right.schema_version
    && left.record_type === right.record_type
    && left.event_id === right.event_id
    && left.question_key === right.question_key
    && left.question_group_id === right.question_group_id
    && left.answered_at === right.answered_at
    && left.result === right.result
    && leftSelections.length === rightSelections.length
    && leftSelections.every((value, index) => value === rightSelections[index])
    && left.provenance.producer === right.provenance.producer
    && left.provenance.producer_version === right.provenance.producer_version
    && left.provenance.source_system === right.provenance.source_system
    && left.provenance.source_record_id === right.provenance.source_record_id
    && left.provenance.recorded_at === right.provenance.recorded_at
    && left.quality.acquisition_method === right.quality.acquisition_method
    && left.quality.temporal_precision === right.quality.temporal_precision
    && left.quality.state_precision === right.quality.state_precision;
}

export function isAttemptDeliveryAckV1(
  value: unknown,
  expectedEventId: string,
): value is AttemptDeliveryAckV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["event_id", "status"])) {
    return false;
  }
  return value.event_id === expectedEventId
    && (value.status === "inserted" || value.status === "duplicate");
}
