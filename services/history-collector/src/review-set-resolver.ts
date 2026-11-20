import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isValidLocalDate, normalizeExactTimestamp } from "@qb-study/contracts";
import type { NotionClient, NotionReviewBlock } from "./notion-client.js";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const SET_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const QUESTION = /^[0-9]{3}[A-Z][1-9][0-9]{0,2}$/u;
const MARKER = /^QB_REVIEW_PLAN_V1:([a-f0-9-]{36}):([a-f0-9]{64})$/iu;
const LINK_PREFIX = "QB問題セット: ";
const DATA_TITLE = "計画データ（照合用）";

export type ReviewSetResolution = {
  readonly schema_version: "1";
  readonly question_set_id: string;
} & ({ readonly study_mode: "normal" } | { readonly study_mode: "review"; readonly review_plan_id: string });
export type ReviewSetTransport = Pick<NotionClient, "listReviewChildPages" | "getReviewPage" | "readReviewBlocks">;

export class ReviewSetResolutionError extends Error {
  constructor() { super("REVIEW_SET_RESOLUTION_UNAVAILABLE"); this.name = "ReviewSetResolutionError"; }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fail(): never { throw new ReviewSetResolutionError(); }

/** Never creates directories, follows a file symlink, or opens the study SQLite database. */
function readFile(path: string, maximum: number): string | undefined {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (object(error) && error.code === "ENOENT") return undefined;
    return fail();
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) return fail();
  try { return readFileSync(path, "utf8"); } catch { return fail(); }
}
function parse(text: string): unknown { try { return JSON.parse(text) as unknown; } catch { return fail(); } }

/** This reader uses only the shared parent ID; it never grants publisher rights. */
export function readReviewSetReaderOptions(options: {
  readonly baseDirectory?: string;
  readonly environment?: { readonly QB_REVIEW_PARENT_PAGE_ID?: string };
} = {}): { readonly journalDirectory: string; readonly parentPageId?: string } {
  const base = options.baseDirectory ?? join(homedir(), "Library", "Application Support", "qb-study-system");
  if (!isAbsolute(base)) return fail();
  const text = readFile(join(base, "review-config.json"), 8_192);
  let parent: unknown = (options.environment ?? process.env).QB_REVIEW_PARENT_PAGE_ID;
  if (text !== undefined) {
    const config = parse(text);
    if (!object(config) || config.schema_version !== "1") return fail();
    parent = config.notion_parent_page_id;
  }
  if (parent !== undefined && (typeof parent !== "string" || !UUID.test(parent))) return fail();
  return { journalDirectory: join(base, "daily-review"), ...(typeof parent === "string" ? { parentPageId: parent.toLowerCase() } : {}) };
}

function journalValue(directory: string, name: string): unknown {
  const text = readFile(join(directory, `${name}.json`), 16 * 1_024 * 1_024);
  if (text === undefined) return undefined;
  const envelope = parse(text);
  if (!object(envelope) || typeof envelope.sha256 !== "string"
    || !Object.hasOwn(envelope, "value") || sha256(JSON.stringify(envelope.value)) !== envelope.sha256) return fail();
  return envelope.value;
}

function setIdFromUrl(value: unknown): string {
  if (typeof value !== "string") return fail();
  let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  const ids = url.searchParams.getAll("questionSetId");
  if (url.origin !== "https://qb.medilink-study.com" || url.pathname !== "/search" || url.username || url.password || url.hash
    || ids.length !== 1 || !SET_ID.test(ids[0]!) || url.searchParams.getAll("operation").length !== 1
    || url.searchParams.get("operation") !== "OR"
    || [...url.searchParams.keys()].some((key) => key !== "questionSetId" && key !== "operation")) return fail();
  if (value !== `https://qb.medilink-study.com/search?questionSetId=${ids[0]!}&operation=OR`) return fail();
  return ids[0]!;
}

function planIdentity(value: unknown): { planId: string; day: string; questions: readonly string[] } {
  if (!object(value) || value.schema_version !== "review-plan-v2" || typeof value.plan_id !== "string" || !UUID.test(value.plan_id)
    || typeof value.target_date !== "string" || !isValidLocalDate(value.target_date) || value.timezone !== "Asia/Tokyo"
    || typeof value.selection_at !== "string" || !normalizeExactTimestamp(value.selection_at).ok
    || typeof value.scheduled_at !== "string" || !normalizeExactTimestamp(value.scheduled_at).ok
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100) return fail();
  const questions = value.items.map((item: unknown, index: number) => {
    if (!object(item) || item.position !== index + 1 || typeof item.question_key !== "string" || !QUESTION.test(item.question_key)) return fail();
    return item.question_key;
  });
  if (new Set(questions).size !== questions.length) return fail();
  return { planId: value.plan_id.toLowerCase(), day: value.target_date, questions };
}

function addMapping(map: Map<string, string>, setId: string, planId: string): void {
  const previous = map.get(setId);
  if (previous !== undefined && previous !== planId) return fail();
  map.set(setId, planId);
}

function localMappings(directory: string): { verified: Map<string, string>; pending: Set<string> } {
  const result = { verified: new Map<string, string>(), pending: new Set<string>() };
  let directories;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return fail();
    directories = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return result;
    return fail();
  }
  for (const entry of directories) {
    if (!isValidLocalDate(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) return fail();
    const dayDirectory = join(directory, entry.name);
    const link = journalValue(dayDirectory, "notion-set-link-verified");
    if (link === undefined) {
      const pending = journalValue(dayDirectory, "qb-created");
      if (pending !== undefined) {
        if (!object(pending) || pending.set_id !== setIdFromUrl(pending.url)) return fail();
        result.pending.add(pending.set_id as string);
      }
      continue; // Pending/ambiguous writes never authorize review classification.
    }
    const identity = planIdentity(journalValue(dayDirectory, "plan"));
    const created = journalValue(dayDirectory, "qb-created");
    const verified = journalValue(dayDirectory, "qb-verified");
    const intent = journalValue(dayDirectory, "qb-intent");
    const notion = journalValue(dayDirectory, "notion-verified");
    if (identity.day !== entry.name || !object(created) || !object(verified) || !object(intent) || !object(notion) || !object(link)
      || typeof intent.plan_id !== "string" || intent.plan_id.toLowerCase() !== identity.planId
      || typeof notion.id !== "string" || !UUID.test(notion.id) || typeof link.page_id !== "string"
      || link.page_id.toLowerCase() !== notion.id.toLowerCase() || link.url !== created.url
      || verified.order !== "added_oldest_first" || JSON.stringify(verified.question_ids) !== JSON.stringify(identity.questions)) return fail();
    const id = setIdFromUrl(created.url);
    if (created.set_id !== id) return fail();
    addMapping(result.verified, id, identity.planId);
  }
  return result;
}

function linkedSetId(blocks: readonly NotionReviewBlock[]): string | undefined {
  const links = blocks.filter((block) => block.text.startsWith(LINK_PREFIX));
  if (links.length === 0) return undefined;
  const link = links[0]!;
  if (links.length !== 1 || link.type !== "paragraph" || link.hasChildren) return fail();
  const url = link.text.slice(LINK_PREFIX.length);
  if (link.links?.length !== 1 || link.links[0] !== url) return fail();
  return setIdFromUrl(url);
}

export class VerifiedReviewSetResolver {
  readonly #options: {
    readonly journalDirectory: string; readonly client?: ReviewSetTransport; readonly parentPageId?: string;
  };
  readonly #now: () => number;
  readonly #refreshInterval: number;
  readonly #positive = new Map<string, string>();
  readonly #negative = new Map<string, number>();
  readonly #conflicted = new Set<string>();
  #lastRefreshAt = Number.NEGATIVE_INFINITY;
  #refresh: Promise<void> | undefined;

  constructor(options: {
    readonly journalDirectory: string; readonly client?: ReviewSetTransport; readonly parentPageId?: string;
    readonly now?: () => number; readonly refreshIntervalMs?: number;
  }) {
    if (!isAbsolute(options.journalDirectory) || (options.parentPageId !== undefined && !UUID.test(options.parentPageId))) {
      throw new ReviewSetResolutionError();
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#refreshInterval = options.refreshIntervalMs ?? 60_000;
    if (!Number.isSafeInteger(this.#refreshInterval) || this.#refreshInterval < 0) return fail();
  }

  async resolve(questionSetId: string): Promise<ReviewSetResolution> {
    if (!SET_ID.test(questionSetId)) return fail();
    if (this.#conflicted.has(questionSetId)) return fail();
    const local = localMappings(this.#options.journalDirectory);
    for (const [id, planId] of local.verified) {
      if (this.#positive.has(id) && this.#positive.get(id) !== planId) { this.#conflicted.add(id); return fail(); }
      this.#positive.set(id, planId); this.#negative.delete(id);
    }
    const known = this.#positive.get(questionSetId);
    if (known !== undefined) return this.#review(questionSetId, known);
    if (local.pending.has(questionSetId)) { this.#negative.delete(questionSetId); return fail(); }
    const negativeUntil = this.#negative.get(questionSetId);
    if (negativeUntil !== undefined && this.#now() < negativeUntil) return this.#normal(questionSetId);
    if (this.#refresh !== undefined) await this.#refresh;
    else {
      // An unrelated new ID was not checked by the previous request. Do not
      // infer normal study from an old catalog while a refresh is throttled.
      if (this.#now() - this.#lastRefreshAt < this.#refreshInterval) return fail();
      this.#lastRefreshAt = this.#now();
      this.#refresh = this.#loadShared();
      try { await this.#refresh; } finally { this.#refresh = undefined; }
    }
    const planId = this.#positive.get(questionSetId);
    if (planId !== undefined) return this.#review(questionSetId, planId);
    this.#negative.set(questionSetId, this.#now() + this.#refreshInterval);
    if (this.#negative.size > 1_000) this.#negative.delete(this.#negative.keys().next().value!);
    return this.#normal(questionSetId);
  }

  #normal(questionSetId: string): ReviewSetResolution {
    return { schema_version: "1", question_set_id: questionSetId, study_mode: "normal" };
  }

  #review(questionSetId: string, planId: string): ReviewSetResolution {
    return { schema_version: "1", question_set_id: questionSetId, study_mode: "review", review_plan_id: planId };
  }

  async #loadShared(): Promise<void> {
    const { client, parentPageId } = this.#options;
    if (client === undefined || parentPageId === undefined) return fail();
    const found = new Map<string, string>();
    try {
      for (const child of await client.listReviewChildPages(parentPageId)) {
        const page = await client.getReviewPage(child.id, parentPageId);
        const blocks = await client.readReviewBlocks(page.id);
        const setId = linkedSetId(blocks);
        if (setId === undefined) continue;
        const markers = blocks.filter((block) => block.text.startsWith("QB_REVIEW_PLAN_V1:"));
        const marker = markers[0]?.text.match(MARKER);
        const data = blocks.filter((block) => block.type === "toggle" && block.text === DATA_TITLE && block.hasChildren);
        if (markers.length !== 1 || markers[0]!.type !== "paragraph" || markers[0]!.hasChildren || marker === null || marker === undefined
          || !UUID.test(marker[1]!) || data.length !== 1) return fail();
        const content = await client.readReviewBlocks(data[0]!.id);
        if (content.length === 0 || content.some((block) => block.type !== "code" || block.hasChildren)) return fail();
        const canonical = content.map((block) => block.text).join("");
        if (Buffer.byteLength(canonical, "utf8") > 240_000 || sha256(canonical) !== marker[2]!.toLowerCase()) return fail();
        const document = parse(canonical);
        const identity = planIdentity(document);
        if (identity.planId !== marker[1]!.toLowerCase() || page.title !== `QB復習候補 ${identity.day}`
          || !object(document) || typeof document.source_plan_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(document.source_plan_sha256)) return fail();
        if (found.has(setId) && found.get(setId) !== identity.planId) { this.#conflicted.add(setId); return fail(); }
        found.set(setId, identity.planId);
      }
      for (const [setId, planId] of found) {
        const previous = this.#positive.get(setId);
        if (previous !== undefined && previous !== planId) { this.#conflicted.add(setId); return fail(); }
      }
      for (const [setId, planId] of found) { this.#positive.set(setId, planId); this.#negative.delete(setId); }
    } catch { return fail(); }
  }
}
