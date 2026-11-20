import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { isValidLocalDate, normalizeExactTimestamp } from "@qb-study/contracts";
import { reviewDueBefore, type DailyReviewPlan, type ReviewReason } from "@qb-study/review-engine";

import { NotionSyncError, type NotionClient, type NotionReviewPage, type NotionReviewBlock } from "./notion-client.js";

export type PublishedReviewPlan = DailyReviewPlan & { readonly plan_id: string };
export type PublishedReviewDocument = Omit<PublishedReviewPlan, "states"> & { readonly source_plan_sha256: string };
export interface PublishedReviewRevision {
  readonly revision: 1;
  readonly revised_at: string;
  readonly reason: "include_due_within_day";
  readonly qb_set_url: string;
  readonly effective_plan: PublishedReviewPlan;
}
export interface VerifiedReviewRevision extends Omit<PublishedReviewRevision, "effective_plan"> {
  readonly schema_version: "review-plan-revision-v1";
  readonly plan_id: string;
  readonly target_date: string;
  readonly original_plan_sha256: string;
  readonly effective_plan: PublishedReviewDocument;
}
export type NotionReviewTransport = Pick<NotionClient,
  "listReviewChildPages" | "createReviewPage" | "getReviewPage" | "readReviewBlocks" | "appendReviewBlocks">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const QUESTION = /^[0-9]{3}[A-Z][1-9][0-9]{0,2}$/u;
const MARKER = "QB_REVIEW_PLAN_V1:";
const DATA_TITLE = "計画データ（照合用）";
const REVISION_MARKER = "QB_REVIEW_REVISION_V1:";
const REVISION_DATA_TITLE = "追記改訂1の計画データ（照合用）";
const REVISION_HEADING = "追記改訂1: ";
const SET_LINK_PREFIX = "QB問題セット: ";
const REASONS: Readonly<Record<string, string>> = {
  exam_priority_weight: "第120回の優先度補正",
  manual_due: "指定した復習日", model_due: "予測した復習時期", latest_incorrect: "直近の解答が不正解",
  same_day_retry_lower_priority: "同じ日の解き直し", sparse_evidence: "判定に使える記録が少ない",
  balance_bucket: "科目・分野の配分", recovered_evidence_due: "補完記録に基づく暫定の復習日",
};

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  throw new NotionSyncError("NOTION_REVIEW_PLAN_INVALID");
}

/** Persist the candidate plan, not an unbounded copy of every internal model state. */
export function canonicalPublishedReviewPlan(plan: PublishedReviewPlan): string {
  if (!UUID.test(plan.plan_id) || plan.schema_version !== "review-plan-v2" || !isValidLocalDate(plan.target_date)
    || plan.timezone !== "Asia/Tokyo" || !normalizeExactTimestamp(plan.selection_at).ok
    || !normalizeExactTimestamp(plan.scheduled_at).ok || plan.items.length > 100
    || (plan.due_before !== undefined && plan.due_before !== reviewDueBefore(plan.target_date))
    || (plan.recovered_evidence !== undefined && Object.values(plan.recovered_evidence).some((count) => !Number.isSafeInteger(count) || count < 0))
    || plan.items.some((item, index) => !QUESTION.test(item.question_key) || item.position !== index + 1
      || item.reasons.some((reason) => !Object.hasOwn(REASONS, reason.code)))) {
    throw new NotionSyncError("NOTION_REVIEW_PLAN_INVALID");
  }
  const document = {
    plan_id: plan.plan_id, schema_version: plan.schema_version, target_date: plan.target_date,
    calendar_date: plan.calendar_date, scheduled_at: plan.scheduled_at, selection_at: plan.selection_at, timezone: plan.timezone,
    evidence_hash: plan.evidence_hash, settings_hash: plan.settings_hash, settings: plan.settings,
    algorithm_id: plan.algorithm_id, algorithm_version: plan.algorithm_version,
    model_id: plan.model_id, model_version: plan.model_version, grade_policy_version: plan.grade_policy_version,
    model_status: plan.model_status, daily_counts: plan.daily_counts, all_time_counts: plan.all_time_counts,
    excluded_future_attempts: plan.excluded_future_attempts, excluded_future_snapshots: plan.excluded_future_snapshots,
    eligible_question_count: plan.eligible_question_count, items: plan.items,
    ...(plan.due_before === undefined ? {} : { due_before: plan.due_before }),
    ...(plan.recovered_evidence === undefined ? {} : { recovered_evidence: plan.recovered_evidence }),
    source_plan_sha256: createHash("sha256").update(stableJson(plan)).digest("hex"),
  };
  const serialized = stableJson(document);
  if (Buffer.byteLength(serialized, "utf8") > 240_000) throw new NotionSyncError("NOTION_REVIEW_PLAN_INVALID");
  return serialized;
}

function chunks(value: string, size: number): string[] {
  const result: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + size);
    if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
    result.push(value.slice(start, end)); start = end;
  }
  return result;
}

function richText(text: string): readonly unknown[] {
  return chunks(text, 2_000).map((content) => ({ type: "text", text: { content } }));
}

function paragraph(text: string): unknown {
  return { object: "block", type: "paragraph", paragraph: { rich_text: richText(text) } };
}

function marker(plan: PublishedReviewPlan, canonical: string): string {
  return `${MARKER}${plan.plan_id}:${createHash("sha256").update(canonical).digest("hex")}`;
}

function tokyoTime(value: string): string {
  const normalized = normalizeExactTimestamp(value);
  if (!normalized.ok) throw new NotionSyncError("NOTION_REVIEW_PLAN_INVALID");
  return new Date(Date.parse(normalized.value) + 9 * 60 * 60 * 1_000).toISOString().slice(0, 19).replace("T", " ") + "（日本時間）";
}

function reasonText(reason: ReviewReason): string {
  const facts = reason.facts;
  switch (reason.code) {
    case "exam_priority_weight": return facts.base_forgetting_risk === null
      ? "第120回の優先度補正（1.25倍）。記憶確率は不明のため、同順位の場合だけ優先しています"
      : "第120回のため、同じ優先分類と分野配分の中で忘却リスクによる優先度を1.25倍にしています";
    case "manual_due": return `指定した復習日（${String(facts.manual_due_on)}）を迎えています`;
    case "model_due": return typeof facts.model_due_at === "string"
      ? facts.due_window === "later_in_review_day"
        ? `今日の復習対象（予測した復習時刻: ${tokyoTime(facts.model_due_at)}）`
        : `予測した復習時期（${tokyoTime(facts.model_due_at)}）を迎えています` : REASONS[reason.code]!;
    case "latest_incorrect": return typeof facts.last_answered_at === "string"
      ? `直近の解答が不正解（${tokyoTime(facts.last_answered_at)}）`
      : typeof facts.last_answered_on === "string" ? `直近の解答が不正解（${facts.last_answered_on}、時刻不明）` : REASONS[reason.code]!;
    case "recovered_evidence_due": return `補完記録（${String(facts.answered_on)}）から${String(facts.interval_days)}日後の暫定復習日（${String(facts.recovered_due_on)}）を迎えています。記憶確率は算出していません`;
    case "same_day_retry_lower_priority": return `今日はすでに${String(facts.attempts_today)}回解答したため、未着手の問題を優先しています`;
    case "sparse_evidence": return `正誤が分かる記録は${String(facts.graded_attempts)}回・${String(facts.graded_distinct_days)}日分で、予測の根拠が少ない状態です`;
    case "balance_bucket": return facts.bucket === "unclassified" ? "科目・分野は未分類です" : "登録済みの科目・分野の偏りを抑える順序です";
  }
}

function qbSetUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new NotionSyncError("NOTION_REVIEW_SET_LINK_CONFLICT"); }
  const ids = parsed.searchParams.getAll("questionSetId");
  const operations = parsed.searchParams.getAll("operation");
  if (parsed.origin !== "https://qb.medilink-study.com" || parsed.pathname !== "/search"
    || parsed.username || parsed.password || parsed.hash || ids.length !== 1 || !/^[A-Za-z0-9_-]{1,100}$/u.test(ids[0]!)
    || operations.length !== 1 || operations[0] !== "OR"
    || [...parsed.searchParams.keys()].some((key) => key !== "questionSetId" && key !== "operation")) {
    throw new NotionSyncError("NOTION_REVIEW_SET_LINK_CONFLICT");
  }
  return `https://qb.medilink-study.com/search?questionSetId=${ids[0]!}&operation=OR`;
}

function setLink(blocks: readonly NotionReviewBlock[]): string | undefined {
  const matching = blocks.filter((block) => block.text.startsWith(SET_LINK_PREFIX));
  if (matching.length === 0) return undefined;
  const block = matching[0]!;
  const url = qbSetUrl(block.text.slice(SET_LINK_PREFIX.length));
  if (matching.length !== 1 || block.type !== "paragraph" || block.hasChildren
    || block.text !== SET_LINK_PREFIX + url || block.links?.length !== 1 || block.links[0] !== url) {
    throw new NotionSyncError("NOTION_REVIEW_SET_LINK_CONFLICT");
  }
  return url;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function revisionConflict(): never {
  throw new NotionSyncError("NOTION_REVIEW_REVISION_CONFLICT");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPublishedItem(value: unknown): boolean {
  if (!plainObject(value) || Object.keys(value).some((key) => !["question_key", "position", "priority_tier", "reasons",
    "model_due_at", "manual_due_on", "retrievability", "evidence_sufficiency"].includes(key))
    || !Number.isSafeInteger(value.priority_tier) || !Array.isArray(value.reasons)
    || !["insufficient", "partial", "sufficient"].includes(String(value.evidence_sufficiency))
    || !(value.model_due_at === null || (typeof value.model_due_at === "string" && normalizeExactTimestamp(value.model_due_at).ok))
    || !(value.manual_due_on === null || (typeof value.manual_due_on === "string" && isValidLocalDate(value.manual_due_on)))
    || !(value.retrievability === null || (typeof value.retrievability === "number" && Number.isFinite(value.retrievability)
      && value.retrievability >= 0 && value.retrievability <= 1))) return false;
  return value.reasons.every((reason: unknown) => plainObject(reason)
    && Object.keys(reason).every((key) => key === "code" || key === "facts")
    && typeof reason.code === "string" && Object.hasOwn(REASONS, reason.code) && plainObject(reason.facts)
    && Object.values(reason.facts).every((fact) => fact === null || typeof fact === "boolean"
      || (typeof fact === "number" && Number.isFinite(fact)) || (typeof fact === "string" && fact.length <= 2_000)));
}

/** Rebuild the published projection to reject unknown fields and malformed untrusted JSON. */
function publishedDocument(value: unknown): PublishedReviewDocument {
  try {
    if (!plainObject(value) || typeof value.source_plan_sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.source_plan_sha256) || !Array.isArray(value.items)
      || !value.items.every(validPublishedItem)) return revisionConflict();
    const rebuilt = JSON.parse(canonicalPublishedReviewPlan({ ...value, states: [] } as unknown as PublishedReviewPlan)) as PublishedReviewDocument;
    const document = { ...rebuilt, source_plan_sha256: value.source_plan_sha256 };
    if (stableJson(document) !== stableJson(value)) return revisionConflict();
    return document;
  } catch { return revisionConflict(); }
}

function unchangedRevisionEvidence(document: PublishedReviewDocument): string {
  return stableJson(Object.fromEntries(Object.entries(document).filter(([key]) =>
    !["algorithm_version", "due_before", "items", "eligible_question_count", "source_plan_sha256"].includes(key))));
}

function revisionDocument(original: PublishedReviewPlan, value: unknown): VerifiedReviewRevision {
  try {
    const originalCanonical = canonicalPublishedReviewPlan(original);
    if (!plainObject(value) || value.schema_version !== "review-plan-revision-v1" || value.revision !== 1
      || value.plan_id !== original.plan_id || value.target_date !== original.target_date
      || value.reason !== "include_due_within_day" || typeof value.revised_at !== "string"
      || typeof value.qb_set_url !== "string" || qbSetUrl(value.qb_set_url) !== value.qb_set_url
      || value.original_plan_sha256 !== sha256(originalCanonical)) return revisionConflict();
    const revisedAt = normalizeExactTimestamp(value.revised_at);
    if (!revisedAt.ok || revisedAt.value !== value.revised_at
      || Date.parse(revisedAt.value) < Date.parse(original.selection_at)) return revisionConflict();
    const effective = publishedDocument(value.effective_plan);
    if (effective.plan_id !== original.plan_id || effective.target_date !== original.target_date
      || effective.selection_at !== original.selection_at || effective.scheduled_at !== original.scheduled_at
      || effective.calendar_date !== original.calendar_date
      || effective.due_before !== reviewDueBefore(original.target_date)
      || typeof effective.algorithm_version !== "string" || !/^[0-9]{1,8}$/u.test(effective.algorithm_version)
      || !Number.isSafeInteger(effective.eligible_question_count) || effective.eligible_question_count < effective.items.length
      || effective.items.length > original.settings.max_questions
      || effective.items.length <= original.items.length || effective.items.length > 100
      || new Set(effective.items.map((item) => item.question_key)).size !== effective.items.length
      || original.items.some((item, index) => stableJson(item) !== stableJson(effective.items[index]))
      || unchangedRevisionEvidence(effective) !== unchangedRevisionEvidence(publishedDocument(JSON.parse(originalCanonical)))) return revisionConflict();
    const document: VerifiedReviewRevision = {
      schema_version: "review-plan-revision-v1", revision: 1, plan_id: original.plan_id, target_date: original.target_date,
      revised_at: revisedAt.value, reason: "include_due_within_day", qb_set_url: value.qb_set_url,
      original_plan_sha256: sha256(originalCanonical), effective_plan: effective,
    };
    if (stableJson(document) !== stableJson(value)) return revisionConflict();
    return document;
  } catch { return revisionConflict(); }
}

/** Revision 1 adds candidates to one existing set; the original plan remains independently verifiable. */
export function canonicalPublishedReviewRevision(original: PublishedReviewPlan, revision: PublishedReviewRevision): string {
  const revisedAt = normalizeExactTimestamp(revision.revised_at);
  if (!revisedAt.ok) return revisionConflict();
  const immutable = (plan: PublishedReviewPlan): string => stableJson(Object.fromEntries(Object.entries(plan).filter(([key]) =>
    !["algorithm_version", "due_before", "items", "eligible_question_count", "states"].includes(key))));
  if (immutable(original) !== immutable(revision.effective_plan)) return revisionConflict();
  const document = revisionDocument(original, {
    schema_version: "review-plan-revision-v1", revision: revision.revision, plan_id: original.plan_id,
    target_date: original.target_date, revised_at: revisedAt.value, reason: revision.reason,
    qb_set_url: qbSetUrl(revision.qb_set_url), original_plan_sha256: sha256(canonicalPublishedReviewPlan(original)),
    effective_plan: JSON.parse(canonicalPublishedReviewPlan(revision.effective_plan)) as unknown,
  });
  const canonical = stableJson(document);
  if (Buffer.byteLength(canonical, "utf8") > 240_000) return revisionConflict();
  return canonical;
}

function revisionMarker(revision: VerifiedReviewRevision, canonical: string): string {
  return `${REVISION_MARKER}${revision.plan_id}:1:${sha256(canonical)}`;
}

function revisionBlocks(revision: VerifiedReviewRevision, canonical: string, originalCount: number): readonly unknown[] {
  const items = revision.effective_plan.items;
  const blocks: unknown[] = [
    paragraph(`${REVISION_HEADING}${tokyoTime(revision.revised_at)}。次の候補更新（翌朝4時）より前に復習時期を迎える問題を追加しました。元の計画と当時の集計は上に保持しています。`),
    paragraph(`改訂後の復習候補 ${items.length}問（元の ${originalCount}問＋追加 ${items.length - originalCount}問）。同じQB問題セットを使用します。以下が追加後の全順序です。`),
  ];
  const lines = items.map((item) => `${item.position}. ${item.question_key}：${item.reasons.map(reasonText).join(" / ")}`);
  for (let index = 0; index < lines.length; index += 10) blocks.push(paragraph(lines.slice(index, index + 10).join("\n")));
  blocks.push(paragraph(revisionMarker(revision, canonical)));
  blocks.push({ object: "block", type: "toggle", toggle: {
    rich_text: richText(REVISION_DATA_TITLE), children: chunks(canonical, 50_000).map((text) => ({
      object: "block", type: "code", code: { language: "json", rich_text: richText(text) },
    })),
  } });
  return blocks;
}

export function reviewRevisionBlocks(original: PublishedReviewPlan, revision: PublishedReviewRevision): readonly unknown[] {
  const canonical = canonicalPublishedReviewRevision(original, revision);
  return revisionBlocks(revisionDocument(original, JSON.parse(canonical)), canonical, original.items.length);
}

function sameVisibleBlocks(actual: readonly NotionReviewBlock[], expected: readonly unknown[]): boolean {
  return actual.length === expected.length && expected.every((raw, index) => {
    const block = raw as { type: string; paragraph?: { rich_text: readonly { text: { content: string } }[] } };
    const saved = actual[index]!;
    return saved.type === block.type && (saved.links?.length ?? 0) === 0 && (block.paragraph === undefined
      || (!saved.hasChildren && saved.text === block.paragraph.rich_text.map((part) => part.text.content).join("")));
  });
}

export function reviewPageBlocks(plan: PublishedReviewPlan): readonly unknown[] {
  const canonical = canonicalPublishedReviewPlan(plan);
  const blocks: unknown[] = [
    paragraph(`集計の確認時刻: ${tokyoTime(plan.selection_at)}。候補の更新基準は毎朝4時。解答数は日本時間の0時から集計します。`),
    paragraph(`${plan.calendar_date}の解答（0時から確認時刻まで）: 通常学習 ${plan.daily_counts.normal.attempts}回 / 復習 ${plan.daily_counts.review.attempts}回 / 未分類 ${plan.daily_counts.unclassified.attempts}回 / 合計 ${plan.daily_counts.total.attempts}回`),
    paragraph(`復習候補 ${plan.items.length}問。記憶予測は暫定モデルです。未同期のMacの履歴は含められません。`),
  ];
  if (plan.recovered_evidence !== undefined) {
    const recovered = plan.recovered_evidence;
    blocks.push(paragraph(`補完記録: 合計 ${recovered.attempts}回（本日 ${recovered.attempts_today}回）を未分類として解答数に含めています。確認時刻より後の補完 ${recovered.excluded_future}回、自動記録と同日・同問の補完 ${recovered.suppressed_by_direct}回は除外しました。補完は解答時刻・選択番号が不明のため記憶予測には入力せず、直近が補完の場合は誤答の翌日・正答の7日後を暫定復習日とします。`));
  }
  const lines = plan.items.map((item) => `${item.position}. ${item.question_key}：${item.reasons.map(reasonText).join(" / ")}`);
  for (let index = 0; index < lines.length; index += 10) blocks.push(paragraph(lines.slice(index, index + 10).join("\n")));
  if (lines.length === 0) blocks.push(paragraph("今回の条件に合う復習候補はありません。"));
  blocks.push(paragraph(marker(plan, canonical)));
  blocks.push({ object: "block", type: "toggle", toggle: {
    rich_text: richText(DATA_TITLE), children: chunks(canonical, 50_000).map((text) => ({
      object: "block", type: "code", code: { language: "json", rich_text: richText(text) },
    })),
  } });
  return blocks;
}

export class NotionReviewPublisher {
  readonly #client: NotionReviewTransport;
  readonly #parentPageId: string;

  constructor(options: { readonly client: NotionReviewTransport; readonly parentPageId: string }) {
    if (!UUID.test(options.parentPageId)) throw new NotionSyncError("NOTION_CONFIG_INVALID");
    this.#client = options.client;
    this.#parentPageId = options.parentPageId;
  }

  async find(plan: PublishedReviewPlan): Promise<readonly NotionReviewPage[]> {
    canonicalPublishedReviewPlan(plan);
    const title = `QB復習候補 ${plan.target_date}`;
    const matches: NotionReviewPage[] = [];
    for (const child of await this.#client.listReviewChildPages(this.#parentPageId)) {
      if (child.title === title) {
        if (!await this.verify(child.id, plan)) throw new NotionSyncError("NOTION_REVIEW_PLAN_CONFLICT");
        matches.push(await this.#client.getReviewPage(child.id, this.#parentPageId));
      }
    }
    return matches;
  }

  /** The caller must persist create intent first, then journal the returned ID before verification. */
  async create(plan: PublishedReviewPlan): Promise<NotionReviewPage> {
    return this.#client.createReviewPage(this.#parentPageId, `QB復習候補 ${plan.target_date}`, reviewPageBlocks(plan));
  }

  async readExistingSetLink(pageId: string): Promise<string | undefined> {
    await this.#client.getReviewPage(pageId, this.#parentPageId);
    return setLink(await this.#client.readReviewBlocks(pageId));
  }

  /** The caller journals intent first and never repeats an ambiguous append without reconciliation. */
  async appendReviewedSetLink(pageId: string, url: string): Promise<void> {
    const canonical = qbSetUrl(url);
    const existing = await this.readExistingSetLink(pageId);
    if (existing !== undefined) {
      if (existing !== canonical) throw new NotionSyncError("NOTION_REVIEW_SET_LINK_CONFLICT");
      return;
    }
    await this.#client.appendReviewBlocks(pageId, [{ object: "block", type: "paragraph", paragraph: { rich_text: [
      { type: "text", text: { content: SET_LINK_PREFIX } },
      { type: "text", text: { content: canonical, link: { url: canonical } } },
    ] } }]);
    try {
      if (await this.readExistingSetLink(pageId) !== canonical) {
        throw new NotionSyncError("NOTION_RESPONSE_INVALID", { retryable: true, ambiguous: true });
      }
    } catch (error) {
      throw new NotionSyncError(error instanceof NotionSyncError ? error.code : "NOTION_RESPONSE_INVALID", {
        retryable: true, ambiguous: true,
      });
    }
  }

  async verify(pageId: string, plan: PublishedReviewPlan): Promise<boolean> {
    canonicalPublishedReviewPlan(plan);
    try {
      await this.#readOriginalAndRevision(pageId, plan);
      return true;
    } catch (error) {
      if (error instanceof NotionSyncError && ["NOTION_REVIEW_PLAN_CONFLICT", "NOTION_REVIEW_REVISION_CONFLICT"].includes(error.code)) return false;
      throw error;
    }
  }

  /** A missing revision is safe to report, but never authorizes repeating an uncertain append. */
  async readRevision(pageId: string, original: PublishedReviewPlan): Promise<VerifiedReviewRevision | undefined> {
    return (await this.#readOriginalAndRevision(pageId, original)).revision;
  }

  async verifyRevision(pageId: string, original: PublishedReviewPlan, revision: PublishedReviewRevision): Promise<boolean> {
    const canonical = canonicalPublishedReviewRevision(original, revision);
    const saved = await this.readRevision(pageId, original);
    return saved !== undefined && stableJson(saved) === canonical;
  }

  /** One append only. Persist intent before calling; an ambiguous result requires read-only reconciliation. */
  async appendRevision(pageId: string, original: PublishedReviewPlan, revision: PublishedReviewRevision): Promise<void> {
    const canonical = canonicalPublishedReviewRevision(original, revision);
    const saved = await this.#readOriginalAndRevision(pageId, original);
    if (saved.setUrl !== revision.qb_set_url) return revisionConflict();
    if (saved.revision !== undefined) {
      if (stableJson(saved.revision) !== canonical) return revisionConflict();
      return;
    }
    await this.#client.appendReviewBlocks(pageId, reviewRevisionBlocks(original, revision));
    try {
      if (!await this.verifyRevision(pageId, original, revision)) return revisionConflict();
    } catch (error) {
      throw new NotionSyncError(error instanceof NotionSyncError ? error.code : "NOTION_RESPONSE_INVALID", {
        retryable: true, ambiguous: true,
      });
    }
  }

  async #readOriginalAndRevision(pageId: string, plan: PublishedReviewPlan): Promise<{
    readonly revision: VerifiedReviewRevision | undefined;
    readonly setUrl: string | undefined;
  }> {
    const canonical = canonicalPublishedReviewPlan(plan);
    const page = await this.#client.getReviewPage(pageId, this.#parentPageId);
    if (page.title !== `QB復習候補 ${plan.target_date}`) throw new NotionSyncError("NOTION_REVIEW_PLAN_CONFLICT");
    const savedBlocks = await this.#client.readReviewBlocks(page.id);
    const setUrl = setLink(savedBlocks);
    const blocks = savedBlocks.filter((block) => !block.text.startsWith(SET_LINK_PREFIX));
    const revisionIndex = blocks.findIndex((block) => block.text.startsWith(REVISION_HEADING));
    const originalBlocks = revisionIndex < 0 ? blocks : blocks.slice(0, revisionIndex);
    if (!sameVisibleBlocks(originalBlocks, reviewPageBlocks(plan))
      || originalBlocks.filter((block) => block.type === "paragraph" && block.text === marker(plan, canonical)).length !== 1) {
      throw new NotionSyncError("NOTION_REVIEW_PLAN_CONFLICT");
    }
    const data = originalBlocks.filter((block) => block.type === "toggle" && block.text === DATA_TITLE && block.hasChildren);
    if (data.length !== 1) throw new NotionSyncError("NOTION_REVIEW_PLAN_CONFLICT");
    const content = await this.#client.readReviewBlocks(data[0]!.id);
    if (content.length === 0 || content.some((block) => block.type !== "code" || block.hasChildren || (block.links?.length ?? 0) > 0)
      || content.map((block) => block.text).join("") !== canonical) throw new NotionSyncError("NOTION_REVIEW_PLAN_CONFLICT");
    if (revisionIndex < 0) return { revision: undefined, setUrl };
    return { revision: await this.#readRevisionBlocks(blocks.slice(revisionIndex), plan, setUrl), setUrl };
  }

  async #readRevisionBlocks(blocks: readonly NotionReviewBlock[], original: PublishedReviewPlan, setUrl: string | undefined): Promise<VerifiedReviewRevision> {
    const markers = blocks.filter((block) => block.text.startsWith(REVISION_MARKER));
    const data = blocks.filter((block) => block.type === "toggle" && block.text === REVISION_DATA_TITLE && block.hasChildren);
    if (markers.length !== 1 || markers[0]!.type !== "paragraph" || markers[0]!.hasChildren || data.length !== 1) return revisionConflict();
    const content = await this.#client.readReviewBlocks(data[0]!.id);
    if (content.length === 0 || content.some((block) => block.type !== "code" || block.hasChildren || (block.links?.length ?? 0) > 0)) return revisionConflict();
    const canonical = content.map((block) => block.text).join("");
    if (Buffer.byteLength(canonical, "utf8") > 240_000) return revisionConflict();
    let parsed: unknown;
    try { parsed = JSON.parse(canonical); } catch { return revisionConflict(); }
    const revision = revisionDocument(original, parsed);
    if (stableJson(revision) !== canonical || markers[0]!.text !== revisionMarker(revision, canonical)
      || setUrl !== revision.qb_set_url || !sameVisibleBlocks(blocks, revisionBlocks(revision, canonical, original.items.length))) return revisionConflict();
    return revision;
  }
}
