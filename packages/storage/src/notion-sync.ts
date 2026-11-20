import { chmodSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { validateAttemptEventV1, validateStudyContextV1, type AttemptEventV1, type StudyContextV1 } from "@qb-study/contracts";

import { StorageError, StorageValidationError } from "./errors.js";
import { applyMigrations } from "./migrations.js";
import { defaultDatabasePath } from "./sqlite-storage.js";
import { prepareAttempt } from "./validation.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9@._:/+%#=~-]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PAGE_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const QUESTION_KEY = /^\d{3}[A-Z][1-9]\d{0,2}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MAX_TIMESTAMP_MS = 253_402_300_799_999;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const STATE_KEYS = new Set(["target", "kind", "key", "status", "pageId", "code", "retryAt"]);

export type NotionSyncResourceKind = "question" | "attempt";
export type NotionSyncStatus = "creating" | "confirmed" | "retry" | "blocked";

export interface NotionSyncState {
  readonly target: string;
  readonly kind: NotionSyncResourceKind;
  readonly key: string;
  readonly status: NotionSyncStatus;
  readonly pageId?: string;
  readonly code?: string;
  readonly retryAt?: number;
}

export interface NotionSyncStorage {
  close(): void;
  /** First activation is permanent; later calls cannot widen its history scope. */
  activateTarget(target: string, includeExisting?: boolean): void;
  /** In insertion order, including confirmed entries for periodic reconciliation. */
  listAttemptsForTarget(target: string, limit?: number): readonly AttemptEventV1[];
  getStudyContext(eventId: string): StudyContextV1 | undefined;
  getState(target: string, kind: NotionSyncResourceKind, key: string): NotionSyncState | undefined;
  appendState(state: NotionSyncState): void;
  /** Atomically checks lease and latest outcome before recording create intent. */
  beginCreate(target: string, kind: NotionSyncResourceKind, key: string, owner: string, nowMs: number): boolean;
  /** Reacquiring by the same owner renews the lease. TTL is at most 24 hours. */
  acquireLease(target: string, owner: string, nowMs: number, ttlMs: number): boolean;
  releaseLease(target: string, owner: string): void;
}

export interface OpenNotionSyncStorageOptions {
  readonly databasePath?: string;
}

function assertIdentifier(value: unknown, maximum: number, field: string): asserts value is string {
  if (typeof value !== "string" || value.length > maximum || !SAFE_IDENTIFIER.test(value)) {
    throw new StorageValidationError(`${field} must be a bounded safe identifier`);
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < 0 || value > MAX_TIMESTAMP_MS) {
    throw new StorageValidationError(`${field} must be a bounded epoch timestamp`);
  }
}

function assertResource(target: unknown, kind: unknown, key: unknown): void {
  assertIdentifier(target, 255, "target");
  if ((kind !== "question" && kind !== "attempt") || typeof key !== "string"
    || !(kind === "question" ? QUESTION_KEY : UUID).test(key)) {
    throw new StorageValidationError("Notion sync resource identity is invalid");
  }
}

function assertState(state: NotionSyncState): void {
  if (typeof state !== "object" || state === null || Array.isArray(state)
    || Object.keys(state).some((key) => !STATE_KEYS.has(key))) {
    throw new StorageValidationError("Notion sync state contains unsupported fields");
  }
  assertResource(state.target, state.kind, state.key);
  if (!["creating", "confirmed", "retry", "blocked"].includes(state.status)) {
    throw new StorageValidationError("Notion sync status is invalid");
  }
  if (state.pageId !== undefined && (typeof state.pageId !== "string" || !PAGE_ID.test(state.pageId))) {
    throw new StorageValidationError("Notion page ID is invalid");
  }
  if (state.status === "confirmed" && state.pageId === undefined) {
    throw new StorageValidationError("Confirmed Notion state requires a page ID");
  }
  if (state.code !== undefined && (typeof state.code !== "string" || !SAFE_CODE.test(state.code))) {
    throw new StorageValidationError("Notion sync code must be an allowlisted identifier");
  }
  if (state.retryAt !== undefined) {
    assertTimestamp(state.retryAt, "retryAt");
  }
}

type Row = Record<string, SQLOutputValue>;

function stateFromRow(row: Row): NotionSyncState {
  const state: NotionSyncState = {
    target: String(row.target),
    kind: row.resource_kind as NotionSyncResourceKind,
    key: String(row.resource_key),
    status: row.status as NotionSyncStatus,
    ...(row.page_id === null ? {} : { pageId: String(row.page_id) }),
    ...(row.code === null ? {} : { code: String(row.code) }),
    ...(row.retry_at_ms === null ? {} : { retryAt: Number(row.retry_at_ms) }),
  };
  assertState(state);
  return Object.freeze(state);
}

class SqliteNotionSyncStorage implements NotionSyncStorage {
  readonly #database: DatabaseSync;
  #closed = false;

  public constructor(databasePath: string) {
    if (databasePath !== ":memory:" && (!isAbsolute(databasePath)
      || databasePath.length > 4_096 || databasePath.includes("\0"))) {
      throw new StorageValidationError("Notion sync database path must be absolute");
    }
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA busy_timeout = 5000");
      if (databasePath !== ":memory:") {
        this.#database.exec("PRAGMA journal_mode = WAL");
        chmodSync(databasePath, 0o600);
      }
      // A create intent must survive a restart before a remote mutation begins.
      this.#database.exec("PRAGMA synchronous = FULL");
      applyMigrations(this.#database);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  public activateTarget(target: string, includeExisting = false): void {
    this.#assertOpen();
    assertIdentifier(target, 255, "target");
    if (typeof includeExisting !== "boolean") {
      throw new StorageValidationError("includeExisting must be a boolean");
    }
    const now = Date.now();
    assertTimestamp(now, "activatedAt");
    // One statement captures the cutoff and inserts it under SQLite's write lock.
    this.#database.prepare(`
      INSERT INTO notion_sync_targets (target, after_attempt_rowid, activated_at_ms)
      SELECT ?, CASE WHEN ? THEN 0 ELSE COALESCE(MAX(rowid), 0) END, ? FROM attempts WHERE true
      ON CONFLICT(target) DO NOTHING
    `).run(target, includeExisting ? 1 : 0, now);
  }

  public listAttemptsForTarget(target: string, limit?: number): readonly AttemptEventV1[] {
    this.#assertOpen();
    this.#requireTarget(target);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new StorageValidationError("Notion sync limit must be a positive safe integer");
    }
    const rows = this.#database.prepare(`
      SELECT attempts.* FROM attempts
      WHERE rowid > (SELECT after_attempt_rowid FROM notion_sync_targets WHERE target = ?)
      ORDER BY rowid LIMIT ?
    `).all(target, limit ?? -1);
    const selections = this.#database.prepare(`
      SELECT option_index FROM attempt_selected_options WHERE event_id = ? ORDER BY option_index
    `);
    return rows.map((row): AttemptEventV1 => {
      const event: unknown = {
        schema_version: row.schema_version,
        record_type: row.record_type,
        event_id: row.event_id,
        question_key: row.question_key,
        ...(row.question_group_id === null ? {} : { question_group_id: row.question_group_id }),
        answered_at: row.answered_at,
        result: row.result,
        selected_option_indices: selections.all(String(row.event_id)).map((option) => Number(option.option_index)),
        provenance: {
          producer: row.producer,
          producer_version: row.producer_version,
          source_system: row.source_system,
          ...(row.source_record_id === null ? {} : { source_record_id: row.source_record_id }),
          recorded_at: row.recorded_at,
        },
        quality: {
          acquisition_method: row.acquisition_method,
          temporal_precision: row.temporal_precision,
          state_precision: row.state_precision,
        },
      };
      if (!validateAttemptEventV1(event)) {
        throw new StorageValidationError("Stored attempt failed validation or checksum verification");
      }
      const prepared = prepareAttempt(event);
      if (prepared.payload_checksum !== row.payload_checksum) {
        throw new StorageValidationError("Stored attempt failed validation or checksum verification");
      }
      return {
        ...event,
        answered_at: prepared.answered_at,
        selected_option_indices: [...prepared.selected_option_indices],
        provenance: { ...event.provenance, recorded_at: prepared.provenance.recorded_at },
      };
    });
  }

  public getStudyContext(eventId: string): StudyContextV1 | undefined {
    this.#assertOpen();
    if (!UUID.test(eventId)) throw new StorageValidationError("Study context event ID is invalid");
    const row = this.#database.prepare("SELECT * FROM attempt_study_context WHERE event_id = ?").get(eventId);
    if (row === undefined) return undefined;
    const context: unknown = { schema_version: "1", record_type: "study_context", event_id: row.event_id,
      study_mode: row.study_mode, ...(row.review_plan_id === null ? {} : { review_plan_id: row.review_plan_id }) };
    if (!validateStudyContextV1(context)
      || createHash("sha256").update(JSON.stringify(context)).digest("hex") !== row.payload_checksum) {
      throw new StorageValidationError("Stored study context failed validation or checksum verification");
    }
    return Object.freeze(context);
  }

  public getState(target: string, kind: NotionSyncResourceKind, key: string): NotionSyncState | undefined {
    this.#assertOpen();
    assertResource(target, kind, key);
    const row = this.#database.prepare(`
      SELECT * FROM notion_sync_journal
      WHERE target = ? AND resource_kind = ? AND resource_key = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(target, kind, key);
    return row === undefined ? undefined : stateFromRow(row);
  }

  public appendState(state: NotionSyncState): void {
    this.#assertOpen();
    assertState(state);
    this.#requireTarget(state.target);
    const now = Date.now();
    assertTimestamp(now, "recordedAt");
    this.#database.prepare(`
      INSERT INTO notion_sync_journal (
        target, resource_kind, resource_key, status, page_id, code, retry_at_ms, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(state.target, state.kind, state.key, state.status, state.pageId ?? null,
      state.code ?? null, state.retryAt ?? null, now);
  }

  public acquireLease(target: string, owner: string, nowMs: number, ttlMs: number): boolean {
    this.#assertOpen();
    this.#requireTarget(target);
    assertIdentifier(owner, 128, "owner");
    assertTimestamp(nowMs, "nowMs");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_TTL_MS) {
      throw new StorageValidationError("Notion lease TTL must be between 1 ms and 24 hours");
    }
    const expiresAt = nowMs + ttlMs;
    assertTimestamp(expiresAt, "expiresAt");
    const result = this.#database.prepare(`
      INSERT INTO notion_sync_leases (target, owner, expires_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(target) DO UPDATE SET owner = excluded.owner, expires_at_ms = excluded.expires_at_ms
      WHERE notion_sync_leases.owner = excluded.owner OR notion_sync_leases.expires_at_ms <= ?
    `).run(target, owner, expiresAt, nowMs);
    return result.changes === 1;
  }

  public beginCreate(target: string, kind: NotionSyncResourceKind, key: string, owner: string, nowMs: number): boolean {
    this.#assertOpen();
    assertResource(target, kind, key);
    assertIdentifier(owner, 128, "owner");
    assertTimestamp(nowMs, "nowMs");
    this.#requireTarget(target);
    // The conditional INSERT is one SQLite write transaction. A worker paused
    // after an earlier read cannot overwrite another worker's create intent.
    const result = this.#database.prepare(`
      WITH latest AS (
        SELECT status, retry_at_ms FROM notion_sync_journal
        WHERE target = ? AND resource_kind = ? AND resource_key = ?
        ORDER BY sequence DESC LIMIT 1
      )
      INSERT INTO notion_sync_journal (
        target, resource_kind, resource_key, status, page_id, code, retry_at_ms, recorded_at_ms
      )
      SELECT ?, ?, ?, 'creating', NULL, 'NOTION_CREATE_UNCONFIRMED', NULL, ?
      WHERE EXISTS (
        SELECT 1 FROM notion_sync_leases WHERE target = ? AND owner = ? AND expires_at_ms > ?
      ) AND (
        NOT EXISTS (SELECT 1 FROM latest)
        OR EXISTS (
          SELECT 1 FROM latest
          WHERE status = 'retry' AND (retry_at_ms IS NULL OR retry_at_ms <= ?)
        )
      )
    `).run(target, kind, key, target, kind, key, nowMs, target, owner, nowMs, nowMs);
    return result.changes === 1;
  }

  public releaseLease(target: string, owner: string): void {
    this.#assertOpen();
    assertIdentifier(target, 255, "target");
    assertIdentifier(owner, 128, "owner");
    this.#database.prepare("DELETE FROM notion_sync_leases WHERE target = ? AND owner = ?")
      .run(target, owner);
  }

  public close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new StorageError("STORAGE_CLOSED", "Storage driver is closed");
    }
  }

  #requireTarget(target: string): void {
    assertIdentifier(target, 255, "target");
    if (this.#database.prepare("SELECT 1 FROM notion_sync_targets WHERE target = ?").get(target) === undefined) {
      throw new StorageError("NOTION_TARGET_INACTIVE", "Activate the Notion target before synchronization");
    }
  }
}

export function openSqliteNotionSyncStorage(options: OpenNotionSyncStorageOptions = {}): NotionSyncStorage {
  return new SqliteNotionSyncStorage(options.databasePath ?? defaultDatabasePath());
}
