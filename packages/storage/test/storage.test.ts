import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AttemptEventV1, HistorySnapshotV1, StudyContextV1 } from "@qb-study/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  StorageValidationError,
  UnsafeLogFieldError,
  openSqliteHistoryCollectorStorage,
  type HistoryCollectorStorage,
  type SystemLogEntry,
} from "../src/history-collector.js";

const temporaryDirectories: string[] = [];

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "qb-study-storage-"));
  temporaryDirectories.push(directory);
  return join(directory, "history.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function attempt(
  overrides: Partial<AttemptEventV1> = {},
): AttemptEventV1 {
  return {
    schema_version: "1",
    record_type: "attempt_event",
    event_id: "10000000-0000-4000-8000-000000000001",
    question_key: "119A12",
    question_group_id: "119A-group-1",
    answered_at: "2026-08-24T00:00:00+09:00",
    result: "correct",
    selected_option_indices: [2, 1],
    provenance: {
      producer: "history-collector",
      producer_version: "0.1.0",
      source_system: "browser-extension",
      source_record_id: "source-attempt-1",
      recorded_at: "2026-08-24T00:00:01+09:00",
    },
    quality: {
      acquisition_method: "direct_capture",
      temporal_precision: "exact",
      state_precision: "exact",
    },
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<HistorySnapshotV1> = {},
): HistorySnapshotV1 {
  return {
    schema_version: "1",
    record_type: "history_snapshot",
    snapshot_id: "20000000-0000-4000-8000-000000000001",
    snapshot_run_id: "30000000-0000-4000-8000-000000000001",
    question_key: "119A12",
    observed_at: "2026-08-24T09:00:00+09:00",
    final_state: "incorrect",
    attempt_count: 3,
    last_attempted_on: "2026-08-23",
    provenance: {
      producer: "history-collector",
      producer_version: "0.1.0",
      source_system: "baseline-import",
      source_record_id: "source-snapshot-1",
      recorded_at: "2026-08-24T09:00:01+09:00",
    },
    quality: {
      acquisition_method: "imported_baseline",
      temporal_precision: "date_only",
      state_precision: "final_state_only",
    },
    ...overrides,
  };
}

function withStorage(
  operation: (storage: HistoryCollectorStorage, databasePath: string) => void,
): void {
  const databasePath = temporaryDatabasePath();
  const storage = openSqliteHistoryCollectorStorage({ databasePath });
  try {
    operation(storage, databasePath);
  } finally {
    storage.close();
  }
}

describe("history collector storage", () => {
  it("normalizes exact timestamps to UTC and stores selected indices separately", () => {
    const databasePath = temporaryDatabasePath();
    const storage = openSqliteHistoryCollectorStorage({ databasePath });
    expect(storage.appendAttempt(attempt())).toEqual({
      status: "inserted",
      record_id: "10000000-0000-4000-8000-000000000001",
    });
    storage.close();

    const database = new DatabaseSync(databasePath);
    try {
      const row = database
        .prepare("SELECT answered_at, recorded_at FROM attempts")
        .get();
      const options = database
        .prepare(
          "SELECT option_index FROM attempt_selected_options ORDER BY option_index",
        )
        .all()
        .map(({ option_index: optionIndex }) => Number(optionIndex));
      expect(row).toMatchObject({
        answered_at: "2026-08-23T15:00:00.000Z",
        recorded_at: "2026-08-23T15:00:01.000Z",
      });
      expect(options).toEqual([1, 2]);
    } finally {
      database.close();
    }
  });

  it("rejects timestamp fractions beyond canonical millisecond precision", () => {
    withStorage((storage) => {
      expect(() =>
        storage.appendAttempt(
          attempt({ answered_at: "2026-08-24T00:00:00.1234+09:00" }),
        ),
      ).toThrowError(StorageValidationError);
    });
  });

  it("shares the contract's low-year and normalized four-digit boundaries", () => {
    withStorage((storage) => {
      expect(
        storage.appendAttempt(
          attempt({ answered_at: "0099-01-01T00:00:00Z" }),
        ).status,
      ).toBe("inserted");
      expect(
        storage.appendHistorySnapshot(
          snapshot({ last_attempted_on: "0000-02-29" }),
        ).status,
      ).toBe("inserted");
      expect(() =>
        storage.appendAttempt(
          attempt({ answered_at: "0000-01-01T00:00:00+14:00" }),
        ),
      ).toThrowError(StorageValidationError);
      expect(() =>
        storage.appendAttempt(
          attempt({ answered_at: "9999-12-31T23:59:59-14:00" }),
        ),
      ).toThrowError(StorageValidationError);
    });
  });

  it("returns duplicate for identical record IDs independent of option ordering", () => {
    withStorage((storage) => {
      expect(storage.appendAttempt(attempt()).status).toBe("inserted");
      expect(
        storage.appendAttempt(attempt({ selected_option_indices: [1, 2] })),
      ).toEqual({
        status: "duplicate",
        record_id: "10000000-0000-4000-8000-000000000001",
        existing_record_id: "10000000-0000-4000-8000-000000000001",
      });
    });
  });

  it("matches the contract safe-identifier pattern exactly", () => {
    withStorage((storage) => {
      expect(
        storage.appendAttempt(
          attempt({
            question_group_id: "group@._:/+%#=~-1",
            provenance: {
              producer: "history-collector",
              producer_version: "0.1.0+local",
              source_system: "browser-extension",
              source_record_id: "source@._:/+%#=~-1",
              recorded_at: "2026-08-24T00:00:01+09:00",
            },
          }),
        ).status,
      ).toBe("inserted");

      expect(() =>
        storage.appendAttempt(
          attempt({
            event_id: "10000000-0000-4000-8000-000000000002",
            question_group_id: "-punctuation-cannot-start-an-identifier",
          }),
        ),
      ).toThrowError(StorageValidationError);
      expect(() =>
        storage.appendAttempt(
          attempt({
            event_id: "10000000-0000-4000-8000-000000000003",
            provenance: {
              producer: "contains prose",
              producer_version: "0.1.0",
              source_system: "browser-extension",
              recorded_at: "2026-08-24T00:00:01+09:00",
            },
          }),
        ),
      ).toThrowError(StorageValidationError);
    });
  });

  it("accepts only safe integers for attempt selections and snapshot counts", () => {
    withStorage((storage) => {
      expect(
        storage.appendAttempt(
          attempt({ selected_option_indices: [Number.MAX_SAFE_INTEGER] }),
        ).status,
      ).toBe("inserted");
      expect(() =>
        storage.appendAttempt(
          attempt({
            event_id: "10000000-0000-4000-8000-000000000002",
            selected_option_indices: [Number.MAX_SAFE_INTEGER + 1],
          }),
        ),
      ).toThrowError(StorageValidationError);

      expect(
        storage.appendHistorySnapshot(
          snapshot({ attempt_count: Number.MAX_SAFE_INTEGER }),
        ).status,
      ).toBe("inserted");
      expect(() =>
        storage.appendHistorySnapshot(
          snapshot({
            snapshot_id: "20000000-0000-4000-8000-000000000002",
            attempt_count: Number.MAX_SAFE_INTEGER + 1,
          }),
        ),
      ).toThrowError(StorageValidationError);
    });
  });

  it("deduplicates a source replay even when its generated event ID differs", () => {
    withStorage((storage) => {
      storage.appendAttempt(attempt());
      expect(
        storage.appendAttempt(
          attempt({ event_id: "10000000-0000-4000-8000-000000000002" }),
        ),
      ).toEqual({
        status: "duplicate",
        record_id: "10000000-0000-4000-8000-000000000002",
        existing_record_id: "10000000-0000-4000-8000-000000000001",
      });
    });
  });

  it("raises an explicit conflict for the same ID with different safe fields", () => {
    withStorage((storage) => {
      storage.appendAttempt(attempt());
      expect(() => storage.appendAttempt(attempt({ result: "incorrect" }))).toThrowError(
        expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
      );
      expect(() => storage.appendAttempt(attempt({ result: "incorrect" }))).toThrowError(
        IdempotencyConflictError,
      );
    });
  });

  it("does not merge legitimate repeated answers with different IDs and no source ID", () => {
    withStorage((storage) => {
      const first = attempt({
        provenance: {
          producer: "history-collector",
          producer_version: "0.1.0",
          source_system: "manual",
          recorded_at: "2026-08-24T00:00:01+09:00",
        },
      });
      const second = {
        ...first,
        event_id: "10000000-0000-4000-8000-000000000002",
      } satisfies AttemptEventV1;
      expect(storage.appendAttempt(first).status).toBe("inserted");
      expect(storage.appendAttempt(second).status).toBe("inserted");
    });
  });

  it("preserves date-only snapshot evidence without inventing a timestamp", () => {
    const databasePath = temporaryDatabasePath();
    const storage = openSqliteHistoryCollectorStorage({ databasePath });
    storage.appendHistorySnapshot(snapshot());
    storage.close();

    const database = new DatabaseSync(databasePath);
    try {
      expect(
        database
          .prepare(
            "SELECT last_attempted_at, last_attempted_on FROM history_snapshots",
          )
          .get(),
      ).toMatchObject({
        last_attempted_at: null,
        last_attempted_on: "2026-08-23",
      });
    } finally {
      database.close();
    }
  });

  it("deduplicates one snapshot per run and question and conflicts on divergence", () => {
    withStorage((storage) => {
      const first = snapshot({
        provenance: {
          producer: "history-collector",
          producer_version: "0.1.0",
          source_system: "baseline-import",
          recorded_at: "2026-08-24T09:00:01+09:00",
        },
      });
      storage.appendHistorySnapshot(first);
      expect(
        storage.appendHistorySnapshot({
          ...first,
          snapshot_id: "20000000-0000-4000-8000-000000000002",
        }),
      ).toMatchObject({ status: "duplicate" });
      expect(() =>
        storage.appendHistorySnapshot({
          ...first,
          snapshot_id: "20000000-0000-4000-8000-000000000003",
          final_state: "correct",
        }),
      ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    });
  });

  it("rejects AttemptEvent and HistorySnapshot discriminator mixing at runtime", () => {
    withStorage((storage) => {
      expect(() =>
        storage.appendAttempt(snapshot() as unknown as AttemptEventV1),
      ).toThrowError(StorageValidationError);
      expect(() =>
        storage.appendHistorySnapshot(attempt() as unknown as HistorySnapshotV1),
      ).toThrowError(StorageValidationError);
    });
  });

  it("enforces append-only attempts and selected options in SQLite", () => {
    const databasePath = temporaryDatabasePath();
    const storage = openSqliteHistoryCollectorStorage({ databasePath });
    storage.appendAttempt(attempt());
    storage.close();

    const database = new DatabaseSync(databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE attempts SET result = 'incorrect'").run(),
      ).toThrow(/ATTEMPTS_APPEND_ONLY/u);
      expect(() => database.prepare("DELETE FROM attempts").run()).toThrow(
        /ATTEMPTS_APPEND_ONLY/u,
      );
      expect(() =>
        database.prepare("DELETE FROM attempt_selected_options").run(),
      ).toThrow(/ATTEMPT_OPTIONS_APPEND_ONLY/u);
      expect(() =>
        database
          .prepare("UPDATE attempt_selected_options SET option_index = option_index + 10")
          .run(),
      ).toThrow(/ATTEMPT_OPTIONS_APPEND_ONLY/u);
    } finally {
      database.close();
    }
  });

  it("rejects arbitrary log fields and stores only allowlisted identifiers and counters", () => {
    const databasePath = temporaryDatabasePath();
    const storage = openSqliteHistoryCollectorStorage({ databasePath });
    const baseLog: SystemLogEntry = {
      log_id: "40000000-0000-4000-8000-000000000001",
      occurred_at: "2026-08-24T12:00:00+09:00",
      severity: "info",
      component: "history_collector",
      event_code: "IMPORT_COMPLETED",
      question_key: "119A12",
      counters: { inserted_count: 2, duplicate_count: 1 },
    };

    expect(() =>
      storage.appendSystemLog({
        ...baseLog,
        message: "not allowed",
      } as SystemLogEntry & { message: string }),
    ).toThrowError(UnsafeLogFieldError);
    storage.appendSystemLog(baseLog);
    storage.close();

    const database = new DatabaseSync(databasePath);
    try {
      const columns = database.prepare("PRAGMA table_info(system_logs)").all();
      const counters = database
        .prepare(
          "SELECT counter_name, counter_value FROM system_log_counters ORDER BY counter_name",
        )
        .all();
      expect(columns.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining(["message", "payload"]),
      );
      expect(counters).toEqual([
        { counter_name: "duplicate_count", counter_value: 1 },
        { counter_name: "inserted_count", counter_value: 2 },
      ]);
    } finally {
      database.close();
    }
  });
});


describe("immutable study purpose evidence", () => {
  function context(event: AttemptEventV1, mode: StudyContextV1["study_mode"] = "review"): StudyContextV1 {
    return { schema_version: "1", record_type: "study_context", event_id: event.event_id,
      study_mode: mode };
  }

  it("saves original and purpose together, survives reopen, and rejects changed purpose or original", () => {
    const databasePath = temporaryDatabasePath();
    let storage = openSqliteHistoryCollectorStorage({ databasePath });
    const event = attempt();
    const envelope = { attempt: event, context: context(event) };
    expect(storage.appendStudyAttempt(envelope).status).toBe("inserted");
    storage.close();
    storage = openSqliteHistoryCollectorStorage({ databasePath });
    try {
      expect(storage.getStudyContext(event.event_id)).toEqual(envelope.context);
      expect(storage.appendStudyAttempt(envelope).status).toBe("duplicate");
      expect(() => storage.appendStudyAttempt({ ...envelope, context: context(event, "normal") }))
        .toThrow(IdempotencyConflictError);
      expect(() => storage.appendStudyAttempt({ ...envelope, attempt: { ...event, result: "incorrect" } }))
        .toThrow(IdempotencyConflictError);
      expect(storage.getStudyContext(event.event_id)).toEqual(envelope.context);
      const database = new DatabaseSync(databasePath);
      try {
        expect(database.prepare("SELECT COUNT(*) AS n FROM attempts").get()?.n).toBe(1);
        expect(() => database.exec("UPDATE attempt_study_context SET study_mode = 'normal'"))
          .toThrow("append-only");
        expect(() => database.exec("DELETE FROM attempt_study_context")).toThrow("append-only");
      } finally { database.close(); }
    } finally { storage.close(); }
  });

  it("rolls back the original and selections when context cannot be committed", () => {
    withStorage((storage, databasePath) => {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(`CREATE TRIGGER reject_test_context BEFORE INSERT ON attempt_study_context
          BEGIN SELECT RAISE(ABORT, 'simulated context failure'); END;`);
        const event = attempt();
        expect(() => storage.appendStudyAttempt({ attempt: event, context: context(event) }))
          .toThrow("simulated context failure");
        expect(database.prepare("SELECT COUNT(*) AS n FROM attempts").get()?.n).toBe(0);
        expect(database.prepare("SELECT COUNT(*) AS n FROM attempt_selected_options").get()?.n).toBe(0);
        expect(storage.getStudyContext(event.event_id)).toBeUndefined();
      } finally { database.close(); }
    });
  });

  it("keeps V1 history unclassified and rejects mismatched identifiers without inserting an original", () => {
    withStorage((storage) => {
      const event = attempt();
      expect(() => storage.appendStudyAttempt({ attempt: event, context: {
        ...context(event), event_id: "20000000-0000-4000-8000-000000000002",
      } })).toThrow(StorageValidationError);
      expect(storage.appendAttempt(event).status).toBe("inserted");
      expect(storage.getStudyContext(event.event_id)).toBeUndefined();
      expect(() => storage.appendStudyAttempt({ attempt: event, context: context(event) }))
        .toThrow(IdempotencyConflictError);
      expect(storage.appendStudyAttempt({ attempt: event, context: context(event, "unclassified") }).status)
        .toBe("duplicate");
      expect(storage.getStudyContext(event.event_id)?.study_mode).toBe("unclassified");
    });
  });
});
