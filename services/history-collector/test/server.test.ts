import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AttemptEventV1 } from "@qb-study/contracts";
import type {
  AppendResult,
  HistoryCollectorStorage,
} from "@qb-study/storage/history-collector";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTEMPT_EVENTS_PATH,
  STUDY_ATTEMPT_EVENTS_PATH,
  REVIEW_SETS_PATH,
  HISTORY_COLLECTOR_HOST,
  MAX_REQUEST_BODY_BYTES,
  startHistoryCollector,
  type RunningHistoryCollector,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const runningCollectors: RunningHistoryCollector[] = [];

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "qb-study-collector-"));
  temporaryDirectories.push(directory);
  return join(directory, "history.sqlite");
}

afterEach(async () => {
  await Promise.all(runningCollectors.splice(0).map((collector) => collector.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function attempt(overrides: Partial<AttemptEventV1> = {}): AttemptEventV1 {
  return {
    schema_version: "1",
    record_type: "attempt_event",
    event_id: "10000000-0000-4000-8000-000000000001",
    question_key: "080A79",
    answered_at: "2026-08-27T03:00:53.663Z",
    result: "incorrect",
    selected_option_indices: [1, 2],
    provenance: {
      producer: "browser-extension",
      producer_version: "0.1.0",
      source_system: "qb-web-dom",
      recorded_at: "2026-08-27T03:00:53.663Z",
    },
    quality: {
      acquisition_method: "direct_capture",
      temporal_precision: "exact",
      state_precision: "exact",
    },
    ...overrides,
  };
}

function endpoint(collector: RunningHistoryCollector, path = ATTEMPT_EVENTS_PATH): string {
  return `http://${collector.host}:${collector.port}${path}`;
}

async function start(databasePath = temporaryDatabasePath()): Promise<{
  readonly collector: RunningHistoryCollector;
  readonly databasePath: string;
}> {
  const collector = await startHistoryCollector({ port: 0, databasePath });
  runningCollectors.push(collector);
  return { collector, databasePath };
}

async function post(
  collector: RunningHistoryCollector,
  body: string,
  headers: Readonly<Record<string, string>> = { "content-type": "application/json" },
  path = ATTEMPT_EVENTS_PATH,
): Promise<Response> {
  return fetch(endpoint(collector, path), {
    method: "POST",
    headers,
    body,
    redirect: "error",
  });
}

function databaseCounts(databasePath: string): {
  readonly attempts: number;
  readonly selections: number;
} {
  const database = new DatabaseSync(databasePath);
  try {
    const attemptRow = database
      .prepare("SELECT count(*) AS count FROM attempts")
      .get() as { readonly count: number };
    const selectionRow = database
      .prepare("SELECT count(*) AS count FROM attempt_selected_options")
      .get() as { readonly count: number };
    return {
      attempts: Number(attemptRow.count),
      selections: Number(selectionRow.count),
    };
  } finally {
    database.close();
  }
}

class ThrowingStorage implements HistoryCollectorStorage {
  public readonly kind = "sqlite" as const;

  public appendStudyAttempt(): AppendResult { throw new Error("TEST_STORAGE_FAILURE"); }
  public getStudyContext(): undefined { return undefined; }

  public migrate(): { readonly applied_versions: readonly number[]; readonly current_version: number } {
    return { applied_versions: [], current_version: 2 };
  }

  public getSchemaVersion(): number {
    return 2;
  }

  public close(): void {}

  public appendAttempt(): AppendResult {
    throw new Error("STORAGE_UNAVAILABLE");
  }

  public appendHistorySnapshot(): AppendResult {
    throw new Error("STORAGE_UNAVAILABLE");
  }

  public appendSystemLog(): void {}
}

describe("loopback verified review set lookup", () => {
  it("returns only the validated identity without exposing history or writing an attempt", async () => {
    const databasePath = temporaryDatabasePath();
    const resolveReviewSet = vi.fn(async (id: string) => ({ schema_version: "1" as const, question_set_id: id,
      study_mode: "review" as const, review_plan_id: "10000000-0000-4000-8000-000000000001", ignored_secret: "NEVER_RETURN" }));
    const collector = await startHistoryCollector({ port: 0, databasePath, resolveReviewSet });
    runningCollectors.push(collector);
    const response = await fetch(endpoint(collector, REVIEW_SETS_PATH + "synthetic-set"), {
      headers: { "x-qb-study-client": "browser-extension" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schema_version: "1", question_set_id: "synthetic-set", study_mode: "review",
      review_plan_id: "10000000-0000-4000-8000-000000000001" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resolveReviewSet).toHaveBeenCalledExactlyOnceWith("synthetic-set");
    expect(databaseCounts(databasePath)).toEqual({ attempts: 0, selections: 0 });
  });

  it("rejects simple webpage GET, credentials, query strings, malformed IDs and CORS preflight", async () => {
    const resolveReviewSet = vi.fn(async (id: string) => ({ schema_version: "1" as const, question_set_id: id, study_mode: "normal" as const }));
    const collector = await startHistoryCollector({ port: 0, databasePath: temporaryDatabasePath(), resolveReviewSet });
    runningCollectors.push(collector);
    const unsupported: Readonly<Record<string, string>>[] = [{}, { "x-qb-study-client": "wrong" },
      { "x-qb-study-client": "browser-extension", cookie: "fixture=1" },
      { "x-qb-study-client": "browser-extension", authorization: "fixture-only" }];
    for (const headers of unsupported) {
      expect((await fetch(endpoint(collector, REVIEW_SETS_PATH + "synthetic-set"), { headers })).status).toBe(400);
    }
    for (const suffix of ["set?extra=1", "set%2Fother", "x".repeat(101)]) {
      expect((await fetch(endpoint(collector, REVIEW_SETS_PATH + suffix), { headers: { "x-qb-study-client": "browser-extension" } })).status).toBe(404);
    }
    const preflight = await fetch(endpoint(collector, REVIEW_SETS_PATH + "synthetic-set"), { method: "OPTIONS",
      headers: { origin: "https://example.test", "access-control-request-method": "GET", "access-control-request-headers": "x-qb-study-client" } });
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(resolveReviewSet).not.toHaveBeenCalled();
  });

  it("rejects non-loopback Host headers before consulting shared records", async () => {
    const resolveReviewSet = vi.fn(async (id: string) => ({ schema_version: "1" as const, question_set_id: id, study_mode: "normal" as const }));
    const collector = await startHistoryCollector({ port: 0, databasePath: temporaryDatabasePath(), resolveReviewSet });
    runningCollectors.push(collector);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: collector.host, port: collector.port, path: REVIEW_SETS_PATH + "synthetic-set", method: "GET",
        headers: { host: `localhost:${collector.port}`, "x-qb-study-client": "browser-extension" } }, (response) => {
        response.resume(); response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject); request.end();
    });
    expect(status).toBe(400); expect(resolveReviewSet).not.toHaveBeenCalled();
  });

  it("uses a sanitized unavailable response for absent or failed evidence", async () => {
    for (const resolveReviewSet of [undefined, async () => { throw new Error("SECRET_UPSTREAM_TEXT"); }]) {
      const collector = await startHistoryCollector({ port: 0, databasePath: temporaryDatabasePath(),
        ...(resolveReviewSet === undefined ? {} : { resolveReviewSet }) });
      runningCollectors.push(collector);
      const response = await fetch(endpoint(collector, REVIEW_SETS_PATH + "synthetic-set"), { headers: { "x-qb-study-client": "browser-extension" } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error_code: "REVIEW_SET_RESOLUTION_UNAVAILABLE" });
    }
  });
});

describe("loopback attempt collector", () => {
  it("drains a one-event protocol outbox only after a committed exact ACK", async () => {
    const { collector, databasePath } = await start();
    const outbox = [attempt()];
    expect(outbox).toHaveLength(1);

    const response = await post(collector, JSON.stringify(outbox[0]));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const acknowledgment = await response.json() as unknown;
    expect(acknowledgment).toStrictEqual({
      event_id: "10000000-0000-4000-8000-000000000001",
      status: "inserted",
    });
    expect(Object.keys(acknowledgment as object).sort()).toEqual(["event_id", "status"]);

    if (
      typeof acknowledgment === "object"
      && acknowledgment !== null
      && "event_id" in acknowledgment
      && acknowledgment.event_id === outbox[0]?.event_id
      && "status" in acknowledgment
      && acknowledgment.status === "inserted"
    ) {
      outbox.shift();
    }
    expect(outbox).toHaveLength(0);

    await collector.close();
    expect(databaseCounts(databasePath)).toEqual({ attempts: 1, selections: 2 });

    const database = new DatabaseSync(databasePath);
    try {
      expect(
        database
          .prepare("SELECT option_index FROM attempt_selected_options ORDER BY option_index")
          .all()
          .map(({ option_index: optionIndex }) => Number(optionIndex)),
      ).toEqual([1, 2]);
    } finally {
      database.close();
    }
  });

  it("returns an exact duplicate ACK for an identical replay without adding rows", async () => {
    const { collector, databasePath } = await start();
    const payload = JSON.stringify(attempt());

    expect(await (await post(collector, payload)).json()).toStrictEqual({
      event_id: "10000000-0000-4000-8000-000000000001",
      status: "inserted",
    });
    const replay = await post(collector, payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toStrictEqual({
      event_id: "10000000-0000-4000-8000-000000000001",
      status: "duplicate",
    });
    expect(databaseCounts(databasePath)).toEqual({ attempts: 1, selections: 2 });
  });

  it("returns 409 for the same event ID with different content", async () => {
    const { collector, databasePath } = await start();
    await post(collector, JSON.stringify(attempt()));

    const conflict = await post(
      collector,
      JSON.stringify(attempt({ result: "correct" })),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toStrictEqual({
      error_code: "IDEMPOTENCY_CONFLICT",
    });
    expect(databaseCounts(databasePath)).toEqual({ attempts: 1, selections: 2 });
  });

  it.each([
    ["malformed JSON", "{", "INVALID_JSON"],
    ["a JSON primitive", "null", "INVALID_ATTEMPT_EVENT"],
    [
      "an extra field",
      JSON.stringify({ ...attempt(), unsupported_field: "blocked" }),
      "INVALID_ATTEMPT_EVENT",
    ],
    [
      "an empty selection",
      JSON.stringify(attempt({ selected_option_indices: [] })),
      "INVALID_ATTEMPT_EVENT",
    ],
    [
      "a wrong discriminator",
      JSON.stringify({ ...attempt(), record_type: "history_snapshot" }),
      "INVALID_ATTEMPT_EVENT",
    ],
  ])("rejects %s without inserting", async (_label, payload, code) => {
    const { collector, databasePath } = await start();
    const response = await post(collector, payload);

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error_code: code });
    expect(databaseCounts(databasePath)).toEqual({ attempts: 0, selections: 0 });
  });

  it("rejects a streamed body over the transport limit", async () => {
    const { collector, databasePath } = await start();
    const response = await post(
      collector,
      JSON.stringify({ padding: "x".repeat(MAX_REQUEST_BODY_BYTES) }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toStrictEqual({
      error_code: "REQUEST_BODY_TOO_LARGE",
    });
    expect(databaseCounts(databasePath)).toEqual({ attempts: 0, selections: 0 });
  });

  it("rejects non-JSON content, encoded bodies, and credential headers", async () => {
    const { collector } = await start();
    const payload = JSON.stringify(attempt());

    const wrongContent = await post(
      collector,
      payload,
      { "content-type": "text/plain" },
    );
    expect(wrongContent.status).toBe(415);
    expect(await wrongContent.json()).toStrictEqual({
      error_code: "CONTENT_TYPE_UNSUPPORTED",
    });

    const encoded = await post(collector, payload, {
      "content-encoding": "gzip",
      "content-type": "application/json",
    });
    expect(encoded.status).toBe(415);
    expect(await encoded.json()).toStrictEqual({
      error_code: "CONTENT_ENCODING_UNSUPPORTED",
    });

    const credentialed = await post(collector, payload, {
      authorization: "Bearer blocked",
      "content-type": "application/json",
    });
    expect(credentialed.status).toBe(400);
    expect(await credentialed.json()).toStrictEqual({
      error_code: "REQUEST_HEADERS_UNSUPPORTED",
    });
  });

  it("accepts only the exact method and path", async () => {
    const { collector } = await start();

    const getResponse = await fetch(endpoint(collector), { method: "GET" });
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
    expect(await getResponse.json()).toStrictEqual({
      error_code: "METHOD_NOT_ALLOWED",
    });

    for (const path of ["/", `${ATTEMPT_EVENTS_PATH}?source=test`]) {
      const response = await post(collector, JSON.stringify(attempt()), undefined, path);
      expect(response.status).toBe(404);
      expect(await response.json()).toStrictEqual({ error_code: "ROUTE_NOT_FOUND" });
    }
  });

  it("rejects a non-loopback Host header", async () => {
    const { collector } = await start();
    const result = await new Promise<{ readonly status: number; readonly body: string }>(
      (resolve, reject) => {
        const request = httpRequest({
          host: collector.host,
          port: collector.port,
          path: ATTEMPT_EVENTS_PATH,
          method: "POST",
          headers: {
            host: `localhost:${collector.port}`,
            "content-type": "application/json",
          },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        });
        request.on("error", reject);
        request.end(JSON.stringify(attempt()));
      },
    );

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toStrictEqual({
      error_code: "HOST_HEADER_UNSUPPORTED",
    });
  });

  it("returns retryable 500 without echoing storage errors", async () => {
    const collector = await startHistoryCollector({
      port: 0,
      storage: new ThrowingStorage(),
    });
    runningCollectors.push(collector);

    const response = await post(collector, JSON.stringify(attempt()));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toStrictEqual({
      error_code: "COLLECTOR_INTERNAL_ERROR",
    });
    expect(body).not.toContain("STORAGE_UNAVAILABLE");
    expect(body).not.toContain("question_key");
  });

  it("binds only IPv4 loopback and fails instead of choosing another port", async () => {
    const first = await start();
    expect(first.collector.host).toBe(HISTORY_COLLECTOR_HOST);
    expect(first.collector.server.address()).toMatchObject({
      address: HISTORY_COLLECTOR_HOST,
      family: "IPv4",
      port: first.collector.port,
    });

    await expect(startHistoryCollector({
      port: first.collector.port,
      databasePath: temporaryDatabasePath(),
    })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("closes idempotently and stops accepting connections", async () => {
    const { collector } = await start();
    const url = endpoint(collector);
    await collector.close();
    await collector.close();

    await expect(fetch(url)).rejects.toThrow();
  });
});


describe("purpose-aware v2 collector route", () => {
  it("acknowledges only the combined commit, protects replay purpose, and preserves v1", async () => {
    const { collector, databasePath } = await start();
    const event = attempt();
    const envelope = { attempt: event, context: { schema_version: "1", record_type: "study_context",
      event_id: event.event_id, study_mode: "review" } };
    const first = await post(collector, JSON.stringify(envelope), undefined, STUDY_ATTEMPT_EVENTS_PATH);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ event_id: event.event_id, status: "inserted" });
    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare("SELECT study_mode FROM attempt_study_context WHERE event_id=?")
        .get(event.event_id)?.study_mode).toBe("review");
      const retry = await post(collector, JSON.stringify(envelope), undefined, STUDY_ATTEMPT_EVENTS_PATH);
      expect(await retry.json()).toEqual({ event_id: event.event_id, status: "duplicate" });
      expect((await post(collector, JSON.stringify({ ...envelope, context: {
        ...envelope.context, study_mode: "normal",
      } }), undefined, STUDY_ATTEMPT_EVENTS_PATH)).status).toBe(409);
      expect((await post(collector, JSON.stringify(event))).status).toBe(200);
      expect(databaseCounts(databasePath).attempts).toBe(1);
      expect(database.prepare("SELECT study_mode FROM attempt_study_context").get()?.study_mode)
        .toBe("review");
    } finally { database.close(); }
  });

  it("rejects mismatched event IDs, additional fields, and purpose-only requests", async () => {
    const { collector, databasePath } = await start();
    const event = attempt();
    const context = { schema_version: "1", record_type: "study_context", event_id: event.event_id,
      study_mode: "normal" };
    for (const body of [
      { attempt: event, context: { ...context, event_id: "20000000-0000-4000-8000-000000000002" } },
      { attempt: event, context: { ...context, question_text: "forbidden" } },
      { context },
    ]) {
      expect((await post(collector, JSON.stringify(body), undefined, STUDY_ATTEMPT_EVENTS_PATH)).status)
        .toBe(400);
    }
    expect(databaseCounts(databasePath)).toEqual({ attempts: 0, selections: 0 });
  });
});
