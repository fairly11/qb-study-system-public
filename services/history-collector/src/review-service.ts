import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeExactTimestamp, validateStudyContextV1, type AttemptEventV1, type StudyContextV1 } from "@qb-study/contracts";
import { generateDailyReviewPlan, selectDailyReviewAdditions, type DailyReviewPlan, type GenerateDailyReviewPlanInput } from "@qb-study/review-engine";
import { createSetManifest, verifySetMembership, type SetManifest } from "@qb-study/set-builder";
import { canonicalAttempt, canonicalStudyContext, NotionSyncError, type NotionReviewSnapshot, type NotionReviewPage } from "./notion-client.js";

export interface ReviewSourceSummary {
  readonly read_started_at: string;
  readonly read_completed_at: string;
  readonly canonical_attempts: number;
  readonly unknown_attempt_rows: number;
  readonly duplicate_attempt_rows: number;
  readonly unknown_question_rows: number;
  readonly excluded_future_events: number;
  readonly excluded_from_aggregation_rows: number;
  readonly recovered_attempts?: number;
  readonly duplicate_recovered_rows?: number;
  readonly suppressed_recovered_rows?: number;
  readonly excluded_future_recoveries?: number;
}
export type SavedReviewPlan = DailyReviewPlan & {readonly plan_id: string; readonly source_summary: ReviewSourceSummary};
export interface SavedReviewRevision {
  readonly revision: 1;
  readonly revised_at: string;
  readonly reason: "include_due_within_day";
  readonly qb_set_url: string;
  readonly base_plan_sha256: string;
  readonly effective_plan: SavedReviewPlan;
}
export interface ReviewPublisher {
  find(plan: SavedReviewPlan): Promise<readonly NotionReviewPage[]>;
  create(plan: SavedReviewPlan): Promise<NotionReviewPage>;
  verify(id: string, plan: SavedReviewPlan): Promise<boolean>;
}
export function latestReviewDay(asOf: string): string {
  const normalized = normalizeExactTimestamp(asOf);
  if (!normalized.ok) throw new Error("REVIEW_TIME_INVALID");
  const instant = Date.parse(normalized.value);
  return new Date(instant + 5 * 3_600_000).toISOString().slice(0, 10);
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Immutable records use link(2) for atomic no-replace publication, then fsync. */
export class ReviewJournal {
  constructor(readonly directory: string) { mkdirSync(directory, {recursive: true, mode: 0o700}); }
  private path(day: string, name: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !/^[a-z][a-z0-9-]{0,99}$/u.test(name)) throw new Error("REVIEW_JOURNAL_KEY_INVALID");
    const directory = join(this.directory, day);
    mkdirSync(directory, {recursive: true, mode: 0o700});
    return join(directory, name + ".json");
  }
  read<T>(day: string, name: string): T | undefined {
    const path = this.path(day, name);
    if (!existsSync(path)) return undefined;
    const stored = JSON.parse(readFileSync(path, "utf8")) as {sha256: string; value: T};
    if (typeof stored.sha256 !== "string" || stored.sha256 !== hash(stored.value)) throw new Error("REVIEW_JOURNAL_CORRUPT");
    return stored.value;
  }
  writeOnce<T>(day: string, name: string, value: T): void {
    const path = this.path(day, name);
    const existing = this.read<T>(day, name);
    if (existing !== undefined) {
      if (hash(existing) !== hash(value)) throw new Error("REVIEW_JOURNAL_CONFLICT");
      return;
    }
    const temporary = path + "." + randomUUID() + ".tmp";
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({sha256: hash(value), value}) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      linkSync(temporary, path);
      const directoryFd = openSync(join(this.directory, day), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } finally { unlinkSync(temporary); }
  }
  async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const directory = join(this.directory, "publisher.lock");
    try { mkdirSync(directory, {mode: 0o700}); }
    catch { throw new Error("REVIEW_PUBLISHER_LOCKED"); }
    writeFileSync(join(directory, "owner.json"), JSON.stringify({pid: process.pid}), {mode: 0o600});
    try { return await task(); }
    finally { unlinkSync(join(directory, "owner.json")); rmdirSync(directory); }
  }
}

/** Preserve legacy input shape when reading an older snapshot. */
export function reviewSnapshotEvidence(snapshot: NotionReviewSnapshot): Pick<GenerateDailyReviewPlanInput,
  "attempts" | "contexts" | "questions" | "recovered_attempts" | "suppressed_recovered_attempts" | "excluded_future_recovered_attempts"> {
  return { attempts: snapshot.attempts, contexts: snapshot.contexts, questions: snapshot.questions,
    ...(snapshot.recoveredAttempts === undefined ? {} : { recovered_attempts: snapshot.recoveredAttempts }),
    ...(snapshot.suppressedRecoveredRows === undefined ? {} : { suppressed_recovered_attempts: snapshot.suppressedRecoveredRows }),
    ...(snapshot.excludedFutureRecoveries === undefined ? {} : { excluded_future_recovered_attempts: snapshot.excludedFutureRecoveries }) };
}

export async function prepareReview(input: {
  readonly asOf: string;
  readonly journal: ReviewJournal;
  readonly readSnapshot: (asOf: string) => Promise<NotionReviewSnapshot>;
  readonly settings?: Partial<DailyReviewPlan["settings"]>;
}): Promise<SavedReviewPlan> {
  const day = latestReviewDay(input.asOf);
  const existing = input.journal.read<SavedReviewPlan>(day, "plan");
  if (existing) {
    if (existing.target_date !== day || !existing.source_summary) throw new Error("REVIEW_JOURNAL_CORRUPT");
    // The immutable plan owns these derived files, including after an interrupted first write.
    input.journal.writeOnce(day, "manifest", createSetManifest(existing));
    input.journal.writeOnce(day, "source-summary", existing.source_summary);
    return existing;
  }
  const snapshot = await input.readSnapshot(input.asOf);
  const plan = {
    ...generateDailyReviewPlan({as_of: input.asOf, ...reviewSnapshotEvidence(snapshot),
      ...(input.settings ? {settings: input.settings} : {})}),
    plan_id: randomUUID(),
    source_summary: {
      read_started_at: snapshot.readStartedAt, read_completed_at: snapshot.readCompletedAt,
      canonical_attempts: snapshot.attempts.length, unknown_attempt_rows: snapshot.unknownAttemptRows,
      duplicate_attempt_rows: snapshot.duplicateAttemptRows, unknown_question_rows: snapshot.unknownQuestionRows,
      excluded_future_events: snapshot.excludedFutureEvents,
      excluded_from_aggregation_rows: snapshot.excludedFromAggregationRows,
      ...(snapshot.recoveredAttempts === undefined ? {} : { recovered_attempts: snapshot.recoveredAttempts.length }),
      ...(snapshot.duplicateRecoveredRows === undefined ? {} : { duplicate_recovered_rows: snapshot.duplicateRecoveredRows }),
      ...(snapshot.suppressedRecoveredRows === undefined ? {} : { suppressed_recovered_rows: snapshot.suppressedRecoveredRows }),
      ...(snapshot.excludedFutureRecoveries === undefined ? {} : { excluded_future_recoveries: snapshot.excludedFutureRecoveries }),
    },
  };
  input.journal.writeOnce(day, "plan", plan);
  input.journal.writeOnce(day, "manifest", createSetManifest(plan));
  input.journal.writeOnce(day, "source-summary", plan.source_summary);
  return plan;
}

/** A user-requested amendment retains the original evidence and selected prefix. */
function extendedPlan(original: SavedReviewPlan): SavedReviewPlan {
  const addition = selectDailyReviewAdditions(original);
  if (addition.items.length === 0) throw new Error("REVIEW_NO_ADDITIONS");
  return { ...original, algorithm_version: "3", due_before: addition.due_before,
    items: [...original.items, ...addition.items],
    eligible_question_count: original.eligible_question_count + addition.eligible_question_count,
    states: original.states.map((state) => state.exclusion === "not_due"
      && state.prediction.next_review_at !== null && state.prediction.next_review_at < addition.due_before
      ? { ...state, exclusion: null } : state),
  };
}

export function readReviewRevision(day: string, journal: ReviewJournal): SavedReviewRevision | undefined {
  const revision = journal.read<SavedReviewRevision>(day, "revision-1");
  if (!revision) return undefined;
  const original = journal.read<SavedReviewPlan>(day, "plan");
  const set = journal.read<{url: string}>(day, "qb-created");
  if (!original || !set || revision.revision !== 1 || revision.reason !== "include_due_within_day"
    || revision.base_plan_sha256 !== hash(original) || revision.qb_set_url !== set.url
    || !normalizeExactTimestamp(revision.revised_at).ok || latestReviewDay(revision.revised_at) !== day
    || hash(revision.effective_plan) !== hash(extendedPlan(original))) throw new Error("REVIEW_JOURNAL_CORRUPT");
  return revision;
}

export function readEffectiveReviewPlan(day: string, journal: ReviewJournal): SavedReviewPlan | undefined {
  return readReviewRevision(day, journal)?.effective_plan ?? journal.read<SavedReviewPlan>(day, "plan");
}

/** Explicit CLI only. Regular prepare never amends an existing day's plan. */
export function amendReviewDay(day: string, asOf: string, journal: ReviewJournal): SavedReviewRevision {
  if (latestReviewDay(asOf) !== day) throw new Error("REVIEW_AMENDMENT_DAY_MISMATCH");
  const existing = readReviewRevision(day, journal);
  if (existing) {
    journal.writeOnce(day, "manifest-revision-1", createSetManifest(existing.effective_plan));
    return existing;
  }
  const original = journal.read<SavedReviewPlan>(day, "plan");
  const set = journal.read<{url: string}>(day, "qb-created");
  const verified = journal.read<{question_ids: readonly string[]}>(day, "qb-verified");
  const link = journal.read<{url: string}>(day, "notion-set-link-verified");
  if (!original || !set || !verified || !link || set.url !== link.url
    || !journal.read(day, "notion-verified")
    || !verifySetMembership(createSetManifest(original), verified.question_ids).verified) {
    throw new Error("REVIEW_VERIFIED_SET_REQUIRED");
  }
  if (original.due_before !== undefined) throw new Error("REVIEW_AMENDMENT_ALREADY_DAY_WIDE");
  const normalized = normalizeExactTimestamp(asOf);
  if (!normalized.ok) throw new Error("REVIEW_TIME_INVALID");
  const revision: SavedReviewRevision = {revision: 1, revised_at: normalized.value,
    reason: "include_due_within_day", qb_set_url: set.url, base_plan_sha256: hash(original),
    effective_plan: extendedPlan(original)};
  journal.writeOnce(day, "revision-1", revision);
  journal.writeOnce(day, "manifest-revision-1", createSetManifest(revision.effective_plan));
  return revision;
}

export function qbVerificationKey(plan: SavedReviewPlan, journal: ReviewJournal): string {
  const revision = readReviewRevision(plan.target_date, journal);
  if (revision && hash(revision.effective_plan) !== hash(plan)) throw new Error("REVIEW_PLAN_REVISION_MISMATCH");
  return revision ? "qb-verified-revision-1" : "qb-verified";
}

export interface ReviewRevisionPublisher {
  verify(id: string, original: SavedReviewPlan): Promise<boolean>;
  readRevision(id: string, original: SavedReviewPlan): Promise<unknown | undefined>;
  verifyRevision(id: string, original: SavedReviewPlan, revision: SavedReviewRevision): Promise<boolean>;
  appendRevision(id: string, original: SavedReviewPlan, revision: SavedReviewRevision): Promise<void>;
}

/** Reconcile uncertain appends; a missing response never authorizes a second append. */
export async function publishReviewRevision(original: SavedReviewPlan, revision: SavedReviewRevision,
  journal: ReviewJournal, publisher: ReviewRevisionPublisher): Promise<void> {
  const day = original.target_date;
  const saved = readReviewRevision(day, journal);
  const page = journal.read<{id: string}>(day, "notion-verified");
  const qb = journal.read<{question_ids: readonly string[]}>(day, "qb-verified-revision-1");
  if (!saved || hash(saved) !== hash(revision) || !page || !qb
    || !verifySetMembership(createSetManifest(revision.effective_plan), qb.question_ids).verified) {
    throw new Error("REVIEW_VERIFIED_SET_REQUIRED");
  }
  if (!await publisher.verify(page.id, original)) throw new Error("REVIEW_NOTION_CHANGED");
  const existing = await publisher.readRevision(page.id, original);
  if (existing === undefined) {
    if (journal.read(day, "notion-revision-1-verified")) throw new Error("REVIEW_NOTION_REVISION_CHANGED");
    let attempt = 1;
    while (journal.read(day, `notion-revision-1-intent-${attempt}`)) {
      const rejection = journal.read<{retry_at_ms: number}>(day, `notion-revision-1-rejected-${attempt}`);
      if (!rejection) throw new Error("REVIEW_NOTION_REVISION_UNRESOLVED");
      if (!Number.isSafeInteger(rejection.retry_at_ms) || rejection.retry_at_ms < 0) throw new Error("REVIEW_JOURNAL_CORRUPT");
      if (Date.now() < rejection.retry_at_ms) throw new Error("REVIEW_NOTION_RETRY_NOT_DUE");
      if (++attempt > 10_000) throw new Error("REVIEW_NOTION_RETRY_LIMIT");
    }
    journal.writeOnce(day, `notion-revision-1-intent-${attempt}`, {page_id: page.id, revision_sha256: hash(revision)});
    try { await publisher.appendRevision(page.id, original, revision); }
    catch (error) {
      if (error instanceof NotionSyncError && error.retryable && !error.ambiguous) {
        const delay = error.retryAfterMs ?? 30_000;
        if (Number.isSafeInteger(delay) && delay >= 0 && Number.isSafeInteger(Date.now() + delay)) {
          journal.writeOnce(day, `notion-revision-1-rejected-${attempt}`, {retry_at_ms: Date.now() + delay});
        }
      }
      throw error;
    }
  }
  if (!await publisher.verifyRevision(page.id, original, revision)) throw new Error("REVIEW_NOTION_REVISION_VERIFY_FAILED");
  journal.writeOnce(day, "notion-revision-1-verified", {page_id: page.id, revision_sha256: hash(revision),
    question_ids: revision.effective_plan.items.map((item) => item.question_key), url: revision.qb_set_url});
}

interface NotionCreateRejection {
  readonly plan_id: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly retry_at_ms: number;
}

function nextNotionCreateAttempt(plan: SavedReviewPlan, journal: ReviewJournal): number {
  // Legacy intents do not record definite rejection evidence. Keep them fail-closed.
  if (journal.read(plan.target_date, "notion-intent")) throw new Error("REVIEW_NOTION_CREATE_UNRESOLVED");
  for (let attempt = 1; attempt <= 10_000; attempt++) {
    const intent = journal.read<{plan_id: string}>(plan.target_date, `notion-create-attempt-${attempt}`);
    if (intent === undefined) return attempt;
    if (intent.plan_id !== plan.plan_id) throw new Error("REVIEW_JOURNAL_CONFLICT");
    const rejection = journal.read<NotionCreateRejection>(plan.target_date, `notion-create-rejected-${attempt}`);
    if (rejection === undefined) throw new Error("REVIEW_NOTION_CREATE_UNRESOLVED");
    if (rejection.plan_id !== plan.plan_id || typeof rejection.retryable !== "boolean"
      || !/^NOTION_[A-Z_]+$/u.test(rejection.code) || !Number.isSafeInteger(rejection.retry_at_ms)
      || rejection.retry_at_ms < 0) throw new Error("REVIEW_JOURNAL_CORRUPT");
    if (!rejection.retryable) throw new Error("REVIEW_NOTION_CREATE_REJECTED");
    if (Date.now() < rejection.retry_at_ms) throw new Error("REVIEW_NOTION_RETRY_NOT_DUE");
  }
  throw new Error("REVIEW_NOTION_RETRY_LIMIT");
}

/** Caller holds journal.exclusive. An uncertain create allows reconciliation only. */
export async function publishReview(plan: SavedReviewPlan, journal: ReviewJournal, publisher: ReviewPublisher): Promise<string> {
  const day = plan.target_date;
  const verified = journal.read<{id: string}>(day, "notion-verified");
  if (verified) {
    if (!await publisher.verify(verified.id, plan)) throw new Error("REVIEW_NOTION_CHANGED");
    return verified.id;
  }
  const found = await publisher.find(plan);
  if (found.length > 1) throw new Error("REVIEW_NOTION_DUPLICATES");
  const created = journal.read<{id: string}>(day, "notion-created");
  if (created && found[0] && created.id !== found[0].id) throw new Error("REVIEW_NOTION_DUPLICATES");
  let pageId = found[0]?.id ?? created?.id;
  if (!pageId) {
    const attempt = nextNotionCreateAttempt(plan, journal);
    journal.writeOnce(day, `notion-create-attempt-${attempt}`, {plan_id: plan.plan_id});
    try {
      pageId = (await publisher.create(plan)).id;
      journal.writeOnce(day, "notion-created", {id: pageId});
    } catch (error) {
      if (error instanceof NotionSyncError && error.committedResourceId !== undefined) {
        journal.writeOnce(day, "notion-created", {id: error.committedResourceId});
      } else if (error instanceof NotionSyncError && !error.ambiguous) {
        const retryDelay = error.retryAfterMs ?? 0;
        // Persist only a validated definite refusal. An invalid delay retains unresolved intent.
        if (Number.isSafeInteger(retryDelay) && retryDelay >= 0 && Number.isSafeInteger(Date.now() + retryDelay)) {
          journal.writeOnce(day, `notion-create-rejected-${attempt}`, {
            plan_id: plan.plan_id, code: error.code, retryable: error.retryable,
            retry_at_ms: Date.now() + retryDelay,
          } satisfies NotionCreateRejection);
        }
      }
      throw error;
    }
  }
  if (!await publisher.verify(pageId, plan)) throw new Error("REVIEW_NOTION_VERIFY_FAILED");
  journal.writeOnce(day, "notion-verified", {id: pageId});
  return pageId;
}

export function beginQbSet(plan: SavedReviewPlan, journal: ReviewJournal): {manifest: SetManifest; may_create: boolean; existing: unknown} {
  const manifest = createSetManifest(plan);
  const existing = journal.read(plan.target_date, "qb-created");
  const hadIntent = journal.read(plan.target_date, "qb-intent") !== undefined;
  journal.writeOnce(plan.target_date, "qb-intent", {name: manifest.name, plan_id: plan.plan_id});
  return {manifest, may_create: !hadIntent && !existing && manifest.question_ids.length > 0, existing};
}
export function recordQbSet(plan: SavedReviewPlan, journal: ReviewJournal, url: string): void {
  const parsed = new URL(url);
  const id = parsed.searchParams.get("questionSetId");
  if (parsed.origin !== "https://qb.medilink-study.com" || parsed.pathname !== "/search"
    || !id || !/^[A-Za-z0-9_-]{1,100}$/u.test(id)
    || [...parsed.searchParams.keys()].some((key) => key !== "questionSetId" && key !== "operation")
    || parsed.username || parsed.password || parsed.hash) throw new Error("REVIEW_QB_URL_INVALID");
  if (!journal.read(plan.target_date, "qb-intent")) throw new Error("REVIEW_QB_INTENT_REQUIRED");
  journal.writeOnce(plan.target_date, "qb-created", {set_id: id,
    url: "https://qb.medilink-study.com/search?questionSetId=" + id + "&operation=OR"});
}
export function finishQbSet(plan: SavedReviewPlan, journal: ReviewJournal, ids: readonly string[]): void {
  if (!journal.read(plan.target_date, "qb-created")) throw new Error("REVIEW_QB_SET_REQUIRED");
  const result = verifySetMembership(createSetManifest(plan), ids);
  if (!result.verified) throw new Error("REVIEW_QB_MEMBERSHIP_MISMATCH");
  journal.writeOnce(plan.target_date, qbVerificationKey(plan, journal), {question_ids: ids, order: "added_oldest_first"});
}

/** Purpose is explicit; matching a question alone never turns normal study into review. */
export function reviewProgress(plan: SavedReviewPlan, attempts: readonly AttemptEventV1[], contexts: readonly StudyContextV1[], asOf: string) {
  const normalize = (value: string): string => {
    const normalized = normalizeExactTimestamp(value);
    if (!normalized.ok) throw new Error("REVIEW_TIME_INVALID");
    return normalized.value;
  };
  const at = Date.parse(normalize(asOf));
  const start = Date.parse(normalize(plan.selection_at));
  const end = Date.parse(normalize(plan.scheduled_at)) + 24 * 3_600_000;
  const byEvent = new Map<string, StudyContextV1>();
  for (const context of contexts) {
    if (!validateStudyContextV1(context)) throw new Error("REVIEW_CONTEXT_INVALID");
    const normalized = {...context, event_id: context.event_id.toLowerCase(),
      ...(context.review_plan_id === undefined ? {} : {review_plan_id: context.review_plan_id.toLowerCase()})};
    const existing = byEvent.get(normalized.event_id);
    if (existing && canonicalStudyContext(existing) !== canonicalStudyContext(normalized)) throw new Error("REVIEW_CONTEXT_CONFLICT");
    byEvent.set(normalized.event_id, normalized);
  }
  const unique = new Map<string, {event: AttemptEventV1; canonical: string}>();
  for (const event of attempts) {
    let serialized: string;
    try { serialized = canonicalAttempt({...event, event_id: event.event_id.toLowerCase()}); }
    catch { throw new Error("REVIEW_ATTEMPT_INVALID"); }
    const normalized = JSON.parse(serialized) as AttemptEventV1;
    const existing = unique.get(normalized.event_id);
    if (existing && existing.canonical !== serialized) throw new Error("REVIEW_EVENT_CONFLICT");
    unique.set(normalized.event_id, {event: normalized, canonical: serialized});
  }
  const keys = new Set(plan.items.map((item) => item.question_key));
  const review = [...unique.values()].map(({event}) => event).filter((attempt) => {
    const context = byEvent.get(attempt.event_id);
    const answeredAt = Date.parse(attempt.answered_at);
    return keys.has(attempt.question_key) && answeredAt >= start && answeredAt <= at && answeredAt < end
      && Date.parse(attempt.provenance.recorded_at) <= at
      && context?.study_mode === "review"
      && (context.review_plan_id === undefined || context.review_plan_id === plan.plan_id.toLowerCase());
  });
  const actual = new Set(review.map((attempt) => attempt.question_key));
  return {
    review_attempts: review.length, attempted_questions: actual.size,
    attempted_positions: plan.items.filter((item) => actual.has(item.question_key)).map((item) => item.position),
    remaining_question_ids: plan.items.filter((item) => !actual.has(item.question_key)).map((item) => item.question_key),
    incorrect_attempts: review.filter((attempt) => attempt.result === "incorrect").length,
  };
}
