import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  validateAttemptEventV1,
  validateStudyAttemptEnvelopeV1,
  type AttemptEventV1,
  type StudyContextV1,
} from "@qb-study/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAttemptEventV1 } from "../src/background/attempt-event.js";
import {
  createChromeRetrySchedulerPort,
  createFetchCollectorTransportPort,
  restrictChromeStorageToTrustedContexts,
} from "../src/background/chrome-ports.js";
import { BackgroundCore } from "../src/background/core.js";
import { isValidCollectorEndpoint } from "../src/background/endpoint.js";
import { createRetryableReadiness } from "../src/background/readiness.js";
import { createBoundedRecovery } from "../src/background/runtime-recovery.js";
import { isBackgroundStateV1 } from "../src/background/state.js";
import {
  BACKOFF_BASE_MS,
  type BackgroundPorts,
  type BackgroundStateV1,
  type BackgroundStoragePort,
  type ClockPort,
  type CollectorTransportPort,
  type RetrySchedulerPort,
} from "../src/background/types.js";
import {
  ATTEMPT_CANDIDATE_MESSAGE_KIND,
  MAX_RECENT_ATTEMPT_SUMMARIES,
  SET_COLLECTOR_ENDPOINT_MESSAGE_KIND,
  type AttemptCandidateMessageV1,
} from "../src/shared/protocol.js";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-08-25T03:05:00.000Z");

const CANDIDATE = {
  kind: ATTEMPT_CANDIDATE_MESSAGE_KIND,
  event_id: EVENT_ID,
  question_key: "119-A-12",
  answered_at: "2026-08-25T03:04:05.006Z",
  result: "correct",
  selected_option_indices: [3, 1],
} as const satisfies AttemptCandidateMessageV1;

const SECOND_CANDIDATE = {
  ...CANDIDATE,
  event_id: "10000000-0000-4000-8000-000000000002",
  question_key: "119-A-13",
  answered_at: "2026-08-25T03:04:15.006Z",
  selected_option_indices: [2],
} as const satisfies AttemptCandidateMessageV1;

function requiredAttemptEvent(
  candidate: AttemptCandidateMessageV1,
  recordedAt = NOW,
): AttemptEventV1 {
  const result = buildAttemptEventV1(candidate, recordedAt);
  if (!result.ok) {
    throw new TypeError(`test attempt event rejected: ${result.code}`);
  }
  return result.event;
}

class MemoryStorage implements BackgroundStoragePort {
  public value: unknown;

  public async read(): Promise<unknown> {
    return structuredClone(this.value);
  }

  public async write(state: BackgroundStateV1): Promise<void> {
    this.value = structuredClone(state);
  }

  public snapshot(): BackgroundStateV1 {
    if (!isBackgroundStateV1(this.value)) {
      throw new TypeError("background state is invalid");
    }
    return this.value;
  }
}

class MutableClock implements ClockPort {
  public constructor(public current = NOW) {}

  public now(): number {
    return this.current;
  }
}

class RecordingScheduler implements RetrySchedulerPort {
  public scheduledAt: number | null = null;
  public blocked = false;

  public async schedule(atEpochMilliseconds: number): Promise<void> {
    if (this.blocked) {
      throw new Error("ALARM_CREATE_BLOCKED");
    }
    this.scheduledAt = atEpochMilliseconds;
  }

  public async clear(): Promise<void> {
    this.scheduledAt = null;
  }
}

interface TestCore {
  readonly core: BackgroundCore;
  readonly storage: MemoryStorage;
  readonly clock: MutableClock;
  readonly scheduler: RecordingScheduler;
}

function createTestCore(transport: CollectorTransportPort): TestCore {
  const storage = new MemoryStorage();
  const clock = new MutableClock();
  const scheduler = new RecordingScheduler();
  const ports: BackgroundPorts = {
    storage,
    clock,
    scheduler,
    transport,
  };
  return {
    core: new BackgroundCore(ports),
    storage,
    clock,
    scheduler,
  };
}

function fixedTransport(response: {
  readonly status: number;
  readonly body: unknown;
}): CollectorTransportPort {
  return {
    postAttempt: () => Promise.resolve(response),
  };
}

const openServers: Server[] = [];

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    throw new TypeError("mock server address is unavailable");
  }
  await close(server);
  return address.port;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(close));
  vi.unstubAllGlobals();
});

describe("AttemptEventV1 construction", () => {
  it("produces the exact V1 payload without prohibited or V1-external fields", () => {
    const result = buildAttemptEventV1(CANDIDATE, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(validateAttemptEventV1(result.event)).toBe(true);
    expect(Object.keys(result.event).sort()).toEqual([
      "answered_at",
      "event_id",
      "provenance",
      "quality",
      "question_key",
      "record_type",
      "result",
      "schema_version",
      "selected_option_indices",
    ]);
    expect(result.event).toMatchObject({
      event_id: EVENT_ID,
      question_key: "119A12",
      answered_at: "2026-08-25T03:04:05.006Z",
      selected_option_indices: [1, 3],
      provenance: {
        producer: "browser-extension",
      producer_version: "0.1.2",
        source_system: "qb-web-dom",
        recorded_at: "2026-08-25T03:05:00.000Z",
      },
    });
    expect(JSON.stringify(result.event)).not.toMatch(
      /question_text|choice_text|explanation|image|cookie|token|session_id|source_device|self_rating|qb_question_id/iu,
    );
    expect(Object.isFrozen(result.event)).toBe(true);
    expect(Object.isFrozen(result.event.selected_option_indices)).toBe(true);
  });
});

describe("collector endpoint", () => {
  it.each([
    "http://127.0.0.1:1/v1/attempt-events",
    "http://127.0.0.1:65535/v1/attempt-events",
  ])("accepts an explicit loopback HTTP endpoint: %s", (endpoint) => {
    expect(isValidCollectorEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "https://127.0.0.1:8765/v1/attempt-events",
    "http://localhost:8765/v1/attempt-events",
    "http://127.0.0.1/v1/attempt-events",
    "http://127.0.0.1:0/v1/attempt-events",
    "http://127.0.0.1:65536/v1/attempt-events",
    "http://user@127.0.0.1:8765/v1/attempt-events",
    "http://127.0.0.1:8765/v1/attempt-events?token=value",
    "http://127.0.0.1:8765/v1/attempt-events#fragment",
    "http://127.0.0.1:8765/v1/../attempt-events",
    "http://127.0.0.1:8765/custom/path",
  ])("rejects a non-allowlisted endpoint: %s", (endpoint) => {
    expect(isValidCollectorEndpoint(endpoint)).toBe(false);
  });
});

describe("Chrome ports", () => {
  it("propagates an alarm creation failure instead of claiming it was scheduled", async () => {
    vi.stubGlobal("chrome", {
      alarms: {
        create: () => Promise.reject(new Error("alarm blocked")),
      },
    });

    await expect(
      createChromeRetrySchedulerPort().schedule(NOW),
    ).rejects.toThrow("alarm blocked");
  });

  it("restricts outbox storage to trusted extension contexts", async () => {
    const setAccessLevel = vi.fn(() => Promise.resolve());
    vi.stubGlobal("chrome", {
      storage: {
        local: { setAccessLevel },
      },
    });

    await restrictChromeStorageToTrustedContexts();
    expect(setAccessLevel).toHaveBeenCalledOnce();
    expect(setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  });

  it("retries initialization after a transient readiness failure", async () => {
    let attempts = 0;
    const ensureReady = createRetryableReadiness(() => {
      attempts += 1;
      return Promise.resolve(attempts >= 2);
    });

    expect(await ensureReady()).toBe(false);
    await Promise.resolve();
    expect(await ensureReady()).toBe(true);
    expect(await ensureReady()).toBe(true);
    expect(attempts).toBe(2);
  });

  it("bounds runtime scheduler recovery and stops after success", async () => {
    const callbacks: Array<() => void> = [];
    let attempts = 0;
    const requestRecovery = createBoundedRecovery(
      () => {
        attempts += 1;
        return Promise.resolve(attempts >= 3);
      },
      {
        delayMilliseconds: 1_000,
        maxAttempts: 3,
        schedule: (callback) => callbacks.push(callback),
      },
    );

    requestRecovery();
    requestRecovery();
    expect(callbacks).toHaveLength(1);
    for (let index = 0; index < 3; index += 1) {
      callbacks.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(attempts).toBe(3);
    expect(callbacks).toEqual([]);
  });
});

describe("background outbox", () => {
  it.each([
    "capture_enable_requested",
    "capture_enable_blocked",
  ] as const)("restores a legacy %s diagnostic without stranding outbox", async (code) => {
    const testCore = createTestCore(fixedTransport({ status: 500, body: null }));
    await testCore.core.initialize();
    const event = requiredAttemptEvent(CANDIDATE);
    testCore.storage.value = {
      ...testCore.storage.snapshot(),
      outbox: [{
        event,
        delivery_attempts: 0,
        next_attempt_at: null,
        state: "pending",
        blocked_code: null,
      }],
      delivery_state: "idle",
      last_diagnostic_code: code,
      diagnostics: [{
        code,
        occurred_at: "2026-08-25T03:04:00.000Z",
      }],
    } satisfies BackgroundStateV1;

    const status = await testCore.core.getPopupStatus();
    expect(status.last_diagnostic_code).toBe(code);
    expect(status.outbox_count).toBe(1);
    expect(status.recent_attempts).toHaveLength(1);
    expect(testCore.storage.snapshot().outbox).toHaveLength(1);
  });

  it("persists an allowlisted DOM failure reason without free-form detail", async () => {
    const testCore = createTestCore(fixedTransport({ status: 500, body: null }));
    await testCore.core.initialize();

    expect(await testCore.core.handleMessage({
      kind: "capture_status_v1",
      state: "unsupported",
      code: "capture_unsupported_dom:option_count_invalid",
    })).toEqual({
      ok: true,
      code: "capture_unsupported_dom:option_count_invalid",
    });
    expect(testCore.storage.snapshot().last_diagnostic_code).toBe(
      "capture_unsupported_dom:option_count_invalid",
    );
    expect(await testCore.core.getPopupStatus()).toMatchObject({
      capture_state: "unsupported",
      last_diagnostic_code: "capture_unsupported_dom:option_count_invalid",
      last_capture_issue_code: "capture_unsupported_dom:option_count_invalid",
    });
    expect(JSON.stringify(testCore.storage.snapshot().diagnostics)).not.toMatch(
      /detail|html|url/iu,
    );

    await testCore.core.handleMessage({
      kind: "capture_status_v1",
      state: "observing",
      code: "capture_observing",
    });
    expect(await testCore.core.getPopupStatus()).toMatchObject({
      last_diagnostic_code: "capture_observing",
      last_capture_issue_code: "capture_unsupported_dom:option_count_invalid",
    });
  });

  it("reports recent delivered and outbox records without leaking full events", async () => {
    const testCore = createTestCore(fixedTransport({ status: 500, body: null }));
    await testCore.core.initialize();

    const candidates = [
      CANDIDATE,
      {
        ...SECOND_CANDIDATE,
        answered_at: "2026-08-25T03:04:25.006Z",
      },
      {
        ...SECOND_CANDIDATE,
        event_id: "10000000-0000-4000-8000-000000000003",
        question_key: "119A14",
        answered_at: "2026-08-25T03:04:35.006Z",
      },
      {
        ...SECOND_CANDIDATE,
        event_id: "10000000-0000-4000-8000-000000000004",
        question_key: "119A15",
        answered_at: "2026-08-25T03:04:45.006Z",
      },
    ] as const satisfies readonly AttemptCandidateMessageV1[];
    const events = candidates.map((candidate) => requiredAttemptEvent(candidate));
    const [deliveredEvent, pendingEvent, retryEvent, blockedEvent] = events;
    if (
      deliveredEvent === undefined
      || pendingEvent === undefined
      || retryEvent === undefined
      || blockedEvent === undefined
    ) {
      throw new TypeError("test attempt events missing");
    }
    const initialized = testCore.storage.snapshot();
    testCore.storage.value = {
      ...initialized,
      outbox: [
        {
          event: pendingEvent,
          delivery_attempts: 0,
          next_attempt_at: null,
          state: "pending",
          blocked_code: null,
        },
        {
          event: retryEvent,
          delivery_attempts: 1,
          next_attempt_at: NOW + BACKOFF_BASE_MS,
          state: "retry_scheduled",
          blocked_code: null,
        },
        {
          event: blockedEvent,
          delivery_attempts: 1,
          next_attempt_at: null,
          state: "blocked",
          blocked_code: "delivery_http_blocked",
        },
      ],
      delivered_events: [deliveredEvent],
      delivery_state: "blocked",
      last_diagnostic_code: "delivery_http_blocked",
    } satisfies BackgroundStateV1;

    const status = await testCore.core.getPopupStatus();
    expect(status.outbox_count).toBe(3);
    expect(status.recent_attempts).toEqual([
      {
        question_key: "119A15",
        answered_at: "2026-08-25T03:04:45.006Z",
        result: "correct",
        selected_option_indices: [2],
        delivery_state: "blocked",
      },
      {
        question_key: "119A14",
        answered_at: "2026-08-25T03:04:35.006Z",
        result: "correct",
        selected_option_indices: [2],
        delivery_state: "retry_scheduled",
      },
      {
        question_key: "119A13",
        answered_at: "2026-08-25T03:04:25.006Z",
        result: "correct",
        selected_option_indices: [2],
        delivery_state: "pending",
      },
      {
        question_key: "119A12",
        answered_at: "2026-08-25T03:04:05.006Z",
        result: "correct",
        selected_option_indices: [1, 3],
        delivery_state: "delivered",
      },
    ]);
    for (const summary of status.recent_attempts) {
      expect(Object.keys(summary).sort()).toEqual([
        "answered_at",
        "delivery_state",
        "question_key",
        "result",
        "selected_option_indices",
      ]);
    }
    expect(JSON.stringify(status.recent_attempts)).not.toMatch(
      /event_id|provenance|quality|question_group_id|correct_option|url|html/iu,
    );
  });

  it("bounds only the popup history to 99 newest records", async () => {
    const testCore = createTestCore(fixedTransport({ status: 500, body: null }));
    await testCore.core.initialize();
    const deliveredEvents = Array.from({ length: 101 }, (_, offset) => {
      const ordinal = offset + 1;
      return requiredAttemptEvent({
        ...CANDIDATE,
        event_id: `10000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
        question_key: `119A${ordinal}`,
        answered_at: new Date(NOW + offset * 1_000).toISOString(),
      }, NOW + offset * 1_000);
    });
    testCore.storage.value = {
      ...testCore.storage.snapshot(),
      delivered_events: deliveredEvents,
      delivery_state: "delivered",
    } satisfies BackgroundStateV1;

    const status = await testCore.core.getPopupStatus();
    expect(status.recent_attempts).toHaveLength(MAX_RECENT_ATTEMPT_SUMMARIES);
    expect(status.recent_attempts[0]?.question_key).toBe("119A101");
    expect(status.recent_attempts.at(-1)?.question_key).toBe("119A3");
    expect(testCore.storage.snapshot().delivered_events).toHaveLength(101);
  });

  it("does not claim an empty history when storage cannot be read", async () => {
    const core = new BackgroundCore({
      storage: {
        read: () => Promise.reject(new Error("READ_BLOCKED")),
        write: () => Promise.resolve(),
      },
      clock: { now: () => NOW },
      scheduler: {
        schedule: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
      transport: fixedTransport({ status: 500, body: null }),
    });

    expect(await core.getPopupStatus()).toMatchObject({
      capture_state: "unsupported",
      outbox_count: 0,
      delivery_state: "blocked",
      last_diagnostic_code: "storage_state_blocked",
      last_capture_issue_code: null,
      recent_attempts: [],
    });
  });

  it("retains an event when a 2xx acknowledgment is not exact", async () => {
    const { core, storage } = createTestCore(fixedTransport({
      status: 200,
      body: { event_id: EVENT_ID, status: "accepted" },
    }));

    expect(await core.handleMessage(CANDIDATE)).toEqual({
      ok: true,
      code: "candidate_enqueued",
    });
    expect(storage.snapshot().outbox[0]?.state).toBe("pending");
    expect(await core.processDueOutbox()).toEqual({
      ok: true,
      code: "retry_processed",
    });
    const state = storage.snapshot();
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.state).toBe("blocked");
    expect(state.outbox[0]?.blocked_code).toBe("delivery_ack_blocked");
  });

  it.each([
    [429, "delivery_rate_limited_retry"],
    [500, "delivery_server_retry"],
    [503, "delivery_server_retry"],
  ] as const)(
    "schedules a retry for retryable HTTP status %i",
    async (status, diagnosticCode) => {
      const testCore = createTestCore(fixedTransport({ status, body: null }));

      await testCore.core.handleMessage(CANDIDATE);
      await testCore.core.processDueOutbox();

      const state = testCore.storage.snapshot();
      expect(state.outbox[0]?.state).toBe("retry_scheduled");
      expect(state.last_diagnostic_code).toBe(diagnosticCode);
      expect(testCore.scheduler.scheduledAt).toBe(NOW + BACKOFF_BASE_MS);
    },
  );

  it("accepts an exact collector duplicate acknowledgment before deleting outbox data", async () => {
    const testCore = createTestCore(fixedTransport({
      status: 200,
      body: { event_id: EVENT_ID, status: "duplicate" },
    }));

    await testCore.core.handleMessage(CANDIDATE);
    await testCore.core.processDueOutbox();

    const state = testCore.storage.snapshot();
    expect(state.outbox).toEqual([]);
    expect(state.delivered_events).toHaveLength(1);
    expect(state.last_diagnostic_code).toBe("delivery_duplicate");
  });

  it("keeps storage valid when an invalid event ID is rejected", async () => {
    const { core, storage } = createTestCore(fixedTransport({
      status: 200,
      body: null,
    }));

    expect(await core.handleMessage({
      ...CANDIDATE,
      event_id: "not-a-uuid",
    })).toEqual({
      ok: false,
      code: "candidate_contract_rejected",
    });
    const state = storage.snapshot();
    expect(state.outbox).toEqual([]);
    expect(state.diagnostics.at(-1)).toEqual({
      code: "candidate_contract_rejected",
      occurred_at: "2026-08-25T03:05:00.000Z",
    });
  });

  it("keeps an already-persisted candidate retryable when alarm creation fails", async () => {
    const testCore = createTestCore(fixedTransport({ status: 500, body: null }));
    testCore.scheduler.blocked = true;

    expect(await testCore.core.handleMessage(CANDIDATE)).toEqual({
      ok: false,
      code: "storage_state_blocked",
    });
    expect(testCore.storage.snapshot().outbox).toHaveLength(1);

    testCore.scheduler.blocked = false;
    expect(await testCore.core.handleMessage(CANDIDATE)).toEqual({
      ok: true,
      code: "candidate_duplicate",
    });
    expect(testCore.scheduler.scheduledAt).toBe(NOW);
  });

  it("continues scheduling a later pending event after an earlier event is blocked", async () => {
    const calls: string[] = [];
    const testCore = createTestCore({
      postAttempt: (_endpoint, event) => {
        calls.push(event.event_id);
        return Promise.resolve(event.event_id === EVENT_ID
          ? { status: 400, body: null }
          : {
              status: 200,
              body: { event_id: event.event_id, status: "inserted" },
            });
      },
    });

    await testCore.core.handleMessage(CANDIDATE);
    await testCore.core.handleMessage(SECOND_CANDIDATE);
    await testCore.core.processDueOutbox();

    expect(testCore.storage.snapshot().outbox.map(({ state }) => state)).toEqual([
      "blocked",
      "pending",
    ]);
    expect(testCore.scheduler.scheduledAt).toBe(NOW);

    await testCore.core.processDueOutbox();
    expect(calls).toEqual([EVENT_ID, SECOND_CANDIDATE.event_id]);
    expect(testCore.storage.snapshot().outbox.map(({ state }) => state)).toEqual([
      "blocked",
    ]);
  });

  it("unblocks a permanently failed event when the popup requests a manual retry", async () => {
    let calls = 0;
    const testCore = createTestCore({
      postAttempt: (_endpoint, event) => {
        calls += 1;
        return Promise.resolve(calls === 1
          ? { status: 200, body: { event_id: event.event_id, status: "accepted" } }
          : { status: 200, body: { event_id: event.event_id, status: "inserted" } });
      },
    });

    await testCore.core.handleMessage(CANDIDATE);
    await testCore.core.processDueOutbox();
    expect(testCore.storage.snapshot().outbox[0]?.state).toBe("blocked");

    expect(await testCore.core.retryOutbox()).toEqual({
      ok: true,
      code: "retry_requested",
    });
    expect(calls).toBe(2);
    expect(testCore.storage.snapshot().outbox).toEqual([]);
  });

  it("persists while offline, then retries against a mock server and deduplicates the event ID", async () => {
    const port = await reserveLoopbackPort();
    const endpoint = `http://127.0.0.1:${port}/v1/attempt-events`;
    const testCore = createTestCore(createFetchCollectorTransportPort());

    expect(await testCore.core.handleMessage({
      kind: SET_COLLECTOR_ENDPOINT_MESSAGE_KIND,
      endpoint,
    })).toEqual({ ok: true, code: "collector_endpoint_updated" });

    expect(await testCore.core.handleMessage(CANDIDATE)).toEqual({
      ok: true,
      code: "candidate_enqueued",
    });
    expect(testCore.storage.snapshot().outbox[0]?.state).toBe("pending");
    expect(testCore.scheduler.scheduledAt).toBe(NOW);

    expect(await testCore.core.processDueOutbox()).toEqual({
      ok: true,
      code: "retry_processed",
    });
    const offlineState = testCore.storage.snapshot();
    expect(offlineState.outbox).toHaveLength(1);
    expect(offlineState.outbox[0]?.state).toBe("retry_scheduled");
    expect(testCore.scheduler.scheduledAt).toBe(NOW + BACKOFF_BASE_MS);

    const requests: AttemptEventV1[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (!validateStudyAttemptEnvelopeV1(body)) {
        response.statusCode = 400;
        response.end();
        return;
      }
      requests.push(body.attempt);
      expect(body.context.study_mode).toBe("unclassified");
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v2/attempt-events");
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        event_id: body.attempt.event_id,
        status: "inserted",
      }));
    });
    openServers.push(server);
    await listen(server, port);

    testCore.clock.current += BACKOFF_BASE_MS;
    expect(await testCore.core.processDueOutbox()).toEqual({
      ok: true,
      code: "retry_processed",
    });
    expect(requests).toHaveLength(1);
    expect(testCore.storage.snapshot().outbox).toEqual([]);

    expect(await testCore.core.handleMessage(CANDIDATE)).toEqual({
      ok: true,
      code: "candidate_duplicate",
    });
    expect(requests).toHaveLength(1);

    expect(await testCore.core.handleMessage({
      ...CANDIDATE,
      result: "incorrect",
    })).toEqual({
      ok: false,
      code: "candidate_event_id_conflict",
    });
    expect(requests).toHaveLength(1);
  });
});


describe("purpose survives background restarts and delivery retries", () => {
  it("retains the first recorded purpose after restart, a failed delivery, and repeated candidate messages", async () => {
    const sent: StudyContextV1[] = [];
    let attempts = 0;
    const transport: CollectorTransportPort = {
      postAttempt: async (_endpoint, event, context) => {
        if (context === undefined) throw new Error("missing study context");
        sent.push(structuredClone(context));
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return { status: 200, body: { event_id: event.event_id, status: "inserted" } };
      },
    };
    const test = createTestCore(transport);
    await test.core.handleMessage(CANDIDATE, "review", "30000000-0000-4000-8000-000000000001");
    expect(test.storage.snapshot().outbox[0]?.context?.study_mode).toBe("review");
    const restarted = new BackgroundCore({ storage: test.storage, clock: test.clock,
      scheduler: test.scheduler, transport });
    await restarted.handleMessage(CANDIDATE, "normal");
    await restarted.processDueOutbox();
    expect(test.storage.snapshot().outbox[0]?.context?.study_mode).toBe("review");
    test.clock.current += BACKOFF_BASE_MS;
    await restarted.processDueOutbox();
    expect(sent.map((context) => context.study_mode)).toEqual(["review", "review"]);
    expect(sent[0]?.event_id).toBe(CANDIDATE.event_id);
    expect(sent.map((context) => context.review_plan_id)).toEqual([
      "30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000001",
    ]);
    expect(test.storage.snapshot().outbox).toEqual([]);
    expect(await restarted.handleMessage(CANDIDATE, "normal"))
      .toEqual({ ok: true, code: "candidate_duplicate" });
    expect(sent).toHaveLength(2);
  });

  it("upgrades an old outbox with no purpose to unclassified without adopting a new session's mode", async () => {
    const sent: StudyContextV1[] = [];
    const test = createTestCore({ postAttempt: async (endpoint, event, context) => {
      expect(endpoint).toContain("/v2/attempt-events");
      if (context === undefined) throw new Error("missing study context");
      sent.push(context);
      return { status: 200, body: { event_id: event.event_id, status: "duplicate" } };
    } });
    await test.core.handleMessage(CANDIDATE);
    const stored = test.storage.snapshot();
    test.storage.value = { ...stored, collector_endpoint: "http://127.0.0.1:8765/v1/attempt-events",
      outbox: stored.outbox.map(({ context: ignored, ...entry }) => { void ignored; return entry; }),
    };
    await test.core.handleMessage(CANDIDATE, "review");
    await test.core.processDueOutbox();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.study_mode).toBe("unclassified");
    expect(test.storage.snapshot().outbox).toEqual([]);
  });
});
