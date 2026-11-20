import { randomUUID } from "node:crypto";

import type { AttemptEventV1 } from "@qb-study/contracts";
import type { NotionSyncState, NotionSyncStorage } from "@qb-study/storage/notion-sync";

import {
  matchesAttempt, matchesQuestion, NotionSyncError, readCanonicalAttempt, readStudyContext, canonicalStudyContext,
  type NotionClient, type NotionPage,
} from "./notion-client.js";

export type NotionSyncClient = Pick<NotionClient,
  "validateSchema" | "findQuestion" | "findAttempt" | "findAttemptsForQuestion"
  | "createQuestion" | "createAttempt" | "getPage" | "linkAttempt" | "backfillStudyContext">;

export interface NotionSyncReport {
  readonly checked: number;
  readonly confirmed: number;
  readonly pending: number;
  readonly blocked: number;
  readonly repaired: number;
  readonly code?: string;
}

export interface NotionSyncWorkerOptions {
  readonly storage: NotionSyncStorage;
  readonly client: NotionSyncClient;
  readonly target: string;
  readonly now?: () => number;
  readonly batchSize?: number;
}

const LEASE_MS = 120_000;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const normalizeId = (id: string): string => id.replaceAll("-", "").toLowerCase();

/** A local delivery worker. Notion is the common original; SQLite is the durable outbox. */
export class NotionSyncWorker {
  readonly #storage: NotionSyncStorage;
  readonly #client: NotionSyncClient;
  readonly #target: string;
  readonly #owner = randomUUID();
  readonly #now: () => number;
  readonly #batchSize: number;
  #running = false;
  #cooldownUntil = 0;
  #auditOffset = 0;
  #pendingOffset = 0;
  #failures = 0;
  #repaired = 0;

  public constructor(options: NotionSyncWorkerOptions) {
    this.#storage = options.storage;
    this.#client = options.client;
    this.#target = options.target;
    this.#now = options.now ?? Date.now;
    this.#batchSize = options.batchSize ?? 10;
    if (!Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 100) {
      throw new Error("NOTION_BATCH_INVALID");
    }
  }

  public async runOnce(): Promise<NotionSyncReport> {
    const empty = { checked: 0, confirmed: 0, pending: 0, blocked: 0, repaired: 0 };
    if (this.#running || this.#now() < this.#cooldownUntil) return empty;
    if (!this.#storage.acquireLease(this.#target, this.#owner, this.#now(), LEASE_MS)) {
      return { ...empty, code: "NOTION_WORKER_BUSY" };
    }
    this.#running = true;
    this.#repaired = 0;
    let checked = 0;
    let confirmed = 0;
    let code: string | undefined;
    try {
      // Fail closed if names/types/options or the relation's destination changed.
      await this.#client.validateSchema();
      this.#renew();
      const attempts = this.#storage.listAttemptsForTarget(this.#target);
      const isConfirmed = (event: AttemptEventV1): boolean =>
        this.#state("attempt", event.event_id)?.status === "confirmed"
        && this.#state("question", event.question_key)?.status === "confirmed";
      const pending = attempts.filter((event) => !isConfirmed(event));
      const delivered = attempts.filter(isConfirmed);
      // Rotate both queues: a blocked early record must not starve later answers.
      const selected = [
        ...this.#rotate(pending, this.#pendingOffset, this.#batchSize).map((event) => ({ event, audit: false })),
        ...this.#rotate(delivered, this.#auditOffset, 2).map((event) => ({ event, audit: true })),
      ];
      for (const { event, audit } of selected) {
        this.#renew();
        try {
          const question = await this.#question(event);
          if (question !== undefined && await this.#attempt(event, question)) confirmed++;
        } catch (error) {
          code = this.#errorCode(error);
          this.#backoff(error);
          break;
        } finally {
          checked++;
          // Advance only what was visited; one failing batch head must not hide the rest.
          if (audit) this.#auditOffset++;
          else this.#pendingOffset++;
        }
      }
      if (code === undefined) this.#failures = 0;
      return {
        checked, confirmed, repaired: this.#repaired,
        pending: attempts.filter((event) => !isConfirmed(event)).length,
        blocked: attempts.filter((event) => {
          const state = this.#state("attempt", event.event_id);
          const question = this.#state("question", event.question_key);
          return state?.status === "blocked" || state?.status === "creating"
            || question?.status === "blocked" || question?.status === "creating";
        }).length,
        ...(code === undefined ? {} : { code }),
      };
    } catch (error) {
      this.#backoff(error);
      return { ...empty, code: this.#errorCode(error) };
    } finally {
      this.#storage.releaseLease(this.#target, this.#owner);
      this.#running = false;
    }
  }

  #rotate(events: readonly AttemptEventV1[], offset: number, count: number): AttemptEventV1[] {
    if (events.length === 0) return [];
    return Array.from({ length: Math.min(count, events.length) }, (_, i) => events[(offset + i) % events.length]!);
  }

  #state(kind: "question" | "attempt", key: string): NotionSyncState | undefined {
    return this.#storage.getState(this.#target, kind, key);
  }

  #save(state: Omit<NotionSyncState, "target">): void {
    this.#renew();
    const next = { ...state, target: this.#target };
    const previous = this.#state(state.kind, state.key);
    if (previous?.status !== next.status || previous.pageId !== next.pageId
      || previous.code !== next.code || previous.retryAt !== next.retryAt) {
      this.#storage.appendState(next);
    }
  }

  #renew(): void {
    if (!this.#storage.acquireLease(this.#target, this.#owner, this.#now(), LEASE_MS)) {
      throw new Error("NOTION_LEASE_LOST");
    }
  }

  #errorCode(error: unknown): string {
    return error instanceof Error && SAFE_CODE.test(error.message)
      ? error.message : "NOTION_SYNC_UNAVAILABLE";
  }

  #backoff(error: unknown): void {
    this.#failures++;
    const delay = Math.min(300_000, 5_000 * 2 ** Math.min(this.#failures, 6));
    const specified = error instanceof NotionSyncError ? error.retryAfterMs ?? 0 : 0;
    this.#cooldownUntil = this.#now() + Math.max(delay, specified);
  }

  #canCreate(kind: "question" | "attempt", key: string): boolean {
    this.#renew();
    const current = this.#state(kind, key);
    if (current === undefined) return true;
    if (current.status === "retry") return (current.retryAt ?? 0) <= this.#now();
    // Confirmed then missing may mean a user deleted/archived it. Never resurrect it.
    if (current.status === "confirmed") {
      this.#save({ kind, key, status: "blocked", pageId: current.pageId!, code: "NOTION_REMOTE_MISSING" });
    }
    // Creating includes a crash between journaling intent and actually sending.
    // A negative query cannot establish whether the write was committed.
    return false;
  }

  async #create(kind: "question" | "attempt", key: string, create: () => Promise<NotionPage>): Promise<NotionPage | undefined> {
    if (!this.#canCreate(kind, key)) return undefined;
    if (!this.#storage.beginCreate(this.#target, kind, key, this.#owner, this.#now())) return undefined;
    try {
      const page = await create();
      this.#renew();
      // Keep the intent until an independent read confirms the saved properties.
      this.#save({ kind, key, status: "creating", pageId: page.id, code: "NOTION_CREATE_UNCONFIRMED" });
      return await this.#client.getPage(page.id);
    } catch (error) {
      // A failed read-after-create must NOT discard the existing create intent.
      const current = this.#state(kind, key);
      if (current?.pageId === undefined && error instanceof NotionSyncError && error.committedResourceId !== undefined) {
        this.#save({ kind, key, status: "creating", pageId: error.committedResourceId, code: "NOTION_CREATE_UNCONFIRMED" });
      }
      if (current?.pageId === undefined && error instanceof NotionSyncError && !error.ambiguous) {
        this.#save({ kind, key, status: error.retryable ? "retry" : "blocked", code: error.code,
          ...(error.retryable ? { retryAt: this.#now() + Math.max(5_000, error.retryAfterMs ?? 0) } : {}) });
      }
      throw error;
    }
  }

  async #question(event: AttemptEventV1): Promise<NotionPage | undefined> {
    let pages = await this.#client.findQuestion(event.question_key);
    this.#renew();
    if (pages.length === 0) {
      const previous = this.#state("question", event.question_key);
      const known = await this.#knownPage("question", event.question_key, previous);
      if (known !== undefined && matchesQuestion(known, event.question_key)) pages = [known];
      else {
        if (known !== undefined) {
          this.#save({ kind: "question", key: event.question_key, status: "blocked", pageId: known.id, code: "NOTION_QUESTION_CONFLICT" });
          return undefined;
        }
        const created = await this.#create("question", event.question_key, () => this.#client.createQuestion(event));
        if (created === undefined) return undefined;
        pages = [created];
      }
    }
    if (pages.some((page) => !matchesQuestion(page, event.question_key))) {
      this.#save({ kind: "question", key: event.question_key, status: "blocked", code: "NOTION_QUESTION_CONFLICT" });
      return undefined;
    }
    const canonical = [...pages].sort((a, b) => normalizeId(a.id).localeCompare(normalizeId(b.id)))[0]!;
    this.#save({ kind: "question", key: event.question_key, status: "confirmed", pageId: canonical.id });
    if (pages.length > 1) await this.#repairQuestionLinks(event.question_key, canonical.id);
    return canonical;
  }

  async #attempt(event: AttemptEventV1, question: NotionPage): Promise<boolean> {
    const context = this.#storage.getStudyContext(event.event_id);
    let pages = await this.#client.findAttempt(event.event_id);
    this.#renew();
    if (pages.length > 1) {
      this.#save({ kind: "attempt", key: event.event_id, status: "blocked", code: "NOTION_DUPLICATE_EVENT" });
      return false;
    }
    if (pages.length === 0) {
      const previous = this.#state("attempt", event.event_id);
      const known = await this.#knownPage("attempt", event.event_id, previous);
      if (known !== undefined) pages = [known];
      else {
        const created = await this.#create("attempt", event.event_id, () => this.#client.createAttempt(event, question.id, context));
        if (created === undefined) return false;
        pages = [created];
      }
    }
    const page = pages[0]!;
    if (!matchesAttempt(page, event)) {
      this.#save({ kind: "attempt", key: event.event_id, status: "blocked", pageId: page.id, code: "NOTION_EVENT_CONFLICT" });
      return false;
    }
    if (context !== undefined) {
      try {
        const stored = readStudyContext(page);
        if (stored !== undefined && canonicalStudyContext(stored) !== canonicalStudyContext(context)) {
          throw new NotionSyncError("NOTION_STUDY_CONTEXT_CONFLICT");
        }
        if (stored === undefined) await this.#client.backfillStudyContext(page.id, event, context);
      } catch (error) {
        if (error instanceof NotionSyncError && error.code === "NOTION_STUDY_CONTEXT_CONFLICT") {
          this.#save({ kind: "attempt", key: event.event_id, status: "blocked", pageId: page.id, code: error.code });
          return false;
        }
        throw error;
      }
    }
    if (!matchesAttempt(page, event, question.id)) {
      this.#renew();
      await this.#client.linkAttempt(page.id, question.id);
      const saved = await this.#client.getPage(page.id);
      if (!matchesAttempt(saved, event, question.id)) throw new Error("NOTION_LINK_UNCONFIRMED");
      this.#repaired++;
    }
    this.#save({ kind: "attempt", key: event.event_id, status: "confirmed", pageId: page.id });
    return true;
  }

  async #knownPage(kind: "question" | "attempt", key: string, previous: NotionSyncState | undefined): Promise<NotionPage | undefined> {
    if (previous?.pageId === undefined) return undefined;
    try {
      return await this.#client.getPage(previous.pageId);
    } catch (error) {
      if (error instanceof NotionSyncError && error.code === "NOTION_NOT_FOUND") {
        this.#save({ kind, key, status: "blocked", pageId: previous.pageId, code: "NOTION_REMOTE_MISSING" });
        return undefined;
      }
      throw error;
    }
  }

  async #repairQuestionLinks(key: string, canonicalId: string): Promise<void> {
    const pages = await this.#client.findAttemptsForQuestion(key);
    const counts = new Map<string, number>();
    for (const page of pages) {
      const event = readCanonicalAttempt(page);
      if (event !== undefined) counts.set(event.event_id, (counts.get(event.event_id) ?? 0) + 1);
    }
    for (const page of pages) {
      const event = readCanonicalAttempt(page);
      // Only verified machine records qualify; user notes and master rows are untouched.
      if (event === undefined || event.question_key !== key || counts.get(event.event_id) !== 1
        || !matchesAttempt(page, event) || matchesAttempt(page, event, canonicalId)) continue;
      this.#renew();
      await this.#client.linkAttempt(page.id, canonicalId);
      const saved = await this.#client.getPage(page.id);
      if (!matchesAttempt(saved, event, canonicalId)) throw new Error("NOTION_LINK_UNCONFIRMED");
      this.#repaired++;
    }
  }
}
