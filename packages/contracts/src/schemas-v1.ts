import { Type, type Static, type TSchema } from "@sinclair/typebox";

const SCHEMA_BASE_URI = "https://schemas.qb-study.local/v1";

export const SAFE_IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9@._:/+%#=~-]*$";
export const MAX_JSON_INTEGER = Number.MAX_SAFE_INTEGER;

function safeIdentifierSchema(maxLength: number) {
  return Type.String({
    minLength: 1,
    maxLength,
    pattern: SAFE_IDENTIFIER_PATTERN,
  });
}

const ExactTimestampSchema = Type.String({
  description: "ISO 8601 date-time with an explicit offset whose normalized UTC value has a four-digit year.",
  format: "date-time",
  pattern: "^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,3})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$",
});

const LocalDateSchema = Type.String({
  description: "Proleptic Gregorian calendar date with a four-digit year and no invented time of day.",
  format: "date",
  pattern: "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$",
});

export const QuestionKeySchema = Type.String({
  description: "Canonical Japanese medical national examination question key.",
  pattern: "^[0-9]{3}[A-Z][1-9][0-9]{0,2}$",
});

export type QuestionKey = Static<typeof QuestionKeySchema>;

export const ProvenanceV1Schema = Type.Object(
  {
    producer: safeIdentifierSchema(100),
    producer_version: safeIdentifierSchema(100),
    source_system: safeIdentifierSchema(100),
    source_record_id: Type.Optional(safeIdentifierSchema(255)),
    recorded_at: ExactTimestampSchema,
  },
  { additionalProperties: false },
);

export type ProvenanceV1 = Static<typeof ProvenanceV1Schema>;

export const QualityV1Schema = Type.Object(
  {
    acquisition_method: Type.Union([
      Type.Literal("direct_capture"),
      Type.Literal("imported_baseline"),
      Type.Literal("derived"),
      Type.Literal("manual"),
    ]),
    temporal_precision: Type.Union([
      Type.Literal("exact"),
      Type.Literal("date_only"),
      Type.Literal("not_applicable"),
    ]),
    state_precision: Type.Union([
      Type.Literal("exact"),
      Type.Literal("final_state_only"),
      Type.Literal("not_applicable"),
    ]),
  },
  { additionalProperties: false },
);

export type QualityV1 = Static<typeof QualityV1Schema>;

const AttemptQualityV1Schema = Type.Object(
  {
    acquisition_method: Type.Literal("direct_capture"),
    temporal_precision: Type.Literal("exact"),
    state_precision: Type.Literal("exact"),
  },
  { additionalProperties: false },
);

function commonRecordProperties<T extends string>(recordType: T) {
  return {
    schema_version: Type.Literal("1"),
    record_type: Type.Literal(recordType),
    provenance: ProvenanceV1Schema,
    quality: QualityV1Schema,
  };
}

function recordOptions(name: string) {
  return {
    $id: `${SCHEMA_BASE_URI}/${name}.schema.json`,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
  };
}

export const AttemptEventV1Schema = Type.Object(
  {
    ...commonRecordProperties("attempt_event"),
    event_id: Type.String({ format: "uuid" }),
    question_key: QuestionKeySchema,
    question_group_id: Type.Optional(safeIdentifierSchema(255)),
    answered_at: ExactTimestampSchema,
    result: Type.Union([
      Type.Literal("correct"),
      Type.Literal("incorrect"),
      Type.Literal("unknown"),
    ]),
    selected_option_indices: Type.Array(Type.Integer({
      minimum: 1,
      maximum: MAX_JSON_INTEGER,
    }), {
      minItems: 1,
      uniqueItems: true,
    }),
    quality: AttemptQualityV1Schema,
  },
  recordOptions("attempt-event-v1"),
);

export type AttemptEventV1 = Static<typeof AttemptEventV1Schema>;

export const HistorySnapshotV1Schema = Type.Object(
  {
    ...commonRecordProperties("history_snapshot"),
    snapshot_id: Type.String({ format: "uuid" }),
    snapshot_run_id: Type.String({ format: "uuid" }),
    question_key: QuestionKeySchema,
    question_group_id: Type.Optional(safeIdentifierSchema(255)),
    observed_at: ExactTimestampSchema,
    final_state: Type.Union([
      Type.Literal("correct"),
      Type.Literal("incorrect"),
      Type.Literal("unknown"),
      Type.Literal("unattempted"),
    ]),
    attempt_count: Type.Optional(Type.Integer({
      minimum: 0,
      maximum: MAX_JSON_INTEGER,
    })),
    last_attempted_at: Type.Optional(ExactTimestampSchema),
    last_attempted_on: Type.Optional(LocalDateSchema),
  },
  {
    ...recordOptions("history-snapshot-v1"),
    allOf: [
      {
        if: {
          type: "object",
          properties: {
            quality: {
              type: "object",
              properties: { temporal_precision: { const: "exact" } },
              required: ["temporal_precision"],
            },
          },
          required: ["quality"],
        },
        then: {
          type: "object",
          properties: { last_attempted_at: {} },
          required: ["last_attempted_at"],
          not: {
            type: "object",
            properties: { last_attempted_on: {} },
            required: ["last_attempted_on"],
          },
        },
      },
      {
        if: {
          type: "object",
          properties: {
            quality: {
              type: "object",
              properties: { temporal_precision: { const: "date_only" } },
              required: ["temporal_precision"],
            },
          },
          required: ["quality"],
        },
        then: {
          type: "object",
          properties: { last_attempted_on: {} },
          required: ["last_attempted_on"],
          not: {
            type: "object",
            properties: { last_attempted_at: {} },
            required: ["last_attempted_at"],
          },
        },
      },
      {
        if: {
          type: "object",
          properties: {
            quality: {
              type: "object",
              properties: { temporal_precision: { const: "not_applicable" } },
              required: ["temporal_precision"],
            },
          },
          required: ["quality"],
        },
        then: {
          type: "object",
          not: {
            type: "object",
            anyOf: [
              {
                type: "object",
                properties: { last_attempted_at: {} },
                required: ["last_attempted_at"],
              },
              {
                type: "object",
                properties: { last_attempted_on: {} },
                required: ["last_attempted_on"],
              },
            ],
          },
        },
      },
    ],
  },
);

export type HistorySnapshotV1 = Static<typeof HistorySnapshotV1Schema>;

export const QuestionStateV1Schema = Type.Object(
  {
    ...commonRecordProperties("question_state"),
    state_id: Type.String({ format: "uuid" }),
    question_key: QuestionKeySchema,
    question_group_id: Type.Optional(safeIdentifierSchema(255)),
    computed_at: ExactTimestampSchema,
    algorithm_id: safeIdentifierSchema(100),
    algorithm_version: safeIdentifierSchema(100),
    evidence_watermark: Type.Union([ExactTimestampSchema, Type.Null()]),
    evidence_sufficiency: Type.Union([
      Type.Literal("insufficient"),
      Type.Literal("partial"),
      Type.Literal("sufficient"),
    ]),
    next_review_on: Type.Union([LocalDateSchema, Type.Null()]),
  },
  recordOptions("question-state-v1"),
);

export type QuestionStateV1 = Static<typeof QuestionStateV1Schema>;

export const ReviewPlanV1Schema = Type.Object(
  {
    ...commonRecordProperties("review_plan"),
    review_plan_id: Type.String({ format: "uuid" }),
    target_date: LocalDateSchema,
    timezone: Type.Literal("Asia/Tokyo"),
    generated_at: ExactTimestampSchema,
    algorithm_id: safeIdentifierSchema(100),
    algorithm_version: safeIdentifierSchema(100),
    item_count: Type.Integer({ minimum: 0, maximum: MAX_JSON_INTEGER }),
  },
  recordOptions("review-plan-v1"),
);

export type ReviewPlanV1 = Static<typeof ReviewPlanV1Schema>;

export const ReviewPlanItemV1Schema = Type.Object(
  {
    ...commonRecordProperties("review_plan_item"),
    review_plan_item_id: Type.String({ format: "uuid" }),
    review_plan_id: Type.String({ format: "uuid" }),
    question_key: QuestionKeySchema,
    question_group_id: Type.Optional(safeIdentifierSchema(255)),
    position: Type.Integer({ minimum: 1, maximum: MAX_JSON_INTEGER }),
    selection_reasons: Type.Array(
      Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }),
      { minItems: 1, uniqueItems: true },
    ),
  },
  recordOptions("review-plan-item-v1"),
);

export type ReviewPlanItemV1 = Static<typeof ReviewPlanItemV1Schema>;

export const SetBuildRequestV1Schema = Type.Object(
  {
    ...commonRecordProperties("set_build_request"),
    request_id: Type.String({ format: "uuid" }),
    set_name: Type.String({ minLength: 1, maxLength: 100 }),
    question_keys: Type.Array(QuestionKeySchema, { minItems: 1, uniqueItems: true }),
    review_plan_id: Type.Optional(Type.String({ format: "uuid" })),
    dry_run: Type.Boolean(),
  },
  recordOptions("set-build-request-v1"),
);

export type SetBuildRequestV1 = Static<typeof SetBuildRequestV1Schema>;

const SetBuildItemResultV1Schema = Type.Object(
  {
    question_key: QuestionKeySchema,
    status: Type.Union([
      Type.Literal("planned"),
      Type.Literal("added"),
      Type.Literal("skipped"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
    ]),
    error_code: Type.Optional(Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" })),
  },
  { additionalProperties: false },
);

export const SetBuildResultV1Schema = Type.Object(
  {
    ...commonRecordProperties("set_build_result"),
    result_id: Type.String({ format: "uuid" }),
    request_id: Type.String({ format: "uuid" }),
    completed_at: ExactTimestampSchema,
    status: Type.Union([
      Type.Literal("planned"),
      Type.Literal("succeeded"),
      Type.Literal("partial"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
    ]),
    items: Type.Array(SetBuildItemResultV1Schema),
  },
  recordOptions("set-build-result-v1"),
);

export type SetBuildResultV1 = Static<typeof SetBuildResultV1Schema>;

const SyncCountsV1Schema = Type.Object(
  {
    attempted: Type.Integer({ minimum: 0, maximum: MAX_JSON_INTEGER }),
    succeeded: Type.Integer({ minimum: 0, maximum: MAX_JSON_INTEGER }),
    skipped: Type.Integer({ minimum: 0, maximum: MAX_JSON_INTEGER }),
    failed: Type.Integer({ minimum: 0, maximum: MAX_JSON_INTEGER }),
  },
  { additionalProperties: false },
);

export const SyncResultV1Schema = Type.Object(
  {
    ...commonRecordProperties("sync_result"),
    sync_result_id: Type.String({ format: "uuid" }),
    sync_run_id: Type.String({ format: "uuid" }),
    direction: Type.Literal("sqlite_to_google_sheets"),
    started_at: ExactTimestampSchema,
    completed_at: ExactTimestampSchema,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("partial"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
    ]),
    counts: SyncCountsV1Schema,
  },
  recordOptions("sync-result-v1"),
);

export type SyncResultV1 = Static<typeof SyncResultV1Schema>;

const ErrorIdentifiersV1Schema = Type.Object(
  {
    run_id: Type.Optional(Type.String({ format: "uuid" })),
    record_id: Type.Optional(Type.String({ format: "uuid" })),
    question_key: Type.Optional(QuestionKeySchema),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const ErrorEnvelopeV1Schema = Type.Object(
  {
    ...commonRecordProperties("error_envelope"),
    error_id: Type.String({ format: "uuid" }),
    occurred_at: ExactTimestampSchema,
    component: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
    error_code: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" }),
    retryable: Type.Boolean(),
    correlation_id: Type.String({ format: "uuid" }),
    identifiers: Type.Optional(ErrorIdentifiersV1Schema),
  },
  recordOptions("error-envelope-v1"),
);

export type ErrorEnvelopeV1 = Static<typeof ErrorEnvelopeV1Schema>;

export type ContractRecordV1 =
  | AttemptEventV1
  | HistorySnapshotV1
  | QuestionStateV1
  | ReviewPlanV1
  | ReviewPlanItemV1
  | SetBuildRequestV1
  | SetBuildResultV1
  | SyncResultV1
  | ErrorEnvelopeV1;

export interface SchemaRegistryEntryV1 {
  readonly fileName: string;
  readonly recordType: ContractRecordV1["record_type"];
  readonly schema: TSchema;
}

export const schemaRegistryV1 = [
  { fileName: "attempt-event-v1.schema.json", recordType: "attempt_event", schema: AttemptEventV1Schema },
  { fileName: "history-snapshot-v1.schema.json", recordType: "history_snapshot", schema: HistorySnapshotV1Schema },
  { fileName: "question-state-v1.schema.json", recordType: "question_state", schema: QuestionStateV1Schema },
  { fileName: "review-plan-v1.schema.json", recordType: "review_plan", schema: ReviewPlanV1Schema },
  { fileName: "review-plan-item-v1.schema.json", recordType: "review_plan_item", schema: ReviewPlanItemV1Schema },
  { fileName: "set-build-request-v1.schema.json", recordType: "set_build_request", schema: SetBuildRequestV1Schema },
  { fileName: "set-build-result-v1.schema.json", recordType: "set_build_result", schema: SetBuildResultV1Schema },
  { fileName: "sync-result-v1.schema.json", recordType: "sync_result", schema: SyncResultV1Schema },
  { fileName: "error-envelope-v1.schema.json", recordType: "error_envelope", schema: ErrorEnvelopeV1Schema },
] as const satisfies readonly SchemaRegistryEntryV1[];
