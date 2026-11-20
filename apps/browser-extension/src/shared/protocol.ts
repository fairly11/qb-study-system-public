import type { StudyMode } from "@qb-study/contracts";
import { isStudyMode } from "../background/study-context.js";

export const ATTEMPT_CANDIDATE_MESSAGE_KIND = "attempt_candidate_v1";
export const CAPTURE_STATUS_MESSAGE_KIND = "capture_status_v1";
export const GET_POPUP_STATUS_MESSAGE_KIND = "get_popup_status_v1";
export const RETRY_OUTBOX_MESSAGE_KIND = "retry_outbox_v1";
export const SET_COLLECTOR_ENDPOINT_MESSAGE_KIND = "set_collector_endpoint_v1";
export const QB_QUIZ_BOOTSTRAP_READY_MESSAGE_KIND = "qb_quiz_bootstrap_ready_v1";
export const QB_QUIZ_CONSENT_PROBE_MESSAGE_KIND = "qb_quiz_consent_probe_v1";
export const QB_QUIZ_CAPTURE_MESSAGE_KIND = "qb_quiz_capture_message_v1";
export const START_CAPTURE_MESSAGE_KIND = "start_capture_v1";
export const STOP_CAPTURE_MESSAGE_KIND = "stop_capture_v1";
export const STOP_TAB_CAPTURE_MESSAGE_KIND = "stop_tab_capture_v1";
export const QB_PAGE_ROUTE_MESSAGE_KIND = "qb_page_route_v1";
export const QB_PAGE_ROUTE_PROBE_MESSAGE_KIND = "qb_page_route_probe_v1";
export const GET_TAB_CONSENT_STATUS_MESSAGE_KIND = "get_tab_consent_status_v1";
export const SET_TAB_CONSENT_MESSAGE_KIND = "set_tab_consent_v1";
export const START_STUDY_CAPTURE_MESSAGE_KIND = "start_study_capture_v2";
export const SET_STUDY_MODE_MESSAGE_KIND = "set_study_mode_v1";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const QUESTION_KEY_PATTERN = /^[0-9]{3}[A-Z][1-9][0-9]{0,2}$/u;
const CANONICAL_UTC_TIMESTAMP_PATTERN =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;
const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9_]+(?::[a-z0-9_]+)?$/u;

export const CAPTURE_UNSUPPORTED_DOM_REASONS = Object.freeze([
  "production_adapter_unavailable",
  "qb_location_unsupported",
  "main_missing",
  "main_ambiguous",
  "fixture_root_missing",
  "fixture_root_ambiguous",
  "question_key_missing",
  "question_key_ambiguous",
  "question_key_invalid",
  "question_key_direct_text_invalid",
  "question_key_nested_text_valid",
  "question_key_unique_descendant_candidate",
  "question_key_candidate_missing",
  "question_key_candidate_ambiguous",
  "question_card_missing",
  "question_card_ambiguous",
  "quiz_root_missing",
  "quiz_root_count_invalid",
  "option_count_invalid",
  "answer_state_missing",
  "answer_state_ambiguous",
  "answer_state_invalid",
  "selected_option_missing",
  "selected_option_invalid",
  "selected_option_duplicate",
  "selected_marker_invalid",
  "correct_marker_missing",
  "correct_marker_invalid",
  "correct_marker_parent_invalid",
  "correct_marker_nested_in_option",
  "correct_marker_nested_first_child_chain",
  "correct_marker_nested_position_invalid",
  "correct_marker_not_uniquely_contained",
  "correct_marker_is_option",
  "correct_marker_option_ancestor_missing",
  "correct_marker_option_ancestor_ambiguous",
  "correct_marker_unclassified_sky_element",
  "correct_marker_progress_structure_invalid",
  "correct_marker_position_invalid",
  "correct_markers_unique_option_mapping",
  "correct_markers_deduplicated_mapping_matches_selection",
  "correct_markers_deduplicated_mapping_differs_from_selection",
  "correct_markers_deduplicated_mapping_strict_superset_of_selection",
  "correct_markers_deduplicated_mapping_strict_subset_of_selection",
  "correct_markers_deduplicated_mapping_disjoint_from_selection",
  "correct_markers_deduplicated_mapping_same_cardinality_partial_overlap_with_selection",
  "correct_markers_deduplicated_mapping_different_cardinality_partial_overlap_with_selection",
  "correct_marker_duplicate",
] as const);

export type CaptureUnsupportedDomReasonV1 =
  (typeof CAPTURE_UNSUPPORTED_DOM_REASONS)[number];
export type CaptureUnsupportedDomDiagnosticCodeV1 =
  `capture_unsupported_dom:${CaptureUnsupportedDomReasonV1}`;

export function captureUnsupportedDomDiagnosticCode(
  reason: CaptureUnsupportedDomReasonV1,
): CaptureUnsupportedDomDiagnosticCodeV1 {
  return `capture_unsupported_dom:${reason}`;
}

export const CAPTURE_UNSUPPORTED_DOM_DIAGNOSTIC_CODES = Object.freeze(
  CAPTURE_UNSUPPORTED_DOM_REASONS.map(captureUnsupportedDomDiagnosticCode),
) as readonly CaptureUnsupportedDomDiagnosticCodeV1[];

export const MAX_RECENT_ATTEMPT_SUMMARIES = 99;

export type AttemptResultV1 = "correct" | "incorrect" | "unknown";

export interface AttemptCandidateMessageV1 {
  readonly kind: typeof ATTEMPT_CANDIDATE_MESSAGE_KIND;
  readonly event_id: string;
  readonly question_key: string;
  readonly answered_at: string;
  readonly result: AttemptResultV1;
  readonly selected_option_indices: readonly number[];
}

export type CaptureStatusCodeV1 =
  | "capture_observing"
  | "capture_unsupported_dom"
  | "capture_candidate_rejected"
  | CaptureUnsupportedDomDiagnosticCodeV1;
export type CaptureIssueCodeV1 = Exclude<
  CaptureStatusCodeV1,
  "capture_observing"
>;

export interface CaptureStatusMessageV1 {
  readonly kind: typeof CAPTURE_STATUS_MESSAGE_KIND;
  readonly state: "observing" | "unsupported";
  readonly code: CaptureStatusCodeV1;
}

export interface GetPopupStatusMessageV1 {
  readonly kind: typeof GET_POPUP_STATUS_MESSAGE_KIND;
}

export interface RetryOutboxMessageV1 {
  readonly kind: typeof RETRY_OUTBOX_MESSAGE_KIND;
}

export interface SetCollectorEndpointMessageV1 {
  readonly kind: typeof SET_COLLECTOR_ENDPOINT_MESSAGE_KIND;
  readonly endpoint: string;
}

export interface QbQuizBootstrapReadyMessageV1 {
  readonly kind: typeof QB_QUIZ_BOOTSTRAP_READY_MESSAGE_KIND;
  readonly page_session_id: string;
}

export interface QbQuizConsentProbeMessageV1 {
  readonly kind: typeof QB_QUIZ_CONSENT_PROBE_MESSAGE_KIND;
  readonly page_session_id: string;
}

export interface StartCaptureMessageV1 {
  readonly kind: typeof START_CAPTURE_MESSAGE_KIND;
  readonly page_session_id: string;
}

export interface StopCaptureMessageV1 {
  readonly kind: typeof STOP_CAPTURE_MESSAGE_KIND;
  readonly page_session_id: string;
}

export interface StopTabCaptureMessageV1 {
  readonly kind: typeof STOP_TAB_CAPTURE_MESSAGE_KIND;
  readonly tab_id: number;
  readonly page_session_id: string;
}

export type QbPageRouteDescriptor =
  | { readonly route_kind: "search"; readonly question_set_id: string | null; readonly invalid_set_id: boolean }
  | { readonly route_kind: "quiz"; readonly question_id: string | null }
  | { readonly route_kind: "other" };

export type QbPageRouteProbeMessageV1 = { readonly kind: typeof QB_PAGE_ROUTE_PROBE_MESSAGE_KIND } & (
  | { readonly expected_url: string; readonly expected_route?: never }
  | { readonly expected_route: QbPageRouteDescriptor; readonly expected_url?: never }
);

export interface StudyRouteEvidence {
  readonly route?: QbPageRouteDescriptor;
  readonly first_document_navigation?: "navigate" | "reload" | "back_forward" | "unknown";
  readonly referrer_set_id?: string;
}

export interface QbPageRouteMessageV1 extends StudyRouteEvidence {
  readonly kind: typeof QB_PAGE_ROUTE_MESSAGE_KIND;
  readonly context_lost?: true;
}

export type CaptureDocumentPayloadV1 =
  | AttemptCandidateMessageV1
  | CaptureStatusMessageV1;

export interface QbQuizCaptureMessageV1 {
  readonly kind: typeof QB_QUIZ_CAPTURE_MESSAGE_KIND;
  readonly page_session_id: string;
  readonly message: CaptureDocumentPayloadV1;
}

export interface GetTabConsentStatusMessageV1 {
  readonly kind: typeof GET_TAB_CONSENT_STATUS_MESSAGE_KIND;
  readonly tab_id: number;
}

export interface SetTabConsentMessageV1 {
  readonly kind: typeof SET_TAB_CONSENT_MESSAGE_KIND;
  readonly tab_id: number;
  readonly page_session_id: string;
  readonly decision: "start" | "decline";
}

export interface StartStudyCaptureMessageV2 {
  readonly kind: typeof START_STUDY_CAPTURE_MESSAGE_KIND;
  readonly tab_id: number;
  readonly page_session_id: string;
  readonly study_mode: StudyMode;
}

export interface SetStudyModeMessageV1 {
  readonly kind: typeof SET_STUDY_MODE_MESSAGE_KIND;
  readonly tab_id: number;
  readonly page_session_id: string;
  readonly study_mode: "normal" | "review";
}

export type PopupRequestMessageV1 =
  | GetPopupStatusMessageV1
  | RetryOutboxMessageV1
  | SetCollectorEndpointMessageV1
  | GetTabConsentStatusMessageV1
  | SetTabConsentMessageV1
  | StartStudyCaptureMessageV2
  | SetStudyModeMessageV1
  | StopTabCaptureMessageV1;

export type ExtensionMessageV1 =
  | AttemptCandidateMessageV1
  | CaptureStatusMessageV1
  | PopupRequestMessageV1
  | QbQuizBootstrapReadyMessageV1
  | QbQuizConsentProbeMessageV1
  | QbQuizCaptureMessageV1
  | StartCaptureMessageV1
  | StopCaptureMessageV1
  | QbPageRouteMessageV1
  | QbPageRouteProbeMessageV1;

export type DeliveryStateV1 = "idle" | "delivered" | "retry_scheduled" | "blocked";

export type RecentAttemptDeliveryStateV1 =
  | "pending"
  | "retry_scheduled"
  | "blocked"
  | "delivered";

export interface RecentAttemptSummaryV1 {
  readonly question_key: string;
  readonly answered_at: string;
  readonly result: AttemptResultV1;
  readonly selected_option_indices: readonly number[];
  readonly delivery_state: RecentAttemptDeliveryStateV1;
}

export interface PopupStatusV1 {
  readonly capture_state: "observing" | "unsupported";
  readonly outbox_count: number;
  readonly collector_endpoint: string;
  readonly delivery_state: DeliveryStateV1;
  readonly last_diagnostic_code: string | null;
  readonly last_capture_issue_code: CaptureIssueCodeV1 | null;
  readonly recent_attempts: readonly RecentAttemptSummaryV1[];
}

export interface TabConsentStatusV1 {
  readonly study_mode?: StudyMode;
  readonly state: "unavailable" | "pending" | "declined" | "capturing" | "paused";
  readonly page_session_id: string | null;
}

export type CommandResponseV1 =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly code: string };

export function isCandidatePersistedResponseV1(
  value: unknown,
): value is CommandResponseV1 & { readonly ok: true } {
  return isRecord(value)
    && hasExactKeys(value, ["ok", "code"])
    && value.ok === true
    && (
      value.code === "candidate_enqueued"
      || value.code === "candidate_duplicate"
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}

export function isAttemptCandidateMessageV1(value: unknown): value is AttemptCandidateMessageV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind",
    "event_id",
    "question_key",
    "answered_at",
    "result",
    "selected_option_indices",
  ])) {
    return false;
  }

  return value.kind === ATTEMPT_CANDIDATE_MESSAGE_KIND
    && typeof value.event_id === "string"
    && typeof value.question_key === "string"
    && typeof value.answered_at === "string"
    && (value.result === "correct" || value.result === "incorrect" || value.result === "unknown")
    && Array.isArray(value.selected_option_indices)
    && value.selected_option_indices.every((entry) => Number.isSafeInteger(entry));
}

export function isCaptureStatusMessageV1(value: unknown): value is CaptureStatusMessageV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "state", "code"])) {
    return false;
  }

  if (value.kind !== CAPTURE_STATUS_MESSAGE_KIND) {
    return false;
  }
  if (value.state === "observing") {
    return value.code === "capture_observing";
  }
  return value.state === "unsupported" && (
    value.code === "capture_unsupported_dom"
    || value.code === "capture_candidate_rejected"
    || (
      typeof value.code === "string"
      && CAPTURE_UNSUPPORTED_DOM_DIAGNOSTIC_CODES.includes(
        value.code as CaptureUnsupportedDomDiagnosticCodeV1,
      )
    )
  );
}

export function isCaptureIssueCodeV1(value: unknown): value is CaptureIssueCodeV1 {
  return value === "capture_unsupported_dom"
    || value === "capture_candidate_rejected"
    || (
      typeof value === "string"
      && CAPTURE_UNSUPPORTED_DOM_DIAGNOSTIC_CODES.includes(
        value as CaptureUnsupportedDomDiagnosticCodeV1,
      )
    );
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string"
    || !CANONICAL_UTC_TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isRecentAttemptSummaryV1(
  value: unknown,
): value is RecentAttemptSummaryV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "question_key",
    "answered_at",
    "result",
    "selected_option_indices",
    "delivery_state",
  ])) {
    return false;
  }

  return typeof value.question_key === "string"
    && QUESTION_KEY_PATTERN.test(value.question_key)
    && isCanonicalUtcTimestamp(value.answered_at)
    && (
      value.result === "correct"
      || value.result === "incorrect"
      || value.result === "unknown"
    )
    && Array.isArray(value.selected_option_indices)
    && value.selected_option_indices.length > 0
    && value.selected_option_indices.every(
      (entry) => Number.isSafeInteger(entry) && entry >= 1,
    )
    && new Set(value.selected_option_indices).size
      === value.selected_option_indices.length
    && (
      value.delivery_state === "pending"
      || value.delivery_state === "retry_scheduled"
      || value.delivery_state === "blocked"
      || value.delivery_state === "delivered"
    );
}

export function isPopupStatusV1(value: unknown): value is PopupStatusV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "capture_state",
    "outbox_count",
    "collector_endpoint",
    "delivery_state",
    "last_diagnostic_code",
    "last_capture_issue_code",
    "recent_attempts",
  ])) {
    return false;
  }

  return (value.capture_state === "observing" || value.capture_state === "unsupported")
    && Number.isSafeInteger(value.outbox_count)
    && typeof value.outbox_count === "number"
    && value.outbox_count >= 0
    && typeof value.collector_endpoint === "string"
    && (
      value.delivery_state === "idle"
      || value.delivery_state === "delivered"
      || value.delivery_state === "retry_scheduled"
      || value.delivery_state === "blocked"
    )
    && (
      value.last_diagnostic_code === null
      || (
        typeof value.last_diagnostic_code === "string"
        && value.last_diagnostic_code.length <= 128
        && DIAGNOSTIC_CODE_PATTERN.test(value.last_diagnostic_code)
      )
    )
    && (
      value.last_capture_issue_code === null
      || isCaptureIssueCodeV1(value.last_capture_issue_code)
    )
    && Array.isArray(value.recent_attempts)
    && value.recent_attempts.length <= MAX_RECENT_ATTEMPT_SUMMARIES
    && value.recent_attempts.every(isRecentAttemptSummaryV1);
}

export function isPopupRequestMessageV1(value: unknown): value is PopupRequestMessageV1 {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  if (
    value.kind === GET_POPUP_STATUS_MESSAGE_KIND
    || value.kind === RETRY_OUTBOX_MESSAGE_KIND
  ) {
    return hasExactKeys(value, ["kind"]);
  }

  if (value.kind === GET_TAB_CONSENT_STATUS_MESSAGE_KIND) {
    return hasExactKeys(value, ["kind", "tab_id"])
      && Number.isSafeInteger(value.tab_id)
      && (value.tab_id as number) >= 0;
  }

  if (value.kind === START_STUDY_CAPTURE_MESSAGE_KIND) {
    return hasExactKeys(value, ["kind", "tab_id", "page_session_id", "study_mode"])
      && Number.isSafeInteger(value.tab_id) && (value.tab_id as number) >= 0
      && typeof value.page_session_id === "string" && UUID_PATTERN.test(value.page_session_id)
      && isStudyMode(value.study_mode);
  }

  if (value.kind === SET_STUDY_MODE_MESSAGE_KIND) {
    return hasExactKeys(value, ["kind", "tab_id", "page_session_id", "study_mode"])
      && Number.isSafeInteger(value.tab_id) && (value.tab_id as number) >= 0
      && typeof value.page_session_id === "string" && UUID_PATTERN.test(value.page_session_id)
      && (value.study_mode === "normal" || value.study_mode === "review");
  }

  if (value.kind === STOP_TAB_CAPTURE_MESSAGE_KIND) {
    return hasExactKeys(value, ["kind", "tab_id", "page_session_id"])
      && Number.isSafeInteger(value.tab_id) && (value.tab_id as number) >= 0
      && typeof value.page_session_id === "string" && UUID_PATTERN.test(value.page_session_id);
  }

  if (value.kind === SET_TAB_CONSENT_MESSAGE_KIND) {
    return hasExactKeys(value, [
      "kind",
      "tab_id",
      "page_session_id",
      "decision",
    ])
      && Number.isSafeInteger(value.tab_id)
      && (value.tab_id as number) >= 0
      && typeof value.page_session_id === "string"
      && UUID_PATTERN.test(value.page_session_id)
      && (value.decision === "start" || value.decision === "decline");
  }

  return value.kind === SET_COLLECTOR_ENDPOINT_MESSAGE_KIND
    && hasExactKeys(value, ["kind", "endpoint"])
    && typeof value.endpoint === "string";
}

export function isQbQuizBootstrapReadyMessageV1(
  value: unknown,
): value is QbQuizBootstrapReadyMessageV1 {
  return isRecord(value)
    && hasExactKeys(value, ["kind", "page_session_id"])
    && value.kind === QB_QUIZ_BOOTSTRAP_READY_MESSAGE_KIND
    && typeof value.page_session_id === "string"
    && UUID_PATTERN.test(value.page_session_id);
}

export function isQbQuizConsentProbeMessageV1(
  value: unknown,
): value is QbQuizConsentProbeMessageV1 {
  return isRecord(value)
    && hasExactKeys(value, ["kind", "page_session_id"])
    && value.kind === QB_QUIZ_CONSENT_PROBE_MESSAGE_KIND
    && typeof value.page_session_id === "string"
    && UUID_PATTERN.test(value.page_session_id);
}

export function isQbQuizCaptureMessageV1(
  value: unknown,
): value is QbQuizCaptureMessageV1 {
  return isRecord(value)
    && hasExactKeys(value, ["kind", "page_session_id", "message"])
    && value.kind === QB_QUIZ_CAPTURE_MESSAGE_KIND
    && typeof value.page_session_id === "string"
    && UUID_PATTERN.test(value.page_session_id)
    && (
      isAttemptCandidateMessageV1(value.message)
      || isCaptureStatusMessageV1(value.message)
    );
}

export function isStartCaptureMessageV1(
  value: unknown,
): value is StartCaptureMessageV1 {
  return isRecord(value)
    && hasExactKeys(value, ["kind", "page_session_id"])
    && value.kind === START_CAPTURE_MESSAGE_KIND
    && typeof value.page_session_id === "string"
    && UUID_PATTERN.test(value.page_session_id);
}

export function isTabConsentStatusV1(value: unknown): value is TabConsentStatusV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["state", "page_session_id",
    ...(Object.hasOwn(value, "study_mode") ? ["study_mode"] : []),
  ])) {
    return false;
  }
  return (
    value.state === "unavailable"
    || value.state === "pending"
    || value.state === "declined"
    || value.state === "capturing"
    || value.state === "paused"
  ) && (value.study_mode === undefined || isStudyMode(value.study_mode)) && (
    value.page_session_id === null
    || (
      typeof value.page_session_id === "string"
      && UUID_PATTERN.test(value.page_session_id)
    )
  );
}

export function isQbPageRouteMessageV1(value: unknown): value is QbPageRouteMessageV1 {
  return isRecord(value) && hasExactKeys(value, ["kind",
    ...(Object.hasOwn(value, "context_lost") ? ["context_lost"] : []),
    ...(Object.hasOwn(value, "route") ? ["route"] : []),
    ...(Object.hasOwn(value, "first_document_navigation") ? ["first_document_navigation"] : []),
    ...(Object.hasOwn(value, "referrer_set_id") ? ["referrer_set_id"] : []),
  ]) && value.kind === QB_PAGE_ROUTE_MESSAGE_KIND
    && (value.context_lost === undefined || value.context_lost === true)
    && (value.route === undefined || isQbPageRouteDescriptor(value.route))
    && (value.first_document_navigation === undefined || ["navigate", "reload", "back_forward", "unknown"].includes(value.first_document_navigation as string))
    && (value.referrer_set_id === undefined || (value.first_document_navigation !== undefined
      && typeof value.referrer_set_id === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(value.referrer_set_id)));
}

export function isStopCaptureMessageV1(value: unknown): value is StopCaptureMessageV1 {
  return isRecord(value) && hasExactKeys(value, ["kind", "page_session_id"])
    && value.kind === STOP_CAPTURE_MESSAGE_KIND
    && typeof value.page_session_id === "string" && UUID_PATTERN.test(value.page_session_id);
}

export function isQbPageRouteDescriptor(value: unknown): value is QbPageRouteDescriptor {
  if (!isRecord(value)) return false;
  const id = (entry: unknown): boolean => entry === null || (typeof entry === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(entry));
  if (value.route_kind === "other") return hasExactKeys(value, ["route_kind"]);
  if (value.route_kind === "quiz") return hasExactKeys(value, ["route_kind", "question_id"]) && id(value.question_id);
  return value.route_kind === "search" && hasExactKeys(value, ["route_kind", "question_set_id", "invalid_set_id"])
    && id(value.question_set_id) && typeof value.invalid_set_id === "boolean"
    && (!value.invalid_set_id || value.question_set_id === null);
}

/** Allowlisted URL metadata only; no page text or unrelated query parameters. */
export function qbPageRouteDescriptor(location: { readonly origin: string; readonly pathname: string; readonly search?: string }): QbPageRouteDescriptor | null {
  if (location.origin !== "https://qb.medilink-study.com") return null;
  const params = new URLSearchParams(location.search ?? "");
  const id = (key: string): string | null => {
    const values = params.getAll(key);
    return values.length === 1 && /^[A-Za-z0-9_-]{1,100}$/u.test(values[0] ?? "") ? values[0]! : null;
  };
  if (location.pathname === "/quiz") return { route_kind: "quiz", question_id: id("question_id") };
  if (location.pathname === "/search") {
    const setId = id("questionSetId");
    return { route_kind: "search", question_set_id: setId, invalid_set_id: params.has("questionSetId") && setId === null };
  }
  return { route_kind: "other" };
}

export function sameQbPageRoute(left: QbPageRouteDescriptor, right: QbPageRouteDescriptor | null): boolean {
  if (right === null || left.route_kind !== right.route_kind) return false;
  if (left.route_kind === "other") return true;
  if (left.route_kind === "quiz") return right.route_kind === "quiz" && left.question_id === right.question_id;
  return right.route_kind === "search" && left.question_set_id === right.question_set_id && left.invalid_set_id === right.invalid_set_id;
}

export function isQbPageRouteProbeMessageV1(value: unknown): value is QbPageRouteProbeMessageV1 {
  if (isRecord(value) && hasExactKeys(value, ["kind", "expected_route"])) {
    return value.kind === QB_PAGE_ROUTE_PROBE_MESSAGE_KIND && isQbPageRouteDescriptor(value.expected_route);
  }
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "expected_url"])
    || value.kind !== QB_PAGE_ROUTE_PROBE_MESSAGE_KIND
    || typeof value.expected_url !== "string" || value.expected_url.length > 16_384) return false;
  try {
    const url = new URL(value.expected_url);
    return url.origin === "https://qb.medilink-study.com" && url.username === "" && url.password === "";
  } catch { return false; }
}
