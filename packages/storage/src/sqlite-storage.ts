import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  validateStudyAttemptEnvelopeV1,
  validateStudyContextV1,
  type AttemptEventV1,
  type HistorySnapshotV1,
  type StudyAttemptEnvelopeV1,
  type StudyContextV1,
} from "@qb-study/contracts";

import { IdempotencyConflictError, StorageError, StorageValidationError } from "./errors.js";
import { applyMigrations, currentSchemaVersion } from "./migrations.js";
import type {
  AppendResult,
  HistoryCollectorStorage,
  MigrationResult,
  OpenStorageOptions,
  SystemLogEntry,
} from "./types.js";
import {
  prepareAttempt,
  prepareSnapshot,
  prepareSystemLog,
  type PreparedAttempt,
  type PreparedSnapshot,
} from "./validation.js";

interface ExistingRecord {
  readonly record_id: string;
  readonly payload_checksum: string;
}

export function defaultDatabasePath(homeDirectory = homedir()): string {
  return join(
    homeDirectory,
    "Library",
    "Application Support",
    "qb-study-system",
    "qb-study.sqlite",
  );
}

function prepareDatabasePath(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
}

function configureDatabase(database: DatabaseSync, databasePath: string): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (databasePath !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    chmodSync(databasePath, 0o600);
  }
}

class SqliteHistoryCollectorStorage implements HistoryCollectorStorage {
  public readonly kind = "sqlite" as const;
  readonly #database: DatabaseSync;
  #closed = false;

  public constructor(databasePath: string, runMigrations: boolean) {
    prepareDatabasePath(databasePath);
    this.#database = new DatabaseSync(databasePath);
    try {
      configureDatabase(this.#database, databasePath);
      if (runMigrations) {
        this.migrate();
      }
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  public migrate(): MigrationResult {
    this.#assertOpen();
    return applyMigrations(this.#database);
  }

  public getSchemaVersion(): number {
    this.#assertOpen();
    return currentSchemaVersion(this.#database);
  }

  public appendAttempt(input: AttemptEventV1): AppendResult {
    this.#assertOpen();
    const attempt = prepareAttempt(input);

    return this.#inTransaction(() => this.#appendPreparedAttempt(attempt));
  }

  public appendStudyAttempt(input: StudyAttemptEnvelopeV1): AppendResult {
    this.#assertOpen();
    if (!validateStudyAttemptEnvelopeV1(input)) {
      throw new StorageValidationError("Study attempt envelope is invalid");
    }
    const attempt = prepareAttempt(input.attempt);
    const context: StudyContextV1 = {
      schema_version: "1", record_type: "study_context",
      event_id: attempt.event_id, study_mode: input.context.study_mode,
      ...(input.context.review_plan_id === undefined ? {} : {
        review_plan_id: input.context.review_plan_id.toLowerCase(),
      }),
    };
    const checksum = createHash("sha256").update(JSON.stringify(context)).digest("hex");
    return this.#inTransaction(() => {
      const result = this.#appendPreparedAttempt(attempt);
      // A source-record alias must not attach evidence to a different event UUID.
      if (result.status === "duplicate" && result.existing_record_id !== context.event_id) {
        throw new IdempotencyConflictError("attempt_event", "record_id", context.event_id,
          result.existing_record_id);
      }
      const existing = this.getStudyContext(context.event_id);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(context)) {
          throw new IdempotencyConflictError("attempt_event", "record_id",
            context.event_id, context.event_id);
        }
        return result;
      }
      // V1 deliveries had no purpose evidence; a retry cannot reclassify them.
      if (result.status === "duplicate" && context.study_mode !== "unclassified") {
        throw new IdempotencyConflictError("attempt_event", "record_id",
          context.event_id, context.event_id);
      }
      this.#database.prepare(`INSERT INTO attempt_study_context
        (event_id, study_mode, review_plan_id, payload_checksum) VALUES (?, ?, ?, ?)`)
        .run(context.event_id, context.study_mode, context.review_plan_id ?? null, checksum);
      return result;
    });
  }

  public getStudyContext(eventId: string): StudyContextV1 | undefined {
    this.#assertOpen();
    const row = this.#database.prepare(`SELECT event_id, study_mode, review_plan_id,
      payload_checksum FROM attempt_study_context WHERE event_id = ?`).get(eventId);
    if (row === undefined) return undefined;
    const context = {
      schema_version: "1", record_type: "study_context", event_id: row.event_id,
      study_mode: row.study_mode,
      ...(row.review_plan_id === null ? {} : { review_plan_id: row.review_plan_id }),
    };
    if (!validateStudyContextV1(context)
      || createHash("sha256").update(JSON.stringify(context)).digest("hex") !== row.payload_checksum) {
      throw new StorageValidationError("Stored study context is invalid");
    }
    return context;
  }

  #appendPreparedAttempt(attempt: PreparedAttempt): AppendResult {
    const duplicate = this.#resolveAttemptIdentity(attempt);
    if (duplicate !== undefined) {
      return duplicate;
    }

    this.#database
      .prepare(`
        INSERT INTO attempts (
          event_id, schema_version, record_type, question_key,
          question_group_id, answered_at, result, producer,
          producer_version, source_system, source_record_id, recorded_at,
          acquisition_method, temporal_precision, state_precision,
          payload_checksum
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attempt.event_id,
        attempt.schema_version,
        attempt.record_type,
        attempt.question_key,
        attempt.question_group_id,
        attempt.answered_at,
        attempt.result,
        attempt.provenance.producer,
        attempt.provenance.producer_version,
        attempt.provenance.source_system,
        attempt.provenance.source_record_id,
        attempt.provenance.recorded_at,
        attempt.quality.acquisition_method,
        attempt.quality.temporal_precision,
        attempt.quality.state_precision,
        attempt.payload_checksum,
      );

    const insertSelection = this.#database.prepare(
      "INSERT INTO attempt_selected_options (event_id, option_index) VALUES (?, ?)",
    );
    for (const optionIndex of attempt.selected_option_indices) {
      insertSelection.run(attempt.event_id, optionIndex);
    }

    return { status: "inserted", record_id: attempt.event_id };
  }

  public appendHistorySnapshot(input: HistorySnapshotV1): AppendResult {
    this.#assertOpen();
    const snapshot = prepareSnapshot(input);

    return this.#inTransaction(() => {
      const duplicate = this.#resolveSnapshotIdentity(snapshot);
      if (duplicate !== undefined) {
        return duplicate;
      }

      this.#database
        .prepare(`
          INSERT INTO history_snapshots (
            snapshot_id, schema_version, record_type, snapshot_run_id,
            question_key, question_group_id, observed_at, final_state,
            attempt_count, last_attempted_at, last_attempted_on, producer,
            producer_version, source_system, source_record_id, recorded_at,
            acquisition_method, temporal_precision, state_precision,
            payload_checksum
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          snapshot.snapshot_id,
          snapshot.schema_version,
          snapshot.record_type,
          snapshot.snapshot_run_id,
          snapshot.question_key,
          snapshot.question_group_id,
          snapshot.observed_at,
          snapshot.final_state,
          snapshot.attempt_count,
          snapshot.last_attempted_at,
          snapshot.last_attempted_on,
          snapshot.provenance.producer,
          snapshot.provenance.producer_version,
          snapshot.provenance.source_system,
          snapshot.provenance.source_record_id,
          snapshot.provenance.recorded_at,
          snapshot.quality.acquisition_method,
          snapshot.quality.temporal_precision,
          snapshot.quality.state_precision,
          snapshot.payload_checksum,
        );

      return { status: "inserted", record_id: snapshot.snapshot_id };
    });
  }

  public appendSystemLog(input: SystemLogEntry): void {
    this.#assertOpen();
    const entry = prepareSystemLog(input);
    this.#inTransaction(() => {
      this.#database
        .prepare(`
          INSERT INTO system_logs (
            log_id, occurred_at, severity, component, event_code,
            run_id, correlation_id, record_id, question_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          entry.log_id,
          entry.occurred_at,
          entry.severity,
          entry.component,
          entry.event_code,
          entry.run_id,
          entry.correlation_id,
          entry.record_id,
          entry.question_key,
        );

      const insertCounter = this.#database.prepare(
        "INSERT INTO system_log_counters (log_id, counter_name, counter_value) VALUES (?, ?, ?)",
      );
      for (const [name, value] of Object.entries(entry.counters).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        insertCounter.run(entry.log_id, name, value);
      }
    });
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new StorageError("STORAGE_CLOSED", "Storage driver is closed");
    }
  }

  #inTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #resolveAttemptIdentity(attempt: PreparedAttempt): AppendResult | undefined {
    const byId = this.#database
      .prepare(
        "SELECT event_id AS record_id, payload_checksum FROM attempts WHERE event_id = ?",
      )
      .get(attempt.event_id) as ExistingRecord | undefined;
    if (byId !== undefined) {
      return this.#duplicateOrConflict(
        "attempt_event",
        "record_id",
        attempt.event_id,
        attempt.payload_checksum,
        byId,
      );
    }

    if (attempt.provenance.source_record_id === null) {
      return undefined;
    }
    const bySource = this.#database
      .prepare(`
        SELECT event_id AS record_id, payload_checksum
        FROM attempts
        WHERE source_system = ? AND source_record_id = ?
      `)
      .get(
        attempt.provenance.source_system,
        attempt.provenance.source_record_id,
      ) as ExistingRecord | undefined;
    if (bySource === undefined) {
      return undefined;
    }
    return this.#duplicateOrConflict(
      "attempt_event",
      "source_record_id",
      attempt.event_id,
      attempt.payload_checksum,
      bySource,
    );
  }

  #resolveSnapshotIdentity(snapshot: PreparedSnapshot): AppendResult | undefined {
    const byId = this.#database
      .prepare(`
        SELECT snapshot_id AS record_id, payload_checksum
        FROM history_snapshots
        WHERE snapshot_id = ?
      `)
      .get(snapshot.snapshot_id) as ExistingRecord | undefined;
    if (byId !== undefined) {
      return this.#duplicateOrConflict(
        "history_snapshot",
        "record_id",
        snapshot.snapshot_id,
        snapshot.payload_checksum,
        byId,
      );
    }

    if (snapshot.provenance.source_record_id === null) {
      return this.#resolveSnapshotRunQuestion(snapshot);
    }
    const bySource = this.#database
      .prepare(`
        SELECT snapshot_id AS record_id, payload_checksum
        FROM history_snapshots
        WHERE source_system = ? AND source_record_id = ?
      `)
      .get(
        snapshot.provenance.source_system,
        snapshot.provenance.source_record_id,
      ) as ExistingRecord | undefined;
    if (bySource === undefined) {
      return this.#resolveSnapshotRunQuestion(snapshot);
    }
    return this.#duplicateOrConflict(
      "history_snapshot",
      "source_record_id",
      snapshot.snapshot_id,
      snapshot.payload_checksum,
      bySource,
    );
  }

  #resolveSnapshotRunQuestion(snapshot: PreparedSnapshot): AppendResult | undefined {
    const existing = this.#database
      .prepare(`
        SELECT snapshot_id AS record_id, payload_checksum
        FROM history_snapshots
        WHERE snapshot_run_id = ? AND question_key = ?
      `)
      .get(snapshot.snapshot_run_id, snapshot.question_key) as ExistingRecord | undefined;
    if (existing === undefined) {
      return undefined;
    }
    return this.#duplicateOrConflict(
      "history_snapshot",
      "snapshot_run_question",
      snapshot.snapshot_id,
      snapshot.payload_checksum,
      existing,
    );
  }

  #duplicateOrConflict(
    recordType: "attempt_event" | "history_snapshot",
    identityKind: "record_id" | "source_record_id" | "snapshot_run_question",
    incomingRecordId: string,
    incomingChecksum: string,
    existing: ExistingRecord,
  ): AppendResult {
    if (existing.payload_checksum === incomingChecksum) {
      return {
        status: "duplicate",
        record_id: incomingRecordId,
        existing_record_id: existing.record_id,
      };
    }
    throw new IdempotencyConflictError(
      recordType,
      identityKind,
      incomingRecordId,
      existing.record_id,
    );
  }
}

export function openSqliteHistoryCollectorStorage(
  options: OpenStorageOptions = {},
): HistoryCollectorStorage {
  const databasePath = options.databasePath ?? defaultDatabasePath();
  return new SqliteHistoryCollectorStorage(databasePath, options.migrate ?? true);
}
