import type { AttemptEventV1, StudyContextV1 } from "@qb-study/contracts";

import {
  CAPTURE_UNSUPPORTED_DOM_DIAGNOSTIC_CODES,
  type DeliveryStateV1,
  type PopupStatusV1,
} from "../shared/protocol.js";

export const DEFAULT_COLLECTOR_ENDPOINT =
  "http://127.0.0.1:8765/v2/attempt-events";
export const BACKGROUND_STORAGE_KEY = "qb_study_background_state_v1";
export const RETRY_ALARM_NAME = "qb_study_outbox_retry_v1";

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 5 * 60 * 1_000;
export const COLLECTOR_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_DIAGNOSTIC_ENTRIES = 100;
export const MAX_DELIVERED_EVENTS = 1_000;

export const DIAGNOSTIC_CODES = [
  "background_initialized",
  "background_message_rejected",
  "capture_observing",
  "capture_unsupported_dom",
  ...CAPTURE_UNSUPPORTED_DOM_DIAGNOSTIC_CODES,
  "capture_candidate_rejected",
  // Read compatibility for states created before document-scoped consent
  // replaced popup-triggered injection. Current code never emits these values.
  "capture_enable_blocked",
  "capture_enable_requested",
  "candidate_question_key_rejected",
  "candidate_contract_rejected",
  "candidate_enqueued",
  "candidate_duplicate",
  "candidate_event_id_conflict",
  "collector_endpoint_updated",
  "collector_endpoint_rejected",
  "delivery_inserted",
  "delivery_duplicate",
  "delivery_network_retry",
  "delivery_rate_limited_retry",
  "delivery_server_retry",
  "delivery_http_blocked",
  "delivery_ack_blocked",
  "delivery_endpoint_blocked",
  "retry_requested",
  "storage_state_blocked",
  "storage_write_blocked",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export interface DiagnosticEntryV1 {
  readonly code: DiagnosticCode;
  readonly occurred_at: string;
  readonly event_id?: string;
}

export type OutboxDeliveryStateV1 =
  | "pending"
  | "retry_scheduled"
  | "blocked";

export interface OutboxEntryV1 {
  readonly event: AttemptEventV1;
  /** Missing only in pre-purpose persisted states; restored as unclassified. */
  readonly context?: StudyContextV1;
  readonly delivery_attempts: number;
  readonly next_attempt_at: number | null;
  readonly state: OutboxDeliveryStateV1;
  readonly blocked_code: DiagnosticCode | null;
}

export interface BackgroundStateV1 {
  readonly version: 1;
  readonly collector_endpoint: string;
  readonly outbox: readonly OutboxEntryV1[];
  readonly delivered_events: readonly AttemptEventV1[];
  readonly capture_state: PopupStatusV1["capture_state"];
  readonly delivery_state: DeliveryStateV1;
  readonly last_diagnostic_code: DiagnosticCode | null;
  readonly diagnostics: readonly DiagnosticEntryV1[];
}

export interface BackgroundStoragePort {
  read(): Promise<unknown>;
  write(state: BackgroundStateV1): Promise<void>;
}

export interface ClockPort {
  now(): number;
}

export interface RetrySchedulerPort {
  schedule(atEpochMilliseconds: number): Promise<void>;
  clear(): Promise<void>;
}

export interface TransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface CollectorTransportPort {
  postAttempt(
    endpoint: string,
    event: AttemptEventV1,
    context?: StudyContextV1,
  ): Promise<TransportResponse>;
}

export interface BackgroundPorts {
  readonly storage: BackgroundStoragePort;
  readonly clock: ClockPort;
  readonly scheduler: RetrySchedulerPort;
  readonly transport: CollectorTransportPort;
}

export type AttemptDeliveryAckV1 = {
  readonly event_id: string;
  readonly status: "inserted" | "duplicate";
};
