import type { AttemptEventV1, RecoveredAttemptV1, StudyContextV1 } from "@qb-study/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NotionClient,
  NotionSyncError,
  NOTION_API_VERSION,
  attemptProperties,
  canonicalAttempt,
  canonicalStudyContext,
  canonicalRecoveredAttempt,
  recoveredAttemptProperties,
  readCanonicalRecoveredAttempt,
  matchesRecoveredAttempt,
  matchesAttempt,
  matchesQuestion,
  questionProperties,
  readCanonicalAttempt,
  readStudyContext,
  relationPageIds,
  type NotionPage,
} from "../src/notion-client.js";

const ATTEMPTS_ID = "00000000-0000-4000-8000-000000000010";
const QUESTIONS_ID = "00000000-0000-4000-8000-000000000020";
const ATTEMPT_PAGE_ID = "00000000-0000-4000-8000-000000000030";
const QUESTION_PAGE_ID = "00000000-0000-4000-8000-000000000040";
const OTHER_PAGE_ID = "00000000-0000-4000-8000-000000000050";
const EVENT: AttemptEventV1 = {
  schema_version: "1", record_type: "attempt_event",
  event_id: "00000000-0000-4000-8000-000000000001",
  question_key: "119A12", question_group_id: "fixture-group",
  answered_at: "2026-10-13T15:00:00Z", result: "correct", selected_option_indices: [3, 1],
  provenance: {
    producer: "browser-extension", producer_version: "0.1.0", source_system: "qb-web-dom",
    source_record_id: "fixture-record", recorded_at: "2026-10-14T00:00:01+09:00",
  },
  quality: { acquisition_method: "direct_capture", temporal_precision: "exact", state_precision: "exact" },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiProperties(properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([name, raw]) => {
    if (!record(raw)) {
      throw new Error("BAD_FIXTURE");
    }
    const type = Object.keys(raw)[0];
    let value: unknown = { ...raw, id: name, type };
    if (type === "date" && record(raw.date)) {
      value = { ...value as object, date: { end: null, time_zone: null, ...raw.date } };
    }
    if (type === "relation") {
      value = { ...value as object, has_more: false };
    }
    return [name, value];
  }));
}

function page(
  properties: Readonly<Record<string, unknown>> = attemptProperties(EVENT, QUESTION_PAGE_ID),
  sourceId = ATTEMPTS_ID,
  id = ATTEMPT_PAGE_ID,
): NotionPage {
  return {
    object: "page", id, parent: { type: "data_source_id", data_source_id: sourceId },
    archived: false, in_trash: false, properties: apiProperties(properties),
  };
}

function question(id = QUESTION_PAGE_ID): NotionPage {
  return page(questionProperties(EVENT), QUESTIONS_ID, id);
}

function schema(sourceId: string): Record<string, unknown> {
  const values = sourceId === QUESTIONS_ID ? questionProperties(EVENT) : attemptProperties(EVENT, QUESTION_PAGE_ID);
  const properties = Object.fromEntries(Object.entries(values).map(([name, raw]) => {
    if (!record(raw)) {
      throw new Error("BAD_FIXTURE");
    }
    const type = Object.keys(raw)[0];
    if (type === undefined) {
      throw new Error("BAD_FIXTURE");
    }
    const selectOptions: Record<string, readonly string[]> = {
      "判定": ["正解", "不正解", "未判定"], "記録元": ["Chrome拡張"], "学習種別": ["未分類"],
    };
    const typedValue = type === "select" ? { options: selectOptions[name]?.map((name) => ({ name })) }
      : type === "relation" ? { data_source_id: QUESTIONS_ID, type: "dual_property", dual_property: {} } : {};
    return [name, { id: name, name, type, [type]: typedValue }];
  }));
  return { object: "data_source", id: sourceId, in_trash: false, archived: false, properties };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function list(results: readonly NotionPage[], cursor: string | null = null): Response {
  return json({ object: "list", results, has_more: cursor !== null, next_cursor: cursor });
}

function client(fetch: typeof globalThis.fetch, sleep = vi.fn(async (milliseconds: number): Promise<void> => { void milliseconds; })): NotionClient {
  return new NotionClient({ token: "fixture-not-a-real-secret", attemptsDataSourceId: ATTEMPTS_ID,
    questionsDataSourceId: QUESTIONS_ID, fetch, sleep });
}

function schemaThen(...responses: Response[]): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  const pending = [json(schema(QUESTIONS_ID)), json(schema(ATTEMPTS_ID)), ...responses];
  return vi.fn<typeof globalThis.fetch>(async () => {
    const response = pending.shift();
    if (response === undefined) {
      throw new Error("UNEXPECTED_REQUEST");
    }
    return response;
  });
}

afterEach(() => { vi.useRealTimers(); });

const RECOVERY: RecoveredAttemptV1 = {
  schema_version: "1", record_type: "recovered_attempt", recovery_id: "00000000-0000-4000-8000-000000000099",
  question_key: "119A12", answered_on: "2026-10-14", result: "incorrect",
  observed_at: "2026-10-14T00:04:23.456+09:00", recovered_at: "2026-10-15T04:00:00+09:00",
  study_mode: "unclassified", selected_option_indices: null, source_system: "computer-history",
  source_event_id: "fixture-event:1", source_segment: "fixture-segment:1",
};

function recoverySchema(): Record<string, unknown> {
  const base = schema(ATTEMPTS_ID);
  return { ...base, properties: { ...base.properties as object,
    "補完ID": { type: "rich_text", rich_text: {} }, "補完データV1": { type: "rich_text", rich_text: {} },
    "観測日時": { type: "date", date: {} },
    "記録元": { type: "select", select: { options: [
      { id: "fixture-source-id", name: "Chrome拡張", color: "blue" }, { name: "Computer History補完" },
    ] } },
  } };
}

function recoveryThen(...responses: Response[]): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  const pending = [json(schema(QUESTIONS_ID)), json(recoverySchema()), ...responses];
  return vi.fn<typeof globalThis.fetch>(async () => {
    const response = pending.shift();
    if (response === undefined) throw new Error("UNEXPECTED_REQUEST");
    return response;
  });
}

describe("separate recovered answer evidence", () => {
  it("preserves unknown selection and day-only answer while retaining exact observation in its own canonical data", () => {
    const properties = recoveredAttemptProperties(RECOVERY, QUESTION_PAGE_ID);
    expect(properties["解答日時"]).toEqual({ date: { start: "2026-10-14" } });
    expect(properties["観測日時"]).toEqual({ date: { start: "2026-10-13T15:04:00.000Z" } });
    expect(properties["自分の解答"]).toEqual({ rich_text: [] });
    expect(properties["記録データV1"]).toEqual({ rich_text: [] });
    expect(properties["イベントID"]).toEqual({ rich_text: [] });
    const saved = page(properties);
    expect(readCanonicalRecoveredAttempt(saved)).toEqual(JSON.parse(canonicalRecoveredAttempt(RECOVERY)));
    expect(readCanonicalAttempt(saved)).toBeUndefined();
    expect(matchesRecoveredAttempt(saved, RECOVERY, QUESTION_PAGE_ID)).toBe(true);
    expect(matchesRecoveredAttempt(saved, RECOVERY, OTHER_PAGE_ID)).toBe(false);
  });

  it.each([
    { "解答日時": { date: { start: "2026-10-13T15:04:00.000Z" } } },
    { "自分の解答": { rich_text: [{ type: "text", text: { content: "a" } }] } },
    { "学習種別": { select: { name: "復習" } } },
    { "記録データV1": attemptProperties(EVENT, QUESTION_PAGE_ID)["記録データV1"] },
    { "観測日時": { date: { start: "2026-10-13T15:04:10.000Z" } } },
  ])("rejects invented or mixed evidence in mapped properties %j", (change) => {
    const saved = page({ ...recoveredAttemptProperties(RECOVERY, QUESTION_PAGE_ID), ...change });
    expect(matchesRecoveredAttempt(saved, RECOVERY)).toBe(false);
  });

  it("reads old schema without migrations and paginates/deduplicates valid recovery rows separately", async () => {
    const legacyFetch = schemaThen(list([page()]), list([question()]));
    const legacy = await client(legacyFetch).readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" });
    expect(legacy.recoveredAttempts).toEqual([]);
    expect(legacyFetch.mock.calls.every(([, init]) => init?.method !== "PATCH")).toBe(true);
    const saved = page(recoveredAttemptProperties(RECOVERY, QUESTION_PAGE_ID));
    const duplicate = { ...saved, id: OTHER_PAGE_ID };
    const fetch = recoveryThen(list([saved], "second"), list([duplicate]), list([question()]));
    const result = await client(fetch).readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" });
    expect(result).toMatchObject({ attempts: [], recoveredAttempts: [JSON.parse(canonicalRecoveredAttempt(RECOVERY))],
      duplicateRecoveredRows: 1, unknownAttemptRows: 0, suppressedRecoveredRows: 0 });
  });

  it("suppresses recovery when a same-day direct observation arrives without changing either source", async () => {
    const saved = page(recoveredAttemptProperties(RECOVERY, QUESTION_PAGE_ID));
    const result = await client(recoveryThen(list([saved, page()]), list([])))
      .readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" });
    expect(result).toMatchObject({ recoveredAttempts: [], suppressedRecoveredRows: 1 });
    expect(result.attempts).toHaveLength(1);
    expect(matchesRecoveredAttempt(saved, RECOVERY)).toBe(true);
  });

  it("does not let an unavailable future direct event suppress recovery, and excludes future recovery evidence", async () => {
    const saved = page(recoveredAttemptProperties(RECOVERY, QUESTION_PAGE_ID));
    const futureDirect = { ...EVENT, provenance: { ...EVENT.provenance, recorded_at: "2026-10-17T00:00:00Z" } };
    const futureRecovery = { ...RECOVERY, recovery_id: OTHER_PAGE_ID, recovered_at: "2026-10-17T00:00:00Z" };
    const result = await client(recoveryThen(list([saved, page(attemptProperties(futureDirect, QUESTION_PAGE_ID)),
      page(recoveredAttemptProperties(futureRecovery, QUESTION_PAGE_ID))]), list([])))
      .readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" });
    expect(result).toMatchObject({ attempts: [], suppressedRecoveredRows: 0, excludedFutureEvents: 1, excludedFutureRecoveries: 1 });
    expect(result.recoveredAttempts).toHaveLength(1);
  });

  it("fails closed for conflicting same-ID or same-question/day recoveries and honors explicit exclusion", async () => {
    const saved = page(recoveredAttemptProperties(RECOVERY, QUESTION_PAGE_ID));
    for (const changed of [{ ...RECOVERY, result: "correct" as const }, { ...RECOVERY, recovery_id: OTHER_PAGE_ID }]) {
      await expect(client(recoveryThen(list([saved, page(recoveredAttemptProperties(changed, QUESTION_PAGE_ID))]), list([])))
        .readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" })).rejects.toMatchObject({ code: "NOTION_RECOVERY_CONFLICT" });
    }
    const excluded = page({ ...recoveredAttemptProperties(RECOVERY, QUESTION_PAGE_ID), "集計除外": { checkbox: true } });
    const result = await client(recoveryThen(list([excluded]), list([]))).readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" });
    expect(result).toMatchObject({ recoveredAttempts: [], excludedFromAggregationRows: 1, unknownAttemptRows: 0 });
  });

  it("does not treat malformed recovery originals as merely unknown legacy rows", async () => {
    const malformed = page({ ...recoveredAttemptProperties(RECOVERY, QUESTION_PAGE_ID), "補完データV1": { rich_text: [] } });
    await expect(client(recoveryThen(list([malformed]))).readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" }))
      .rejects.toMatchObject({ code: "NOTION_RECOVERY_CONFLICT" });
  });

  it("explicitly adds only recovery columns and source label while preserving existing labels", async () => {
    const old = schema(ATTEMPTS_ID);
    const oldProperties = old.properties as Record<string, unknown>;
    oldProperties["記録元"] = { type: "select", select: { options: [{ id: "fixture-source-id", name: "Chrome拡張", color: "blue" }] } };
    const pending = [json(schema(QUESTIONS_ID)), json(old), json(old), json(recoverySchema()), json(schema(QUESTIONS_ID)), json(recoverySchema())];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => pending.shift()!);
    await client(fetch).ensureRecoveredAttemptSchema();
    const patch = JSON.parse(String(fetch.mock.calls[3]?.[1]?.body)) as { properties: Record<string, unknown> };
    expect(Object.keys(patch.properties).sort()).toEqual(["補完ID", "補完データV1", "観測日時", "記録元"].sort());
    expect(patch.properties["記録元"]).toEqual({ select: { options: [
      { id: "fixture-source-id", name: "Chrome拡張", color: "blue" }, { name: "Computer History補完" },
    ] } });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("rejects writes until explicit migration and reuses matching recovery instead of creating a second row", async () => {
    const old = schemaThen();
    await expect(client(old).createRecoveredAttempt(RECOVERY, QUESTION_PAGE_ID)).rejects.toMatchObject({ code: "NOTION_RECOVERY_SCHEMA_REQUIRED" });
    expect(old).toHaveBeenCalledTimes(2);
    const saved = page(recoveredAttemptProperties(RECOVERY, QUESTION_PAGE_ID));
    const fetch = recoveryThen(list([saved]));
    expect((await client(fetch).createRecoveredAttempt(RECOVERY, QUESTION_PAGE_ID)).id).toBe(saved.id);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/pages"))).toHaveLength(0);
  });

  it("blocks a same-day direct answer, another recovery, or an unrecognized prior row before create", async () => {
    const otherRecovery = { ...RECOVERY, recovery_id: OTHER_PAGE_ID };
    for (const prior of [page(), page(recoveredAttemptProperties(otherRecovery, QUESTION_PAGE_ID)), page({ "問題キー": questionProperties(EVENT)["問題キー"] })]) {
      const fetch = recoveryThen(list([]), json(question()), list([prior]));
      await expect(client(fetch).createRecoveredAttempt(RECOVERY, QUESTION_PAGE_ID)).rejects.toBeInstanceOf(NotionSyncError);
      expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/pages"))).toBe(false);
    }
  });

  it("creates only one row, verifies it, and does not retry ambiguous create failures", async () => {
    const saved = page(recoveredAttemptProperties(RECOVERY, QUESTION_PAGE_ID));
    const fetch = recoveryThen(list([]), json(question()), list([]), json(saved), json(saved));
    const notion = client(fetch);
    expect((await notion.createRecoveredAttempt(RECOVERY, QUESTION_PAGE_ID)).id).toBe(saved.id);
    expect(await notion.verifyRecoveredAttempt(saved.id, RECOVERY, QUESTION_PAGE_ID)).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/pages"))).toHaveLength(1);
    for (const response of [json({}, 503), json({ object: "page" })]) {
      const failing = recoveryThen(list([]), json(question()), list([]), response);
      await expect(client(failing).createRecoveredAttempt(RECOVERY, QUESTION_PAGE_ID)).rejects.toMatchObject({ ambiguous: true });
      expect(failing.mock.calls.filter(([url]) => String(url).endsWith("/pages"))).toHaveLength(1);
    }
  });

  it("creates a question master directly from recovery identity without an invented V1 attempt", async () => {
    const fetch = schemaThen(json(question()));
    expect((await client(fetch).createRecoveredQuestion(RECOVERY)).id).toBe(QUESTION_PAGE_ID);
    const body = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body)) as { properties: Record<string, unknown> };
    expect(Object.keys(body.properties).sort()).toEqual(["問題番号", "問題キー"].sort());
  });
});

describe("Notion ordinary review pages", () => {
  const title = "QB復習候補 2026-10-16";
  const parent = { object: "page", id: QUESTION_PAGE_ID, archived: false, in_trash: false };
  const child = { object: "page", id: OTHER_PAGE_ID, archived: false, in_trash: false,
    parent: { type: "page_id", page_id: QUESTION_PAGE_ID },
    properties: { title: { type: "title", title: [{ type: "text", text: { content: title } }] } } };

  it("checks the parent before one create and rejects an uncertain malformed success", async () => {
    const responses = [json(parent), json(child)];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!);
    const saved = await client(fetch).createReviewPage(QUESTION_PAGE_ID, title, []);
    expect(saved).toMatchObject({ id: OTHER_PAGE_ID, parentPageId: QUESTION_PAGE_ID, title });
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`https://api.notion.com/v1/pages/${QUESTION_PAGE_ID}`, "GET"], ["https://api.notion.com/v1/pages", "POST"],
    ]);
    const invalidResponses = [json(parent), json({ object: "page" })];
    const invalid = vi.fn<typeof globalThis.fetch>(async () => invalidResponses.shift()!);
    await expect(client(invalid).createReviewPage(QUESTION_PAGE_ID, title, [])).rejects.toMatchObject({ ambiguous: true });
    expect(invalid).toHaveBeenCalledTimes(2);
  });

  it("paginates parent blocks and ignores unsupported text in unrelated blocks", async () => {
    const responses = [json(parent), json({ object: "list", has_more: true, next_cursor: "next-parent-page", results: [
      { object: "block", id: ATTEMPT_PAGE_ID, type: "paragraph", has_children: false,
        paragraph: { rich_text: [{ type: "mention", mention: { type: "page", page: { id: OTHER_PAGE_ID } } }] } },
    ] }), json({ object: "list", has_more: false, next_cursor: null, results: [
      { object: "block", id: OTHER_PAGE_ID, type: "child_page", has_children: false, child_page: { title } },
    ] })];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!);
    expect(await client(fetch).listReviewChildPages(QUESTION_PAGE_ID)).toEqual([{ id: OTHER_PAGE_ID, title }]);
    expect(String(fetch.mock.calls[2]?.[0])).toContain("start_cursor=next-parent-page");
  });

  it("marks an append error or malformed success ambiguous without retrying", async () => {
    for (const response of [json({}, 503), json({ object: "list", results: [], has_more: false, next_cursor: null })]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
      await expect(client(fetch).appendReviewBlocks(OTHER_PAGE_ID, [{ object: "block", type: "paragraph", paragraph: { rich_text: [] } }]))
        .rejects.toMatchObject({ ambiguous: true });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.method).toBe("PATCH");
    }
  });
});

describe("Notion event mapping", () => {
  it("preserves a full V1 event, normalizes instants, and derives study day in Tokyo", () => {
    const properties = attemptProperties(EVENT, QUESTION_PAGE_ID, { includeExtensionVersion: true });
    expect(properties["学習日"]).toEqual({ date: { start: "2026-10-14" } });
    expect(properties["解答日時"]).toEqual({ date: { start: "2026-10-13T15:00:00.000Z" } });
    expect(properties["取得日時"]).toEqual({ date: { start: "2026-10-13T15:00:00.000Z" } });
    expect(properties["自分の解答"]).toEqual({ rich_text: [{ type: "text", text: { content: "a,c" } }] });
    const recovered = readCanonicalAttempt(page(properties));
    expect(recovered?.question_group_id).toBe("fixture-group");
    expect(recovered?.provenance).toEqual({ ...EVENT.provenance, recorded_at: "2026-10-13T15:00:01.000Z" });
    expect(recovered?.selected_option_indices).toEqual([1, 3]);
    expect(canonicalAttempt(EVENT)).toBe(canonicalAttempt({ ...EVENT, selected_option_indices: [1, 3] }));
    expect(EVENT.selected_option_indices).toEqual([3, 1]);
    expect(properties).not.toHaveProperty("メモ");
    expect(properties).not.toHaveProperty("正解");
    expect(properties).not.toHaveProperty("端末ID");
  });

  it("does not invent letters, Chrome provenance, or accept extra contract fields", () => {
    for (const bad of [
      { ...EVENT, selected_option_indices: [6] },
      { ...EVENT, selected_option_indices: [0] },
      { ...EVENT, selected_option_indices: [1, 1] },
      { ...EVENT, provenance: { ...EVENT.provenance, producer: "another-source" } },
      { ...EVENT, raw_dom: "NEVER_SEND_THIS" },
    ]) {
      expect(() => attemptProperties(bad, QUESTION_PAGE_ID)).toThrowError(expect.objectContaining({ code: "NOTION_EVENT_UNSUPPORTED" }));
    }
  });

  it("preserves exact evidence while writing minute-precision Notion date projections", () => {
    const precise: AttemptEventV1 = { ...EVENT, answered_at: "2026-10-14T15:36:14.693Z",
      provenance: { ...EVENT.provenance, recorded_at: "2026-10-14T15:36:14.766Z" } };
    const mapped = attemptProperties(precise, QUESTION_PAGE_ID);
    expect(mapped["解答日時"]).toEqual({ date: { start: "2026-10-14T15:36:00.000Z" } });
    expect(mapped["取得日時"]).toEqual({ date: { start: "2026-10-14T15:36:00.000Z" } });
    expect(mapped["学習日"]).toEqual({ date: { start: "2026-10-15" } });
    expect(mapped["記録名"]).toEqual({ title: [{ type: "text", text: { content: "119A12 2026-10-14T15:36:14.693Z" } }] });
    const saved = page(mapped);
    expect(readCanonicalAttempt(saved)?.answered_at).toBe(precise.answered_at);
    expect(readCanonicalAttempt(saved)?.provenance.recorded_at).toBe(precise.provenance.recorded_at);
    expect(matchesAttempt(saved, precise, QUESTION_PAGE_ID)).toBe(true);
    // Canonical evidence must still match exactly, even when both displays share a minute.
    expect(matchesAttempt(saved, { ...precise, answered_at: "2026-10-14T15:36:14.694Z" })).toBe(false);
    expect(matchesAttempt(saved, { ...precise, provenance: { ...precise.provenance,
      recorded_at: "2026-10-14T15:36:14.767Z" } })).toBe(false);
  });

  it("accepts only exact or UTC minute-floor dates, rejecting other instants and ambiguous dates", () => {
    const precise: AttemptEventV1 = { ...EVENT, answered_at: "2026-10-14T15:36:14.693Z",
      provenance: { ...EVENT.provenance, recorded_at: "2026-10-14T15:36:14.766Z" } };
    const saved = page(attemptProperties(precise, QUESTION_PAGE_ID));
    const withDate = (name: string, date: Record<string, unknown>): NotionPage => ({
      ...saved, properties: { ...saved.properties, [name]: { type: "date", date: {
        end: null, time_zone: null, ...date,
      } } },
    });
    for (const [name, expected] of [["解答日時", precise.answered_at], ["取得日時", precise.provenance.recorded_at]]) {
      expect(matchesAttempt(withDate(name!, { start: expected }), precise)).toBe(true);
      expect(matchesAttempt(withDate(name!, { start: "2026-10-14T15:36:00.000+00:00" }), precise)).toBe(true);
      expect(matchesAttempt(withDate(name!, { start: "2026-10-15T00:36:00+09:00" }), precise)).toBe(true);
      for (const bad of [
        { start: "2026-10-14T15:36:14.000Z" },
        { start: "2026-10-14T15:36:00.001Z" },
        { start: "2026-10-14T15:36:59.999Z" },
        { start: "2026-10-14T15:35:00.000Z" },
        { start: "2026-10-14T15:37:00.000Z" },
        { start: "2026-10-14" },
        { start: "2026-10-14T15:36:00" },
        { start: "2026-10-14T15:36:00.000Z", end: "2026-10-14T15:37:00.000Z" },
        { start: "2026-10-14T15:36:00.000Z", time_zone: "Asia/Tokyo" },
      ]) {
        expect(matchesAttempt(withDate(name!, bad), precise)).toBe(false);
      }
    }
  });

  it("compares full evidence and mapped values but permits personal title and study type edits", () => {
    const original = page();
    expect(matchesAttempt(original, EVENT, QUESTION_PAGE_ID)).toBe(true);
    expect(matchesAttempt({ ...original, properties: {
      ...original.properties, "記録名": { type: "title", title: [] },
      "学習種別": { type: "select", select: { name: "復習" } }, "メモ": { type: "rich_text", rich_text: [] },
    } }, EVENT, QUESTION_PAGE_ID)).toBe(true);
    expect(matchesAttempt(original, { ...EVENT, result: "incorrect" })).toBe(false);
    expect(matchesAttempt(original, { ...EVENT, provenance: { ...EVENT.provenance, producer_version: "0.2.0" } })).toBe(false);
    expect(matchesAttempt(original, EVENT, OTHER_PAGE_ID)).toBe(false);
    expect(matchesAttempt({ ...original, in_trash: true }, EVENT)).toBe(false);
    const altered = page({ ...attemptProperties(EVENT, QUESTION_PAGE_ID), "判定": { select: { name: "不正解" } } });
    expect(matchesAttempt(altered, EVENT)).toBe(false);
  });

  it("reads split rich text and rejects lossy or malformed canonical evidence", () => {
    const original = page();
    const split = { ...original, properties: { ...original.properties, "イベントID": {
      type: "rich_text", rich_text: [EVENT.event_id.slice(0, 8), EVENT.event_id.slice(8)].map((content) => ({
        type: "text", text: { content }, plain_text: content,
      })),
    } } };
    expect(matchesAttempt(split, EVENT)).toBe(true);
    expect(readCanonicalAttempt(page({ ...attemptProperties(EVENT, QUESTION_PAGE_ID),
      "記録データV1": { rich_text: [{ type: "text", text: { content: "{}" } }] },
    }))).toBeUndefined();
    expect(matchesAttempt(page({ ...attemptProperties(EVENT, QUESTION_PAGE_ID),
      "記録データV1": { rich_text: [{ type: "text", text: { content: "not-json" } }] },
    }), EVENT)).toBe(false);
    expect(matchesAttempt({ ...split, properties: { ...split.properties, "イベントID": {
      type: "rich_text", rich_text: [{ type: "mention", plain_text: EVENT.event_id }],
    } } }, EVENT)).toBe(false);
  });

  it("matches question keys independently of editable titles and rejects truncated relations", () => {
    expect(matchesQuestion(question(), EVENT.question_key)).toBe(true);
    expect(matchesQuestion(question(), "119A13")).toBe(false);
    expect(relationPageIds(page())).toEqual([QUESTION_PAGE_ID]);
    expect(() => relationPageIds({ ...page(), properties: { "問題": {
      type: "relation", relation: [{ id: QUESTION_PAGE_ID }], has_more: true,
    } } })).toThrowError(NotionSyncError);
  });
});

describe("Notion fixed-endpoint client", () => {
  it("validates both schemas and uses the data-source parent with no hidden create retries", async () => {
    const fetch = schemaThen(json(page()));
    const api = client(fetch);
    const result = await api.createAttempt(EVENT, QUESTION_PAGE_ID);
    expect(result.id).toBe(ATTEMPT_PAGE_ID);
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[2] ?? [];
    expect(url).toBe("https://api.notion.com/v1/pages");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ Authorization: "Bearer fixture-not-a-real-secret",
      "Notion-Version": NOTION_API_VERSION, "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      parent: { type: "data_source_id", data_source_id: ATTEMPTS_ID }, properties: attemptProperties(EVENT, QUESTION_PAGE_ID),
    });
    expect(JSON.stringify(api)).not.toContain("fixture-not-a-real-secret");
  });

  it("writes a minimal question master only after schema checks", async () => {
    const fetch = schemaThen(json(question()));
    await expect(client(fetch).createQuestion(EVENT)).resolves.toEqual(question());
    const init = fetch.mock.calls[2]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      parent: { type: "data_source_id", data_source_id: QUESTIONS_ID }, properties: questionProperties(EVENT),
    });
  });

  it.each(["missing", "type", "select", "relation", "extension"])("blocks writes for %s schema mismatch", async (fault) => {
    const bad = schema(ATTEMPTS_ID);
    if (!record(bad.properties)) {
      throw new Error("BAD_FIXTURE");
    }
    if (fault === "missing") delete bad.properties["記録データV1"];
    if (fault === "type") bad.properties["イベントID"] = { type: "title", title: {} };
    if (fault === "select") bad.properties["判定"] = { type: "select", select: { options: [{ name: "正解" }] } };
    if (fault === "relation") bad.properties["問題"] = { type: "relation", relation: { data_source_id: OTHER_PAGE_ID } };
    if (fault === "extension") bad.properties["拡張バージョン"] = { type: "number", number: {} };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(schema(QUESTIONS_ID))).mockResolvedValueOnce(json(bad));
    await expect(client(fetch).createAttempt(EVENT, QUESTION_PAGE_ID)).rejects.toMatchObject({ code: "NOTION_SCHEMA_MISMATCH", ambiguous: false });
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("blocks unsupported selections before touching the network", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(client(fetch).createAttempt({ ...EVENT, selected_option_indices: [6] }, QUESTION_PAGE_ID))
      .rejects.toMatchObject({ code: "NOTION_EVENT_UNSUPPORTED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(() => new NotionClient({ token: "test", attemptsDataSourceId: "../../evil", questionsDataSourceId: QUESTIONS_ID }))
      .toThrowError(NotionSyncError);
  });

  it("queries exact keys and walks every question page", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(list([question()], "next-fixture"))
      .mockResolvedValueOnce(list([question(OTHER_PAGE_ID)]));
    const result = await client(fetch).findQuestion(EVENT.question_key);
    expect(result.map(({ id }) => id)).toEqual([QUESTION_PAGE_ID, OTHER_PAGE_ID]);
    const [url, init] = fetch.mock.calls[1] ?? [];
    expect(url).toBe(`https://api.notion.com/v1/data_sources/${QUESTIONS_ID}/query`);
    expect(JSON.parse(String(init?.body))).toEqual({ filter: { property: "問題キー", rich_text: { equals: EVENT.question_key } },
      page_size: 100, start_cursor: "next-fixture" });
  });

  it("finds duplicate attempt IDs without a workspace search and lists attempts for master repair", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(list([page(), page(undefined, ATTEMPTS_ID, OTHER_PAGE_ID)], "more"))
      .mockResolvedValueOnce(list([page()]));
    const api = client(fetch);
    expect(await api.findAttempt(EVENT.event_id)).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await api.findAttemptsForQuestion(EVENT.question_key)).toHaveLength(1);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      filter: { property: "問題キー", rich_text: { equals: EVENT.question_key } },
    });
  });

  it("rejects incomplete pagination, parent mismatch, wrong keys, and malformed page metadata", async () => {
    for (const response of [
      { object: "list", results: [], has_more: true, next_cursor: null },
      { object: "list", results: [{ ...question(), parent: { type: "data_source_id", data_source_id: ATTEMPTS_ID } }], has_more: false, next_cursor: null },
      { object: "list", results: [page(questionProperties({ ...EVENT, question_key: "119A13" }), QUESTIONS_ID, QUESTION_PAGE_ID)], has_more: false, next_cursor: null },
      { object: "list", results: [{ ...question(), archived: undefined }], has_more: false, next_cursor: null },
    ]) {
      await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(response))).findQuestion(EVENT.question_key))
        .rejects.toMatchObject({ code: "NOTION_RESPONSE_INVALID" });
    }
    const repeated = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => list([], "same"));
    await expect(client(repeated).findQuestion(EVENT.question_key)).rejects.toMatchObject({ code: "NOTION_RESPONSE_INVALID" });
    expect(repeated).toHaveBeenCalledTimes(2);
    let count = 0;
    const endless = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => list([], `cursor${count++}`));
    await expect(client(endless).findQuestion(EVENT.question_key)).rejects.toMatchObject({ code: "NOTION_QUERY_LIMIT" });
    expect(endless).toHaveBeenCalledTimes(10);
  });

  it.each([429, 529])("exposes %i Retry-After without automatic POST retry or response text", async (status) => {
    const fetch = schemaThen(json({ message: "SECRET_RAW_BODY" }, status, { "Retry-After": "123" }));
    await expect(client(fetch).createAttempt(EVENT, QUESTION_PAGE_ID)).rejects.toMatchObject({
      code: "NOTION_RATE_LIMITED", retryable: true, ambiguous: false, retryAfterMs: 123_000,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("treats write timeouts, 5xx, and malformed successes as ambiguous without another create", async () => {
    for (const response of [json({}, 500), new Response("MALFORMED_SECRET", { status: 200 }), json({ object: "page", id: ATTEMPT_PAGE_ID })]) {
      const fetch = schemaThen(response);
      const error = await client(fetch).createAttempt(EVENT, QUESTION_PAGE_ID).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(NotionSyncError);
      expect(error).toMatchObject({ retryable: true, ambiguous: true });
      expect(String(error)).not.toContain("MALFORMED_SECRET");
      expect(fetch).toHaveBeenCalledTimes(3);
    }
    const fetch = schemaThen();
    const api = client(fetch);
    await api.validateSchema();
    fetch.mockRejectedValueOnce(new Error("network with SECRET_HEADER"));
    const error = await api.createAttempt(EVENT, QUESTION_PAGE_ID).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "NOTION_NETWORK_ERROR", retryable: true, ambiguous: true });
    expect(JSON.stringify(error)).not.toContain("SECRET_HEADER");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps only a UUID from a committed 503 response", async () => {
    const fetch = schemaThen(json({ message: "SECRET_MESSAGE", additional_data: {
      committed_resource_id: ATTEMPT_PAGE_ID, other: "PRIVATE_PAYLOAD",
    } }, 503, { "Retry-After": "2" }));
    const error = await client(fetch).createAttempt(EVENT, QUESTION_PAGE_ID).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "NOTION_SERVICE_UNAVAILABLE", ambiguous: true, committedResourceId: ATTEMPT_PAGE_ID, retryAfterMs: 2_000 });
    expect(JSON.stringify(error)).not.toContain("SECRET_MESSAGE");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_PAYLOAD");
  });

  it("uses bounded responses, never follows redirects, and sanitizes authentication failures", async () => {
    const responses = [
      { response: new Response("x", { headers: { "Content-Length": String(3 * 1_024 * 1_024) } }), code: "NOTION_RESPONSE_TOO_LARGE" },
      { response: new Response("x".repeat(2 * 1_024 * 1_024 + 1)), code: "NOTION_RESPONSE_TOO_LARGE" },
      { response: new Response(null, { status: 302, headers: { location: "https://example.com/private" } }), code: "NOTION_REQUEST_REJECTED" },
      { response: json({ message: "SECRET_TOKEN" }, 401), code: "NOTION_UNAUTHORIZED" },
      { response: json({ message: "SECRET_TOKEN" }, 403), code: "NOTION_FORBIDDEN" },
    ];
    for (const { response, code } of responses) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      const error = await client(fetch).getPage(ATTEMPT_PAGE_ID).catch((error: unknown) => error);
      expect(error).toMatchObject({ code, ambiguous: false });
      expect(JSON.stringify(error)).not.toContain("SECRET_TOKEN");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("paces concurrent calls and retains only allowed page properties", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    const starts: number[] = [];
    const sleep = vi.fn(async (milliseconds: number) => { vi.setSystemTime(Date.now() + milliseconds); });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      starts.push(Date.now());
      return json({ ...page(), properties: { ...page().properties, "メモ": { type: "rich_text", rich_text: [] } } });
    });
    const api = client(fetch, sleep);
    const results = await Promise.all([api.getPage(ATTEMPT_PAGE_ID), api.getPage(ATTEMPT_PAGE_ID), api.getPage(ATTEMPT_PAGE_ID)]);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(500);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(500);
    expect(results[0]?.properties).not.toHaveProperty("メモ");
  });

  it("changes only the question relation and validates its returned page", async () => {
    const fetch = schemaThen(json(page(attemptProperties(EVENT, OTHER_PAGE_ID))));
    await expect(client(fetch).linkAttempt(ATTEMPT_PAGE_ID, OTHER_PAGE_ID)).resolves.toBeUndefined();
    expect(fetch.mock.calls[2]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      properties: { "問題": { relation: [{ id: OTHER_PAGE_ID }] } },
    });
    const wrong = schemaThen(json(page()));
    await expect(client(wrong).linkAttempt(ATTEMPT_PAGE_ID, OTHER_PAGE_ID)).rejects.toMatchObject({ ambiguous: true });
  });
});

describe("Notion review evidence and study contexts", () => {
  const context: StudyContextV1 = { schema_version: "1", record_type: "study_context", event_id: EVENT.event_id,
    study_mode: "review", review_plan_id: OTHER_PAGE_ID };

  function contextSchema(): Record<string, unknown> {
    const value = schema(ATTEMPTS_ID);
    const properties = value.properties as Record<string, unknown>;
    properties["学習目的データV1"] = { type: "rich_text", rich_text: {} };
    properties["集計除外"] = { type: "checkbox", checkbox: {} };
    properties["学習種別"] = { type: "select", select: { options: ["新規", "復習", "未分類", "通常学習"].map((name) => ({ name })) } };
    return value;
  }

  function withContext(event = EVENT): NotionPage {
    return page(attemptProperties(event, QUESTION_PAGE_ID, { studyContext: { ...context, event_id: event.event_id } }));
  }

  it("reads more than 1000 answers without truncation and keeps full exact evidence", async () => {
    const pages = Array.from({ length: 1_001 }, (_, index) => page(attemptProperties({ ...EVENT,
      event_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }, QUESTION_PAGE_ID), ATTEMPTS_ID, `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`));
    const responses: Response[] = [];
    for (let start = 0; start < pages.length; start += 100) {
      responses.push(list(pages.slice(start, start + 100), start + 100 < pages.length ? `cursor-${start + 100}` : null));
    }
    responses.push(list([question()]));
    const fetch = schemaThen(...responses);
    const snapshot = await client(fetch).readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" });
    expect(snapshot.attempts).toHaveLength(1_001);
    expect(snapshot.unknownAttemptRows).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(14);
    expect(fetch.mock.calls[12]?.[1]?.body).toContain("cursor-1000");
  });

  it("deduplicates identical evidence, warns on unknown rows, and excludes future or opted-out records", async () => {
    const future = { ...EVENT, event_id: "00000000-0000-4000-8000-000000000099", answered_at: "2026-10-18T00:00:00Z" };
    const omitted = { ...page(attemptProperties({ ...EVENT, result: "incorrect" }, QUESTION_PAGE_ID)),
      properties: { ...page(attemptProperties({ ...EVENT, result: "incorrect" }, QUESTION_PAGE_ID)).properties,
        "集計除外": { type: "checkbox", checkbox: true } } };
    const fetch = schemaThen(list([withContext(), withContext(), page({}, ATTEMPTS_ID, OTHER_PAGE_ID), withContext(future), omitted]), list([question()]));
    const snapshot = await client(fetch).readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" });
    expect(snapshot.attempts).toEqual([JSON.parse(canonicalAttempt(EVENT))]);
    expect(snapshot.contexts).toEqual([context]);
    expect(snapshot).toMatchObject({ duplicateAttemptRows: 1, unknownAttemptRows: 1, excludedFutureEvents: 1, excludedFromAggregationRows: 1 });
  });

  it("fails closed on an event ID with conflicting evidence or context", async () => {
    for (const conflicting of [page(attemptProperties({ ...EVENT, result: "incorrect" }, QUESTION_PAGE_ID)),
      page(attemptProperties(EVENT, QUESTION_PAGE_ID, { studyContext: {
        schema_version: "1", record_type: "study_context", event_id: EVENT.event_id, study_mode: "normal",
      } }))]) {
      const fetch = schemaThen(list([withContext(), conflicting]));
      await expect(client(fetch).readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" })).rejects.toBeInstanceOf(NotionSyncError);
    }
  });

  it("reads only explicit master metadata without guessing classifications", async () => {
    const master = { ...question(), properties: { ...question().properties,
      "復習停止": { type: "checkbox", checkbox: true }, "次回復習日": { type: "date", date: { start: "2026-10-17", end: null, time_zone: null } },
      "科目": { type: "rich_text", rich_text: [{ type: "text", text: { content: "自分の科目分類" } }] },
      "分野": { type: "rich_text", rich_text: [] },
    } };
    const snapshot = await client(schemaThen(list([page()]), list([master]))).readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" });
    expect(snapshot.questions).toEqual([{ question_key: "119A12", stopped: true, next_review_on: "2026-10-17",
      subjects: ["自分の科目分類"], fields: [] }]);
    const conflicting = { ...question(OTHER_PAGE_ID), properties: { ...master.properties, "復習停止": { type: "checkbox", checkbox: false } } };
    await expect(client(schemaThen(list([]), list([master, conflicting]))).readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" }))
      .rejects.toMatchObject({ code: "NOTION_QUESTION_METADATA_CONFLICT" });
  });

  it("never creates a context property or display option implicitly", async () => {
    const fetch = schemaThen();
    await expect(client(fetch).createAttempt(EVENT, QUESTION_PAGE_ID, context)).rejects.toMatchObject({ code: "NOTION_STUDY_CONTEXT_SCHEMA_REQUIRED" });
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    const schemas = [json(schema(QUESTIONS_ID)), json(contextSchema()), json(withContext())];
    const ready = vi.fn<typeof globalThis.fetch>(async () => schemas.shift()!);
    await client(ready).createAttempt(EVENT, QUESTION_PAGE_ID, context);
    const request = JSON.parse(String(ready.mock.calls[2]?.[1]?.body)) as { properties: Record<string, unknown> };
    expect(request.properties["学習種別"]).toEqual({ select: { name: "復習" } });
    expect(request.properties["学習目的データV1"]).toBeDefined();
  });

  it("adds only absent context and preserves existing personal display classifications", async () => {
    const existing = page({ ...attemptProperties(EVENT, QUESTION_PAGE_ID), "学習種別": { select: { name: "新規" } } });
    const saved: NotionPage = { ...existing, properties: { ...existing.properties,
      "学習目的データV1": apiProperties({ "学習目的データV1": { rich_text: [{ type: "text", text: { content: canonicalStudyContext(context) } }] } })["学習目的データV1"],
    } };
    const responses = [json(schema(QUESTIONS_ID)), json(contextSchema()), json(existing), json(saved), json(saved)];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!);
    await client(fetch).backfillStudyContext(ATTEMPT_PAGE_ID, EVENT, context);
    const body = JSON.parse(String(fetch.mock.calls[3]?.[1]?.body)) as { properties: Record<string, unknown> };
    expect(Object.keys(body.properties)).toEqual(["学習目的データV1"]);
    expect(readStudyContext(saved)).toEqual(context);
    expect(saved.properties["学習種別"]).toEqual(existing.properties["学習種別"]);
    expect(() => readStudyContext(page({ ...attemptProperties(EVENT, QUESTION_PAGE_ID),
      "学習目的データV1": { rich_text: [{ type: "text", text: { content: "{}" } }] } }))).toThrowError(NotionSyncError);
  });

  it("requires an explicit schema ensure and preserves existing select options", async () => {
    const before = schema(ATTEMPTS_ID);
    (before.properties as Record<string, unknown>)["学習種別"] = { type: "select", select: {
      options: [{ id: "existing-new", name: "新規", color: "blue" }, { id: "existing-unclassified", name: "未分類", color: "gray" }],
    } };
    const responses = [json(schema(QUESTIONS_ID)), json(before), json(before), json(contextSchema()),
      json(schema(QUESTIONS_ID)), json(contextSchema()), json(contextSchema())];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!);
    await client(fetch).ensureStudyContextSchema();
    const mutation = fetch.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(mutation).toHaveLength(1);
    const body = JSON.parse(String(mutation[0]?.[1]?.body)) as { properties: Record<string, unknown> };
    expect(Object.keys(body.properties).sort()).toEqual(["学習目的データV1", "学習種別"].sort());
    expect(JSON.stringify(body)).toContain("existing-new");
    expect(body.properties["学習種別"]).toMatchObject({ select: { options: expect.arrayContaining([
      { id: "existing-new", name: "新規", color: "blue" }, { id: "existing-unclassified", name: "未分類", color: "gray" },
    ]) } });
    expect(JSON.stringify(body)).toContain("通常学習");
  });
});


describe("iPhone Safari records in the shared Notion source", () => {
  const safari: AttemptEventV1 = { ...EVENT, provenance: { ...EVENT.provenance, producer_version: "ios-0.1.0" } };
  it("reads Safari and Chrome rows together without changing V1 evidence", async () => {
    const saved = page(attemptProperties(safari, QUESTION_PAGE_ID));
    expect(matchesAttempt(saved, safari, QUESTION_PAGE_ID)).toBe(true);
    expect((saved.properties["記録元"] as { select: { name: string } }).select.name).toBe("Safari拡張");
    const chrome = { ...EVENT, event_id: "00000000-0000-4000-8000-000000000002" };
    const snapshot = await client(schemaThen(list([saved, page(attemptProperties(chrome, QUESTION_PAGE_ID))]), list([question()])))
      .readReviewSnapshot({ asOf: "2026-10-16T00:00:00Z" });
    expect(snapshot.attempts).toHaveLength(2);
    expect(snapshot.unknownAttemptRows).toBe(0);
  });
  it("rejects a source label inconsistent with the immutable producer version", () => {
    expect(matchesAttempt(page({ ...attemptProperties(safari, QUESTION_PAGE_ID), "記録元": { select: { name: "Chrome拡張" } } }), safari)).toBe(false);
    expect(matchesAttempt(page({ ...attemptProperties(EVENT, QUESTION_PAGE_ID), "記録元": { select: { name: "Safari拡張" } } }), EVENT)).toBe(false);
  });
});
