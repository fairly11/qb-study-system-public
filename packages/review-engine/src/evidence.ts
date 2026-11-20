import { createHash } from "node:crypto";
import {
  isValidLocalDate,
  normalizeExactTimestamp,
  toTokyoDate,
  validateAttemptEventV1,
  validateHistorySnapshotV1,
  validateRecoveredAttemptV1,
  type AttemptEventV1,
  type HistorySnapshotV1,
  type RecoveredAttemptV1,
} from "@qb-study/contracts";

import type {
  GenerateDailyReviewPlanInput, ReviewQuestionMetadata, ReviewSettings, StudyMode,
  StudyStatistics,
} from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const QUESTION_KEY = /^\d{3}[A-Z][1-9]\d{0,2}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9@._:/+%#=~-]{0,99}$/u;
export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = Object.freeze({
  settings_version: "1",
  max_questions: 100,
  request_retention: 0.9,
  per_question_daily_cap: 2,
  sparse_min_graded_attempts: 3,
  sparse_min_distinct_days: 2,
});

/** Errors contain only fixed codes, never upstream evidence or user text. */
export class ReviewEngineError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReviewEngineError";
  }
}

export function exactTimestamp(value: string): string {
  const normalized = normalizeExactTimestamp(value);
  if (!normalized.ok) throw new ReviewEngineError("REVIEW_TIMESTAMP_INVALID");
  return normalized.value;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareText(a, b))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

export function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function resolveReviewSettings(input: Partial<ReviewSettings> = {}): ReviewSettings {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !(key in DEFAULT_REVIEW_SETTINGS))) {
    throw new ReviewEngineError("REVIEW_SETTINGS_INVALID");
  }
  const settings = { ...DEFAULT_REVIEW_SETTINGS, ...input };
  if (typeof settings.settings_version !== "string" || !SAFE_ID.test(settings.settings_version)
    || !Number.isInteger(settings.max_questions) || settings.max_questions < 0 || settings.max_questions > 100
    || !Number.isFinite(settings.request_retention) || settings.request_retention <= 0 || settings.request_retention >= 1
    || !Number.isSafeInteger(settings.per_question_daily_cap) || settings.per_question_daily_cap < 1
    || settings.per_question_daily_cap > 100
    || !Number.isSafeInteger(settings.sparse_min_graded_attempts) || settings.sparse_min_graded_attempts < 1
    || settings.sparse_min_graded_attempts > 1_000
    || !Number.isSafeInteger(settings.sparse_min_distinct_days) || settings.sparse_min_distinct_days < 1
    || settings.sparse_min_distinct_days > 1_000) {
    throw new ReviewEngineError("REVIEW_SETTINGS_INVALID");
  }
  return settings;
}

function normalizeAttempt(input: AttemptEventV1): AttemptEventV1 {
  if (!validateAttemptEventV1(input)) throw new ReviewEngineError("REVIEW_ATTEMPT_INVALID");
  return {
    ...input,
    event_id: input.event_id.toLowerCase(),
    answered_at: exactTimestamp(input.answered_at),
    selected_option_indices: [...input.selected_option_indices].sort((a, b) => a - b),
    provenance: { ...input.provenance, recorded_at: exactTimestamp(input.provenance.recorded_at) },
    quality: { ...input.quality },
  };
}

function normalizeRecovery(input: RecoveredAttemptV1): RecoveredAttemptV1 {
  if (!validateRecoveredAttemptV1(input)) throw new ReviewEngineError("REVIEW_RECOVERED_ATTEMPT_INVALID");
  return { ...input, recovery_id: input.recovery_id.toLowerCase(),
    observed_at: exactTimestamp(input.observed_at), recovered_at: exactTimestamp(input.recovered_at) };
}

function exclusionCount(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new ReviewEngineError("REVIEW_INPUT_INVALID");
  return value;
}

function distinctRecords<T>(values: readonly T[], key: (value: T) => string, code: string): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    const existing = unique.get(id);
    if (existing !== undefined && evidenceHash(existing) !== evidenceHash(value)) {
      throw new ReviewEngineError(code);
    }
    unique.set(id, value);
  }
  return [...unique.values()];
}

function tags(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== "string"
    || entry.length < 1 || entry.length > 100 || hasControlCharacters(entry))) {
    throw new ReviewEngineError("REVIEW_METADATA_INVALID");
  }
  return [...new Set(value)].sort(compareText);
}

function normalizeQuestion(input: ReviewQuestionMetadata): ReviewQuestionMetadata {
  if (input === null || typeof input !== "object" || !QUESTION_KEY.test(input.question_key)
    || (input.stopped !== undefined && typeof input.stopped !== "boolean")
    || (input.next_review_on !== undefined && input.next_review_on !== null
      && !isValidLocalDate(input.next_review_on))) {
    throw new ReviewEngineError("REVIEW_METADATA_INVALID");
  }
  return {
    question_key: input.question_key,
    stopped: input.stopped ?? false,
    next_review_on: input.next_review_on ?? null,
    subjects: tags(input.subjects), fields: tags(input.fields), knowledge_tags: tags(input.knowledge_tags),
  };
}

export function prepareEvidence(input: GenerateDailyReviewPlanInput) {
  const asOf = exactTimestamp(input.as_of);
  if (!Array.isArray(input.attempts) || !Array.isArray(input.contexts ?? [])
    || !Array.isArray(input.questions ?? []) || !Array.isArray(input.snapshots ?? [])
    || !Array.isArray(input.recovered_attempts ?? [])) {
    throw new ReviewEngineError("REVIEW_INPUT_INVALID");
  }
  const allAttempts = distinctRecords(input.attempts.map(normalizeAttempt), (event) => event.event_id,
    "REVIEW_EVENT_CONFLICT");
  // An answer observed in the future is not available evidence at the cutoff.
  const attempts = allAttempts.filter((event) => event.answered_at <= asOf && event.provenance.recorded_at <= asOf)
    .sort((a, b) => compareText(a.answered_at, b.answered_at) || compareText(a.event_id, b.event_id));
  const recoveryEnabled = input.recovered_attempts !== undefined || input.suppressed_recovered_attempts !== undefined
    || input.excluded_future_recovered_attempts !== undefined;
  const calendarDate = toTokyoDate(asOf);
  const allRecoveries = distinctRecords((input.recovered_attempts ?? []).map(normalizeRecovery),
    (event) => event.recovery_id, "REVIEW_RECOVERY_CONFLICT");
  const recoveredDays = new Set<string>();
  for (const event of allRecoveries) {
    const key = `${event.question_key}:${event.answered_on}`;
    if (recoveredDays.has(key)) throw new ReviewEngineError("REVIEW_RECOVERY_CONFLICT");
    recoveredDays.add(key);
  }
  const availableRecoveries = allRecoveries.filter((event) => event.answered_on <= calendarDate
    && event.observed_at <= asOf && event.recovered_at <= asOf);
  const directDays = new Set(attempts.map((event) => `${event.question_key}:${toTokyoDate(event.answered_at)}`));
  const recoveredAttempts = availableRecoveries.filter((event) => !directDays.has(`${event.question_key}:${event.answered_on}`))
    .sort((a, b) => compareText(a.answered_on, b.answered_on) || compareText(a.observed_at, b.observed_at)
      || compareText(a.recovery_id, b.recovery_id));
  const excludedFutureRecoveries = allRecoveries.length - availableRecoveries.length
    + exclusionCount(input.excluded_future_recovered_attempts);
  const suppressedRecoveries = availableRecoveries.length - recoveredAttempts.length
    + exclusionCount(input.suppressed_recovered_attempts);
  const contexts = new Map<string, StudyMode>();
  for (const context of input.contexts ?? []) {
    if (context === null || typeof context !== "object" || !UUID.test(context.event_id)
      || !["normal", "review", "unclassified"].includes(context.study_mode)) {
      throw new ReviewEngineError("REVIEW_CONTEXT_INVALID");
    }
    const eventId = context.event_id.toLowerCase();
    if (contexts.has(eventId) && contexts.get(eventId) !== context.study_mode) {
      throw new ReviewEngineError("REVIEW_CONTEXT_CONFLICT");
    }
    contexts.set(eventId, context.study_mode);
  }
  const allSnapshots = distinctRecords((input.snapshots ?? []).map((snapshot) => {
    if (!validateHistorySnapshotV1(snapshot)) throw new ReviewEngineError("REVIEW_SNAPSHOT_INVALID");
    return {
      ...snapshot, snapshot_id: snapshot.snapshot_id.toLowerCase(), snapshot_run_id: snapshot.snapshot_run_id.toLowerCase(),
      observed_at: exactTimestamp(snapshot.observed_at),
      ...(snapshot.last_attempted_at === undefined ? {} : { last_attempted_at: exactTimestamp(snapshot.last_attempted_at) }),
      provenance: { ...snapshot.provenance, recorded_at: exactTimestamp(snapshot.provenance.recorded_at) },
      quality: { ...snapshot.quality },
    } satisfies HistorySnapshotV1;
  }), (snapshot) => snapshot.snapshot_id, "REVIEW_SNAPSHOT_CONFLICT");
  const snapshots = allSnapshots.filter((snapshot) => snapshot.observed_at <= asOf
    && snapshot.provenance.recorded_at <= asOf).sort((a, b) => compareText(a.snapshot_id, b.snapshot_id));
  const questions = distinctRecords((input.questions ?? []).map(normalizeQuestion), (question) => question.question_key,
    "REVIEW_METADATA_CONFLICT").sort((a, b) => compareText(a.question_key, b.question_key));
  const metadata = new Map(questions.map((question) => [question.question_key, question]));
  const questionKeys = [...new Set([...metadata.keys(), ...attempts.map((event) => event.question_key),
    ...snapshots.map((snapshot) => snapshot.question_key), ...recoveredAttempts.map((event) => event.question_key)])].sort(compareText);
  const targetDate = toTokyoDate(new Date(Date.parse(asOf) - 4 * 60 * 60 * 1_000).toISOString());
  return {
    asOf, calendarDate, targetDate,
    scheduledAt: exactTimestamp(`${targetDate}T04:00:00+09:00`),
    attempts, contexts, snapshots, metadata, questionKeys,
    recoveryEnabled, recoveredAttempts, excludedFutureRecoveries, suppressedRecoveries,
    excludedFutureAttempts: allAttempts.length - attempts.length,
    excludedFutureSnapshots: allSnapshots.length - snapshots.length,
    hash: evidenceHash({ attempts, snapshots, questions,
      ...(recoveryEnabled ? { recovered_attempts: recoveredAttempts,
        excluded_future_recovered_attempts: excludedFutureRecoveries, suppressed_recovered_attempts: suppressedRecoveries } : {}),
      contexts: attempts.map((event) => ({ event_id: event.event_id, study_mode: contexts.get(event.event_id) ?? "unclassified" })),
    }),
  };
}

export function countStudy(attempts: readonly AttemptEventV1[], contexts: ReadonlyMap<string, StudyMode>,
  recoveries: readonly RecoveredAttemptV1[] = []): StudyStatistics {
  const count = (events: readonly Pick<AttemptEventV1, "question_key" | "result">[]) => ({
    attempts: events.length, unique_questions: new Set(events.map((event) => event.question_key)).size,
    correct: events.filter((event) => event.result === "correct").length,
    incorrect: events.filter((event) => event.result === "incorrect").length,
    unknown: events.filter((event) => event.result === "unknown").length,
  });
  return {
    total: count([...attempts, ...recoveries]),
    normal: count(attempts.filter((event) => contexts.get(event.event_id) === "normal")),
    review: count(attempts.filter((event) => contexts.get(event.event_id) === "review")),
    unclassified: count([...attempts.filter((event) => (contexts.get(event.event_id) ?? "unclassified") === "unclassified"), ...recoveries]),
  };
}
