import type { AttemptEventV1, StudyMode } from "@qb-study/contracts";

import {
  GET_POPUP_STATUS_MESSAGE_KIND,
  MAX_RECENT_ATTEMPT_SUMMARIES,
  RETRY_OUTBOX_MESSAGE_KIND,
  SET_COLLECTOR_ENDPOINT_MESSAGE_KIND,
  isAttemptCandidateMessageV1,
  isCaptureIssueCodeV1,
  isCaptureStatusMessageV1,
  isPopupRequestMessageV1,
  type CommandResponseV1,
  type PopupStatusV1,
  type RecentAttemptDeliveryStateV1,
  type RecentAttemptSummaryV1,
  type CaptureIssueCodeV1,
} from "../shared/protocol.js";
import { createStudyContext, isStudyMode, isReviewPlanId } from "./study-context.js";
import { buildAttemptEventV1 } from "./attempt-event.js";
import { isValidCollectorEndpoint } from "./endpoint.js";
import {
  appendDiagnostic,
  calculateBackoffMilliseconds,
  createDefaultBackgroundState,
  immutableState,
  isAttemptDeliveryAckV1,
  restoreBackgroundState,
  sameAttemptEvent,
} from "./state.js";
import {
  DEFAULT_COLLECTOR_ENDPOINT,
  MAX_DELIVERED_EVENTS,
  type BackgroundPorts,
  type BackgroundStateV1,
  type DiagnosticCode,
  type OutboxEntryV1,
} from "./types.js";

const SAFE_EVENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type BackgroundMessageResponseV1 = PopupStatusV1 | CommandResponseV1;

type CandidateResult =
  | { readonly accepted: true; readonly code: string }
  | { readonly accepted: false; readonly code: string };

class BackgroundStorageError extends Error {
  public override readonly name = "BackgroundStorageError";

  public constructor(public readonly operation: "read" | "write") {
    super(operation === "read" ? "STORAGE_READ_BLOCKED" : "STORAGE_WRITE_BLOCKED");
  }
}

function replaceOutboxEntry(
  outbox: readonly OutboxEntryV1[],
  index: number,
  replacement: OutboxEntryV1,
): readonly OutboxEntryV1[] {
  return outbox.map((entry, entryIndex) => entryIndex === index ? replacement : entry);
}

function aggregateDeliveryState(
  outbox: readonly OutboxEntryV1[],
  emptyState: "idle" | "delivered",
): BackgroundStateV1["delivery_state"] {
  if (outbox.some(({ state }) => state === "blocked")) {
    return "blocked";
  }
  if (outbox.some(({ state }) => state === "retry_scheduled")) {
    return "retry_scheduled";
  }
  return outbox.length === 0 ? emptyState : "idle";
}

function response(ok: boolean, code: string): CommandResponseV1 {
  return ok ? { ok: true, code } : { ok: false, code };
}

function recentAttemptSummary(
  event: AttemptEventV1,
  deliveryState: RecentAttemptDeliveryStateV1,
): RecentAttemptSummaryV1 {
  return Object.freeze({
    question_key: event.question_key,
    answered_at: event.answered_at,
    result: event.result,
    selected_option_indices: Object.freeze([...event.selected_option_indices]),
    delivery_state: deliveryState,
  });
}

function recentAttemptSummaries(
  state: BackgroundStateV1,
): readonly RecentAttemptSummaryV1[] {
  const records = [
    ...state.outbox.map(({ event, state: deliveryState }) => ({
      event,
      deliveryState,
    })),
    ...state.delivered_events.map((event) => ({
      event,
      deliveryState: "delivered" as const,
    })),
  ];

  records.sort((left, right) => {
    const answeredAtOrder = right.event.answered_at.localeCompare(
      left.event.answered_at,
    );
    return answeredAtOrder !== 0
      ? answeredAtOrder
      : right.event.event_id.localeCompare(left.event.event_id);
  });

  return Object.freeze(records
    .slice(0, MAX_RECENT_ATTEMPT_SUMMARIES)
    .map(({ event, deliveryState }) => (
      recentAttemptSummary(event, deliveryState)
    )));
}

function lastCaptureIssueCode(
  state: BackgroundStateV1,
): CaptureIssueCodeV1 | null {
  for (let index = state.diagnostics.length - 1; index >= 0; index -= 1) {
    const code = state.diagnostics[index]?.code;
    if (isCaptureIssueCodeV1(code)) {
      return code;
    }
  }
  return null;
}

export class BackgroundCore {
  readonly #ports: BackgroundPorts;
  #operationTail: Promise<void> = Promise.resolve();

  public constructor(ports: BackgroundPorts) {
    this.#ports = ports;
  }

  public initialize(): Promise<CommandResponseV1> {
    return this.#serialize(async () => {
      try {
        let state = await this.#readState();
        state = this.#withDiagnostic(state, "background_initialized");
        await this.#writeState(state);
        await this.#scheduleFromState(state);
        return response(true, "background_initialized");
      } catch (error) {
        return this.#storageFailureResponse(error);
      }
    });
  }

  public handleMessage(message: unknown, studyMode: StudyMode = "unclassified", reviewPlanId?: string): Promise<BackgroundMessageResponseV1> {
    return this.#serialize(async () => {
      if (
        isPopupRequestMessageV1(message)
        && message.kind === GET_POPUP_STATUS_MESSAGE_KIND
      ) {
        return this.#popupStatus();
      }

      try {
        if (isAttemptCandidateMessageV1(message)) {
          const result = await this.#acceptCandidate(message, studyMode, reviewPlanId);
          return response(result.accepted, result.code);
        }
        if (isCaptureStatusMessageV1(message)) {
          let state = await this.#readState();
          state = immutableState({
            ...state,
            capture_state: message.state,
          });
          state = this.#withDiagnostic(state, message.code);
          await this.#writeState(state);
          return response(true, message.code);
        }
        if (isPopupRequestMessageV1(message)) {
          if (message.kind === RETRY_OUTBOX_MESSAGE_KIND) {
            return this.#retryOutbox();
          }
          if (message.kind === SET_COLLECTOR_ENDPOINT_MESSAGE_KIND) {
            return this.#setCollectorEndpoint(message.endpoint);
          }
        }

        let state = await this.#readState();
        state = this.#withDiagnostic(state, "background_message_rejected");
        await this.#writeState(state);
        return response(false, "background_message_rejected");
      } catch (error) {
        return this.#storageFailureResponse(error);
      }
    });
  }

  public retryOutbox(): Promise<CommandResponseV1> {
    return this.#serialize(() => this.#retryOutbox());
  }

  public processDueOutbox(): Promise<CommandResponseV1> {
    return this.#serialize(async () => {
      try {
        const state = await this.#readState();
        await this.#flush(state);
        return response(true, "retry_processed");
      } catch (error) {
        return this.#storageFailureResponse(error);
      }
    });
  }

  public getPopupStatus(): Promise<PopupStatusV1> {
    return this.#serialize(() => this.#popupStatus());
  }

  async #acceptCandidate(
    candidate: Parameters<typeof buildAttemptEventV1>[0],
    studyMode: StudyMode,
    reviewPlanId?: string,
  ): Promise<CandidateResult> {
    if (!isStudyMode(studyMode) || (reviewPlanId !== undefined
      && (studyMode !== "review" || !isReviewPlanId(reviewPlanId)))) {
      return { accepted: false, code: "candidate_contract_rejected" };
    }
    let state = await this.#readState();
    const existing = state.outbox.find(
      ({ event }) => event.event_id === candidate.event_id,
    );
    const delivered = state.delivered_events.find(
      ({ event_id: eventId }) => eventId === candidate.event_id,
    );
    const recordedAt = existing === undefined
      ? delivered === undefined
        ? this.#ports.clock.now()
        : Date.parse(delivered.provenance.recorded_at)
      : Date.parse(existing.event.provenance.recorded_at);
    const built = buildAttemptEventV1(candidate, recordedAt);
    if (!built.ok) {
      state = this.#withDiagnostic(state, built.code, candidate.event_id);
      await this.#writeState(state);
      return { accepted: false, code: built.code };
    }

    if (delivered !== undefined) {
      if (!sameAttemptEvent(delivered, built.event)) {
        state = immutableState({ ...state, delivery_state: "blocked" });
        state = this.#withDiagnostic(
          state,
          "candidate_event_id_conflict",
          candidate.event_id,
        );
        await this.#writeState(state);
        return { accepted: false, code: "candidate_event_id_conflict" };
      }
      state = this.#withDiagnostic(
        state,
        "candidate_duplicate",
        candidate.event_id,
      );
      await this.#writeState(state);
      return { accepted: true, code: "candidate_duplicate" };
    }

    if (existing !== undefined) {
      if (!sameAttemptEvent(existing.event, built.event)) {
        state = immutableState({ ...state, delivery_state: "blocked" });
        state = this.#withDiagnostic(
          state,
          "candidate_event_id_conflict",
          candidate.event_id,
        );
        await this.#writeState(state);
        return { accepted: false, code: "candidate_event_id_conflict" };
      }
      state = this.#withDiagnostic(
        state,
        "candidate_duplicate",
        candidate.event_id,
      );
      await this.#writeState(state);
      await this.#scheduleFromState(state);
      return { accepted: true, code: "candidate_duplicate" };
    }

    const entry: OutboxEntryV1 = Object.freeze({
      event: built.event,
      context: createStudyContext(built.event.event_id, studyMode, reviewPlanId),
      delivery_attempts: 0,
      next_attempt_at: null,
      state: "pending",
      blocked_code: null,
    });
    state = immutableState({
      ...state,
      outbox: [...state.outbox, entry],
      delivery_state: aggregateDeliveryState([...state.outbox, entry], "idle"),
    });
    state = this.#withDiagnostic(state, "candidate_enqueued", candidate.event_id);
    await this.#writeState(state);
    await this.#scheduleFromState(state);
    return { accepted: true, code: "candidate_enqueued" };
  }

  async #retryOutbox(): Promise<CommandResponseV1> {
    try {
      let state = await this.#readState();
      const resetOutbox = state.outbox.map((entry): OutboxEntryV1 => Object.freeze({
        ...entry,
        next_attempt_at: null,
        state: "pending",
        blocked_code: null,
      }));
      state = immutableState({
        ...state,
        outbox: resetOutbox,
        delivery_state: aggregateDeliveryState(resetOutbox, "idle"),
      });
      state = this.#withDiagnostic(state, "retry_requested");
      await this.#writeState(state);
      await this.#flush(state);
      return response(true, "retry_requested");
    } catch (error) {
      return this.#storageFailureResponse(error);
    }
  }

  async #setCollectorEndpoint(endpoint: string): Promise<CommandResponseV1> {
    try {
      let state = await this.#readState();
      if (!isValidCollectorEndpoint(endpoint)) {
        state = this.#withDiagnostic(state, "collector_endpoint_rejected");
        await this.#writeState(state);
        return response(false, "collector_endpoint_rejected");
      }

      const resetOutbox = state.outbox.map((entry): OutboxEntryV1 => Object.freeze({
        ...entry,
        next_attempt_at: null,
        state: "pending",
        blocked_code: null,
      }));
      state = immutableState({
        ...state,
        collector_endpoint: endpoint,
        outbox: resetOutbox,
        delivery_state: aggregateDeliveryState(resetOutbox, "idle"),
      });
      state = this.#withDiagnostic(state, "collector_endpoint_updated");
      await this.#writeState(state);
      await this.#flush(state);
      return response(true, "collector_endpoint_updated");
    } catch (error) {
      return this.#storageFailureResponse(error);
    }
  }

  async #popupStatus(): Promise<PopupStatusV1> {
    try {
      const state = await this.#readState();
      return {
        capture_state: state.capture_state,
        outbox_count: state.outbox.length,
        collector_endpoint: state.collector_endpoint,
        delivery_state: state.delivery_state,
        last_diagnostic_code: state.last_diagnostic_code,
        last_capture_issue_code: lastCaptureIssueCode(state),
        recent_attempts: recentAttemptSummaries(state),
      };
    } catch {
      return {
        capture_state: "unsupported",
        outbox_count: 0,
        collector_endpoint: DEFAULT_COLLECTOR_ENDPOINT,
        delivery_state: "blocked",
        last_diagnostic_code: "storage_state_blocked",
        last_capture_issue_code: null,
        recent_attempts: [],
      };
    }
  }

  async #flush(startingState: BackgroundStateV1): Promise<BackgroundStateV1> {
    const state = startingState;
    const now = this.#ports.clock.now();
    let index = state.outbox.findIndex(({ state: entryState }) => (
      entryState === "pending"
    ));
    if (index === -1) {
      index = state.outbox.findIndex((entry) => (
        entry.state === "retry_scheduled"
        && entry.next_attempt_at !== null
        && entry.next_attempt_at <= now
      ));
    }
    if (index === -1) {
      await this.#scheduleFromState(state);
      return state;
    }

    const entry = state.outbox[index];
    if (entry === undefined) {
      await this.#scheduleFromState(state);
      return state;
    }

    if (!isValidCollectorEndpoint(state.collector_endpoint)) {
      return this.#blockEntry(state, index, "delivery_endpoint_blocked");
    }

    let transportResponse: Awaited<ReturnType<BackgroundPorts["transport"]["postAttempt"]>>;
    try {
      transportResponse = await this.#ports.transport.postAttempt(
        state.collector_endpoint,
        entry.event,
        entry.context ?? createStudyContext(entry.event.event_id),
      );
    } catch {
      return this.#scheduleRetry(state, index, "delivery_network_retry");
    }

    if (transportResponse.status === 429) {
      return this.#scheduleRetry(
        state,
        index,
        "delivery_rate_limited_retry",
      );
    }
    if (transportResponse.status >= 500 && transportResponse.status <= 599) {
      return this.#scheduleRetry(state, index, "delivery_server_retry");
    }
    if (transportResponse.status < 200 || transportResponse.status > 299) {
      return this.#blockEntry(state, index, "delivery_http_blocked");
    }
    if (!isAttemptDeliveryAckV1(transportResponse.body, entry.event.event_id)) {
      return this.#blockEntry(state, index, "delivery_ack_blocked");
    }

    return this.#acknowledgeEntry(
      state,
      index,
      entry.event,
      transportResponse.body.status,
    );
  }

  async #acknowledgeEntry(
    state: BackgroundStateV1,
    index: number,
    event: AttemptEventV1,
    status: "inserted" | "duplicate",
  ): Promise<BackgroundStateV1> {
    const outbox = state.outbox.filter((_, entryIndex) => entryIndex !== index);
    const deliveredEvents = state.delivered_events.some(
      ({ event_id: eventId }) => eventId === event.event_id,
    )
      ? state.delivered_events
      : [...state.delivered_events, event].slice(-MAX_DELIVERED_EVENTS);
    let next = immutableState({
      ...state,
      outbox,
      delivered_events: deliveredEvents,
      delivery_state: aggregateDeliveryState(outbox, "delivered"),
    });
    next = this.#withDiagnostic(
      next,
      status === "inserted" ? "delivery_inserted" : "delivery_duplicate",
      event.event_id,
    );
    await this.#writeState(next);
    await this.#scheduleFromState(next);
    return next;
  }

  async #scheduleRetry(
    state: BackgroundStateV1,
    index: number,
    code: Extract<
      DiagnosticCode,
      | "delivery_network_retry"
      | "delivery_rate_limited_retry"
      | "delivery_server_retry"
    >,
  ): Promise<BackgroundStateV1> {
    const entry = state.outbox[index];
    if (entry === undefined) {
      return state;
    }
    const attempts = Math.min(entry.delivery_attempts + 1, Number.MAX_SAFE_INTEGER);
    const scheduledAt = Math.min(
      this.#ports.clock.now() + calculateBackoffMilliseconds(attempts),
      Number.MAX_SAFE_INTEGER,
    );
    const replacement: OutboxEntryV1 = Object.freeze({
      ...entry,
      delivery_attempts: attempts,
      next_attempt_at: scheduledAt,
      state: "retry_scheduled",
      blocked_code: null,
    });
    const outbox = replaceOutboxEntry(state.outbox, index, replacement);
    let next = immutableState({
      ...state,
      outbox,
      delivery_state: aggregateDeliveryState(outbox, "idle"),
    });
    next = this.#withDiagnostic(next, code, entry.event.event_id);
    await this.#writeState(next);
    await this.#scheduleFromState(next);
    return next;
  }

  async #blockEntry(
    state: BackgroundStateV1,
    index: number,
    code: Extract<
      DiagnosticCode,
      | "delivery_http_blocked"
      | "delivery_ack_blocked"
      | "delivery_endpoint_blocked"
    >,
  ): Promise<BackgroundStateV1> {
    const entry = state.outbox[index];
    if (entry === undefined) {
      return state;
    }
    const replacement: OutboxEntryV1 = Object.freeze({
      ...entry,
      next_attempt_at: null,
      state: "blocked",
      blocked_code: code,
    });
    const outbox = replaceOutboxEntry(state.outbox, index, replacement);
    let next = immutableState({
      ...state,
      outbox,
      delivery_state: "blocked",
    });
    next = this.#withDiagnostic(next, code, entry.event.event_id);
    await this.#writeState(next);
    await this.#scheduleFromState(next);
    return next;
  }

  async #scheduleFromState(state: BackgroundStateV1): Promise<void> {
    if (state.outbox.some(({ state: entryState }) => entryState === "pending")) {
      await this.#ports.scheduler.schedule(this.#ports.clock.now());
      return;
    }
    const scheduled = state.outbox
      .filter((entry) => (
        entry.state === "retry_scheduled" && entry.next_attempt_at !== null
      ))
      .map(({ next_attempt_at: nextAttemptAt }) => nextAttemptAt as number);
    if (scheduled.length === 0) {
      await this.#ports.scheduler.clear();
      return;
    }
    await this.#ports.scheduler.schedule(Math.min(...scheduled));
  }

  #withDiagnostic(
    state: BackgroundStateV1,
    code: DiagnosticCode,
    eventId?: string,
  ): BackgroundStateV1 {
    const occurredAt = new Date(this.#ports.clock.now()).toISOString();
    return appendDiagnostic(
      state,
      code,
      occurredAt,
      eventId !== undefined && SAFE_EVENT_ID.test(eventId) ? eventId : undefined,
    );
  }

  async #readState(): Promise<BackgroundStateV1> {
    let raw: unknown;
    try {
      raw = await this.#ports.storage.read();
    } catch {
      throw new BackgroundStorageError("read");
    }
    const restored = restoreBackgroundState(raw);
    if (restored === null) {
      throw new BackgroundStorageError("read");
    }
    return restored;
  }

  async #writeState(state: BackgroundStateV1): Promise<void> {
    try {
      await this.#ports.storage.write(immutableState(state));
    } catch {
      throw new BackgroundStorageError("write");
    }
  }

  #storageFailureResponse(error: unknown): CommandResponseV1 {
    if (error instanceof BackgroundStorageError && error.operation === "write") {
      return response(false, "storage_write_blocked");
    }
    return response(false, "storage_state_blocked");
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function createDefaultCoreState(): BackgroundStateV1 {
  return createDefaultBackgroundState();
}
