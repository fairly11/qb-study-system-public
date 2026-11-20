import type { AttemptEventV1, HistorySnapshotV1, StudyAttemptEnvelopeV1, StudyContextV1 } from "@qb-study/contracts";

export type AppendResult =
  | {
      readonly status: "inserted";
      readonly record_id: string;
    }
  | {
      readonly status: "duplicate";
      readonly record_id: string;
      readonly existing_record_id: string;
    };

export type SystemLogSeverity = "debug" | "info" | "warn" | "error";

/**
 * Deliberately contains no message or arbitrary payload field. Identifiers and
 * non-negative numeric counters are the complete logging surface.
 */
export interface SystemLogEntry {
  readonly log_id: string;
  readonly occurred_at: string;
  readonly severity: SystemLogSeverity;
  readonly component: string;
  readonly event_code: string;
  readonly run_id?: string;
  readonly correlation_id?: string;
  readonly record_id?: string;
  readonly question_key?: string;
  readonly counters?: Readonly<Record<string, number>>;
}

export interface MigrationResult {
  readonly applied_versions: readonly number[];
  readonly current_version: number;
}

/** Seam implemented by SQLite now and replaceable without changing callers. */
export interface StorageDriver {
  readonly kind: "sqlite" | (string & {});
  migrate(): MigrationResult;
  getSchemaVersion(): number;
  close(): void;
}

/**
 * The append surface belongs to the history collector entrypoint. Review code
 * must not depend on this interface or on @qb-study/storage/history-collector.
 */
export interface HistoryCollectorStorage extends StorageDriver {
  appendAttempt(event: AttemptEventV1): AppendResult;
  appendStudyAttempt(envelope: StudyAttemptEnvelopeV1): AppendResult;
  getStudyContext(eventId: string): StudyContextV1 | undefined;
  appendHistorySnapshot(snapshot: HistorySnapshotV1): AppendResult;
  appendSystemLog(entry: SystemLogEntry): void;
}

export interface OpenStorageOptions {
  readonly databasePath?: string;
  readonly migrate?: boolean;
}
