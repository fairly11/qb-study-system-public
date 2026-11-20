import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { MigrationError } from "../src/errors.js";
import {
  applyMigrations,
  type Migration,
  readMigrations,
  validateMigrationSequence,
} from "../src/migrations.js";

function migration(version: number, name: string, sql: string): Migration {
  return {
    version,
    name,
    fileName: `${String(version).padStart(4, "0")}_${name}.sql`,
    sql,
    checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
  };
}

describe("SQLite migrations", () => {
  it("creates the complete schema from an empty database and is idempotent", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const first = applyMigrations(database);
      const second = applyMigrations(database);
      const tableNames = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => String(row.name));
      const indexNames = database
        .prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
          ORDER BY name
        `)
        .all()
        .map((row) => String(row.name));
      const triggerNames = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all()
        .map((row) => String(row.name));

      expect(first.applied_versions).toEqual([1, 2, 3, 4]);
      expect(first.current_version).toBe(4);
      expect(second).toEqual({ applied_versions: [], current_version: 4 });
      expect(tableNames).toEqual(
        expect.arrayContaining([
          "attempts",
          "attempt_selected_options",
          "attempt_study_context",
          "history_snapshots",
          "question_states",
          "review_plans",
          "review_plan_items",
          "review_plan_item_reasons",
          "set_creation_runs",
          "sync_runs",
          "system_logs",
          "system_log_counters",
          "schema_migrations",
          "notion_sync_targets",
          "notion_sync_journal",
          "notion_sync_leases",
        ]),
      );
      expect(indexNames).toEqual([
        "attempts_question_answered_at",
        "attempts_source_record_unique",
        "history_snapshots_run_question",
        "history_snapshots_source_record_unique",
        "notion_sync_journal_resource_sequence",
        "system_logs_occurred_at",
      ]);
      expect(triggerNames).toEqual([
        "attempt_selected_options_reject_delete",
        "attempt_selected_options_reject_update",
        "attempt_study_context_no_delete",
        "attempt_study_context_no_update",
        "attempts_reject_delete",
        "attempts_reject_update",
        "history_snapshots_reject_delete",
        "history_snapshots_reject_update",
        "notion_sync_journal_reject_delete",
        "notion_sync_journal_reject_update",
        "notion_sync_targets_reject_delete",
        "notion_sync_targets_reject_update",
        "review_plan_item_reasons_reject_delete",
        "review_plan_item_reasons_reject_update",
        "review_plan_items_reject_delete",
        "review_plan_items_reject_update",
        "review_plans_reject_delete",
        "review_plans_reject_update",
        "set_creation_runs_reject_delete",
        "set_creation_runs_reject_update",
        "sync_runs_reject_delete",
        "sync_runs_reject_update",
        "system_log_counters_reject_delete",
        "system_log_counters_reject_update",
        "system_logs_reject_delete",
        "system_logs_reject_update",
      ]);
    } finally {
      database.close();
    }
  });

  it("enforces one history snapshot per run and question in the DB schema", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database);
      const indexes = database.prepare("PRAGMA index_list(history_snapshots)").all();
      const uniqueIndex = indexes.find((index) => {
        if (Number(index.unique) !== 1) {
          return false;
        }
        const columns = database
          .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
          .all(String(index.name))
          .map((row) => String(row.name));
        return columns.join(",") === "snapshot_run_id,question_key";
      });

      expect(uniqueIndex).toBeDefined();
    } finally {
      database.close();
    }
  });

  it("keeps question states mutable for derived-state upserts", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database);
      database
        .prepare(`
          INSERT INTO question_states (
            state_id, schema_version, record_type, question_key,
            question_group_id, computed_at, algorithm_id, algorithm_version,
            evidence_watermark, evidence_sufficiency, next_review_on,
            producer, producer_version, source_system, source_record_id,
            recorded_at, acquisition_method, temporal_precision,
            state_precision, payload_checksum
          ) VALUES (?, '1', 'question_state', '119A12', NULL, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, NULL, ?, 'derived', 'exact', 'exact', ?)
        `)
        .run(
          "50000000-0000-4000-8000-000000000001",
          "2026-08-24T00:00:00.000Z",
          "test-algorithm",
          "1.0.0",
          "2026-08-24T00:00:00.000Z",
          "sufficient",
          "2026-08-25",
          "review-engine",
          "1.0.0",
          "review-engine",
          "2026-08-24T00:00:01.000Z",
          "0".repeat(64),
        );

      expect(() =>
        database
          .prepare(
            "UPDATE question_states SET evidence_sufficiency = 'partial' WHERE question_key = '119A12'",
          )
          .run(),
      ).not.toThrow();
      expect(
        database
          .prepare(
            "SELECT evidence_sufficiency FROM question_states WHERE question_key = '119A12'",
          )
          .get(),
      ).toMatchObject({ evidence_sufficiency: "partial" });
    } finally {
      database.close();
    }
  });

  it("fails closed when a numbered migration is missing", () => {
    const migrations = [
      migration(1, "first", "CREATE TABLE first_table (id INTEGER) STRICT;"),
      migration(3, "third", "CREATE TABLE third_table (id INTEGER) STRICT;"),
    ];

    expect(() => validateMigrationSequence(migrations)).toThrowError(
      expect.objectContaining({ code: "MIGRATION_SEQUENCE_INVALID" }),
    );
  });

  it("fails closed when an applied migration checksum changes", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database, [
        migration(1, "first", "CREATE TABLE first_table (id INTEGER) STRICT;"),
      ]);

      expect(() =>
        applyMigrations(database, [
          migration(
            1,
            "first",
            "CREATE TABLE first_table (id INTEGER, changed TEXT) STRICT;",
          ),
        ]),
      ).toThrowError(expect.objectContaining({ code: "MIGRATION_HISTORY_DIVERGED" }));
    } finally {
      database.close();
    }
  });

  it("rolls back a partially failing migration", () => {
    const database = new DatabaseSync(":memory:");
    const migrations = [
      migration(1, "stable", "CREATE TABLE stable_table (id INTEGER) STRICT;"),
      migration(
        2,
        "broken",
        "CREATE TABLE should_rollback (id INTEGER) STRICT; INVALID SQL;",
      ),
    ];

    try {
      expect(() => applyMigrations(database, migrations)).toThrowError(MigrationError);
      const rolledBackTable = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
        )
        .get();
      const version = database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get();
      expect(rolledBackTable).toBeUndefined();
      expect(Number(version?.version)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("loads only a contiguous set of conventionally named SQL files", () => {
    const migrations = readMigrations();
    expect(migrations.map(({ fileName }) => fileName)).toEqual([
      "0001_initial_schema.sql",
      "0002_append_only_guards.sql",
      "0003_notion_sync_journal.sql",
      "0004_attempt_study_context.sql",
    ]);
    expect(migrations.every(({ checksum }) => /^[0-9a-f]{64}$/u.test(checksum))).toBe(
      true,
    );
  });
});
