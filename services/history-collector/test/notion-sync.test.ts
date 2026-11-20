import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AttemptEventV1, StudyContextV1 } from "@qb-study/contracts";
import { openSqliteHistoryCollectorStorage } from "@qb-study/storage/history-collector";
import { openSqliteNotionSyncStorage, type NotionSyncStorage } from "@qb-study/storage/notion-sync";
import { afterEach, describe, expect, it } from "vitest";
import {
  attemptProperties, matchesAttempt, NotionSyncError, questionProperties,
  readCanonicalAttempt, relationPageIds, type NotionPage,
  canonicalStudyContext, readStudyContext,
} from "../src/notion-client.js";
import { NotionSyncWorker, type NotionSyncClient } from "../src/notion-sync.js";

const TARGET = "notion:test-attempts:test-questions";
const QUESTIONS_SOURCE = "30000000-0000-4000-8000-000000000001";
const ATTEMPTS_SOURCE = "30000000-0000-4000-8000-000000000002";
const FIRST_EVENT = "10000000-0000-4000-8000-000000000001";
const SECOND_EVENT = "10000000-0000-4000-8000-000000000002";
const directories: string[] = [];
const opened: { close(): void }[] = [];

function attempt(overrides: Partial<AttemptEventV1> = {}): AttemptEventV1 {
  return {
    schema_version: "1", record_type: "attempt_event", event_id: FIRST_EVENT,
    question_key: "119A12", answered_at: "2026-10-14T03:00:00.000Z",
    result: "correct", selected_option_indices: [2],
    provenance: {
      producer: "browser-extension", producer_version: "0.1.0",
      source_system: "qb-web-dom", recorded_at: "2026-10-14T03:00:01.000Z",
    },
    quality: {
      acquisition_method: "direct_capture", temporal_precision: "exact", state_precision: "exact",
    },
    ...overrides,
  };
}

// Response type tags/nulls differ from create request properties; retain the real strict matchers.
function responseProperties(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([name, value]) => {
    const field = value as Record<string, unknown>;
    const type = Object.keys(field)[0]!;
    return [name, {
      ...field, type,
      ...(type === "date" ? { date: { ...(field.date as object), end: null, time_zone: null } } : {}),
      ...(type === "relation" ? { has_more: false } : {}),
    }];
  }));
}

function textProperty(page: NotionPage, name: string): string {
  const field = page.properties[name] as { rich_text: { text: { content: string } }[] } | undefined;
  return field?.rich_text.map((item) => item.text.content).join("") ?? "";
}

type CreateFailure = "ambiguous-empty" | "ambiguous-committed" | "rate-limit";

class SharedNotion implements NotionSyncClient {
  readonly pages = new Map<string, NotionPage>();
  readonly attemptCreates: string[] = [];
  readonly questionCreates: string[] = [];
  readonly linkUpdates: { pageId: string; questionId: string }[] = [];
  readonly failures = new Map<string, CreateFailure>();
  readonly questionQueryFailures = new Set<string>();
  readonly questionIds = [
    "90000000-0000-4000-8000-000000000001",
    "80000000-0000-4000-8000-000000000001",
  ];
  beforeAttemptCreate: ((event: AttemptEventV1) => void) | undefined;
  floorDateProjections = false;
  #sequence = 0;

  validateSchema(): Promise<void> { return Promise.resolve(); }
  findQuestion(key: string): Promise<readonly NotionPage[]> {
    if (this.questionQueryFailures.has(key)) {
      return Promise.reject(new NotionSyncError("NOTION_SERVICE_UNAVAILABLE", { retryable: true }));
    }
    return Promise.resolve(this.#find(QUESTIONS_SOURCE, "問題キー", key));
  }
  findAttempt(id: string): Promise<readonly NotionPage[]> {
    return Promise.resolve(this.#find(ATTEMPTS_SOURCE, "イベントID", id));
  }
  findAttemptsForQuestion(key: string): Promise<readonly NotionPage[]> {
    return Promise.resolve(this.#find(ATTEMPTS_SOURCE, "問題キー", key));
  }
  createQuestion(event: AttemptEventV1): Promise<NotionPage> {
    this.questionCreates.push(event.question_key);
    return Promise.resolve(this.addQuestion(event));
  }
  createAttempt(event: AttemptEventV1, questionId: string): Promise<NotionPage> {
    this.beforeAttemptCreate?.(event);
    this.attemptCreates.push(event.event_id);
    const failure = this.failures.get(event.event_id);
    this.failures.delete(event.event_id);
    if (failure === "rate-limit") {
      return Promise.reject(new NotionSyncError("NOTION_RATE_LIMITED", {
        retryable: true, retryAfterMs: 20_000,
      }));
    }
    if (failure === "ambiguous-empty") {
      return Promise.reject(new NotionSyncError("NOTION_NETWORK_ERROR", { retryable: true, ambiguous: true }));
    }
    const page = this.addAttempt(event, questionId);
    if (failure === "ambiguous-committed") {
      return Promise.reject(new NotionSyncError("NOTION_NETWORK_ERROR", { retryable: true, ambiguous: true }));
    }
    return Promise.resolve(page);
  }
  getPage(id: string): Promise<NotionPage> {
    const page = this.pages.get(id);
    return page === undefined ? Promise.reject(new NotionSyncError("NOTION_NOT_FOUND"))
      : Promise.resolve(structuredClone(page));
  }
  linkAttempt(pageId: string, questionId: string): Promise<void> {
    this.linkUpdates.push({ pageId, questionId });
    this.changeProperties(pageId, { "問題": { type: "relation", relation: [{ id: questionId }], has_more: false } });
    return Promise.resolve();
  }
  backfillStudyContext(pageId: string, _event: AttemptEventV1, context: StudyContextV1): Promise<void> {
    void _event;
    this.changeProperties(pageId, { "学習目的データV1": { type: "rich_text", rich_text: [
      { type: "text", text: { content: canonicalStudyContext(context) } },
    ] } });
    return Promise.resolve();
  }
  addQuestion(event: AttemptEventV1): NotionPage {
    return this.#add(QUESTIONS_SOURCE, questionProperties(event), this.questionIds.shift());
  }
  addAttempt(event: AttemptEventV1, questionId: string): NotionPage {
    const properties = attemptProperties(event, questionId);
    const minute = (value: string): string => new Date(Math.floor(Date.parse(value) / 60_000) * 60_000).toISOString();
    return this.#add(ATTEMPTS_SOURCE, this.floorDateProjections ? {
      ...properties,
      "解答日時": { date: { start: minute(event.answered_at) } },
      "取得日時": { date: { start: minute(event.provenance.recorded_at) } },
    } : properties);
  }
  changeProperties(id: string, changes: Readonly<Record<string, unknown>>): void {
    const page = this.pages.get(id);
    if (page === undefined) throw new Error("FAKE_PAGE_MISSING");
    this.pages.set(id, { ...page, properties: { ...page.properties, ...structuredClone(changes) } });
  }
  get attempts(): readonly NotionPage[] {
    return [...this.pages.values()].filter((page) => page.parent.data_source_id === ATTEMPTS_SOURCE);
  }
  get questions(): readonly NotionPage[] {
    return [...this.pages.values()].filter((page) => page.parent.data_source_id === QUESTIONS_SOURCE);
  }
  #find(source: string, property: string, value: string): readonly NotionPage[] {
    return [...this.pages.values()].filter((page) => page.parent.data_source_id === source
      && !page.archived && !page.in_trash && textProperty(page, property) === value).map((page) => structuredClone(page));
  }
  #add(source: string, properties: Readonly<Record<string, unknown>>, id?: string): NotionPage {
    this.#sequence++;
    const page: NotionPage = {
      object: "page", id: id ?? `40000000-0000-4000-8000-${String(this.#sequence).padStart(12, "0")}`,
      parent: { type: "data_source_id", data_source_id: source },
      archived: false, in_trash: false, properties: responseProperties(properties),
    };
    this.pages.set(page.id, page);
    return structuredClone(page);
  }
}

function mac(events: readonly AttemptEventV1[]) {
  const directory = mkdtempSync(join(tmpdir(), "qb-notion-worker-"));
  directories.push(directory);
  const databasePath = join(directory, "history.sqlite");
  const history = openSqliteHistoryCollectorStorage({ databasePath });
  opened.push(history);
  for (const event of events) history.appendAttempt(event);
  const reopen = (): NotionSyncStorage => {
    const storage = openSqliteNotionSyncStorage({ databasePath });
    storage.activateTarget(TARGET, true);
    opened.push(storage);
    return storage;
  };
  return { history, storage: reopen(), reopen, databasePath };
}

function attemptJournal(databasePath: string, eventId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT * FROM notion_sync_journal
      WHERE target = ? AND resource_kind = 'attempt' AND resource_key = ?
      ORDER BY sequence
    `).all(TARGET, eventId);
  } finally {
    database.close();
  }
}

function worker(storage: NotionSyncStorage, client: NotionSyncClient, options: {
  now?: () => number; batchSize?: number;
} = {}): NotionSyncWorker {
  return new NotionSyncWorker({ storage, client, target: TARGET, ...options });
}

afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Notion common original synchronization", () => {
  it("reads persisted purpose and adds it without changing the answer or an existing display label", async () => {
    const event = attempt();
    const context: StudyContextV1 = { schema_version: "1", record_type: "study_context", event_id: event.event_id, study_mode: "normal" };
    const local = mac([]);
    local.history.appendStudyAttempt({ attempt: event, context });
    expect(local.storage.getStudyContext(event.event_id)).toEqual(context);
    const notion = new SharedNotion();
    const question = notion.addQuestion(event);
    const page = notion.addAttempt(event, question.id);
    notion.changeProperties(page.id, { "学習種別": { type: "select", select: { name: "新規" } } });
    expect(await worker(local.storage, notion).runOnce()).toMatchObject({ confirmed: 1, blocked: 0 });
    const saved = notion.attempts[0]!;
    expect(readStudyContext(saved)).toEqual(context);
    expect(readCanonicalAttempt(saved)).toEqual(event);
    expect(saved.properties["学習種別"]).toEqual({ type: "select", select: { name: "新規" } });
    expect(notion.attemptCreates).toEqual([]);
  });

  it("blocks conflicting machine purpose without overwriting shared evidence", async () => {
    const event = attempt();
    const local = mac([]);
    local.history.appendStudyAttempt({ attempt: event, context: {
      schema_version: "1", record_type: "study_context", event_id: event.event_id, study_mode: "normal",
    } });
    const notion = new SharedNotion();
    const question = notion.addQuestion(event);
    const page = notion.addAttempt(event, question.id);
    const remoteContext: StudyContextV1 = {
      schema_version: "1", record_type: "study_context", event_id: event.event_id, study_mode: "unclassified",
    };
    notion.changeProperties(page.id, responseProperties({ "学習目的データV1": {
      rich_text: [{ type: "text", text: { content: canonicalStudyContext(remoteContext) } }],
    } }));
    expect(await worker(local.storage, notion).runOnce()).toMatchObject({ blocked: 1 });
    expect(local.storage.getState(TARGET, "attempt", event.event_id)).toMatchObject({ code: "NOTION_STUDY_CONTEXT_CONFLICT" });
    expect(readStudyContext(notion.attempts[0]!)).toEqual(remoteContext);
    expect(notion.attemptCreates).toEqual([]);
  });

  it("keeps both Macs' answers even when question, time and selection are identical", async () => {
    const first = attempt();
    const second = attempt({ event_id: SECOND_EVENT });
    const macA = mac([first]);
    const macB = mac([second]);
    const notion = new SharedNotion();
    expect((await worker(macA.storage, notion).runOnce()).confirmed).toBe(1);
    expect((await worker(macB.storage, notion).runOnce()).confirmed).toBe(1);
    expect(notion.questions).toHaveLength(1);
    expect(notion.attempts).toHaveLength(2);
    expect(notion.attempts.map(readCanonicalAttempt)).toEqual([first, second]);
    expect(macA.storage.getState(TARGET, "attempt", FIRST_EVENT)?.status).toBe("confirmed");
    expect(macB.storage.getState(TARGET, "attempt", SECOND_EVENT)?.status).toBe("confirmed");
  });

  it("confirms minute-truncated Notion date projections while retaining exact canonical timestamps", async () => {
    const event = attempt({
      answered_at: "2026-10-14T03:00:53.663Z",
      provenance: { ...attempt().provenance, recorded_at: "2026-10-14T03:01:02.147Z" },
    });
    const local = mac([event]);
    const notion = new SharedNotion();
    notion.floorDateProjections = true;
    const sync = worker(local.storage, notion);
    expect(await sync.runOnce()).toMatchObject({ confirmed: 1, pending: 0, blocked: 0 });
    const page = notion.attempts[0]!;
    expect(page.properties["解答日時"]).toMatchObject({ date: { start: "2026-10-14T03:00:00.000Z" } });
    expect(page.properties["取得日時"]).toMatchObject({ date: { start: "2026-10-14T03:01:00.000Z" } });
    expect(readCanonicalAttempt(page)).toEqual(event);
    expect(local.storage.listAttemptsForTarget(TARGET)).toEqual([event]);
    expect(await sync.runOnce()).toMatchObject({ confirmed: 1, pending: 0, blocked: 0 });
    expect(notion.attempts).toHaveLength(1);
    expect(notion.attemptCreates).toEqual([FIRST_EVENT]);
    expect(notion.linkUpdates).toEqual([]);
  });

  it("recovers a persisted conflict against a minute-truncated page by appending a confirmation after restart", async () => {
    const event = attempt({
      answered_at: "2026-10-14T03:00:53.663Z",
      provenance: { ...attempt().provenance, recorded_at: "2026-10-14T03:01:02.147Z" },
    });
    const local = mac([event]);
    const notion = new SharedNotion();
    notion.floorDateProjections = true;
    const question = notion.addQuestion(event);
    const page = notion.addAttempt(event, question.id);
    // Reproduce the persisted journal produced by the earlier exact-projection matcher.
    local.storage.appendState({ target: TARGET, kind: "question", key: event.question_key,
      status: "confirmed", pageId: question.id });
    local.storage.appendState({ target: TARGET, kind: "attempt", key: event.event_id,
      status: "creating", pageId: page.id, code: "NOTION_CREATE_UNCONFIRMED" });
    local.storage.appendState({ target: TARGET, kind: "attempt", key: event.event_id,
      status: "blocked", pageId: page.id, code: "NOTION_EVENT_CONFLICT" });
    const journalBefore = attemptJournal(local.databasePath, event.event_id);
    expect(journalBefore.map((entry) => entry.status)).toEqual(["creating", "blocked"]);
    local.storage.close();
    const reopened = local.reopen();
    expect(reopened.getState(TARGET, "attempt", event.event_id)).toMatchObject({
      status: "blocked", pageId: page.id, code: "NOTION_EVENT_CONFLICT",
    });
    const resumed = worker(reopened, notion);
    expect(await resumed.runOnce()).toMatchObject({ confirmed: 1, pending: 0, blocked: 0 });
    expect(reopened.getState(TARGET, "attempt", event.event_id)).toMatchObject({ status: "confirmed", pageId: page.id });
    const journalAfter = attemptJournal(local.databasePath, event.event_id);
    expect(journalAfter.slice(0, journalBefore.length)).toEqual(journalBefore);
    expect(journalAfter.map((entry) => entry.status)).toEqual(["creating", "blocked", "confirmed"]);
    expect(await resumed.runOnce()).toMatchObject({ confirmed: 1, pending: 0, blocked: 0 });
    expect(attemptJournal(local.databasePath, event.event_id)).toEqual(journalAfter);
    expect(notion.attempts).toHaveLength(1);
    expect(notion.attemptCreates).toEqual([]);
    expect(notion.questionCreates).toEqual([]);
    expect(notion.linkUpdates).toEqual([]);
    expect(readCanonicalAttempt(notion.attempts[0]!)).toEqual(event);
    expect(reopened.listAttemptsForTarget(TARGET)).toEqual([event]);
  });

  it("replays an event on another Mac without creating another Notion answer", async () => {
    const event = attempt();
    const macA = mac([event]);
    const macB = mac([event]);
    const notion = new SharedNotion();
    const firstWorker = worker(macA.storage, notion);
    await firstWorker.runOnce();
    await firstWorker.runOnce();
    await worker(macB.storage, notion).runOnce();
    expect(notion.attemptCreates).toEqual([FIRST_EVENT]);
    expect(notion.attempts).toHaveLength(1);
    expect(macB.storage.getState(TARGET, "attempt", FIRST_EVENT)?.status).toBe("confirmed");
  });

  it("journals intent before sending and holds an ambiguous no-match across restarts", async () => {
    const event = attempt();
    const local = mac([event]);
    const notion = new SharedNotion();
    notion.failures.set(FIRST_EVENT, "ambiguous-empty");
    notion.beforeAttemptCreate = () => expect(local.storage.getState(TARGET, "attempt", FIRST_EVENT))
      .toMatchObject({ status: "creating", code: "NOTION_CREATE_UNCONFIRMED" });
    expect(await worker(local.storage, notion).runOnce()).toMatchObject({
      pending: 1, blocked: 1, code: "NOTION_NETWORK_ERROR",
    });
    local.storage.close();
    const reopened = local.reopen();
    const resumed = worker(reopened, notion);
    await resumed.runOnce();
    await resumed.runOnce();
    expect(notion.attemptCreates).toEqual([FIRST_EVENT]);
    expect(notion.attempts).toHaveLength(0);
    expect(reopened.getState(TARGET, "attempt", FIRST_EVENT)?.status).toBe("creating");
    expect(reopened.listAttemptsForTarget(TARGET)).toEqual([event]);
  });

  it("reconciles a committed create whose response was lost after restart", async () => {
    const local = mac([attempt()]);
    const notion = new SharedNotion();
    notion.failures.set(FIRST_EVENT, "ambiguous-committed");
    await worker(local.storage, notion).runOnce();
    expect(notion.attempts).toHaveLength(1);
    expect(local.storage.getState(TARGET, "attempt", FIRST_EVENT)?.status).toBe("creating");
    local.storage.close();
    const reopened = local.reopen();
    expect(await worker(reopened, notion).runOnce()).toMatchObject({ confirmed: 1, pending: 0, blocked: 0 });
    expect(notion.attemptCreates).toEqual([FIRST_EVENT]);
    expect(reopened.getState(TARGET, "attempt", FIRST_EVENT)?.status).toBe("confirmed");
  });

  it("retries an explicit rate limit only after its delay and preserves the event ID", async () => {
    const local = mac([attempt()]);
    const notion = new SharedNotion();
    notion.failures.set(FIRST_EVENT, "rate-limit");
    let now = Date.parse("2026-10-14T04:00:00.000Z");
    const sync = worker(local.storage, notion, { now: () => now });
    expect((await sync.runOnce()).code).toBe("NOTION_RATE_LIMITED");
    expect(local.storage.getState(TARGET, "attempt", FIRST_EVENT)).toMatchObject({ status: "retry", retryAt: now + 20_000 });
    now += 19_999;
    await sync.runOnce();
    expect(notion.attemptCreates).toEqual([FIRST_EVENT]);
    now++;
    expect((await sync.runOnce()).confirmed).toBe(1);
    expect(notion.attemptCreates).toEqual([FIRST_EVENT, FIRST_EVENT]);
    expect(notion.attempts).toHaveLength(1);
  });

  it.each(["attempt", "question"] as const)("never recreates a known remotely deleted %s", async (kind) => {
    const local = mac([attempt()]);
    const notion = new SharedNotion();
    await worker(local.storage, notion).runOnce();
    const key = kind === "attempt" ? FIRST_EVENT : "119A12";
    const id = local.storage.getState(TARGET, kind, key)?.pageId;
    expect(id).toBeDefined();
    notion.pages.delete(id!);
    expect(await worker(local.storage, notion).runOnce()).toMatchObject({ confirmed: 0, pending: 1, blocked: 1 });
    expect(local.storage.getState(TARGET, kind, key)).toMatchObject({
      status: "blocked", code: "NOTION_REMOTE_MISSING", pageId: id,
    });
    local.storage.close();
    const reopened = local.reopen();
    expect(await worker(reopened, notion).runOnce()).toMatchObject({ confirmed: 0, pending: 1, blocked: 1 });
    expect(reopened.getState(TARGET, kind, key)).toMatchObject({
      status: "blocked", code: "NOTION_REMOTE_MISSING", pageId: id,
    });
    expect(notion.questionCreates).toHaveLength(1);
    expect(notion.attemptCreates).toEqual([FIRST_EVENT]);
    expect(notion.pages.has(id!)).toBe(false);
  });

  it("blocks a positive event-ID match with different immutable payload", async () => {
    const event = attempt();
    const local = mac([event]);
    const notion = new SharedNotion();
    const question = notion.addQuestion(event);
    const conflicting = notion.addAttempt(attempt({ result: "incorrect" }), question.id);
    expect(await worker(local.storage, notion).runOnce()).toMatchObject({ confirmed: 0, pending: 1, blocked: 1 });
    expect(local.storage.getState(TARGET, "attempt", FIRST_EVENT)).toMatchObject({
      status: "blocked", code: "NOTION_EVENT_CONFLICT", pageId: conflicting.id,
    });
    expect(notion.attemptCreates).toEqual([]);
    expect(notion.linkUpdates).toEqual([]);
    expect(readCanonicalAttempt(notion.attempts[0]!)).toEqual(attempt({ result: "incorrect" }));
  });

  it("blocks duplicate rows for one event without merging or deleting either", async () => {
    const event = attempt();
    const local = mac([event]);
    const notion = new SharedNotion();
    const question = notion.addQuestion(event);
    notion.addAttempt(event, question.id);
    notion.addAttempt(event, question.id);
    expect((await worker(local.storage, notion).runOnce()).blocked).toBe(1);
    expect(local.storage.getState(TARGET, "attempt", FIRST_EVENT)?.code).toBe("NOTION_DUPLICATE_EVENT");
    expect(notion.attempts).toHaveLength(2);
    expect(notion.attemptCreates).toEqual([]);
    expect(notion.linkUpdates).toEqual([]);
  });

  it("repairs a simultaneous master race including an offline Mac's log and preserves user notes", async () => {
    const first = attempt();
    const second = attempt({ event_id: SECOND_EVENT });
    const macA = mac([first]);
    const macB = mac([second]);
    const notion = new SharedNotion();
    const workerA = worker(macA.storage, notion);
    const workerB = worker(macB.storage, notion);
    await Promise.all([workerA.runOnce(), workerB.runOnce()]);
    expect(notion.questions).toHaveLength(2);
    expect(notion.attempts).toHaveLength(2);
    const firstPage = notion.attempts.find((page) => readCanonicalAttempt(page)?.event_id === FIRST_EVENT)!;
    const canonical = [...notion.questions].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    expect(relationPageIds(firstPage)).not.toEqual([canonical.id]);
    const notes = { type: "rich_text", rich_text: [{ type: "text", text: { content: "Keep my learning note" } }] };
    for (const page of [...notion.questions, ...notion.attempts]) notion.changeProperties(page.id, { "メモ": notes });
    const before = new Map([...notion.pages.values()].map((page) => [page.id, structuredClone(page.properties)]));
    // Mac A goes offline permanently; Mac B must repair Mac A's verified log too.
    macA.storage.close();
    expect((await workerB.runOnce()).repaired).toBe(1);
    for (const page of notion.attempts) {
      expect(relationPageIds(page)).toEqual([canonical.id]);
      expect(page.properties["メモ"]).toEqual(notes);
      const beforeProperties = { ...before.get(page.id) };
      const afterProperties = { ...page.properties };
      delete beforeProperties["問題"];
      delete afterProperties["問題"];
      expect(afterProperties).toEqual(beforeProperties);
    }
    for (const page of notion.questions) expect(page.properties).toEqual(before.get(page.id));
    expect(notion.questions).toHaveLength(2);
    expect(notion.attemptCreates).toHaveLength(2);
    expect(matchesAttempt(notion.pages.get(firstPage.id)!, first, canonical.id)).toBe(true);
  });

  it("visits later entries when alternating batch heads always fail their question queries", async () => {
    const events = [1, 2, 3, 4].map((number) => attempt({
      event_id: `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
      question_key: `119A${number}`,
    }));
    const local = mac(events);
    const notion = new SharedNotion();
    notion.questionQueryFailures.add("119A1");
    notion.questionQueryFailures.add("119A3");
    let now = Date.parse("2026-10-14T04:00:00.000Z");
    const sync = worker(local.storage, notion, { batchSize: 2, now: () => now });
    for (let run = 0; run < 8; run++) {
      await sync.runOnce();
      now += 300_001;
    }
    for (const index of [1, 3]) {
      expect(local.storage.getState(TARGET, "attempt", events[index]!.event_id)?.status).toBe("confirmed");
    }
    expect(notion.attempts.map((page) => readCanonicalAttempt(page)?.question_key).sort()).toEqual(["119A2", "119A4"]);
    expect(notion.attemptCreates.sort()).toEqual([events[1]!.event_id, events[3]!.event_id]);
    expect(notion.questionCreates.sort()).toEqual(["119A2", "119A4"]);
  });

  it("does not starve later answers behind blocked early entries when the batch is small", async () => {
    const first = attempt();
    const second = attempt({ event_id: SECOND_EVENT });
    const third = attempt({ event_id: "10000000-0000-4000-8000-000000000003" });
    const local = mac([first, second, third]);
    const notion = new SharedNotion();
    const question = notion.addQuestion(first);
    notion.addAttempt(attempt({ result: "incorrect" }), question.id);
    const sync = worker(local.storage, notion, { batchSize: 1 });
    for (let run = 0; run < 6; run++) await sync.runOnce();
    expect(local.storage.getState(TARGET, "attempt", FIRST_EVENT)?.status).toBe("blocked");
    expect(local.storage.getState(TARGET, "attempt", SECOND_EVENT)?.status).toBe("confirmed");
    expect(local.storage.getState(TARGET, "attempt", third.event_id)?.status).toBe("confirmed");
    expect(notion.attemptCreates.sort()).toEqual([SECOND_EVENT, third.event_id]);
  });
});
