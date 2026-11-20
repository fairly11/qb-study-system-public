import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptEventV1, RecoveredAttemptV1, StudyContextV1 } from "@qb-study/contracts";
import { generateDailyReviewPlan } from "@qb-study/review-engine";
import { createSetManifest } from "@qb-study/set-builder";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotionSyncError, type NotionReviewPage, type NotionReviewSnapshot } from "../src/notion-client.js";
import { ReviewJournal, beginQbSet, finishQbSet, latestReviewDay, prepareReview, publishReview,
  recordQbSet, reviewProgress, reviewSnapshotEvidence, type ReviewPublisher, type SavedReviewPlan } from "../src/review-service.js";

const directories: string[] = [];
const AS_OF = "2026-10-16T04:00:00+09:00";
const PLAN_ID = "90000000-0000-4000-8000-000000000001";
function journal(): ReviewJournal {
  const path = mkdtempSync(join(tmpdir(), "qb-review-service-test-"));
  directories.push(path);
  return new ReviewJournal(path);
}
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, {recursive:true,force:true}); });

function event(id: number, question = "119A12", answeredAt = "2026-10-16T05:00:00+09:00"): AttemptEventV1 {
  return {
    schema_version: "1", record_type: "attempt_event", event_id: `10000000-0000-4000-8000-${String(id).padStart(12,"0")}`,
    question_key: question, answered_at: answeredAt, result: "incorrect", selected_option_indices: [1],
    provenance: {producer:"browser-extension",producer_version:"0.1.0",source_system:"qb-web-dom",recorded_at:answeredAt},
    quality: {acquisition_method:"direct_capture",temporal_precision:"exact",state_precision:"exact"},
  };
}
function context(attempt: AttemptEventV1, mode: StudyContextV1["study_mode"] = "review", planId?: string): StudyContextV1 {
  return {schema_version:"1",record_type:"study_context",event_id:attempt.event_id,study_mode:mode,
    ...(planId === undefined ? {} : {review_plan_id:planId})};
}
function snapshot(): NotionReviewSnapshot {
  return {attempts:[],contexts:[],questions:["119A12","119A13","119A14"].map((key) => ({
    question_key:key,stopped:false,next_review_on:"2026-10-15",subjects:[],fields:[],
  })),unknownAttemptRows:2,duplicateAttemptRows:1,excludedFutureEvents:3,excludedFromAggregationRows:4,unknownQuestionRows:0,
  readStartedAt:"2026-10-15T19:00:00.000Z",readCompletedAt:"2026-10-15T19:00:01.000Z"};
}
function plan(): SavedReviewPlan {
  return {...generateDailyReviewPlan({as_of:AS_OF,attempts:[],questions:snapshot().questions}),plan_id:PLAN_ID,
    source_summary:{read_started_at:"2026-10-15T19:00:00.000Z",read_completed_at:"2026-10-15T19:00:01.000Z",
      canonical_attempts:0,unknown_attempt_rows:2,duplicate_attempt_rows:1,unknown_question_rows:0,
      excluded_future_events:3,excluded_from_aggregation_rows:4}};
}
const page: NotionReviewPage = {id:"a0000000-0000-4000-8000-000000000001",
  parentPageId:"b0000000-0000-4000-8000-000000000001",title:"test",archived:false,in_trash:false};
function publisher(): ReviewPublisher {
  return {find:vi.fn(async () => []),create:vi.fn(async () => page),verify:vi.fn(async () => true)};
}

describe("recovered evidence in daily plans", () => {
  const recovered: RecoveredAttemptV1 = {
    schema_version: "1", record_type: "recovered_attempt", recovery_id: "a0000000-0000-4000-8000-000000000001",
    question_key: "119A99", answered_on: "2026-10-15", result: "incorrect",
    observed_at: "2026-10-15T20:00:00+09:00", recovered_at: "2026-10-16T03:00:00+09:00",
    study_mode: "unclassified", selected_option_indices: null, source_system: "computer-history",
    source_event_id: "synthetic-1", source_segment: "segment-1",
  };

  it("passes recovery evidence and reader exclusion counts into a new immutable plan", async () => {
    const store = journal();
    const source = { ...snapshot(), recoveredAttempts: [recovered], duplicateRecoveredRows: 2,
      suppressedRecoveredRows: 3, excludedFutureRecoveries: 4 };
    const saved = await prepareReview({ asOf: AS_OF, journal: store, readSnapshot: async () => source });
    expect(saved.all_time_counts.unclassified.attempts).toBe(1);
    expect(saved.recovered_evidence).toEqual({ attempts: 1, attempts_today: 0, excluded_future: 4, suppressed_by_direct: 3 });
    expect(saved.items.find((item) => item.question_key === recovered.question_key)?.reasons)
      .toContainEqual({ code: "recovered_evidence_due", facts: { answered_on: "2026-10-15", recovered_due_on: "2026-10-16",
        result: "incorrect", provisional: true, interval_days: 1 } });
    expect(saved.source_summary).toMatchObject({ canonical_attempts: 0, recovered_attempts: 1,
      duplicate_recovered_rows: 2, suppressed_recovered_rows: 3, excluded_future_recoveries: 4 });
    expect(store.read(saved.target_date, "plan")).toEqual(saved);
    expect(reviewProgress(saved, source.attempts, source.contexts, AS_OF)).toMatchObject({ review_attempts: 0, attempted_questions: 0 });
  });

  it("does not rewrite an old saved plan after recoveries arrive; the next day consumes them", async () => {
    const store = journal();
    const legacy = plan();
    store.writeOnce(legacy.target_date, "plan", legacy);
    const reader = vi.fn(async () => ({ ...snapshot(), recoveredAttempts: [recovered] }));
    const sameDay = await prepareReview({ asOf: "2026-10-16T18:00:00+09:00", journal: store, readSnapshot: reader });
    expect(sameDay).toEqual(legacy);
    expect(sameDay).not.toHaveProperty("recovered_evidence");
    expect(reader).not.toHaveBeenCalled();
    const nextDay = await prepareReview({ asOf: "2026-10-17T04:00:00+09:00", journal: store, readSnapshot: reader });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(nextDay.recovered_evidence?.attempts).toBe(1);
    expect(store.read(legacy.target_date, "plan")).toEqual(legacy);
  });

  it("shares the same evidence projection for CLI preview/status and persisted preparation", () => {
    expect(reviewSnapshotEvidence(snapshot())).toEqual({ attempts: [], contexts: [], questions: snapshot().questions });
    const source = { ...snapshot(), recoveredAttempts: [recovered], suppressedRecoveredRows: 3, excludedFutureRecoveries: 4 };
    expect(reviewSnapshotEvidence(source)).toMatchObject({ recovered_attempts: [recovered],
      suppressed_recovered_attempts: 3, excluded_future_recovered_attempts: 4 });
  });
});

describe("frozen daily plan and local recovery", () => {
  it("persists only examinations 116 through 120 in a new plan and manifest", async () => {
    const store = journal();
    const questionKeys = ["115A1", "116A1", "117B1", "118C1", "119D1", "120F1", "121A1"];
    const source: NotionReviewSnapshot = { ...snapshot(),
      attempts: questionKeys.map((key, index) => event(index + 1, key, "2026-10-15T05:00:00+09:00")),
      questions: questionKeys.map((key) => ({ question_key: key, stopped: false,
        next_review_on: "2026-10-15", subjects: [], fields: [] })),
    };
    const saved = await prepareReview({ asOf: AS_OF, journal: store, readSnapshot: async () => source });
    const expected = ["120F1", "116A1", "117B1", "118C1", "119D1"];
    expect(saved.items.map((item) => item.question_key)).toEqual(expected);
    expect(saved.eligible_question_count).toBe(expected.length);
    expect(saved.states.filter((state) => state.exclusion === "outside_exam_scope")
      .map((state) => state.question_key)).toEqual(["115A1", "121A1"]);
    expect(saved.states).toHaveLength(questionKeys.length);
    expect(saved.all_time_counts.total.attempts).toBe(questionKeys.length);
    expect(store.read(saved.target_date, "plan")).toEqual(saved);
    expect(store.read(saved.target_date, "manifest")).toMatchObject({ question_ids: expected });
  });

  it("reuses an older saved plan and manifest containing examinations 115 and 121 without rereading evidence", async () => {
    const store = journal();
    const questionKeys = ["115A1", "116B1", "120F1", "121A1"];
    const generated = generateDailyReviewPlan({ as_of: AS_OF, attempts: [],
      questions: questionKeys.map((key) => ({ question_key: key, next_review_on: "2026-10-15" })),
    });
    // Model the actual old selection, including eligible states and selected out-of-scope items.
    const legacy: SavedReviewPlan = { ...plan(), ...generated, algorithm_version: "3",
      eligible_question_count: questionKeys.length,
      states: generated.states.map((state) => ({ ...state, exclusion: null })),
      items: questionKeys.map((key, index): SavedReviewPlan["items"][number] => ({ question_key: key, position: index + 1, priority_tier: 0,
        reasons: [
          { code: "manual_due", facts: { manual_due_on: "2026-10-15" } },
          { code: "sparse_evidence", facts: { graded_attempts: 0, graded_distinct_days: 0, evidence_sufficiency: "insufficient" } },
          { code: "balance_bucket", facts: { bucket: "unclassified" } },
        ],
        model_due_at: null, manual_due_on: "2026-10-15", retrievability: null, evidence_sufficiency: "insufficient",
      })),
    };
    const manifest = createSetManifest(legacy);
    store.writeOnce(legacy.target_date, "plan", legacy);
    store.writeOnce(legacy.target_date, "manifest", manifest);
    store.writeOnce(legacy.target_date, "source-summary", legacy.source_summary);
    const planPath = join(store.directory, legacy.target_date, "plan.json");
    const manifestPath = join(store.directory, legacy.target_date, "manifest.json");
    const planBefore = readFileSync(planPath, "utf8");
    const manifestBefore = readFileSync(manifestPath, "utf8");
    const reader = vi.fn(async () => snapshot());

    const reused = await prepareReview({ asOf: "2026-10-16T21:00:00+09:00", journal: store, readSnapshot: reader });

    expect(reader).not.toHaveBeenCalled();
    expect(reused).toEqual(legacy);
    expect(reused.items.map((item) => item.question_key)).toEqual(questionKeys);
    expect(reused.states.every((state) => state.exclusion === null)).toBe(true);
    expect(store.read(legacy.target_date, "manifest")).toEqual(manifest);
    expect(readFileSync(planPath, "utf8")).toBe(planBefore);
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
  });

  it("keeps the first plan all day despite later answers or settings changes", async () => {
    const store = journal();
    const reader = vi.fn(async () => snapshot());
    const first = await prepareReview({asOf:AS_OF,journal:store,readSnapshot:reader,settings:{max_questions:2}});
    const second = await prepareReview({asOf:"2026-10-16T21:00:00+09:00",journal:store,readSnapshot:reader,settings:{max_questions:1}});
    expect(second).toEqual(first);
    expect(second.items).toHaveLength(2);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("recovers derived manifest and coverage files from the saved plan after interruption", async () => {
    const store = journal();
    const first = await prepareReview({asOf:AS_OF,journal:store,readSnapshot:async () => snapshot()});
    unlinkSync(join(store.directory,first.target_date,"manifest.json"));
    unlinkSync(join(store.directory,first.target_date,"source-summary.json"));
    const unavailableReader = vi.fn(async (): Promise<NotionReviewSnapshot> => {throw new Error("offline");});
    const recovered = await prepareReview({asOf:AS_OF,journal:store,readSnapshot:unavailableReader});
    expect(recovered).toEqual(first);
    expect(unavailableReader).not.toHaveBeenCalled();
    expect(store.read(first.target_date,"manifest")).toMatchObject({plan_id:first.plan_id});
    expect(store.read(first.target_date,"source-summary")).toMatchObject({excluded_future_events:3,excluded_from_aggregation_rows:4});
  });

  it("uses the recovery instant after a missed morning run without producing missed-day plans", async () => {
    const store = journal();
    const reader = vi.fn(async () => snapshot());
    const result = await prepareReview({asOf:"2026-10-19T12:00:00+09:00",journal:store,readSnapshot:reader});
    expect(reader).toHaveBeenCalledWith("2026-10-19T12:00:00+09:00");
    expect(result.target_date).toBe("2026-10-19");
    expect(result.selection_at).toBe("2026-10-19T03:00:00.000Z");
    expect(store.read("2026-10-18","plan")).toBeUndefined();
  });

  it("changes the plan day at exactly 04:00 JST and rejects an offset-free time", () => {
    expect(latestReviewDay("2026-10-16T03:59:59+09:00")).toBe("2026-10-15");
    expect(latestReviewDay(AS_OF)).toBe("2026-10-16");
    expect(() => latestReviewDay("2026-10-16")).toThrow("REVIEW_TIME_INVALID");
  });

  it("rejects a conflicting rewrite and a corrupted journal", () => {
    const store = journal();
    store.writeOnce("2026-10-16","sample",{count:1});
    store.writeOnce("2026-10-16","sample",{count:1});
    expect(() => store.writeOnce("2026-10-16","sample",{count:2})).toThrow("REVIEW_JOURNAL_CONFLICT");
    const file = join(store.directory,"2026-10-16","sample.json");
    const stored = JSON.parse(readFileSync(file,"utf8")) as {value:{count:number}};
    stored.value.count = 3;
    writeFileSync(file,JSON.stringify(stored));
    expect(() => store.read("2026-10-16","sample")).toThrow("REVIEW_JOURNAL_CORRUPT");
  });

  it("excludes concurrent local publishers and releases the lock after a handled failure", async () => {
    const store = journal();
    await expect(store.exclusive(async () => {
      await expect(store.exclusive(async () => undefined)).rejects.toThrow("REVIEW_PUBLISHER_LOCKED");
      throw new Error("handled failure");
    })).rejects.toThrow("handled failure");
    await expect(store.exclusive(async () => 1)).resolves.toBe(1);
  });
});

describe("Notion publication reconciliation", () => {
  it("persists create intent before calling Notion and never repeats an uncertain create", async () => {
    const store = journal();
    const p = plan();
    const remote = publisher();
    remote.create = vi.fn(async () => {
      expect(store.read(p.target_date,"notion-create-attempt-1")).toEqual({plan_id:p.plan_id});
      throw new Error("response lost");
    });
    await expect(publishReview(p,store,remote)).rejects.toThrow("response lost");
    await expect(publishReview(p,store,remote)).rejects.toThrow("REVIEW_NOTION_CREATE_UNRESOLVED");
    expect(remote.create).toHaveBeenCalledTimes(1);
  });

  it("recovers a matching page after an uncertain create without a second creation", async () => {
    const store = journal();
    const p = plan();
    store.writeOnce(p.target_date,"notion-intent",{plan_id:p.plan_id});
    const remote = publisher();
    remote.find = vi.fn(async () => [page]);
    await expect(publishReview(p,store,remote)).resolves.toBe(page.id);
    expect(remote.create).not.toHaveBeenCalled();
    expect(remote.verify).toHaveBeenCalledWith(page.id,p);
    expect(store.read(p.target_date,"notion-verified")).toEqual({id:page.id});
  });

  it("retries a definite 429 once per invocation, then holds an unknown second outcome", async () => {
    const store = journal();
    const p = plan();
    const remote = publisher();
    remote.create = vi.fn()
      .mockRejectedValueOnce(new NotionSyncError("NOTION_RATE_LIMITED", {retryable:true,ambiguous:false}))
      .mockRejectedValueOnce(new NotionSyncError("NOTION_NETWORK_ERROR", {retryable:true,ambiguous:true}));
    await expect(publishReview(p,store,remote)).rejects.toThrow("NOTION_RATE_LIMITED");
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(store.read(p.target_date,"notion-create-rejected-1")).toMatchObject({code:"NOTION_RATE_LIMITED",retryable:true});
    await expect(publishReview(p,store,remote)).rejects.toThrow("NOTION_NETWORK_ERROR");
    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(store.read(p.target_date,"notion-create-attempt-2")).toEqual({plan_id:p.plan_id});
    expect(store.read(p.target_date,"notion-create-rejected-2")).toBeUndefined();
    await expect(publishReview(p,store,remote)).rejects.toThrow("REVIEW_NOTION_CREATE_UNRESOLVED");
    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(store.read(p.target_date,"notion-create-attempt-3")).toBeUndefined();
  });

  it("honors a definite refusal's retry delay and confirms the successful next attempt", async () => {
    const store = journal();
    const p = plan();
    const clock = vi.spyOn(Date,"now").mockReturnValue(1_000);
    const remote = publisher();
    remote.create = vi.fn()
      .mockRejectedValueOnce(new NotionSyncError("NOTION_RATE_LIMITED", {retryable:true,ambiguous:false,retryAfterMs:5_000}))
      .mockResolvedValueOnce(page);
    await expect(publishReview(p,store,remote)).rejects.toThrow("NOTION_RATE_LIMITED");
    await expect(publishReview(p,store,remote)).rejects.toThrow("REVIEW_NOTION_RETRY_NOT_DUE");
    expect(remote.create).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(6_000);
    await expect(publishReview(p,store,remote)).resolves.toBe(page.id);
    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(store.read(p.target_date,"notion-create-rejected-1")).toMatchObject({retry_at_ms:6_000});
    expect(store.read(p.target_date,"notion-verified")).toEqual({id:page.id});
  });

  it("keeps non-retryable refusals and legacy unresolved intents stopped", async () => {
    const store = journal();
    const p = plan();
    const remote = publisher();
    remote.create = vi.fn(async () => {throw new NotionSyncError("NOTION_FORBIDDEN",{retryable:false,ambiguous:false});});
    await expect(publishReview(p,store,remote)).rejects.toThrow("NOTION_FORBIDDEN");
    await expect(publishReview(p,store,remote)).rejects.toThrow("REVIEW_NOTION_CREATE_REJECTED");
    expect(remote.create).toHaveBeenCalledTimes(1);
    const legacy = journal();
    legacy.writeOnce(p.target_date,"notion-intent",{plan_id:p.plan_id});
    await expect(publishReview(p,legacy,remote)).rejects.toThrow("REVIEW_NOTION_CREATE_UNRESOLVED");
    expect(remote.create).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate matching pages and does not create another", async () => {
    const remote = publisher();
    remote.find = vi.fn(async () => [page,{...page,id:"a0000000-0000-4000-8000-000000000002"}]);
    await expect(publishReview(plan(),journal(),remote)).rejects.toThrow("REVIEW_NOTION_DUPLICATES");
    expect(remote.create).not.toHaveBeenCalled();
  });

  it("requires a verified read after creation and preserves intent on a failed verification", async () => {
    const store = journal();
    const p = plan();
    const remote = publisher();
    remote.verify = vi.fn(async () => false);
    await expect(publishReview(p,store,remote)).rejects.toThrow("REVIEW_NOTION_VERIFY_FAILED");
    expect(store.read(p.target_date,"notion-create-attempt-1")).toBeDefined();
    expect(store.read(p.target_date,"notion-verified")).toBeUndefined();
    expect(store.read(p.target_date,"notion-created")).toEqual({id:page.id});
    remote.verify = vi.fn(async () => true);
    // Even an eventually consistent listing does not lose the returned page identity.
    await expect(publishReview(p,store,remote)).resolves.toBe(page.id);
    expect(remote.create).toHaveBeenCalledTimes(1);
  });

  it("rechecks an existing published page and does not recreate a changed or missing page", async () => {
    const store = journal();
    const p = plan();
    const remote = publisher();
    await publishReview(p,store,remote);
    remote.verify = vi.fn(async () => false);
    await expect(publishReview(p,store,remote)).rejects.toThrow("REVIEW_NOTION_CHANGED");
    expect(remote.create).toHaveBeenCalledTimes(1);
  });
});

describe("actual review progress", () => {
  it("counts the actually attempted position even if earlier questions were skipped", () => {
    const p = plan();
    const normal = event(1,"119A12");
    const third = event(2,"119A14");
    const retry = event(3,"119A14");
    const unclassified = event(4,"119A13");
    const progress = reviewProgress(p,[normal,third,retry,third,unclassified],[context(normal,"normal"),
      context(third,"review",p.plan_id),context(retry),context(unclassified,"unclassified")],"2026-10-16T06:00:00+09:00");
    expect(progress).toEqual({review_attempts:2,attempted_questions:1,attempted_positions:[3],
      remaining_question_ids:["119A12","119A13"],incorrect_attempts:2});
  });

  it("uses instants for offset times and excludes future and next-plan-day attempts", () => {
    const before = event(1,"119A12","2026-10-16T03:59:59+09:00");
    const at = event(2,"119A13",AS_OF);
    const future = event(3,"119A14","2026-10-16T06:00:00+09:00");
    const nextDay = event(4,"119A14","2026-10-17T04:00:00+09:00");
    const events = [before,at,future,nextDay];
    expect(reviewProgress(plan(),events,events.map((entry) => context(entry)),"2026-10-16T05:00:00+09:00").attempted_positions).toEqual([2]);
    expect(reviewProgress(plan(),[before,at,nextDay],events.map((entry) => context(entry)),"2026-10-18T05:00:00+09:00").attempted_positions).toEqual([2]);
  });

  it("excludes another explicitly named plan and rejects event or context conflicts", () => {
    const attempt = event(1);
    const other = context(attempt,"review","90000000-0000-4000-8000-000000000002");
    expect(reviewProgress(plan(),[attempt],[other],"2026-10-16T06:00:00+09:00").review_attempts).toBe(0);
    expect(() => reviewProgress(plan(),[attempt,{...attempt,result:"correct"}],[context(attempt)],"2026-10-16T06:00:00+09:00"))
      .toThrow("REVIEW_EVENT_CONFLICT");
    expect(() => reviewProgress(plan(),[attempt],[context(attempt),context(attempt,"normal")],"2026-10-16T06:00:00+09:00"))
      .toThrow("REVIEW_CONTEXT_CONFLICT");
  });
});

describe("QB set intent and verification", () => {
  it("stops blind repeated set creation and verifies both membership and order", () => {
    const store = journal();
    const p = plan();
    expect(beginQbSet(p,store).may_create).toBe(true);
    expect(beginQbSet(p,store).may_create).toBe(false);
    recordQbSet(p,store,"https://qb.medilink-study.com/search?questionSetId=test-set&operation=OR");
    expect(() => finishQbSet(p,store,["119A13","119A12","119A14"])).toThrow("REVIEW_QB_MEMBERSHIP_MISMATCH");
    finishQbSet(p,store,["119A12","119A13","119A14"]);
    expect(store.read(p.target_date,"qb-verified")).toMatchObject({question_ids:["119A12","119A13","119A14"]});
  });
});
