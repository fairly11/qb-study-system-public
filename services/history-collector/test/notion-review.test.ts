import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateDailyReviewPlan, reviewDueBefore } from "@qb-study/review-engine";
import { NotionSyncError, type NotionReviewBlock, type NotionReviewPage } from "../src/notion-client.js";
import {
  canonicalPublishedReviewPlan, NotionReviewPublisher, reviewPageBlocks,
  canonicalPublishedReviewRevision, reviewRevisionBlocks,
  type NotionReviewTransport, type PublishedReviewPlan, type PublishedReviewRevision,
} from "../src/notion-review.js";

const PARENT = "10000000-0000-4000-8000-000000000001";
const PAGE = "20000000-0000-4000-8000-000000000001";
const PLAN = "30000000-0000-4000-8000-000000000001";

function plan(): PublishedReviewPlan {
  const legacy = { ...generateDailyReviewPlan({ as_of: "2026-10-16T03:00:00Z", attempts: [] }), plan_id: PLAN,
    algorithm_version: "1" };
  delete legacy.due_before;
  return legacy;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("BAD_FIXTURE");
  return value as Record<string, unknown>;
}

class MemoryTransport implements NotionReviewTransport {
  readonly blocks = new Map<string, NotionReviewBlock[]>();
  readonly pages: NotionReviewPage[] = [];
  creates = 0;
  appends = 0;
  failure: NotionSyncError | undefined;
  #sequence = 0;

  listReviewChildPages(parent: string): Promise<readonly { id: string; title: string }[]> {
    return Promise.resolve(this.pages.filter((page) => page.parentPageId === parent));
  }
  async createReviewPage(parent: string, title: string, children: readonly unknown[]): Promise<NotionReviewPage> {
    this.creates++;
    if (this.failure !== undefined) throw this.failure;
    const page = { id: PAGE, parentPageId: parent, title, archived: false, in_trash: false };
    this.pages.push(page);
    this.#putBlocks(PAGE, children);
    return page;
  }
  getReviewPage(id: string, parent: string): Promise<NotionReviewPage> {
    const page = this.pages.find((page) => page.id === id && page.parentPageId === parent);
    return page === undefined ? Promise.reject(new NotionSyncError("NOTION_NOT_FOUND")) : Promise.resolve(page);
  }
  readReviewBlocks(id: string): Promise<readonly NotionReviewBlock[]> {
    return Promise.resolve(this.blocks.get(id) ?? []);
  }
  appendReviewBlocks(id: string, children: readonly unknown[]): Promise<void> {
    this.appends++;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const previous = this.blocks.get(id) ?? [];
    this.#putBlocks(id, children);
    this.blocks.set(id, [...previous, ...this.blocks.get(id)!]);
    return Promise.resolve();
  }
  #putBlocks(id: string, input: readonly unknown[]): void {
    const blocks = input.map((raw) => {
      this.#sequence++;
      const blockId = `40000000-0000-4000-8000-${String(this.#sequence).padStart(12, "0")}`;
      const block = object(raw);
      const type = String(block.type);
      const content = object(block[type]);
      const text = (content.rich_text as unknown[]).map((part) => String(object(object(part).text).content)).join("");
      const links = (content.rich_text as unknown[]).flatMap((part) => {
        const link = object(object(part).text).link;
        return link === undefined ? [] : [String(object(link).url)];
      });
      const children = content.children as readonly unknown[] | undefined;
      if (children !== undefined) this.#putBlocks(blockId, children);
      return { id: blockId, type, text, hasChildren: children !== undefined, links };
    });
    this.blocks.set(id, blocks);
  }
}

describe("recovered daily plan publication", () => {
  it("preserves the exact canonical and visible block bytes for a legacy plan", () => {
    const legacy = plan();
    expect(createHash("sha256").update(canonicalPublishedReviewPlan(legacy)).digest("hex"))
      .toBe("b63330594ca9925dfb46dac7acc150263ed7392588160b47212f6bb0a63bea7e");
    expect(createHash("sha256").update(JSON.stringify(reviewPageBlocks(legacy))).digest("hex"))
      .toBe("3fe27baef32145a5e750c99120012385e2b37f0f7304eeb92a45f01c682b64d8");
  });

  it("publishes and verifies recovery counts and provisional due reasons without claiming an exact answer time", async () => {
    const input = { ...generateDailyReviewPlan({ as_of: "2026-10-19T12:00:00+09:00", attempts: [],
      recovered_attempts: [{ schema_version: "1", record_type: "recovered_attempt",
        recovery_id: "a0000000-0000-4000-8000-000000000001", question_key: "119A12", answered_on: "2026-10-18",
        result: "incorrect", observed_at: "2026-10-18T22:00:00+09:00", recovered_at: "2026-10-19T09:00:00+09:00",
        study_mode: "unclassified", selected_option_indices: null, source_system: "computer-history",
        source_event_id: "synthetic-1", source_segment: "segment-1" }],
      suppressed_recovered_attempts: 2, excluded_future_recovered_attempts: 3 }), plan_id: PLAN };
    const transport = new MemoryTransport();
    const publisher = new NotionReviewPublisher({ client: transport, parentPageId: PARENT });
    const saved = await publisher.create(input);
    expect(await publisher.verify(saved.id, input)).toBe(true);
    expect(JSON.parse(canonicalPublishedReviewPlan(input))).toMatchObject({ recovered_evidence: {
      attempts: 1, attempts_today: 0, excluded_future: 3, suppressed_by_direct: 2 }, algorithm_version: "5" });
    const visible = transport.blocks.get(PAGE)!.map((block) => block.text).join("\n");
    expect(visible).toContain("補完記録: 合計 1回（本日 0回）");
    expect(visible).toContain("2026-10-18、時刻不明");
    expect(visible).toContain("1日後の暫定復習日（2026-10-19）");
    expect(visible).toContain("記憶確率は算出していません");
    const blocks = transport.blocks.get(PAGE)!;
    blocks[3] = { ...blocks[3]!, text: "補完記録: 合計 999回" };
    expect(await publisher.verify(saved.id, input)).toBe(false);
  });
});

describe("Notion daily review publication", () => {
  it("publishes weighted exam reasons and reads back unchanged canonical risk values and visible explanations", async () => {
    const input: PublishedReviewPlan = { ...generateDailyReviewPlan({ as_of: "2026-11-12T04:00:00+09:00",
      attempts: [{ schema_version: "1", record_type: "attempt_event",
        event_id: "a0000000-0000-4000-8000-000000000001", question_key: "120A1",
        answered_at: "2026-11-01T00:00:00.000Z", result: "incorrect", selected_option_indices: [1],
        provenance: { producer: "browser-extension", producer_version: "0.1.0", source_system: "qb-web-dom",
          recorded_at: "2026-11-01T00:00:01.000Z" },
        quality: { acquisition_method: "direct_capture", temporal_precision: "exact", state_precision: "exact" } }],
      questions: ["119A1", "120A1", "120A2"].map((question_key) => ({ question_key, next_review_on: "2026-11-11" })),
      model: { model_id: "test", model_version: "1", grade_policy_version: "test-v1",
        predict: ({ attempts }) => ({ next_review_at: attempts.length > 0 ? "2026-11-10T00:00:00.000Z" : null,
          retrievability: attempts.length > 0 ? 0.5 : null, stability_days: null, difficulty: null, derived_grades: [] }) },
    }), plan_id: PLAN };
    const original = JSON.stringify(input);
    const transport = new MemoryTransport();
    const publisher = new NotionReviewPublisher({ client: transport, parentPageId: PARENT });
    const saved = await publisher.create(input);
    expect(await publisher.verify(saved.id, input)).toBe(true);
    const blocks = await transport.readReviewBlocks(saved.id);
    const visible = blocks.map((block) => block.text).join("\n");
    expect(visible).toContain("忘却リスクによる優先度を1.25倍");
    expect(visible).toContain("記憶確率は不明のため、同順位の場合だけ優先");
    const toggle = blocks.find((block) => block.type === "toggle")!;
    const savedCanonical = (await transport.readReviewBlocks(toggle.id)).map((block) => block.text).join("");
    expect(savedCanonical).toBe(canonicalPublishedReviewPlan(input));
    expect(JSON.parse(savedCanonical)).toMatchObject({ algorithm_version: "5", items: input.items });
    expect(input.items.map((item) => item.question_key)).toEqual(["120A1", "120A2", "119A1"]);
    expect(input.items[0]!.reasons).toContainEqual({ code: "exam_priority_weight", facts: {
      exam: 120, weight: 1.25, base_forgetting_risk: 0.5, weighted_forgetting_risk: 0.625,
    } });
    expect(input.items[1]!.reasons).toContainEqual({ code: "exam_priority_weight", facts: {
      exam: 120, weight: 1.25, base_forgetting_risk: null, weighted_forgetting_risk: null,
    } });
    expect(JSON.stringify(input)).toBe(original);
    expect(transport.creates).toBe(1);
  });

  it("creates an ordinary child page and independently verifies the saved plan", async () => {
    const transport = new MemoryTransport();
    const publisher = new NotionReviewPublisher({ client: transport, parentPageId: PARENT });
    const input = plan();
    expect(await publisher.find(input)).toEqual([]);
    const saved = await publisher.create(input);
    expect(saved.parentPageId).toBe(PARENT);
    expect(saved.title).toBe(`QB復習候補 ${input.target_date}`);
    expect(await publisher.verify(saved.id, input)).toBe(true);
    expect(await publisher.find(input)).toEqual([saved]);
    expect(transport.creates).toBe(1);
    const canonical = JSON.parse(canonicalPublishedReviewPlan(input)) as Record<string, unknown>;
    expect(canonical).toMatchObject({ plan_id: PLAN, daily_counts: input.daily_counts, items: input.items });
    expect(canonical).not.toHaveProperty("states");
    expect(canonical.source_plan_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("renders selected question IDs, ranks, reasons, counts and evidence time", () => {
    const input: PublishedReviewPlan = { ...plan(), items: [{ question_key: "119A12", position: 1,
      priority_tier: 1, reasons: [{ code: "latest_incorrect", facts: { result: "incorrect" } }], model_due_at: null,
      manual_due_on: null, retrievability: null, evidence_sufficiency: "partial" }] };
    const text = JSON.stringify(reviewPageBlocks(input));
    expect(text).toContain("1. 119A12");
    expect(text).toContain("直近の解答が不正解");
    expect(text).toContain("通常学習 0回");
    expect(text).toContain(input.selection_at);
    expect(text).toContain("2026-10-16 12:00:00（日本時間）");
    expect(text).toContain("0時から確認時刻まで");
  });

  it("rejects a modified canonical document or wrong plan identity", async () => {
    const transport = new MemoryTransport();
    const publisher = new NotionReviewPublisher({ client: transport, parentPageId: PARENT });
    const input = plan();
    await publisher.create(input);
    expect(await publisher.verify(PAGE, { ...input, plan_id: "30000000-0000-4000-8000-000000000002" })).toBe(false);
    const toggle = transport.blocks.get(PAGE)!.find((block) => block.type === "toggle")!;
    transport.blocks.set(toggle.id, [{ id: toggle.id, type: "code", text: "{}", hasChildren: false }]);
    expect(await publisher.verify(PAGE, input)).toBe(false);
    await expect(publisher.find(input)).rejects.toMatchObject({ code: "NOTION_REVIEW_PLAN_CONFLICT" });
  });

  it("detects modified visible counts independently of canonical plan data", async () => {
    const transport = new MemoryTransport();
    const publisher = new NotionReviewPublisher({ client: transport, parentPageId: PARENT });
    const input = plan();
    await publisher.create(input);
    const blocks = transport.blocks.get(PAGE)!;
    blocks[1] = { ...blocks[1]!, text: "合計 999回" };
    expect(await publisher.verify(PAGE, input)).toBe(false);
  });

  it("appends one verified QB set link, preserves plan verification, and rejects conflicting links", async () => {
    const transport = new MemoryTransport();
    const publisher = new NotionReviewPublisher({ client: transport, parentPageId: PARENT });
    const input = plan();
    await publisher.create(input);
    const url = "https://qb.medilink-study.com/search?questionSetId=synthetic-set&operation=OR";
    expect(await publisher.readExistingSetLink(PAGE)).toBeUndefined();
    await publisher.appendReviewedSetLink(PAGE, url);
    await publisher.appendReviewedSetLink(PAGE, url);
    expect(transport.appends).toBe(1);
    expect(await publisher.readExistingSetLink(PAGE)).toBe(url);
    expect(await publisher.verify(PAGE, input)).toBe(true);
    await expect(publisher.appendReviewedSetLink(PAGE, url.replace("synthetic-set", "other-set")))
      .rejects.toMatchObject({ code: "NOTION_REVIEW_SET_LINK_CONFLICT" });
    await expect(publisher.appendReviewedSetLink(PAGE, "https://example.test/search?questionSetId=synthetic-set&operation=OR"))
      .rejects.toMatchObject({ code: "NOTION_REVIEW_SET_LINK_CONFLICT" });
    expect(transport.appends).toBe(1);
  });

  it("does not repeat an uncertain link append", async () => {
    const transport = new MemoryTransport();
    const publisher = new NotionReviewPublisher({ client: transport, parentPageId: PARENT });
    await publisher.create(plan());
    transport.failure = new NotionSyncError("NOTION_NETWORK_ERROR", { ambiguous: true, retryable: true });
    await expect(publisher.appendReviewedSetLink(PAGE,
      "https://qb.medilink-study.com/search?questionSetId=synthetic-set&operation=OR"))
      .rejects.toMatchObject({ ambiguous: true });
    expect(transport.appends).toBe(1);
  });

  it("surfaces ambiguous create results without attempting a second create", async () => {
    const transport = new MemoryTransport();
    transport.failure = new NotionSyncError("NOTION_NETWORK_ERROR", { ambiguous: true, retryable: true });
    const publisher = new NotionReviewPublisher({ client: transport, parentPageId: PARENT });
    await expect(publisher.create(plan())).rejects.toMatchObject({ ambiguous: true });
    expect(transport.creates).toBe(1);
    expect(transport.pages).toEqual([]);
  });

  it("fails before a write for invalid IDs, question numbers or oversized plan evidence", async () => {
    const transport = new MemoryTransport();
    const publisher = new NotionReviewPublisher({ client: transport, parentPageId: PARENT });
    await expect(publisher.create({ ...plan(), plan_id: "unknown" })).rejects.toMatchObject({ code: "NOTION_REVIEW_PLAN_INVALID" });
    const input = { ...plan(), evidence_hash: "x".repeat(250_000) };
    await expect(publisher.create(input)).rejects.toMatchObject({ code: "NOTION_REVIEW_PLAN_INVALID" });
    expect(transport.creates).toBe(0);
  });
});

const SET_URL = "https://qb.medilink-study.com/search?questionSetId=synthetic-set&operation=OR";

function revisionFixture(): { original: PublishedReviewPlan; revision: PublishedReviewRevision } {
  const first = { question_key: "119A12", position: 1, priority_tier: 1,
    reasons: [{ code: "latest_incorrect" as const, facts: { result: "incorrect" } }], model_due_at: null,
    manual_due_on: null, retrievability: null, evidence_sufficiency: "partial" as const };
  const original = { ...plan(), items: [first], eligible_question_count: 1 };
  const due = "2026-10-16T10:00:00.000Z";
  const added = { ...first, question_key: "120C16", position: 2, model_due_at: due,
    reasons: [{ code: "model_due" as const, facts: { model_due_at: due, as_of: original.selection_at,
      due_before: reviewDueBefore(original.target_date), due_window: "later_in_review_day" } }] };
  return { original, revision: { revision: 1, revised_at: "2026-10-16T04:00:00.000Z",
    reason: "include_due_within_day", qb_set_url: SET_URL,
    effective_plan: { ...original, algorithm_version: "3", due_before: reviewDueBefore(original.target_date),
      eligible_question_count: 2, items: [first, added] } } };
}

async function revisionPage(): Promise<{
  transport: MemoryTransport; publisher: NotionReviewPublisher; original: PublishedReviewPlan; revision: PublishedReviewRevision;
}> {
  const transport = new MemoryTransport();
  const publisher = new NotionReviewPublisher({ client: transport, parentPageId: PARENT });
  const { original, revision } = revisionFixture();
  await publisher.create(original);
  await publisher.appendReviewedSetLink(PAGE, SET_URL);
  return { transport, publisher, original, revision };
}

describe("append-only Notion daily plan revision", () => {
  it("keeps all original blocks, title and link, appends once and reads the effective ordered plan", async () => {
    const { transport, publisher, original, revision } = await revisionPage();
    const originalBlocks = structuredClone(transport.blocks.get(PAGE)!);
    const originalCanonical = canonicalPublishedReviewPlan(original);
    expect(await publisher.readRevision(PAGE, original)).toBeUndefined();
    await publisher.appendRevision(PAGE, original, revision);
    await publisher.appendRevision(PAGE, original, revision);
    expect(transport.appends).toBe(2); // one link and one revision
    expect(transport.creates).toBe(1);
    expect(transport.blocks.get(PAGE)!.slice(0, originalBlocks.length)).toEqual(originalBlocks);
    expect(canonicalPublishedReviewPlan(original)).toBe(originalCanonical);
    expect(await publisher.verify(PAGE, original)).toBe(true);
    expect(await publisher.find(original)).toEqual(transport.pages);
    expect(await publisher.verifyRevision(PAGE, original, revision)).toBe(true);
    expect(await publisher.readExistingSetLink(PAGE)).toBe(SET_URL);
    const saved = await publisher.readRevision(PAGE, original);
    expect(saved?.effective_plan.items.map((item) => item.question_key)).toEqual(["119A12", "120C16"]);
    expect(saved?.effective_plan).not.toHaveProperty("states");
    expect(saved?.original_plan_sha256).toBe(createHash("sha256").update(originalCanonical).digest("hex"));
    expect(saved?.effective_plan.due_before).toBe(reviewDueBefore(original.target_date));
    const visible = transport.blocks.get(PAGE)!.map((block) => block.text).join("\n");
    expect(visible).toContain("改訂後の復習候補 2問（元の 1問＋追加 1問）");
    expect(visible).toContain("今日の復習対象（予測した復習時刻: 2026-10-16 19:00:00");
    expect(visible).not.toContain("19:00:00（日本時間））を迎えています");
    expect(visible.match(/QB_REVIEW_PLAN_V1:/gu)).toHaveLength(1);
    expect(visible.match(/QB_REVIEW_REVISION_V1:/gu)).toHaveLength(1);
  });

  it("reconciles a committed append with a lost response without adding another revision", async () => {
    const { transport, publisher, original, revision } = await revisionPage();
    const append = transport.appendReviewBlocks.bind(transport);
    transport.appendReviewBlocks = async (id, blocks) => {
      await append(id, blocks);
      throw new NotionSyncError("NOTION_NETWORK_ERROR", { ambiguous: true, retryable: true });
    };
    await expect(publisher.appendRevision(PAGE, original, revision)).rejects.toMatchObject({ ambiguous: true });
    expect(await publisher.verifyRevision(PAGE, original, revision)).toBe(true);
    await publisher.appendRevision(PAGE, original, revision);
    expect(transport.appends).toBe(2);
  });

  it("surfaces an uncertain uncommitted append without retrying", async () => {
    const { transport, publisher, original, revision } = await revisionPage();
    transport.failure = new NotionSyncError("NOTION_NETWORK_ERROR", { ambiguous: true, retryable: true });
    await expect(publisher.appendRevision(PAGE, original, revision)).rejects.toMatchObject({ ambiguous: true });
    expect(transport.appends).toBe(2);
    expect(await publisher.readRevision(PAGE, original)).toBeUndefined();
    // The caller's persisted intent blocks any second append when reconciliation finds nothing.
  });

  it("reports an ambiguous result if post-write read-back fails", async () => {
    const { transport, publisher, original, revision } = await revisionPage();
    const append = transport.appendReviewBlocks.bind(transport);
    transport.appendReviewBlocks = async (id, blocks) => {
      await append(id, blocks);
      transport.readReviewBlocks = () => Promise.reject(new NotionSyncError("NOTION_RATE_LIMITED", { retryable: true }));
    };
    await expect(publisher.appendRevision(PAGE, original, revision)).rejects.toMatchObject({ code: "NOTION_RATE_LIMITED", ambiguous: true });
    expect(transport.appends).toBe(2);
  });

  it.each(["missing-data", "duplicate-revision", "visible-order", "payload", "base-marker", "revision-marker", "link"])(
    "rejects %s corruption without another write", async (corruption) => {
      const { transport, publisher, original, revision } = await revisionPage();
      await publisher.appendRevision(PAGE, original, revision);
      const blocks = transport.blocks.get(PAGE)!;
      const revisionStart = blocks.findIndex((block) => block.text.startsWith("追記改訂1: "));
      const toggle = blocks.find((block) => block.text === "追記改訂1の計画データ（照合用）")!;
      if (corruption === "missing-data") transport.blocks.set(PAGE, blocks.filter((block) => block !== toggle));
      if (corruption === "duplicate-revision") blocks.push(...blocks.slice(revisionStart));
      if (corruption === "visible-order") blocks[revisionStart + 2] = { ...blocks[revisionStart + 2]!, text: "2. 119A12\n1. 120C16" };
      if (corruption === "payload") transport.blocks.set(toggle.id, [{ id: toggle.id, type: "code", text: "{}", hasChildren: false }]);
      if (corruption === "base-marker" || corruption === "revision-marker") {
        const prefix = corruption === "base-marker" ? "QB_REVIEW_PLAN_V1:" : "QB_REVIEW_REVISION_V1:";
        const index = blocks.findIndex((block) => block.text.startsWith(prefix));
        blocks[index] = { ...blocks[index]!, text: blocks[index]!.text.slice(0, -1) + "x" };
      }
      if (corruption === "link") {
        const index = blocks.findIndex((block) => block.text.startsWith("QB問題セット: "));
        blocks[index] = { ...blocks[index]!, text: "QB問題セット: " + SET_URL.replace("synthetic-set", "other-set"),
          links: [SET_URL.replace("synthetic-set", "other-set")] };
      }
      expect(await publisher.verify(PAGE, original)).toBe(false);
      await expect(publisher.readRevision(PAGE, original)).rejects.toBeInstanceOf(NotionSyncError);
      await expect(publisher.appendRevision(PAGE, original, revision)).rejects.toBeInstanceOf(NotionSyncError);
      expect(transport.appends).toBe(2);
    },
  );

  it("rejects conflicting revision identity or a missing original set link", async () => {
    const { transport, publisher, original, revision } = await revisionPage();
    await publisher.appendRevision(PAGE, original, revision);
    const different = { ...revision, revised_at: "2026-10-16T04:01:00.000Z" };
    expect(await publisher.verifyRevision(PAGE, original, different)).toBe(false);
    await expect(publisher.appendRevision(PAGE, original, different)).rejects.toMatchObject({ code: "NOTION_REVIEW_REVISION_CONFLICT" });
    const empty = new MemoryTransport();
    const fresh = new NotionReviewPublisher({ client: empty, parentPageId: PARENT });
    await fresh.create(original);
    await expect(fresh.appendRevision(PAGE, original, revision)).rejects.toMatchObject({ code: "NOTION_REVIEW_REVISION_CONFLICT" });
    expect(empty.appends).toBe(0);
    expect(transport.appends).toBe(2);
  });

  it("rejects a changed prefix, duplicate question, new evidence, changed counts, times or target before writing", async () => {
    const { transport, publisher, original, revision } = await revisionPage();
    const effective = revision.effective_plan;
    const invalid: PublishedReviewPlan[] = [
      { ...effective, items: [{ ...effective.items[0]!, priority_tier: 2 }, effective.items[1]!] },
      { ...effective, items: [effective.items[0]!, { ...effective.items[1]!, question_key: effective.items[0]!.question_key }] },
      { ...effective, evidence_hash: "changed" },
      { ...effective, daily_counts: { ...effective.daily_counts, total: { ...effective.daily_counts.total, attempts: 10 } } },
      { ...effective, selection_at: "2026-10-16T04:00:00.000Z" },
      { ...effective, target_date: "2026-10-17" },
      { ...effective, plan_id: "30000000-0000-4000-8000-000000000002" },
      { ...effective, due_before: "2026-10-16T15:00:00.000Z" },
      { ...effective, eligible_question_count: 1 },
      { ...effective, items: original.items },
    ];
    for (const input of invalid) {
      await expect(publisher.appendRevision(PAGE, original, { ...revision, effective_plan: input })).rejects.toBeInstanceOf(NotionSyncError);
    }
    await expect(publisher.appendRevision(PAGE, original, { ...revision, revision: 2 } as unknown as PublishedReviewRevision))
      .rejects.toMatchObject({ code: "NOTION_REVIEW_REVISION_CONFLICT" });
    expect(transport.appends).toBe(1);
  });

  it("binds hidden source-summary evidence as well as the published projection", () => {
    const { original, revision } = revisionFixture();
    const base = { ...original, source_summary: { canonical_attempts: 79 } };
    const effective = { ...revision.effective_plan, source_summary: { canonical_attempts: 80 } };
    expect(() => canonicalPublishedReviewRevision(base, { ...revision, effective_plan: effective }))
      .toThrow("NOTION_REVIEW_REVISION_CONFLICT");
  });

  it("persists optional due_before only for new plans and keeps the previous canonical unchanged", () => {
    const { original, revision } = revisionFixture();
    expect(JSON.parse(canonicalPublishedReviewPlan(original))).not.toHaveProperty("due_before");
    expect(JSON.parse(canonicalPublishedReviewRevision(original, revision)).effective_plan.due_before)
      .toBe(reviewDueBefore(original.target_date));
    expect(reviewRevisionBlocks(original, revision).length).toBeLessThan(100);
  });
});
