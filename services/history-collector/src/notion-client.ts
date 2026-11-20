import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { TextDecoder } from "node:util";

import {
  normalizeExactTimestamp,
  isValidLocalDate,
  toTokyoDate,
  validateAttemptEventV1,
  validateStudyContextV1,
  validateRecoveredAttemptV1,
  type AttemptEventV1,
  type RecoveredAttemptV1,
  type StudyContextV1,
} from "@qb-study/contracts";

const API_ORIGIN = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2025-09-03";
const REQUEST_TIMEOUT_MS = 20_000;
const MIN_REQUEST_INTERVAL_MS = 500;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_EVENT_BYTES = 64 * 1_024;
const MAX_QUERY_PAGES = 10;
const UUID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu;
const QUESTION_KEY = /^[0-9]{3}[A-Z][1-9][0-9]{0,2}$/u;

export type NotionSyncErrorCode =
  | "NOTION_CONFIG_INVALID"
  | "NOTION_EVENT_UNSUPPORTED"
  | "NOTION_SCHEMA_MISMATCH"
  | "NOTION_RESPONSE_INVALID"
  | "NOTION_RESPONSE_TOO_LARGE"
  | "NOTION_NETWORK_ERROR"
  | "NOTION_RATE_LIMITED"
  | "NOTION_UNAUTHORIZED"
  | "NOTION_FORBIDDEN"
  | "NOTION_NOT_FOUND"
  | "NOTION_REQUEST_REJECTED"
  | "NOTION_SERVICE_UNAVAILABLE"
  | "NOTION_QUERY_LIMIT"
  | "NOTION_PAGE_MISMATCH"
  | "NOTION_EVENT_CONFLICT"
  | "NOTION_STUDY_CONTEXT_CONFLICT"
  | "NOTION_STUDY_CONTEXT_SCHEMA_REQUIRED"
  | "NOTION_QUESTION_METADATA_CONFLICT"
  | "NOTION_REVIEW_PLAN_INVALID"
  | "NOTION_REVIEW_PLAN_CONFLICT"
  | "NOTION_REVIEW_REVISION_CONFLICT"
  | "NOTION_REVIEW_SET_LINK_CONFLICT"
  | "NOTION_RECOVERY_CONFLICT"
  | "NOTION_RECOVERY_SCHEMA_REQUIRED"
  | "NOTION_RECOVERY_ALREADY_RECORDED";

/** Deliberately excludes upstream messages, bodies, URLs, headers, and causes. */
export class NotionSyncError extends Error {
  readonly code: NotionSyncErrorCode;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly retryAfterMs: number | undefined;
  readonly committedResourceId: string | undefined;

  constructor(
    code: NotionSyncErrorCode,
    options: {
      readonly retryable?: boolean;
      readonly ambiguous?: boolean;
      readonly retryAfterMs?: number;
      readonly committedResourceId?: string;
    } = {},
  ) {
    super(code);
    this.name = "NotionSyncError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.committedResourceId = options.committedResourceId;
  }
}

export interface NotionPage {
  readonly object: "page";
  readonly id: string;
  readonly parent: {
    readonly type: "data_source_id";
    readonly data_source_id: string;
  };
  readonly archived: boolean;
  readonly in_trash: boolean;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface NotionClientOptions {
  readonly token: string;
  readonly attemptsDataSourceId: string;
  readonly questionsDataSourceId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface NotionQuestionMetadata {
  readonly question_key: string;
  readonly stopped: boolean;
  readonly next_review_on: string | null;
  readonly subjects: readonly string[];
  readonly fields: readonly string[];
}

export interface NotionReviewSnapshot {
  readonly attempts: readonly AttemptEventV1[];
  readonly recoveredAttempts?: readonly RecoveredAttemptV1[];
  readonly duplicateRecoveredRows?: number;
  readonly suppressedRecoveredRows?: number;
  readonly excludedFutureRecoveries?: number;
  readonly contexts: readonly StudyContextV1[];
  readonly questions: readonly NotionQuestionMetadata[];
  readonly unknownAttemptRows: number;
  readonly duplicateAttemptRows: number;
  readonly excludedFutureEvents: number;
  readonly excludedFromAggregationRows: number;
  readonly unknownQuestionRows: number;
  readonly readStartedAt: string;
  readonly readCompletedAt: string;
}

export interface NotionReviewPage {
  readonly id: string;
  readonly parentPageId: string;
  readonly title: string;
  readonly archived: boolean;
  readonly in_trash: boolean;
}

export interface NotionReviewBlock {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly hasChildren: boolean;
  readonly links?: readonly string[];
}

const STUDY_MODE_LABELS = { normal: "通常学習", review: "復習", unclassified: "未分類" } as const;

export function canonicalStudyContext(context: StudyContextV1): string {
  if (!validateStudyContextV1(context)) throw new NotionSyncError("NOTION_EVENT_UNSUPPORTED");
  return JSON.stringify({ schema_version: "1", record_type: "study_context", event_id: context.event_id,
    study_mode: context.study_mode, ...(context.review_plan_id === undefined ? {} : { review_plan_id: context.review_plan_id }) });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value !== "string" || !UUID.test(value)) {
    return undefined;
  }
  const compact = value.replaceAll("-", "").toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function requireId(value: unknown): string {
  const id = normalizeId(value);
  if (id === undefined) {
    throw new NotionSyncError("NOTION_CONFIG_INVALID");
  }
  return id;
}

function normalizedTimestamp(value: string): string {
  const normalized = normalizeExactTimestamp(value);
  if (!normalized.ok) {
    throw new NotionSyncError("NOTION_EVENT_UNSUPPORTED");
  }
  return normalized.value;
}

/** Notion date properties are a minute-precision display; V1 retains the exact instant. */
function notionDateTimestamp(value: string): string {
  return `${normalizedTimestamp(value).slice(0, 16)}:00.000Z`;
}

/** A recoverable, deterministic V1 record; never includes DOM or unknown keys. */
export function canonicalAttempt(event: AttemptEventV1): string {
  if (!validateAttemptEventV1(event)) {
    throw new NotionSyncError("NOTION_EVENT_UNSUPPORTED");
  }
  const value: AttemptEventV1 = {
    schema_version: event.schema_version,
    record_type: event.record_type,
    event_id: event.event_id,
    question_key: event.question_key,
    ...(event.question_group_id === undefined ? {} : { question_group_id: event.question_group_id }),
    answered_at: normalizedTimestamp(event.answered_at),
    result: event.result,
    selected_option_indices: [...event.selected_option_indices].sort((left, right) => left - right),
    provenance: {
      producer: event.provenance.producer,
      producer_version: event.provenance.producer_version,
      source_system: event.provenance.source_system,
      ...(event.provenance.source_record_id === undefined
        ? {} : { source_record_id: event.provenance.source_record_id }),
      recorded_at: normalizedTimestamp(event.provenance.recorded_at),
    },
    quality: {
      acquisition_method: event.quality.acquisition_method,
      temporal_precision: event.quality.temporal_precision,
      state_precision: event.quality.state_precision,
    },
  };
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) {
    throw new NotionSyncError("NOTION_EVENT_UNSUPPORTED");
  }
  return serialized;
}

/** Separate evidence: no exact answer timestamp or selected option is manufactured. */
export function canonicalRecoveredAttempt(value: RecoveredAttemptV1): string {
  if (!validateRecoveredAttemptV1(value)) throw new NotionSyncError("NOTION_EVENT_UNSUPPORTED");
  return JSON.stringify({
    schema_version: "1", record_type: "recovered_attempt", recovery_id: requireId(value.recovery_id),
    question_key: value.question_key, answered_on: value.answered_on, result: value.result,
    observed_at: normalizedTimestamp(value.observed_at), recovered_at: normalizedTimestamp(value.recovered_at),
    study_mode: "unclassified", selected_option_indices: null, source_system: "computer-history",
    source_event_id: value.source_event_id, source_segment: value.source_segment,
  });
}

export function recoveredAttemptProperties(value: RecoveredAttemptV1, questionPageId: string): Readonly<Record<string, unknown>> {
  const canonical = canonicalRecoveredAttempt(value);
  return {
    "記録名": { title: textValue(`補完 ${value.question_key} ${value.answered_on}`) },
    "補完ID": richText(requireId(value.recovery_id)), "補完データV1": richText(canonical),
    "問題キー": richText(value.question_key), "問題番号": richText(value.question_key),
    "自分の解答": richText(""), "イベントID": richText(""), "記録データV1": richText(""),
    "判定": { select: { name: value.result === "correct" ? "正解" : "不正解" } },
    "解答日時": { date: { start: value.answered_on } }, "学習日": { date: { start: value.answered_on } },
    "観測日時": { date: { start: notionDateTimestamp(value.observed_at) } },
    "取得日時": { date: { start: notionDateTimestamp(value.recovered_at) } },
    "問題": { relation: [{ id: requireId(questionPageId) }] },
    "記録元": { select: { name: "Computer History補完" } },
    "スキーマバージョン": richText("recovered-attempt-v1"), "学習種別": { select: { name: "未分類" } },
  };
}

function textValue(text: string): readonly unknown[] {
  const chunks: unknown[] = [];
  for (let position = 0; position < text.length; position += 2_000) {
    chunks.push({ type: "text", text: { content: text.slice(position, position + 2_000) } });
  }
  return chunks;
}

function richText(text: string): unknown {
  return { rich_text: textValue(text) };
}

function selectedLetters(event: AttemptEventV1): string {
  if (event.provenance.producer !== "browser-extension" || event.provenance.source_system !== "qb-web-dom"
    || event.selected_option_indices.some((value) => !Number.isInteger(value) || value < 1 || value > 5)) {
    throw new NotionSyncError("NOTION_EVENT_UNSUPPORTED");
  }
  return [...event.selected_option_indices].sort((left, right) => left - right)
    .map((value) => String.fromCharCode(96 + value)).join(",");
}

/** iOS keeps V1 compatible and identifies its producer build explicitly. */
function sourceLabel(event: AttemptEventV1): string {
  return /^ios-[0-9]+\.[0-9]+\.[0-9]+(?:[-+.][A-Za-z0-9.-]+)?$/u.test(event.provenance.producer_version)
    ? "Safari拡張" : "Chrome拡張";
}

function resultLabel(event: AttemptEventV1): string {
  return { correct: "正解", incorrect: "不正解", unknown: "未判定" }[event.result];
}

export function questionProperties(event: AttemptEventV1): Readonly<Record<string, unknown>> {
  canonicalAttempt(event);
  selectedLetters(event);
  return {
    "問題番号": { title: textValue(event.question_key) },
    "問題キー": richText(event.question_key),
  };
}

export function attemptProperties(
  event: AttemptEventV1,
  questionPageId: string,
  options: { readonly includeExtensionVersion?: boolean; readonly studyContext?: StudyContextV1 } = {},
): Readonly<Record<string, unknown>> {
  const serialized = canonicalAttempt(event);
  const letters = selectedLetters(event);
  if (options.studyContext !== undefined && options.studyContext.event_id !== event.event_id) {
    throw new NotionSyncError("NOTION_STUDY_CONTEXT_CONFLICT");
  }
  let studyDay: string;
  try {
    studyDay = toTokyoDate(event.answered_at);
  } catch {
    throw new NotionSyncError("NOTION_EVENT_UNSUPPORTED");
  }
  return {
    "記録名": { title: textValue(`${event.question_key} ${normalizedTimestamp(event.answered_at)}`) },
    "イベントID": richText(event.event_id),
    "問題キー": richText(event.question_key),
    "問題番号": richText(event.question_key),
    "自分の解答": richText(letters),
    "判定": { select: { name: resultLabel(event) } },
    "解答日時": { date: { start: notionDateTimestamp(event.answered_at) } },
    "学習日": { date: { start: studyDay } },
    "取得日時": { date: { start: notionDateTimestamp(event.provenance.recorded_at) } },
    "問題": { relation: [{ id: requireId(questionPageId) }] },
    "記録元": { select: { name: sourceLabel(event) } },
    "スキーマバージョン": richText(event.schema_version),
    "学習種別": { select: { name: options.studyContext === undefined ? "未分類" : STUDY_MODE_LABELS[options.studyContext.study_mode] } },
    "記録データV1": richText(serialized),
    ...(options.studyContext === undefined ? {} : { "学習目的データV1": richText(canonicalStudyContext(options.studyContext)) }),
    ...(options.includeExtensionVersion === true
      ? { "拡張バージョン": richText(event.provenance.producer_version) } : {}),
  };
}

function property(page: NotionPage, name: string, type: string): Record<string, unknown> | undefined {
  const value = page.properties[name];
  return record(value) && value.type === type ? value : undefined;
}

function readText(page: NotionPage, name: string): string | undefined {
  const items = property(page, name, "rich_text")?.rich_text;
  if (!Array.isArray(items) || items.length > 100) {
    return undefined;
  }
  let text = "";
  for (const item of items) {
    if (!record(item) || item.type !== "text" || !record(item.text)
      || typeof item.text.content !== "string" || item.text.content.length > 2_000
      || (item.plain_text !== undefined && item.plain_text !== item.text.content)) {
      return undefined;
    }
    text += item.text.content;
  }
  return text;
}

function sameDate(page: NotionPage, name: string, expected: string, dateOnly = false): boolean {
  const date = property(page, name, "date")?.date;
  if (!record(date) || typeof date.start !== "string" || date.end !== null || date.time_zone !== null) {
    return false;
  }
  if (dateOnly) {
    return date.start === expected;
  }
  const normalized = normalizeExactTimestamp(date.start);
  // Permit exact historical values or Notion's observed minute-floor representation.
  // Never accept an arbitrary timestamp merely because it falls within that minute.
  return normalized.ok && (normalized.value === normalizedTimestamp(expected)
    || normalized.value === notionDateTimestamp(expected));
}

function sameSelect(page: NotionPage, name: string, expected: string): boolean {
  const selected = property(page, name, "select")?.select;
  return record(selected) && selected.name === expected;
}

export function relationPageIds(page: NotionPage): readonly string[] {
  const relation = property(page, "問題", "relation");
  if (relation === undefined || relation.has_more !== false || !Array.isArray(relation.relation)
    || relation.relation.length > 100) {
    throw new NotionSyncError("NOTION_RESPONSE_INVALID");
  }
  return relation.relation.map((item: unknown) => {
    const id = record(item) ? normalizeId(item.id) : undefined;
    if (id === undefined) {
      throw new NotionSyncError("NOTION_RESPONSE_INVALID");
    }
    return id;
  });
}

export function matchesQuestion(page: NotionPage, questionKey: string): boolean {
  return !page.archived && !page.in_trash
    && QUESTION_KEY.test(questionKey) && readText(page, "問題キー") === questionKey;
}

export function readCanonicalAttempt(page: NotionPage): AttemptEventV1 | undefined {
  try {
    const serialized = readText(page, "記録データV1");
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) {
      return undefined;
    }
    const recovered: unknown = JSON.parse(serialized);
    return validateAttemptEventV1(recovered) ? recovered : undefined;
  } catch {
    return undefined;
  }
}

export function readCanonicalRecoveredAttempt(page: NotionPage): RecoveredAttemptV1 | undefined {
  try {
    const serialized = readText(page, "補完データV1");
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    return validateRecoveredAttemptV1(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function hasRecoveryEvidence(page: NotionPage): boolean {
  return ["補完ID", "補完データV1"].some((name) => Object.hasOwn(page.properties, name) && readText(page, name) !== "")
    || sameSelect(page, "記録元", "Computer History補完");
}

export function matchesRecoveredAttempt(page: NotionPage, value: RecoveredAttemptV1, questionPageId?: string): boolean {
  try {
    const parsed = readCanonicalRecoveredAttempt(page);
    if (page.archived || page.in_trash || parsed === undefined
      || canonicalRecoveredAttempt(parsed) !== canonicalRecoveredAttempt(value)) return false;
    if (["イベントID", "記録データV1", "学習目的データV1"].some((name) => {
      const text = readText(page, name);
      return Object.hasOwn(page.properties, name) && text !== "";
    })) return false;
    if (readText(page, "補完ID") !== requireId(value.recovery_id)
      || readText(page, "問題キー") !== value.question_key || readText(page, "問題番号") !== value.question_key
      || readText(page, "自分の解答") !== "" || readText(page, "スキーマバージョン") !== "recovered-attempt-v1"
      || !sameSelect(page, "判定", value.result === "correct" ? "正解" : "不正解")
      || !sameSelect(page, "記録元", "Computer History補完") || !sameSelect(page, "学習種別", "未分類")
      || !sameDate(page, "解答日時", value.answered_on, true) || !sameDate(page, "学習日", value.answered_on, true)
      || !sameDate(page, "観測日時", value.observed_at) || !sameDate(page, "取得日時", value.recovered_at)) return false;
    if (questionPageId !== undefined) {
      const ids = relationPageIds(page);
      return ids.length === 1 && ids[0] === requireId(questionPageId);
    }
    return true;
  } catch { return false; }
}

export function readStudyContext(page: NotionPage): StudyContextV1 | undefined {
  const raw = readText(page, "学習目的データV1");
  if (Object.hasOwn(page.properties, "学習目的データV1") && raw === undefined) {
    throw new NotionSyncError("NOTION_STUDY_CONTEXT_CONFLICT");
  }
  if (raw === undefined || raw === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!validateStudyContextV1(parsed)) throw new Error("INVALID");
    return parsed;
  } catch {
    throw new NotionSyncError("NOTION_STUDY_CONTEXT_CONFLICT");
  }
}

export function matchesAttempt(page: NotionPage, event: AttemptEventV1, questionPageId?: string): boolean {
  try {
    if (page.archived || page.in_trash) {
      return false;
    }
    const recovered = readCanonicalAttempt(page);
    if (recovered === undefined || canonicalAttempt(recovered) !== canonicalAttempt(event)) {
      return false;
    }
    const immutableText: Readonly<Record<string, string>> = {
      "イベントID": event.event_id,
      "問題キー": event.question_key,
      "問題番号": event.question_key,
      "自分の解答": selectedLetters(event),
      "スキーマバージョン": event.schema_version,
    };
    if (!Object.entries(immutableText).every(([name, expected]) => readText(page, name) === expected)
      || !sameSelect(page, "判定", resultLabel(event))
      || !sameSelect(page, "記録元", sourceLabel(event))
      || !sameDate(page, "解答日時", event.answered_at)
      || !sameDate(page, "取得日時", event.provenance.recorded_at)
      || !sameDate(page, "学習日", toTokyoDate(event.answered_at), true)) {
      return false;
    }
    if (questionPageId !== undefined) {
      const relation = relationPageIds(page);
      return relation.length === 1 && relation[0] === requireId(questionPageId);
    }
    return true;
  } catch {
    return false;
  }
}

const ATTEMPT_SCHEMA: Readonly<Record<string, string>> = {
  "記録名": "title", "イベントID": "rich_text", "問題キー": "rich_text", "問題番号": "rich_text",
  "自分の解答": "rich_text", "判定": "select", "解答日時": "date", "学習日": "date",
  "取得日時": "date", "問題": "relation", "記録元": "select", "スキーマバージョン": "rich_text",
  "学習種別": "select", "記録データV1": "rich_text",
};
const QUESTION_SCHEMA: Readonly<Record<string, string>> = { "問題番号": "title", "問題キー": "rich_text" };
const RECOVERY_SCHEMA: Readonly<Record<string, string>> = { "補完ID": "rich_text", "補完データV1": "rich_text", "観測日時": "date" };
const RETAINED_PROPERTIES = new Set([...Object.keys(ATTEMPT_SCHEMA), "拡張バージョン", "学習目的データV1",
  ...Object.keys(RECOVERY_SCHEMA), "復習停止", "次回復習日", "科目", "分野", "集計除外"]);

function parsePage(value: unknown, allowedSources: readonly string[]): NotionPage {
  if (!record(value) || value.object !== "page" || normalizeId(value.id) === undefined
    || !record(value.parent) || value.parent.type !== "data_source_id"
    || typeof value.archived !== "boolean" || typeof value.in_trash !== "boolean"
    || value.archived !== value.in_trash || !record(value.properties)) {
    throw new NotionSyncError("NOTION_RESPONSE_INVALID");
  }
  const sourceId = normalizeId(value.parent.data_source_id);
  if (sourceId === undefined || !allowedSources.includes(sourceId)) {
    throw new NotionSyncError("NOTION_RESPONSE_INVALID");
  }
  const properties: Record<string, unknown> = {};
  for (const [name, propertyValue] of Object.entries(value.properties)) {
    if (RETAINED_PROPERTIES.has(name)) {
      if (!record(propertyValue) || typeof propertyValue.type !== "string") {
        throw new NotionSyncError("NOTION_RESPONSE_INVALID");
      }
      properties[name] = propertyValue;
    }
  }
  return {
    object: "page", id: requireId(value.id),
    parent: { type: "data_source_id", data_source_id: sourceId },
    archived: value.archived, in_trash: value.in_trash, properties,
  };
}

function schemaProperties(value: unknown, expectedId: string): Record<string, unknown> {
  if (!record(value) || value.object !== "data_source" || normalizeId(value.id) !== expectedId
    || !record(value.properties) || value.in_trash === true || value.archived === true) {
    throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
  }
  return value.properties;
}

function validateProperties(actual: Record<string, unknown>, required: Readonly<Record<string, string>>): void {
  for (const [name, type] of Object.entries(required)) {
    const value = actual[name];
    if (!record(value) || value.type !== type || !record(value[type])) {
      throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
    }
  }
}

function requireSelectOptions(properties: Record<string, unknown>, name: string, required: readonly string[]): void {
  const prop = properties[name];
  const select = record(prop) ? prop.select : undefined;
  const options = record(select) ? select.options : undefined;
  if (!Array.isArray(options)
    || !required.every((name) => options.some((option: unknown) => record(option) && option.name === name))) {
    throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/u.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new NotionSyncError("NOTION_RESPONSE_TOO_LARGE");
  }
  if (response.body === null) {
    throw new NotionSyncError("NOTION_RESPONSE_INVALID");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new NotionSyncError("NOTION_RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof NotionSyncError) {
      throw error;
    }
    throw new NotionSyncError("NOTION_RESPONSE_INVALID");
  } finally {
    reader.releaseLock();
  }
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) {
    return undefined;
  }
  const seconds = /^\d+(?:\.\d+)?$/u.test(raw) ? Number(raw) : undefined;
  const milliseconds = seconds === undefined ? Date.parse(raw) - Date.now() : Math.ceil(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
}

function metadataLabels(page: NotionPage, name: string): readonly string[] {
  const value = page.properties[name];
  if (value === undefined) return [];
  if (!record(value)) throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
  let labels: unknown[];
  if (value.type === "rich_text") {
    const text = readText(page, name);
    if (text === undefined || text.length > 1_000 || containsControlCharacter(text)) throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
    return text === "" ? [] : [text];
  }
  if (value.type === "select") labels = value.select === null ? [] : [value.select];
  else if (value.type === "multi_select" && Array.isArray(value.multi_select)) labels = value.multi_select;
  else throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
  return [...new Set(labels.map((label) => {
    if (!record(label) || typeof label.name !== "string" || label.name.length < 1 || label.name.length > 100
      || containsControlCharacter(label.name)) throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
    return label.name;
  }))].sort();
}

function questionMetadata(page: NotionPage): NotionQuestionMetadata | undefined {
  const questionKey = readText(page, "問題キー");
  if (questionKey === undefined || !QUESTION_KEY.test(questionKey)) return undefined;
  const stopped = page.properties["復習停止"];
  if (stopped !== undefined && (!record(stopped) || stopped.type !== "checkbox" || typeof stopped.checkbox !== "boolean")) {
    throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
  }
  const due = page.properties["次回復習日"];
  let dueOn: string | null = null;
  if (due !== undefined) {
    if (!record(due) || due.type !== "date") throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
    if (due.date !== null) {
      if (!record(due.date) || typeof due.date.start !== "string" || !isValidLocalDate(due.date.start)
        || due.date.end !== null || due.date.time_zone !== null) throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
      dueOn = due.date.start;
    }
  }
  return { question_key: questionKey, stopped: record(stopped) && stopped.checkbox === true,
    next_review_on: dueOn, subjects: metadataLabels(page, "科目"), fields: metadataLabels(page, "分野") };
}

function ordinaryPage(value: unknown, expectedParent: string): NotionReviewPage {
  if (!record(value) || value.object !== "page" || normalizeId(value.id) === undefined
    || !record(value.parent) || value.parent.type !== "page_id" || normalizeId(value.parent.page_id) !== expectedParent
    || value.archived !== false || value.in_trash !== false || !record(value.properties)) {
    throw new NotionSyncError("NOTION_PAGE_MISMATCH");
  }
  const title = value.properties.title;
  if (!record(title) || title.type !== "title" || !Array.isArray(title.title)) throw new NotionSyncError("NOTION_RESPONSE_INVALID");
  let text = "";
  for (const part of title.title) {
    if (!record(part) || part.type !== "text" || !record(part.text) || typeof part.text.content !== "string") {
      throw new NotionSyncError("NOTION_RESPONSE_INVALID");
    }
    text += part.text.content;
  }
  if (text.length > 200) throw new NotionSyncError("NOTION_RESPONSE_INVALID");
  return { id: requireId(value.id), parentPageId: expectedParent, title: text, archived: false, in_trash: false };
}

export class NotionClient {
  readonly #token: string;
  readonly #attemptsId: string;
  readonly #questionsId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #requestQueue: Promise<void> = Promise.resolve();
  #lastRequestAt: number | undefined;
  #schemaValidated = false;
  #extensionVersion = false;
  #studyContextSchema = false;
  #recoverySchema = false;
  #studyModeLabels = new Set<string>();

  constructor(options: NotionClientOptions) {
    if (options.token.length < 1 || options.token.length > 4_096 || /\s/u.test(options.token)) {
      throw new NotionSyncError("NOTION_CONFIG_INVALID");
    }
    this.#token = options.token;
    this.#attemptsId = requireId(options.attemptsDataSourceId);
    this.#questionsId = requireId(options.questionsDataSourceId);
    if (this.#attemptsId === this.#questionsId) {
      throw new NotionSyncError("NOTION_CONFIG_INVALID");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? (async (milliseconds) => { await delay(milliseconds); });
  }

  async validateSchema(): Promise<void> {
    this.#schemaValidated = false;
    const questions = schemaProperties(await this.#request("GET", `/data_sources/${this.#questionsId}`), this.#questionsId);
    const attempts = schemaProperties(await this.#request("GET", `/data_sources/${this.#attemptsId}`), this.#attemptsId);
    validateProperties(questions, QUESTION_SCHEMA);
    validateProperties(attempts, ATTEMPT_SCHEMA);
    requireSelectOptions(attempts, "判定", ["正解", "不正解", "未判定"]);
    requireSelectOptions(attempts, "記録元", ["Chrome拡張"]);
    requireSelectOptions(attempts, "学習種別", ["未分類"]);
    const studyMode = attempts["学習種別"];
    this.#studyModeLabels = new Set(record(studyMode) && record(studyMode.select) && Array.isArray(studyMode.select.options)
      ? studyMode.select.options.flatMap((option: unknown) => record(option) && typeof option.name === "string" ? [option.name] : []) : []);
    const relation = attempts["問題"];
    if (!record(relation) || !record(relation.relation)
      || normalizeId(relation.relation.data_source_id) !== this.#questionsId) {
      throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
    }
    this.#extensionVersion = Object.hasOwn(attempts, "拡張バージョン");
    if (this.#extensionVersion) {
      validateProperties(attempts, { "拡張バージョン": "rich_text" });
    }
    this.#studyContextSchema = Object.hasOwn(attempts, "学習目的データV1");
    if (this.#studyContextSchema) validateProperties(attempts, { "学習目的データV1": "rich_text" });
    for (const [name, type] of Object.entries(RECOVERY_SCHEMA)) {
      if (Object.hasOwn(attempts, name)) validateProperties(attempts, { [name]: type });
    }
    const source = attempts["記録元"];
    this.#recoverySchema = Object.keys(RECOVERY_SCHEMA).every((name) => Object.hasOwn(attempts, name))
      && record(source) && record(source.select) && Array.isArray(source.select.options)
      && source.select.options.some((option: unknown) => record(option) && option.name === "Computer History補完");
    for (const [name, types] of Object.entries({ "復習停止": ["checkbox"], "次回復習日": ["date"],
      "科目": ["rich_text", "select", "multi_select"], "分野": ["rich_text", "select", "multi_select"] })) {
      const metadata = questions[name];
      if (metadata !== undefined && (!record(metadata) || typeof metadata.type !== "string" || !types.includes(metadata.type))) {
        throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
      }
    }
    if (Object.hasOwn(attempts, "集計除外")) validateProperties(attempts, { "集計除外": "checkbox" });
    this.#schemaValidated = true;
  }

  /** Explicit migration entry point. Normal capture/reads never alter schema or option lists. */
  async ensureStudyContextSchema(): Promise<void> {
    await this.validateSchema();
    const attempts = schemaProperties(await this.#request("GET", `/data_sources/${this.#attemptsId}`), this.#attemptsId);
    const mode = attempts["学習種別"];
    if (!record(mode) || !record(mode.select) || !Array.isArray(mode.select.options)) throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
    const existing = mode.select.options.map((option: unknown) => {
      if (!record(option) || typeof option.name !== "string") throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
      return { ...(typeof option.id === "string" ? { id: option.id } : {}), name: option.name,
        ...(typeof option.color === "string" ? { color: option.color } : {}) };
    });
    const additions = Object.values(STUDY_MODE_LABELS).filter((name) => !existing.some((item) => item.name === name));
    if (!this.#studyContextSchema || additions.length > 0) {
      await this.#request("PATCH", `/data_sources/${this.#attemptsId}`, { properties: {
        ...(!this.#studyContextSchema ? { "学習目的データV1": { rich_text: {} } } : {}),
        ...(additions.length > 0 ? { "学習種別": { select: { options: [...existing, ...additions.map((name) => ({ name }))] } } } : {}),
      } });
    }
    await this.validateSchema();
    const saved = schemaProperties(await this.#request("GET", `/data_sources/${this.#attemptsId}`), this.#attemptsId);
    requireSelectOptions(saved, "学習種別", Object.values(STUDY_MODE_LABELS));
    if (!this.#studyContextSchema) throw new NotionSyncError("NOTION_STUDY_CONTEXT_SCHEMA_REQUIRED");
  }

  /** Explicit additive migration; normal reads and writes never silently create properties/options. */
  async ensureRecoveredAttemptSchema(): Promise<void> {
    await this.validateSchema();
    const attempts = schemaProperties(await this.#request("GET", `/data_sources/${this.#attemptsId}`), this.#attemptsId);
    const source = attempts["記録元"];
    if (!record(source) || !record(source.select) || !Array.isArray(source.select.options)) throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
    const existing = source.select.options.map((option: unknown) => {
      if (!record(option) || typeof option.name !== "string") throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
      return { ...(typeof option.id === "string" ? { id: option.id } : {}), name: option.name,
        ...(typeof option.color === "string" ? { color: option.color } : {}) };
    });
    const properties: Record<string, unknown> = {};
    for (const [name, type] of Object.entries(RECOVERY_SCHEMA)) {
      if (!Object.hasOwn(attempts, name)) properties[name] = { [type]: {} };
    }
    if (!existing.some(({ name }) => name === "Computer History補完")) {
      properties["記録元"] = { select: { options: [...existing, { name: "Computer History補完" }] } };
    }
    if (Object.keys(properties).length > 0) await this.#request("PATCH", `/data_sources/${this.#attemptsId}`, { properties });
    await this.validateSchema();
    if (!this.#recoverySchema) throw new NotionSyncError("NOTION_RECOVERY_SCHEMA_REQUIRED");
  }

  /** Full data-source pagination; never presents a partial 1000-row result as complete. */
  async readReviewSnapshot(options: { readonly asOf: string }): Promise<NotionReviewSnapshot> {
    const asOf = normalizedTimestamp(options.asOf);
    const readStartedAt = new Date().toISOString();
    await this.validateSchema();
    const events = new Map<string, { event: AttemptEventV1; canonical: string }>();
    const recoveries = new Map<string, { event: RecoveredAttemptV1; canonical: string }>();
    const contexts = new Map<string, StudyContextV1>();
    let unknownAttemptRows = 0;
    let duplicateAttemptRows = 0;
    let excludedFromAggregationRows = 0;
    let duplicateRecoveredRows = 0;
    for (const page of await this.#allPages(this.#attemptsId)) {
      const exclusion = page.properties["集計除外"];
      if (exclusion !== undefined && (!record(exclusion) || exclusion.type !== "checkbox" || typeof exclusion.checkbox !== "boolean")) {
        throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
      }
      if (record(exclusion) && exclusion.checkbox === true) { excludedFromAggregationRows++; continue; }
      if (hasRecoveryEvidence(page)) {
        const recovery = readCanonicalRecoveredAttempt(page);
        if (recovery === undefined || !matchesRecoveredAttempt(page, recovery)) throw new NotionSyncError("NOTION_RECOVERY_CONFLICT");
        const canonical = canonicalRecoveredAttempt(recovery);
        const id = requireId(recovery.recovery_id);
        const existing = recoveries.get(id);
        if (existing !== undefined && existing.canonical !== canonical) throw new NotionSyncError("NOTION_RECOVERY_CONFLICT");
        if (existing !== undefined) duplicateRecoveredRows++;
        else recoveries.set(id, { event: JSON.parse(canonical) as RecoveredAttemptV1, canonical });
        continue;
      }
      const event = readCanonicalAttempt(page);
      if (event === undefined) { unknownAttemptRows++; continue; }
      if (!matchesAttempt(page, event)) throw new NotionSyncError("NOTION_EVENT_CONFLICT");
      const canonical = canonicalAttempt(event);
      const existing = events.get(event.event_id);
      if (existing !== undefined && existing.canonical !== canonical) throw new NotionSyncError("NOTION_EVENT_CONFLICT");
      if (existing !== undefined) duplicateAttemptRows++;
      else events.set(event.event_id, { event: JSON.parse(canonical) as AttemptEventV1, canonical });
      const context = readStudyContext(page);
      if (context !== undefined) {
        if (context.event_id !== event.event_id) throw new NotionSyncError("NOTION_STUDY_CONTEXT_CONFLICT");
        const existingContext = contexts.get(event.event_id);
        if (existingContext !== undefined && canonicalStudyContext(existingContext) !== canonicalStudyContext(context)) {
          throw new NotionSyncError("NOTION_STUDY_CONTEXT_CONFLICT");
        }
        contexts.set(event.event_id, context);
      }
    }
    const questions = new Map<string, NotionQuestionMetadata>();
    let unknownQuestionRows = 0;
    for (const page of await this.#allPages(this.#questionsId)) {
      const metadata = questionMetadata(page);
      if (metadata === undefined) { unknownQuestionRows++; continue; }
      const existing = questions.get(metadata.question_key);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(metadata)) {
        throw new NotionSyncError("NOTION_QUESTION_METADATA_CONFLICT");
      }
      questions.set(metadata.question_key, metadata);
    }
    const attempts = [...events.values()].map(({ event }) => event)
      .filter((event) => event.answered_at <= asOf && event.provenance.recorded_at <= asOf)
      .sort((left, right) => left.answered_at.localeCompare(right.answered_at) || left.event_id.localeCompare(right.event_id));
    const directDays = new Set(attempts.map((event) => `${event.question_key}:${toTokyoDate(event.answered_at)}`));
    const recoveriesByDay = new Map<string, RecoveredAttemptV1>();
    let suppressedRecoveredRows = 0;
    let excludedFutureRecoveries = 0;
    for (const { event } of recoveries.values()) {
      if (event.answered_on > toTokyoDate(asOf) || event.observed_at > asOf || event.recovered_at > asOf) {
        excludedFutureRecoveries++; continue;
      }
      const dayKey = `${event.question_key}:${event.answered_on}`;
      if (directDays.has(dayKey)) { suppressedRecoveredRows++; continue; }
      // Distinct recovery IDs cannot prove multiple answers to the same question on one day.
      if (recoveriesByDay.has(dayKey)) throw new NotionSyncError("NOTION_RECOVERY_CONFLICT");
      recoveriesByDay.set(dayKey, event);
    }
    const recoveredAttempts = [...recoveriesByDay.values()].sort((left, right) => left.answered_on.localeCompare(right.answered_on)
      || left.recovery_id.localeCompare(right.recovery_id));
    const included = new Set(attempts.map(({ event_id }) => event_id));
    return { attempts, recoveredAttempts, duplicateRecoveredRows, suppressedRecoveredRows, excludedFutureRecoveries,
      contexts: [...contexts.values()].filter(({ event_id }) => included.has(event_id)),
      questions: [...questions.values()].sort((left, right) => left.question_key.localeCompare(right.question_key)),
      unknownAttemptRows, duplicateAttemptRows, excludedFutureEvents: events.size - attempts.length, excludedFromAggregationRows, unknownQuestionRows,
      readStartedAt, readCompletedAt: new Date().toISOString() };
  }

  async findQuestion(questionKey: string): Promise<readonly NotionPage[]> {
    if (!QUESTION_KEY.test(questionKey)) {
      throw new NotionSyncError("NOTION_EVENT_UNSUPPORTED");
    }
    return this.#query(this.#questionsId, "問題キー", questionKey, false);
  }

  async findAttempt(eventId: string): Promise<readonly NotionPage[]> {
    requireId(eventId);
    return this.#query(this.#attemptsId, "イベントID", eventId, true);
  }

  async findAttemptsForQuestion(questionKey: string): Promise<readonly NotionPage[]> {
    if (!QUESTION_KEY.test(questionKey)) {
      throw new NotionSyncError("NOTION_EVENT_UNSUPPORTED");
    }
    return this.#query(this.#attemptsId, "問題キー", questionKey, false);
  }

  async createQuestion(event: AttemptEventV1): Promise<NotionPage> {
    const properties = questionProperties(event);
    await this.#ensureSchema();
    return this.#create(this.#questionsId, properties);
  }

  async createRecoveredQuestion(value: RecoveredAttemptV1): Promise<NotionPage> {
    canonicalRecoveredAttempt(value);
    await this.#ensureSchema();
    return this.#create(this.#questionsId, {
      "問題番号": { title: textValue(value.question_key) }, "問題キー": richText(value.question_key),
    });
  }

  async findRecoveredAttempt(recoveryId: string): Promise<readonly NotionPage[]> {
    const id = requireId(recoveryId);
    await this.#ensureSchema();
    if (!this.#recoverySchema) throw new NotionSyncError("NOTION_RECOVERY_SCHEMA_REQUIRED");
    return this.#query(this.#attemptsId, "補完ID", id, true);
  }

  async verifyRecoveredAttempt(pageId: string, value: RecoveredAttemptV1, questionPageId?: string): Promise<boolean> {
    canonicalRecoveredAttempt(value);
    const saved = await this.getPage(pageId);
    return saved.parent.data_source_id === this.#attemptsId && matchesRecoveredAttempt(saved, value, questionPageId);
  }

  /** Caller must persist create intent and never blindly repeat after an ambiguous response. */
  async createRecoveredAttempt(value: RecoveredAttemptV1, questionPageId: string): Promise<NotionPage> {
    const properties = recoveredAttemptProperties(value, questionPageId);
    await this.#ensureSchema();
    if (!this.#recoverySchema) throw new NotionSyncError("NOTION_RECOVERY_SCHEMA_REQUIRED");
    const existing = await this.findRecoveredAttempt(value.recovery_id);
    if (existing.length > 0) {
      if (existing.length !== 1 || !matchesRecoveredAttempt(existing[0]!, value, questionPageId)) {
        throw new NotionSyncError("NOTION_RECOVERY_CONFLICT");
      }
      return existing[0]!;
    }
    const master = await this.getPage(questionPageId);
    if (master.parent.data_source_id !== this.#questionsId || !matchesQuestion(master, value.question_key)) {
      throw new NotionSyncError("NOTION_PAGE_MISMATCH");
    }
    for (const page of await this.findAttemptsForQuestion(value.question_key)) {
      const exclusion = page.properties["集計除外"];
      if (exclusion !== undefined && (!record(exclusion) || exclusion.type !== "checkbox" || typeof exclusion.checkbox !== "boolean")) {
        throw new NotionSyncError("NOTION_SCHEMA_MISMATCH");
      }
      if (record(exclusion) && exclusion.checkbox === true) continue;
      const direct = readCanonicalAttempt(page);
      const recovery = readCanonicalRecoveredAttempt(page);
      if (hasRecoveryEvidence(page)) {
        if (recovery === undefined || !matchesRecoveredAttempt(page, recovery)) throw new NotionSyncError("NOTION_RECOVERY_CONFLICT");
        if (recovery.answered_on === value.answered_on) throw new NotionSyncError("NOTION_RECOVERY_ALREADY_RECORDED");
      } else if (direct !== undefined && matchesAttempt(page, direct)) {
        if (toTokyoDate(direct.answered_at) === value.answered_on) throw new NotionSyncError("NOTION_RECOVERY_ALREADY_RECORDED");
      } else {
        // An unrecognized row may be a prior answer; do not hide uncertainty by creating another.
        throw new NotionSyncError("NOTION_RECOVERY_CONFLICT");
      }
    }
    const created = await this.#create(this.#attemptsId, properties);
    if (!matchesRecoveredAttempt(created, value, questionPageId)) {
      throw new NotionSyncError("NOTION_RESPONSE_INVALID", { ambiguous: true });
    }
    return created;
  }

  async createAttempt(event: AttemptEventV1, questionPageId: string, studyContext?: StudyContextV1): Promise<NotionPage> {
    // Validate before any network call, even when schema validation is needed.
    attemptProperties(event, questionPageId, studyContext === undefined ? {} : { studyContext });
    await this.#ensureSchema();
    if (studyContext !== undefined && (!this.#studyContextSchema || !this.#studyModeLabels.has(STUDY_MODE_LABELS[studyContext.study_mode]))) {
      throw new NotionSyncError("NOTION_STUDY_CONTEXT_SCHEMA_REQUIRED");
    }
    return this.#create(this.#attemptsId, attemptProperties(event, questionPageId, {
      includeExtensionVersion: this.#extensionVersion,
      ...(studyContext === undefined ? {} : { studyContext }),
    }));
  }

  async backfillStudyContext(pageId: string, event: AttemptEventV1, context: StudyContextV1): Promise<void> {
    const canonical = canonicalStudyContext(context);
    if (context.event_id !== event.event_id) throw new NotionSyncError("NOTION_STUDY_CONTEXT_CONFLICT");
    await this.#ensureSchema();
    if (!this.#studyContextSchema) throw new NotionSyncError("NOTION_STUDY_CONTEXT_SCHEMA_REQUIRED");
    const page = await this.getPage(pageId);
    if (page.parent.data_source_id !== this.#attemptsId || !matchesAttempt(page, event)) throw new NotionSyncError("NOTION_EVENT_CONFLICT");
    const existing = readStudyContext(page);
    if (existing !== undefined) {
      if (canonicalStudyContext(existing) !== canonical) throw new NotionSyncError("NOTION_STUDY_CONTEXT_CONFLICT");
      return;
    }
    // Add evidence only. Preserve the user's existing display classification and every attempt field.
    await this.#request("PATCH", `/pages/${page.id}`, { properties: { "学習目的データV1": richText(canonical) } });
    const saved = await this.getPage(page.id);
    const savedContext = readStudyContext(saved);
    if (!matchesAttempt(saved, event) || savedContext === undefined || canonicalStudyContext(savedContext) !== canonical) {
      throw new NotionSyncError("NOTION_STUDY_CONTEXT_CONFLICT");
    }
  }

  async getPage(pageId: string): Promise<NotionPage> {
    const id = requireId(pageId);
    const page = parsePage(await this.#request("GET", `/pages/${id}`), [this.#attemptsId, this.#questionsId]);
    if (page.id !== id) {
      throw new NotionSyncError("NOTION_PAGE_MISMATCH");
    }
    return page;
  }

  async linkAttempt(pageId: string, questionPageId: string): Promise<void> {
    const id = requireId(pageId);
    const questionId = requireId(questionPageId);
    await this.#ensureSchema();
    const response = await this.#request("PATCH", `/pages/${id}`, {
      properties: { "問題": { relation: [{ id: questionId }] } },
    });
    let page: NotionPage;
    try {
      page = parsePage(response, [this.#attemptsId]);
      const linked = relationPageIds(page);
      if (page.id !== id || page.archived || linked.length !== 1 || linked[0] !== questionId) {
        throw new NotionSyncError("NOTION_PAGE_MISMATCH");
      }
    } catch {
      throw new NotionSyncError("NOTION_RESPONSE_INVALID", { retryable: true, ambiguous: true });
    }
  }

  async listReviewChildPages(parentPageId: string): Promise<readonly { id: string; title: string }[]> {
    const parent = requireId(parentPageId);
    await this.#checkReviewParent(parent);
    return (await this.readReviewBlocks(parent)).filter((block) => block.type === "child_page")
      .map((block) => ({ id: block.id, title: block.text }));
  }

  async assertReviewParent(parentPageId: string): Promise<void> {
    await this.#checkReviewParent(requireId(parentPageId));
  }

  async getReviewPage(pageId: string, parentPageId: string): Promise<NotionReviewPage> {
    const id = requireId(pageId);
    const page = ordinaryPage(await this.#request("GET", `/pages/${id}`), requireId(parentPageId));
    if (page.id !== id) throw new NotionSyncError("NOTION_PAGE_MISMATCH");
    return page;
  }

  async createReviewPage(parentPageId: string, title: string, children: readonly unknown[]): Promise<NotionReviewPage> {
    const parent = requireId(parentPageId);
    if (!/^QB復習候補 \d{4}-\d{2}-\d{2}$/u.test(title) || !isValidLocalDate(title.slice(-10)) || children.length > 100) {
      throw new NotionSyncError("NOTION_REVIEW_PLAN_INVALID");
    }
    const body = { parent: { type: "page_id", page_id: parent }, properties: { title: { type: "title", title: textValue(title) } }, children };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 450_000) throw new NotionSyncError("NOTION_REVIEW_PLAN_INVALID");
    await this.#checkReviewParent(parent);
    const response = await this.#request("POST", "/pages", body);
    try {
      const page = ordinaryPage(response, parent);
      if (page.title !== title) throw new NotionSyncError("NOTION_PAGE_MISMATCH");
      return page;
    } catch {
      throw new NotionSyncError("NOTION_RESPONSE_INVALID", { retryable: true, ambiguous: true });
    }
  }

  async readReviewBlocks(pageOrBlockId: string): Promise<readonly NotionReviewBlock[]> {
    const id = requireId(pageOrBlockId);
    const blocks: NotionReviewBlock[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const response = await this.#request("GET", `/blocks/${id}/children?page_size=100${cursor === undefined ? "" : `&start_cursor=${encodeURIComponent(cursor)}`}`);
      const list = this.#parseList(response);
      for (const value of list.results) {
        if (!record(value) || value.object !== "block" || normalizeId(value.id) === undefined
          || typeof value.type !== "string" || typeof value.has_children !== "boolean") throw new NotionSyncError("NOTION_RESPONSE_INVALID");
        if (value.archived === true || value.in_trash === true) continue;
        const body = value[value.type];
        let text = "";
        const links: string[] = [];
        if (record(body) && value.type === "child_page" && typeof body.title === "string") text = body.title;
        else if (record(body) && Array.isArray(body.rich_text)) {
          for (const item of body.rich_text) {
            if (!record(item) || item.type !== "text" || !record(item.text) || typeof item.text.content !== "string") {
              // Unrelated blocks on the parent may contain mentions or equations.
              // An unsupported representation cannot match our exact plain-text blocks.
              text = "";
              break;
            }
            text += item.text.content;
            if (record(item.text.link) && typeof item.text.link.url === "string") links.push(item.text.link.url);
          }
        }
        blocks.push({ id: requireId(value.id), type: value.type, text, hasChildren: value.has_children, links });
      }
      if (list.cursor === null) return blocks;
      if (cursors.has(list.cursor)) throw new NotionSyncError("NOTION_RESPONSE_INVALID");
      cursors.add(list.cursor); cursor = list.cursor;
    }
  }

  /** Append once; caller must journal intent and reconcile an ambiguous response. */
  async appendReviewBlocks(pageId: string, children: readonly unknown[]): Promise<void> {
    const id = requireId(pageId);
    const body = { children };
    if (children.length < 1 || children.length > 100 || Buffer.byteLength(JSON.stringify(body), "utf8") > 450_000) {
      throw new NotionSyncError("NOTION_REVIEW_PLAN_INVALID");
    }
    const response = await this.#request("PATCH", `/blocks/${id}/children`, body);
    try {
      const list = this.#parseList(response);
      if (list.cursor !== null || list.results.length !== children.length || list.results.some((block) =>
        !record(block) || block.object !== "block" || normalizeId(block.id) === undefined)) {
        throw new NotionSyncError("NOTION_RESPONSE_INVALID");
      }
    } catch {
      throw new NotionSyncError("NOTION_RESPONSE_INVALID", { retryable: true, ambiguous: true });
    }
  }

  async #checkReviewParent(id: string): Promise<void> {
    const parent = await this.#request("GET", `/pages/${id}`);
    if (!record(parent) || parent.object !== "page" || normalizeId(parent.id) !== id
      || parent.archived !== false || parent.in_trash !== false) throw new NotionSyncError("NOTION_PAGE_MISMATCH");
  }

  #parseList(response: unknown): { results: readonly unknown[]; cursor: string | null } {
    if (!record(response) || response.object !== "list" || !Array.isArray(response.results)
      || response.results.length > 100 || typeof response.has_more !== "boolean"
      || (response.has_more ? typeof response.next_cursor !== "string" || response.next_cursor.length < 1
        || response.next_cursor.length > 2_000 : response.next_cursor !== null)) {
      throw new NotionSyncError("NOTION_RESPONSE_INVALID");
    }
    return { results: response.results, cursor: response.next_cursor as string | null };
  }

  async #allPages(sourceId: string): Promise<readonly NotionPage[]> {
    const pages: NotionPage[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const response = await this.#request("POST", `/data_sources/${sourceId}/query`, {
        page_size: 100, sorts: [{ timestamp: "created_time", direction: "ascending" }],
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      });
      const list = this.#parseList(response);
      for (const raw of list.results) {
        const page = parsePage(raw, [sourceId]);
        if (!page.archived && !page.in_trash) pages.push(page);
      }
      if (list.cursor === null) return pages;
      if (cursors.has(list.cursor)) throw new NotionSyncError("NOTION_RESPONSE_INVALID");
      cursors.add(list.cursor); cursor = list.cursor;
    }
  }

  async #ensureSchema(): Promise<void> {
    if (!this.#schemaValidated) {
      await this.validateSchema();
    }
  }

  async #create(sourceId: string, properties: Readonly<Record<string, unknown>>): Promise<NotionPage> {
    const response = await this.#request("POST", "/pages", {
      parent: { type: "data_source_id", data_source_id: sourceId }, properties,
    });
    try {
      const page = parsePage(response, [sourceId]);
      if (page.archived) {
        throw new NotionSyncError("NOTION_RESPONSE_INVALID");
      }
      return page;
    } catch {
      throw new NotionSyncError("NOTION_RESPONSE_INVALID", { retryable: true, ambiguous: true });
    }
  }

  async #query(sourceId: string, name: string, value: string, stopAtDuplicate: boolean): Promise<readonly NotionPage[]> {
    const pages: NotionPage[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let iteration = 0; iteration < MAX_QUERY_PAGES; iteration += 1) {
      const response = await this.#request("POST", `/data_sources/${sourceId}/query`, {
        filter: { property: name, rich_text: { equals: value } }, page_size: 100,
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      });
      if (!record(response) || response.object !== "list" || !Array.isArray(response.results)
        || response.results.length > 100 || typeof response.has_more !== "boolean"
        || (response.has_more ? typeof response.next_cursor !== "string" : response.next_cursor !== null)) {
        throw new NotionSyncError("NOTION_RESPONSE_INVALID");
      }
      for (const item of response.results) {
        const page = parsePage(item, [sourceId]);
        // Query filters are checked again rather than trusting a partial response.
        if (page.archived || readText(page, name) !== value) {
          throw new NotionSyncError("NOTION_RESPONSE_INVALID");
        }
        pages.push(page);
      }
      if (!response.has_more || (stopAtDuplicate && pages.length >= 2)) {
        return pages;
      }
      cursor = response.next_cursor as string;
      if (cursor.length < 1 || cursor.length > 2_000 || cursors.has(cursor)) {
        throw new NotionSyncError("NOTION_RESPONSE_INVALID");
      }
      cursors.add(cursor);
    }
    throw new NotionSyncError("NOTION_QUERY_LIMIT");
  }

  async #request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
    const write = method === "PATCH" || (method === "POST" && path === "/pages");
    const run = this.#requestQueue.then(async () => {
      if (this.#lastRequestAt !== undefined) {
        const wait = Math.max(0, this.#lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now());
        if (wait > 0) {
          await this.#sleep(wait);
        }
      }
      this.#lastRequestAt = Date.now();
      try {
        const response = await this.#fetch(`${API_ORIGIN}${path}`, {
          method, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${this.#token}`, "Notion-Version": NOTION_API_VERSION,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          throw new NotionSyncError("NOTION_REQUEST_REJECTED", { ambiguous: write });
        }
        if (!response.ok) {
          const wait = retryAfter(response);
          let committedResourceId: string | undefined;
          // A 503 may identify a committed write. Retain only its validated UUID.
          if (write && response.status === 503) {
            try {
              const errorBody = await readBoundedJson(response);
              if (record(errorBody)) {
                committedResourceId = normalizeId(errorBody.committed_resource_id);
                if (committedResourceId === undefined && record(errorBody.additional_data)) {
                  committedResourceId = normalizeId(errorBody.additional_data.committed_resource_id);
                }
              }
            } catch { /* Status alone still requires reconciliation. */ }
          } else {
            try {
              await response.body?.cancel();
            } catch { /* The received HTTP status still establishes the error class. */ }
          }
          if (response.status === 429 || response.status === 529) {
            throw new NotionSyncError("NOTION_RATE_LIMITED", {
              retryable: true, ...(wait === undefined ? {} : { retryAfterMs: wait }),
            });
          }
          if (response.status >= 500 || response.status === 408) {
            throw new NotionSyncError("NOTION_SERVICE_UNAVAILABLE", {
              retryable: true, ambiguous: write,
              ...(wait === undefined ? {} : { retryAfterMs: wait }),
              ...(committedResourceId === undefined ? {} : { committedResourceId }),
            });
          }
          const code = response.status === 401 ? "NOTION_UNAUTHORIZED"
            : response.status === 403 ? "NOTION_FORBIDDEN"
              : response.status === 404 ? "NOTION_NOT_FOUND" : "NOTION_REQUEST_REJECTED";
          throw new NotionSyncError(code);
        }
        return await readBoundedJson(response);
      } catch (error) {
        if (error instanceof NotionSyncError) {
          if (write && (error.code === "NOTION_RESPONSE_INVALID" || error.code === "NOTION_RESPONSE_TOO_LARGE")) {
            throw new NotionSyncError(error.code, { retryable: true, ambiguous: true });
          }
          throw error;
        }
        throw new NotionSyncError("NOTION_NETWORK_ERROR", { retryable: true, ambiguous: write });
      }
    });
    this.#requestQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
