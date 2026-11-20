export type StorageErrorCode =
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_STORAGE_RECORD"
  | "MIGRATION_APPLY_FAILED"
  | "MIGRATION_DIRECTORY_NOT_FOUND"
  | "MIGRATION_FILENAME_INVALID"
  | "MIGRATION_HISTORY_DIVERGED"
  | "MIGRATION_SEQUENCE_INVALID"
  | "NOTION_TARGET_INACTIVE"
  | "STORAGE_CLOSED"
  | "UNSAFE_LOG_FIELD";

export class StorageError extends Error {
  public override readonly name: string = "StorageError";

  public constructor(
    public readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class StorageValidationError extends StorageError {
  public override readonly name: string = "StorageValidationError";

  public constructor(message: string) {
    super("INVALID_STORAGE_RECORD", message);
  }
}

export class UnsafeLogFieldError extends StorageError {
  public override readonly name: string = "UnsafeLogFieldError";

  public constructor() {
    super("UNSAFE_LOG_FIELD", "System log contains a field outside the allowlist");
  }
}

export class IdempotencyConflictError extends StorageError {
  public override readonly name: string = "IdempotencyConflictError";

  public constructor(
    public readonly recordType: "attempt_event" | "history_snapshot",
    public readonly identityKind:
      | "record_id"
      | "source_record_id"
      | "snapshot_run_question",
    public readonly incomingRecordId: string,
    public readonly existingRecordId: string,
  ) {
    super(
      "IDEMPOTENCY_CONFLICT",
      `${recordType} conflicts with an existing ${identityKind}`,
    );
  }
}

export class MigrationError extends StorageError {
  public override readonly name: string = "MigrationError";
}
