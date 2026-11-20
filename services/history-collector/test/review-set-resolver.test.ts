import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateDailyReviewPlan } from "@qb-study/review-engine";
import { canonicalPublishedReviewPlan, reviewPageBlocks, reviewRevisionBlocks, type PublishedReviewPlan } from "../src/notion-review.js";
import type { NotionReviewBlock, NotionReviewPage } from "../src/notion-client.js";
import { readReviewSetReaderOptions, VerifiedReviewSetResolver, type ReviewSetTransport } from "../src/review-set-resolver.js";

const PLAN = "10000000-0000-4000-8000-000000000001";
const PAGE = "20000000-0000-4000-8000-000000000001";
const PARENT = "30000000-0000-4000-8000-000000000001";
const SET = "synthetic-QB-set";
const URL = `https://qb.medilink-study.com/search?questionSetId=${SET}&operation=OR`;
const directories: string[] = [];
function temporary(): string { const directory = mkdtempSync(join(tmpdir(), "qb-review-set-")); directories.push(directory); return directory; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function plan(): PublishedReviewPlan {
  return { ...generateDailyReviewPlan({ as_of: "2026-10-18T03:00:00Z", attempts: [] }), plan_id: PLAN,
    items: [{ question_key: "119A12", position: 1, priority_tier: 1, reasons: [], model_due_at: null,
      manual_due_on: null, retrievability: null, evidence_sufficiency: "partial" }] };
}
function writeJournal(directory: string, name: string, value: unknown): void {
  const target = join(directory, plan().target_date);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${name}.json`), JSON.stringify({
    sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"), value,
  }));
}
function completedLocal(directory: string): void {
  writeJournal(directory, "plan", plan());
  writeJournal(directory, "qb-intent", { plan_id: PLAN, name: "synthetic" });
  writeJournal(directory, "qb-created", { set_id: SET, url: URL });
  writeJournal(directory, "qb-verified", { question_ids: ["119A12"], order: "added_oldest_first" });
  writeJournal(directory, "notion-verified", { id: PAGE });
  writeJournal(directory, "notion-set-link-verified", { page_id: PAGE, url: URL });
}
function object(value: unknown): Record<string, unknown> { return value as Record<string, unknown>; }
class SharedNotion implements ReviewSetTransport {
  readonly pages: NotionReviewPage[] = [];
  readonly blocks = new Map<string, NotionReviewBlock[]>();
  listCalls = 0;
  readonly blockReads: string[] = [];
  fail = false;
  #sequence = 0;
  add(input = plan(), id = PAGE, url = URL): void {
    this.pages.push({ id, parentPageId: PARENT, title: `QB復習候補 ${input.target_date}`, archived: false, in_trash: false });
    this.#put(id, reviewPageBlocks(input));
    this.blocks.get(id)!.push({ id: "40000000-0000-4000-8000-000000000999", type: "paragraph",
      text: `QB問題セット: ${url}`, hasChildren: false, links: [url] });
  }
  append(id: string, inputs: readonly unknown[]): void {
    const existing = this.blocks.get(id) ?? [];
    this.#put(id, inputs);
    this.blocks.set(id, [...existing, ...this.blocks.get(id)!]);
  }
  #put(id: string, inputs: readonly unknown[]): void {
    const blocks = inputs.map((value) => {
      this.#sequence++;
      const blockId = `40000000-0000-4000-8000-${String(this.#sequence).padStart(12, "0")}`;
      const raw = object(value); const type = String(raw.type); const body = object(raw[type]);
      const text = (body.rich_text as unknown[]).map((part) => String(object(object(part).text).content)).join("");
      const children = body.children as readonly unknown[] | undefined;
      if (children !== undefined) this.#put(blockId, children);
      return { id: blockId, type, text, hasChildren: children !== undefined };
    });
    this.blocks.set(id, blocks);
  }
  listReviewChildPages(parent: string): Promise<readonly { id: string; title: string }[]> {
    this.listCalls++;
    return this.fail ? Promise.reject(new Error("SECRET_UPSTREAM_ERROR")) : Promise.resolve(this.pages.filter((page) => page.parentPageId === parent));
  }
  getReviewPage(id: string, parent: string): Promise<NotionReviewPage> {
    const page = this.pages.find((page) => page.id === id && page.parentPageId === parent);
    return page === undefined ? Promise.reject(new Error("MISSING")) : Promise.resolve(page);
  }
  readReviewBlocks(id: string): Promise<readonly NotionReviewBlock[]> {
    this.blockReads.push(id);
    return Promise.resolve(this.blocks.get(id) ?? []);
  }
}

describe("verified review set identity", () => {
  it("recognizes only a completed immutable local journal without creating files", async () => {
    const directory = temporary();
    completedLocal(directory);
    const resolver = new VerifiedReviewSetResolver({ journalDirectory: directory });
    expect(await resolver.resolve(SET)).toEqual({ schema_version: "1", question_set_id: SET, study_mode: "review", review_plan_id: PLAN });
    await expect(resolver.resolve("ordinary-set")).rejects.toThrow("REVIEW_SET_RESOLUTION_UNAVAILABLE");
    const missing = join(temporary(), "absent");
    await expect(new VerifiedReviewSetResolver({ journalDirectory: missing }).resolve(SET)).rejects.toThrow();
    expect(() => readFileSync(missing)).toThrow();
  });

  it("does not recognize a pending set or names and membership without a verified link", async () => {
    const directory = temporary();
    completedLocal(directory);
    rmSync(join(directory, plan().target_date, "notion-set-link-verified.json"));
    const shared = new SharedNotion();
    const resolver = new VerifiedReviewSetResolver({ journalDirectory: directory, client: shared, parentPageId: PARENT });
    await expect(resolver.resolve(SET)).rejects.toThrow("REVIEW_SET_RESOLUTION_UNAVAILABLE");
    expect(shared.listCalls).toBe(0);
  });

  it("rejects corrupt or mismatched local confirmation rather than inferring review", async () => {
    for (const corrupted of [true, false]) {
      const directory = temporary(); completedLocal(directory);
      if (corrupted) writeFileSync(join(directory, plan().target_date, "qb-created.json"), JSON.stringify({ sha256: "wrong", value: { set_id: SET } }));
      else writeJournal(directory, "qb-verified", { question_ids: ["119A13"], order: "added_oldest_first" });
      await expect(new VerifiedReviewSetResolver({ journalDirectory: directory }).resolve(SET)).rejects.toThrow("REVIEW_SET_RESOLUTION_UNAVAILABLE");
    }
  });

  it("recognizes the shared Notion evidence on a Mac with no local publisher journal", async () => {
    const shared = new SharedNotion(); shared.add();
    const resolver = new VerifiedReviewSetResolver({ journalDirectory: join(temporary(), "missing"), client: shared, parentPageId: PARENT });
    expect(await resolver.resolve(SET)).toEqual({ schema_version: "1", question_set_id: SET, study_mode: "review", review_plan_id: PLAN });
    shared.fail = true;
    expect(await resolver.resolve(SET)).toMatchObject({ study_mode: "review", review_plan_id: PLAN });
    expect(shared.listCalls).toBe(1);
  });

  it("cold-resolves an amended set from its original set/plan identity without depending on added-question membership", async () => {
    const base = plan();
    const original: PublishedReviewPlan = { ...base, items: Array.from({ length: 4 }, (_, index) => ({
      ...base.items[0]!, question_key: `119A${index + 12}`, position: index + 1,
    })) };
    const effective: PublishedReviewPlan = { ...original, due_before: "2026-10-18T19:00:00.000Z", eligible_question_count:14, items: [
      ...original.items,
      ...Array.from({ length: 10 }, (_, index) => ({
        ...base.items[0]!, question_key: `119A${index + 16}`, position: index + 5,
      })),
    ] };
    const shared = new SharedNotion();
    shared.add(original);
    const originalBlocks = [...shared.blocks.get(PAGE)!];
    const originalToggle = originalBlocks.find((block) => block.type === "toggle")!;
    const originalData = [...shared.blocks.get(originalToggle.id)!];
    shared.append(PAGE, reviewRevisionBlocks(original, {
      revision: 1, revised_at: "2026-10-18T04:00:00.000Z", reason: "include_due_within_day",
      qb_set_url: URL, effective_plan: effective,
    }));
    const amendedBlocks = shared.blocks.get(PAGE)!;
    const revisionToggle = amendedBlocks.find((block) => block.type === "toggle"
      && block.text === "追記改訂1の計画データ（照合用）")!;
    expect(amendedBlocks.slice(0, originalBlocks.length)).toEqual(originalBlocks);
    expect(shared.blocks.get(originalToggle.id)).toEqual(originalData);
    expect(amendedBlocks.filter((block) => block.text.startsWith("QB_REVIEW_PLAN_V1:"))).toHaveLength(1);
    expect(amendedBlocks.filter((block) => block.text.startsWith("QB_REVIEW_REVISION_V1:"))).toHaveLength(1);
    expect(amendedBlocks.filter((block) => block.text.startsWith("QB問題セット: "))).toHaveLength(1);
    expect(effective.items).toHaveLength(14);
    expect(original.items.some((item) => item.question_key === effective.items[13]!.question_key)).toBe(false);

    // No local journal or warm cache can supply this identity. The old reader
    // intentionally verifies the original plan, not the appended question list.
    const resolver = new VerifiedReviewSetResolver({
      journalDirectory: join(temporary(), "missing"), client: shared, parentPageId: PARENT,
    });
    expect(await resolver.resolve(SET)).toEqual({
      schema_version: "1", question_set_id: SET, study_mode: "review", review_plan_id: PLAN,
    });
    expect(shared.listCalls).toBe(1);
    expect(shared.blockReads).toContain(originalToggle.id);
    expect(revisionToggle).toBeDefined();
    expect(shared.blockReads).not.toContain(revisionToggle.id);
  });

  it("does not use a stale negative to classify a newly created set as normal", async () => {
    const shared = new SharedNotion(); let now = 0;
    const resolver = new VerifiedReviewSetResolver({ journalDirectory: temporary(), client: shared, parentPageId: PARENT, now: () => now });
    expect(await resolver.resolve("ordinary-set")).toMatchObject({ study_mode: "normal" });
    expect(await resolver.resolve("ordinary-set")).toMatchObject({ study_mode: "normal" });
    expect(shared.listCalls).toBe(1);
    shared.add();
    await expect(resolver.resolve(SET)).rejects.toThrow("REVIEW_SET_RESOLUTION_UNAVAILABLE");
    now = 60_001;
    expect(await resolver.resolve(SET)).toMatchObject({ study_mode: "review", review_plan_id: PLAN });
  });

  it("does not expose upstream errors or classify missing configuration as normal", async () => {
    const shared = new SharedNotion(); shared.fail = true;
    const resolver = new VerifiedReviewSetResolver({ journalDirectory: temporary(), client: shared, parentPageId: PARENT });
    await expect(resolver.resolve(SET)).rejects.toThrow(/^REVIEW_SET_RESOLUTION_UNAVAILABLE$/u);
    await expect(new VerifiedReviewSetResolver({ journalDirectory: temporary() }).resolve(SET)).rejects.toThrow(/^REVIEW_SET_RESOLUTION_UNAVAILABLE$/u);
  });

  it("overrides a cached negative when that ID has become a local pending set", async () => {
    const directory = temporary(); const shared = new SharedNotion();
    const resolver = new VerifiedReviewSetResolver({ journalDirectory: directory, client: shared, parentPageId: PARENT });
    expect(await resolver.resolve(SET)).toMatchObject({ study_mode: "normal" });
    writeJournal(directory, "qb-created", { set_id: SET, url: URL });
    await expect(resolver.resolve(SET)).rejects.toThrow("REVIEW_SET_RESOLUTION_UNAVAILABLE");
    completedLocal(directory);
    expect(await resolver.resolve(SET)).toMatchObject({ study_mode: "review", review_plan_id: PLAN });
    expect(shared.listCalls).toBe(1);
  });

  it("does not keep serving a cached identity after observing a conflicting plan", async () => {
    const shared = new SharedNotion(); shared.add(); let now = 0;
    const resolver = new VerifiedReviewSetResolver({ journalDirectory: temporary(), client: shared, parentPageId: PARENT, now: () => now });
    expect(await resolver.resolve(SET)).toMatchObject({ study_mode: "review" });
    now = 60_001;
    shared.add({ ...plan(), plan_id: "10000000-0000-4000-8000-000000000002" }, "20000000-0000-4000-8000-000000000002");
    await expect(resolver.resolve("another-set")).rejects.toThrow("REVIEW_SET_RESOLUTION_UNAVAILABLE");
    await expect(resolver.resolve(SET)).rejects.toThrow("REVIEW_SET_RESOLUTION_UNAVAILABLE");
  });

  it("rejects a changed canonical document, plain URL text, or conflicting plan identities", async () => {
    for (const failure of ["document", "link", "conflict"] as const) {
      const shared = new SharedNotion(); shared.add();
      if (failure === "document") {
        const toggle = shared.blocks.get(PAGE)!.find((block) => block.type === "toggle")!;
        shared.blocks.set(toggle.id, [{ ...shared.blocks.get(toggle.id)![0]!,
          text: canonicalPublishedReviewPlan({ ...plan(), plan_id: "10000000-0000-4000-8000-000000000002" }) }]);
      } else if (failure === "link") {
        const blocks = shared.blocks.get(PAGE)!; blocks[blocks.length - 1] = { ...blocks.at(-1)!, links: [] };
      } else shared.add({ ...plan(), plan_id: "10000000-0000-4000-8000-000000000002" }, "20000000-0000-4000-8000-000000000002");
      await expect(new VerifiedReviewSetResolver({ journalDirectory: temporary(), client: shared, parentPageId: PARENT }).resolve(SET))
        .rejects.toThrow("REVIEW_SET_RESOLUTION_UNAVAILABLE");
    }
  });

  it("reads only the parent ID without publisher-host permission and uses the non-secret fallback", () => {
    const base = temporary();
    expect(readReviewSetReaderOptions({ baseDirectory: base, environment: { QB_REVIEW_PARENT_PAGE_ID: PARENT } }))
      .toEqual({ journalDirectory: join(base, "daily-review"), parentPageId: PARENT });
    writeFileSync(join(base, "review-config.json"), JSON.stringify({ schema_version: "1", publisher_host: "another-Mac", notion_parent_page_id: PARENT }));
    expect(readReviewSetReaderOptions({ baseDirectory: base, environment: { QB_REVIEW_PARENT_PAGE_ID: "ignored-invalid" } }).parentPageId).toBe(PARENT);
    writeFileSync(join(base, "review-config.json"), "{}");
    expect(() => readReviewSetReaderOptions({ baseDirectory: base, environment: { QB_REVIEW_PARENT_PAGE_ID: PARENT } })).toThrow();
  });
});
