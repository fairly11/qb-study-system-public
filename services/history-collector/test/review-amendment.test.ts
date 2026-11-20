import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptEventV1, StudyContextV1 } from "@qb-study/contracts";
import { generateDailyReviewPlan, type ReviewMemoryModel } from "@qb-study/review-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewJournal, amendReviewDay, beginQbSet, finishQbSet, prepareReview, publishReviewRevision,
  qbVerificationKey, readEffectiveReviewPlan, readReviewRevision, recordQbSet, reviewProgress,
  type ReviewRevisionPublisher, type SavedReviewPlan } from "../src/review-service.js";
import { NotionSyncError } from "../src/notion-client.js";

const paths: string[] = [];
const day = "2026-10-16";
const morning = "2026-10-16T04:00:00+09:00";
const revisedAt = "2026-10-16T11:00:00+09:00";
const planId = "90000000-0000-4000-8000-000000000001";
const url = "https://qb.medilink-study.com/search?questionSetId=existing-set&operation=OR";
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, {recursive:true,force:true}); });

function event(id: number, question: string, at = "2026-10-15T05:00:00.000Z"): AttemptEventV1 {
  return {schema_version:"1",record_type:"attempt_event",event_id:`10000000-0000-4000-8000-${String(id).padStart(12,"0")}`,
    question_key:question,answered_at:at,result:"incorrect",selected_option_indices:[1],
    provenance:{producer:"browser-extension",producer_version:"0.1.2",source_system:"qb-web-dom",recorded_at:at},
    quality:{acquisition_method:"direct_capture",temporal_precision:"exact",state_precision:"exact"}};
}
function setup() {
  const path = mkdtempSync(join(tmpdir(), "qb-amendment-test-")); paths.push(path);
  const journal = new ReviewJournal(path);
  const model: ReviewMemoryModel = {model_id:"test",model_version:"1",grade_policy_version:"1",
    predict({attempts}) { return {next_review_at: attempts[0]?.question_key === "119A12"
      ? "2026-10-14T19:00:00.000Z" : "2026-10-16T07:00:00.000Z",
    retrievability:0.5,stability_days:1,difficulty:5,derived_grades:[]}; }};
  const current = generateDailyReviewPlan({as_of:morning,attempts:[event(1,"119A12"),event(2,"119A13")],model});
  const {due_before, ...legacy} = current; void due_before;
  const original: SavedReviewPlan = {...legacy,algorithm_version:"2",plan_id:planId,
    items:current.items.filter((item) => item.question_key === "119A12"),eligible_question_count:1,
    states:current.states.map((state) => state.question_key === "119A13" ? {...state,exclusion:"not_due"} : state),
    source_summary:{read_started_at:"2026-10-15T19:00:00.000Z",read_completed_at:"2026-10-15T19:00:01.000Z",
      canonical_attempts:2,unknown_attempt_rows:0,duplicate_attempt_rows:0,unknown_question_rows:0,
      excluded_future_events:0,excluded_from_aggregation_rows:0}};
  journal.writeOnce(day,"plan",original);
  beginQbSet(original,journal); recordQbSet(original,journal,url); finishQbSet(original,journal,["119A12"]);
  journal.writeOnce(day,"notion-verified",{id:"a0000000-0000-4000-8000-000000000001"});
  journal.writeOnce(day,"notion-set-link-verified",{page_id:"a0000000-0000-4000-8000-000000000001",url});
  return {journal,original};
}

describe("explicit same-day append-only amendment", () => {
  it("retains the original files, plan identity, morning answers and selected prefix", async () => {
    const {journal,original} = setup();
    const before = ["plan","qb-verified","qb-intent","qb-created"].map((name) => readFileSync(join(journal.directory,day,name+".json"),"utf8"));
    const revision = amendReviewDay(day,revisedAt,journal);
    const effective = readEffectiveReviewPlan(day,journal)!;
    expect(effective.items.map((item) => item.question_key)).toEqual(["119A12","119A13"]);
    expect(effective.items[0]).toEqual(original.items[0]);
    expect(effective.items[1]?.position).toBe(2);
    expect(effective.selection_at).toBe(original.selection_at);
    expect(effective.plan_id).toBe(original.plan_id);
    expect(effective.evidence_hash).toBe(original.evidence_hash);
    expect(effective.due_before).toBe("2026-10-16T19:00:00.000Z");
    expect(effective.eligible_question_count).toBe(2);
    expect(amendReviewDay(day,"2026-10-16T18:00:00+09:00",journal)).toEqual(revision);
    expect(["plan","qb-verified","qb-intent","qb-created"].map((name) => readFileSync(join(journal.directory,day,name+".json"),"utf8"))).toEqual(before);
    const readSnapshot = vi.fn(async () => {throw new Error("must not recalculate");});
    expect(await prepareReview({asOf:revisedAt,journal,readSnapshot})).toEqual(original);
    expect(readSnapshot).not.toHaveBeenCalled();
    const early = event(3,"119A12","2026-10-16T00:00:00.000Z");
    const later = event(4,"119A13","2026-10-16T03:00:00.000Z");
    const contexts: StudyContextV1[] = [early,later].map((attempt) => ({schema_version:"1",record_type:"study_context",
      event_id:attempt.event_id,study_mode:"review",review_plan_id:planId}));
    expect(reviewProgress(effective,[early,later],contexts,"2026-10-16T13:00:00+09:00").attempted_positions).toEqual([1,2]);
  });

  it("requires verification of all revised IDs and preserves base verification", () => {
    const {journal,original} = setup(); amendReviewDay(day,revisedAt,journal);
    const effective = readEffectiveReviewPlan(day,journal)!;
    expect(qbVerificationKey(effective,journal)).toBe("qb-verified-revision-1");
    expect(journal.read(day,qbVerificationKey(effective,journal))).toBeUndefined();
    expect(() => finishQbSet(effective,journal,["119A12"])).toThrow("REVIEW_QB_MEMBERSHIP_MISMATCH");
    expect(() => finishQbSet(effective,journal,["119A13","119A12"])).toThrow("REVIEW_QB_MEMBERSHIP_MISMATCH");
    expect(() => finishQbSet(original,journal,["119A12"])).toThrow("REVIEW_PLAN_REVISION_MISMATCH");
    finishQbSet(effective,journal,["119A12","119A13"]);
    expect(journal.read(day,"qb-verified")).toMatchObject({question_ids:["119A12"]});
    expect(journal.read(day,"qb-verified-revision-1")).toMatchObject({question_ids:["119A12","119A13"]});
  });

  it("does not amend another day or accept an unbound revision", () => {
    const {journal} = setup();
    expect(() => amendReviewDay(day,"2026-10-17T04:00:00+09:00",journal)).toThrow("REVIEW_AMENDMENT_DAY_MISMATCH");
    expect(readReviewRevision(day,journal)).toBeUndefined();
    const revision = amendReviewDay(day,revisedAt,journal);
    const other = setup();
    other.journal.writeOnce(day,"revision-1",{...revision,base_plan_sha256:"invalid"});
    expect(() => readEffectiveReviewPlan(day,other.journal)).toThrow("REVIEW_JOURNAL_CORRUPT");
  });

  it("restores only the derived manifest after interruption between revision writes", () => {
    const {journal} = setup();
    const revision = amendReviewDay(day,revisedAt,journal);
    rmSync(join(journal.directory,day,"manifest-revision-1.json"));
    expect(amendReviewDay(day,revisedAt,journal)).toEqual(revision);
    expect(journal.read(day,"manifest-revision-1")).toMatchObject({question_ids:["119A12","119A13"]});
  });
});

describe("Notion amendment reconciliation", () => {
  function remote() {
    let present = false;
    const publisher: ReviewRevisionPublisher = {
      verify:vi.fn(async () => true),readRevision:vi.fn(async () => present ? {revision:1} : undefined),
      verifyRevision:vi.fn(async () => present),appendRevision:vi.fn(async () => {present=true;}),
    };
    return {publisher,makePresent:() => {present=true;}};
  }

  it("publishes once only after QB verification and rereads before reporting completion", async () => {
    const {journal,original} = setup(); const revision = amendReviewDay(day,revisedAt,journal); const {publisher} = remote();
    await expect(publishReviewRevision(original,revision,journal,publisher)).rejects.toThrow("REVIEW_VERIFIED_SET_REQUIRED");
    expect(publisher.appendRevision).not.toHaveBeenCalled();
    finishQbSet(revision.effective_plan,journal,["119A12","119A13"]);
    await publishReviewRevision(original,revision,journal,publisher);
    await publishReviewRevision(original,revision,journal,publisher);
    expect(publisher.appendRevision).toHaveBeenCalledTimes(1);
    expect(publisher.verifyRevision).toHaveBeenCalledTimes(2);
    expect(journal.read(day,"notion-revision-1-verified")).toMatchObject({question_ids:["119A12","119A13"],url});
  });

  it("never repeats an ambiguous append and resumes through positive readback", async () => {
    const {journal,original} = setup(); const revision = amendReviewDay(day,revisedAt,journal); const r = remote();
    finishQbSet(revision.effective_plan,journal,["119A12","119A13"]);
    r.publisher.appendRevision = vi.fn(async () => {throw new NotionSyncError("NOTION_NETWORK_ERROR",{retryable:true,ambiguous:true});});
    await expect(publishReviewRevision(original,revision,journal,r.publisher)).rejects.toThrow("NOTION_NETWORK_ERROR");
    await expect(publishReviewRevision(original,revision,journal,r.publisher)).rejects.toThrow("REVIEW_NOTION_REVISION_UNRESOLVED");
    expect(r.publisher.appendRevision).toHaveBeenCalledTimes(1);
    r.makePresent();
    await publishReviewRevision(original,revision,journal,r.publisher);
    expect(r.publisher.appendRevision).toHaveBeenCalledTimes(1);
  });
});
