import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { validateAttemptEventV1, type AttemptEventV1 } from "@qb-study/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { StorageValidationError } from "../src/errors.js";
import { openSqliteHistoryCollectorStorage } from "../src/history-collector.js";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import { openSqliteNotionSyncStorage, type NotionSyncState } from "../src/notion-sync.js";

const directories: string[] = [];
const closers: (() => void)[] = [];
const TARGET = "notion:questions-1:attempts-1";
const PAGE_ID = "20000000-0000-4000-8000-000000000001";

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "qb-notion-sync-"));
  directories.push(directory);
  return join(directory, "history.sqlite");
}

function track<T extends { close(): void }>(resource: T): T {
  closers.push(() => resource.close());
  return resource;
}

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function attempt(number: number, overrides: Partial<AttemptEventV1> = {}): AttemptEventV1 {
  return {
    schema_version: "1",
    record_type: "attempt_event",
    event_id: `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    question_key: "119A12",
    answered_at: "2026-08-24T09:00:00+09:00",
    result: "correct",
    selected_option_indices: [3, 1],
    provenance: {
      producer: "test-fixture",
      producer_version: "1.0.0",
      source_system: "synthetic",
      recorded_at: "2026-08-24T09:00:01+09:00",
    },
    quality: {
      acquisition_method: "direct_capture",
      temporal_precision: "exact",
      state_precision: "exact",
    },
    ...overrides,
  };
}

function state(overrides: Partial<NotionSyncState> = {}): NotionSyncState {
  return { target: TARGET, kind: "attempt", key: attempt(1).event_id, status: "creating", ...overrides };
}

describe("Notion synchronization storage", () => {
  it("preserves the first activation boundary across restarts and ignores later scope widening", () => {
    const path = databasePath();
    const history = track(openSqliteHistoryCollectorStorage({ databasePath: path }));
    history.appendAttempt(attempt(1));
    const first = track(openSqliteNotionSyncStorage({ databasePath: path }));
    first.activateTarget(TARGET);
    history.appendAttempt(attempt(2));
    first.close();
    const restarted = track(openSqliteNotionSyncStorage({ databasePath: path }));
    restarted.activateTarget(TARGET, true);
    expect(restarted.listAttemptsForTarget(TARGET).map((event) => event.event_id)).toEqual([attempt(2).event_id]);
    restarted.activateTarget("other-target", true);
    expect(restarted.listAttemptsForTarget("other-target").map((event) => event.event_id))
      .toEqual([attempt(1).event_id, attempt(2).event_id]);
  });

  it("returns every repeated answer in insertion order with strict canonical V1 fields", () => {
    const path = databasePath();
    const history = track(openSqliteHistoryCollectorStorage({ databasePath: path }));
    const sync = track(openSqliteNotionSyncStorage({ databasePath: path }));
    sync.activateTarget(TARGET);
    history.appendAttempt(attempt(2));
    history.appendAttempt(attempt(1, { result: "incorrect", answered_at: "2026-08-23T09:00:00+09:00" }));
    const events = sync.listAttemptsForTarget(TARGET);
    expect(events.map((event) => event.event_id)).toEqual([attempt(2).event_id, attempt(1).event_id]);
    expect(events.every(validateAttemptEventV1)).toBe(true);
    expect(events[0]).toEqual({
      ...attempt(2),
      answered_at: "2026-08-24T00:00:00.000Z",
      selected_option_indices: [1, 3],
      provenance: { ...attempt(2).provenance, recorded_at: "2026-08-24T00:00:01.000Z" },
    });
    expect(sync.listAttemptsForTarget(TARGET, 1)).toEqual([events[0]]);
    sync.appendState(state({ key: attempt(2).event_id, status: "confirmed", pageId: PAGE_ID }));
    expect(sync.listAttemptsForTarget(TARGET)).toEqual(events);
  });

  it("keeps all eligible attempts without an implicit batch ceiling", () => {
    const path = databasePath();
    const history = track(openSqliteHistoryCollectorStorage({ databasePath: path }));
    const sync = track(openSqliteNotionSyncStorage({ databasePath: path }));
    sync.activateTarget(TARGET);
    for (let index = 1; index <= 125; index += 1) history.appendAttempt(attempt(index));
    expect(sync.listAttemptsForTarget(TARGET)).toHaveLength(125);
  });

  it("persists create intent before a simulated process restart and appends later outcomes", () => {
    const path = databasePath();
    const first = track(openSqliteNotionSyncStorage({ databasePath: path }));
    first.activateTarget(TARGET);
    first.appendState(state());
    first.close();
    const restarted = track(openSqliteNotionSyncStorage({ databasePath: path }));
    expect(restarted.getState(TARGET, "attempt", attempt(1).event_id)).toEqual(state());
    restarted.appendState(state({ status: "blocked", code: "CREATE_OUTCOME_UNKNOWN" }));
    restarted.appendState(state({ status: "confirmed", pageId: PAGE_ID }));
    expect(restarted.getState(TARGET, "attempt", attempt(1).event_id))
      .toEqual(state({ status: "confirmed", pageId: PAGE_ID }));
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      expect(raw.prepare("SELECT status FROM notion_sync_journal ORDER BY sequence").all().map((row) => row.status))
        .toEqual(["creating", "blocked", "confirmed"]);
    } finally { raw.close(); }
  });

  it("isolates resource kinds and destinations, including retry timestamps", () => {
    const sync = track(openSqliteNotionSyncStorage({ databasePath: databasePath() }));
    sync.activateTarget(TARGET);
    sync.activateTarget("other-target");
    sync.appendState(state({ kind: "question", key: "119A12", status: "retry", code: "RATE_LIMITED", retryAt: 1_900_000_000_000 }));
    expect(sync.getState(TARGET, "question", "119A12"))
      .toEqual(state({ kind: "question", key: "119A12", status: "retry", code: "RATE_LIMITED", retryAt: 1_900_000_000_000 }));
    expect(sync.getState(TARGET, "attempt", attempt(1).event_id)).toBeUndefined();
    expect(sync.getState("other-target", "question", "119A12")).toBeUndefined();
  });

  it("prevents evidence updates and deletion while leases remain operationally mutable", () => {
    const path = databasePath();
    const sync = track(openSqliteNotionSyncStorage({ databasePath: path }));
    sync.activateTarget(TARGET);
    sync.appendState(state());
    const raw = new DatabaseSync(path);
    try {
      for (const table of ["notion_sync_targets", "notion_sync_journal"]) {
        expect(() => raw.exec(`DELETE FROM ${table}`)).toThrow(/APPEND_ONLY/u);
        expect(() => raw.exec(`UPDATE ${table} SET target = target`)).toThrow(/APPEND_ONLY/u);
      }
    } finally { raw.close(); }
    expect(sync.acquireLease(TARGET, "worker-a", 100, 1_000)).toBe(true);
    sync.releaseLease(TARGET, "worker-a");
    expect(sync.acquireLease(TARGET, "worker-b", 100, 1_000)).toBe(true);
  });

  it("coordinates independent connections, owner renewal, expiry, restart, and stale release", () => {
    const path = databasePath();
    const first = track(openSqliteNotionSyncStorage({ databasePath: path }));
    const second = track(openSqliteNotionSyncStorage({ databasePath: path }));
    first.activateTarget(TARGET);
    expect(first.acquireLease(TARGET, "worker-a", 100, 1_000)).toBe(true);
    expect(second.acquireLease(TARGET, "worker-b", 1_099, 1_000)).toBe(false);
    expect(first.acquireLease(TARGET, "worker-a", 500, 1_000)).toBe(true);
    first.close();
    expect(second.acquireLease(TARGET, "worker-b", 1_100, 1_000)).toBe(false);
    expect(second.acquireLease(TARGET, "worker-b", 1_500, 1_000)).toBe(true);
    const restarted = track(openSqliteNotionSyncStorage({ databasePath: path }));
    restarted.releaseLease(TARGET, "worker-a");
    expect(restarted.acquireLease(TARGET, "worker-c", 1_501, 1_000)).toBe(false);
    second.releaseLease(TARGET, "worker-b");
    expect(restarted.acquireLease(TARGET, "worker-c", 1_501, 1_000)).toBe(true);
  });

  it("rejects inactive targets, unbounded text, unknown fields, and invalid timestamps", () => {
    const sync = track(openSqliteNotionSyncStorage({ databasePath: databasePath() }));
    expect(() => sync.listAttemptsForTarget(TARGET)).toThrowError(expect.objectContaining({ code: "NOTION_TARGET_INACTIVE" }));
    expect(() => sync.appendState(state())).toThrowError(expect.objectContaining({ code: "NOTION_TARGET_INACTIVE" }));
    expect(() => sync.activateTarget("contains prose")).toThrowError(StorageValidationError);
    expect(() => sync.activateTarget("x".repeat(256))).toThrowError(StorageValidationError);
    sync.activateTarget(TARGET);
    const invalidStates: NotionSyncState[] = [
      state({ key: "119A12" }),
      state({ kind: "question", key: " 119A12" }),
      state({ status: "confirmed" }),
      state({ pageId: "https://example.com/page" }),
      state({ code: "Server response containing private text" }),
      state({ code: "X".repeat(65) }),
      state({ retryAt: NaN }),
      state({ retryAt: 253_402_300_800_000 }),
      { ...state(), payload: "not allowed" } as NotionSyncState,
    ];
    for (const invalid of invalidStates) expect(() => sync.appendState(invalid)).toThrowError(StorageValidationError);
    for (const limit of [0, -1, NaN, 0.5]) expect(() => sync.listAttemptsForTarget(TARGET, limit)).toThrowError(StorageValidationError);
    expect(() => sync.acquireLease(TARGET, "worker-a", -1, 1_000)).toThrowError(StorageValidationError);
    expect(() => sync.acquireLease(TARGET, "worker-a", 0, 86_400_001)).toThrowError(StorageValidationError);
    expect(() => sync.acquireLease(TARGET, "worker-a", 253_402_300_799_999, 1)).toThrowError(StorageValidationError);
  });

  it("atomically begins a create only for the active lease owner and only once", () => {
    const path = databasePath();
    const first = track(openSqliteNotionSyncStorage({ databasePath: path }));
    const second = track(openSqliteNotionSyncStorage({ databasePath: path }));
    first.activateTarget(TARGET);
    const key = attempt(1).event_id;
    expect(first.beginCreate(TARGET, "attempt", key, "worker-a", 100)).toBe(false);
    first.acquireLease(TARGET, "worker-a", 100, 1_000);
    expect(second.beginCreate(TARGET, "attempt", key, "worker-b", 100)).toBe(false);
    expect(first.beginCreate(TARGET, "attempt", key, "worker-a", 100)).toBe(true);
    expect(first.getState(TARGET, "attempt", key))
      .toEqual(state({ code: "NOTION_CREATE_UNCONFIRMED" }));
    expect(first.beginCreate(TARGET, "attempt", key, "worker-a", 101)).toBe(false);
    expect(second.acquireLease(TARGET, "worker-b", 1_100, 1_000)).toBe(true);
    expect(second.beginCreate(TARGET, "attempt", key, "worker-b", 1_100)).toBe(false);
    expect(first.beginCreate(TARGET, "attempt", attempt(2).event_id, "worker-a", 1_100)).toBe(false);
    expect(second.beginCreate(TARGET, "attempt", attempt(2).event_id, "worker-b", 1_100)).toBe(true);
    // A returned page ID can be retained before remote verification completes.
    second.appendState(state({ pageId: PAGE_ID, code: "NOTION_CREATE_UNCONFIRMED" }));
    expect(second.getState(TARGET, "attempt", key)?.pageId).toBe(PAGE_ID);
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      expect(raw.prepare("SELECT COUNT(*) AS count FROM notion_sync_journal WHERE resource_key = ? AND page_id IS NULL")
        .get(key)?.count).toBe(1);
    } finally { raw.close(); }
  });

  it("allows a due retry to begin while blocking premature retries and terminal states", () => {
    const sync = track(openSqliteNotionSyncStorage({ databasePath: databasePath() }));
    sync.activateTarget(TARGET);
    sync.acquireLease(TARGET, "worker-a", 100, 10_000);
    const key = attempt(1).event_id;
    sync.appendState(state({ status: "retry", retryAt: 1_000 }));
    expect(sync.beginCreate(TARGET, "attempt", key, "worker-a", 999)).toBe(false);
    expect(sync.beginCreate(TARGET, "attempt", key, "worker-a", 1_000)).toBe(true);
    sync.appendState(state({ status: "confirmed", pageId: PAGE_ID }));
    expect(sync.beginCreate(TARGET, "attempt", key, "worker-a", 1_001)).toBe(false);
    sync.appendState(state({ status: "blocked", code: "CREATE_OUTCOME_UNKNOWN" }));
    expect(sync.beginCreate(TARGET, "attempt", key, "worker-a", 1_001)).toBe(false);
    sync.appendState(state({ kind: "question", key: "119A12", status: "retry" }));
    expect(sync.beginCreate(TARGET, "question", "119A12", "worker-a", 1_001)).toBe(true);
    expect(sync.beginCreate(TARGET, "question", "119A13", "worker-a", 10_100)).toBe(false);
  });

  it("migrates an existing version-2 database without changing attempt rows", () => {
    const path = databasePath();
    const raw = new DatabaseSync(path);
    applyMigrations(raw, readMigrations().slice(0, 2));
    raw.close();
    const history = track(openSqliteHistoryCollectorStorage({ databasePath: path, migrate: false }));
    history.appendAttempt(attempt(1));
    const before = new DatabaseSync(path, { readOnly: true });
    const oldRows = before.prepare("SELECT * FROM attempts").all();
    before.close();
    const sync = track(openSqliteNotionSyncStorage({ databasePath: path }));
    sync.activateTarget(TARGET);
    expect(sync.listAttemptsForTarget(TARGET)).toEqual([]);
    const after = new DatabaseSync(path, { readOnly: true });
    try {
      expect(after.prepare("SELECT * FROM attempts").all()).toEqual(oldRows);
      expect(after.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version).toBe(4);
      expect(() => after.prepare("SELECT * FROM sync_runs").all()).not.toThrow();
    } finally { after.close(); }
  });

  it("rejects tampered stored attempts before exporting them", () => {
    const path = databasePath();
    const history = track(openSqliteHistoryCollectorStorage({ databasePath: path }));
    history.appendAttempt(attempt(1));
    const sync = track(openSqliteNotionSyncStorage({ databasePath: path }));
    sync.activateTarget(TARGET, true);
    const raw = new DatabaseSync(path);
    raw.exec("DROP TRIGGER attempts_reject_update");
    raw.exec("UPDATE attempts SET result = 'incorrect'");
    raw.close();
    expect(() => sync.listAttemptsForTarget(TARGET)).toThrowError(StorageValidationError);
  });
});
