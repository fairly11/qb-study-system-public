import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createSetManifest, remainingSetItems } from "@qb-study/set-builder";
import { generateDailyReviewPlan } from "@qb-study/review-engine";
import { NotionClient, NotionSyncError } from "./notion-client.js";
import { readNotionSyncConfig } from "./notion-config.js";
import { NotionReviewPublisher } from "./notion-review.js";
import { ReviewJournal, beginQbSet, finishQbSet, latestReviewDay, prepareReview, publishReview, recordQbSet,
  reviewProgress, reviewSnapshotEvidence, amendReviewDay, readEffectiveReviewPlan, readReviewRevision,
  qbVerificationKey, publishReviewRevision, type SavedReviewPlan } from "./review-service.js";

const base = join(homedir(), "Library", "Application Support", "qb-study-system");
interface ReviewConfig {
  schema_version: "1"; publisher_host: string; notion_parent_page_id: string; max_questions: number;
  request_retention?: number; per_question_daily_cap?: number; settings_version?: string;
}
function config(): ReviewConfig {
  const file = join(base, "review-config.json");
  if (!existsSync(file)) throw new Error("REVIEW_CONFIG_MISSING");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (stat.mode & 0o077) !== 0) {
    throw new Error("REVIEW_CONFIG_PERMISSIONS");
  }
  const value = JSON.parse(readFileSync(file, "utf8")) as ReviewConfig;
  if (value.schema_version !== "1" || value.publisher_host !== hostname()
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value.notion_parent_page_id)
    || !Number.isSafeInteger(value.max_questions) || value.max_questions < 1 || value.max_questions > 100
    || (value.request_retention !== undefined && (!Number.isFinite(value.request_retention) || value.request_retention <= 0 || value.request_retention >= 1))
    || (value.per_question_daily_cap !== undefined && (!Number.isSafeInteger(value.per_question_daily_cap) || value.per_question_daily_cap < 1 || value.per_question_daily_cap > 100))
    || (value.settings_version !== undefined && (typeof value.settings_version !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/u.test(value.settings_version)))
    || Object.keys(value).some((key) => !["schema_version","publisher_host","notion_parent_page_id","max_questions","request_retention","per_question_daily_cap","settings_version"].includes(key))) {
    throw new Error("REVIEW_CONFIG_INVALID_OR_WRONG_HOST");
  }
  return value;
}
function readIds(path: string | undefined): readonly string[] {
  if (!path) throw new Error("REVIEW_IDS_FILE_REQUIRED");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) throw new Error("REVIEW_IDS_INVALID");
  return value as string[];
}
async function main(): Promise<void> {
  const [command, argument, dateArg] = process.argv.slice(2);
  const settings = config();
  const engineSettings = {max_questions: settings.max_questions,
    request_retention: settings.request_retention ?? 0.9,
    per_question_daily_cap: settings.per_question_daily_cap ?? 2,
    settings_version: settings.settings_version ?? "daily-review-settings-v1"};
  const notion = readNotionSyncConfig();
  if (!notion) throw new Error("REVIEW_NOTION_REQUIRED");
  const client = new NotionClient(notion);
  const publisher = new NotionReviewPublisher({client, parentPageId: settings.notion_parent_page_id});
  const journal = new ReviewJournal(join(base, "daily-review"));
  const asOf = new Date().toISOString();
  const day = dateArg ?? latestReviewDay(asOf);
  const output = await journal.exclusive(async () => {
    if (command === "preview") {
      const snapshot = await client.readReviewSnapshot({asOf});
      const preview = generateDailyReviewPlan({as_of:asOf,...reviewSnapshotEvidence(snapshot),settings:engineSettings});
      return {event_code:"REVIEW_PREVIEW",target_date:preview.target_date,items:preview.items,
        daily_counts:preview.daily_counts,
        ...(preview.recovered_evidence === undefined ? {} : {recovered_evidence:preview.recovered_evidence}),canonical_attempts:snapshot.attempts.length,
        excluded_rows:snapshot.excludedFromAggregationRows,unknown_rows:snapshot.unknownAttemptRows};
    }
    if (command === "configure-schema") {
      await client.ensureStudyContextSchema();
      return {event_code:"REVIEW_STUDY_CONTEXT_SCHEMA_READY"};
    }
    if (command === "prepare") {
      await client.assertReviewParent(settings.notion_parent_page_id);
      const original = await prepareReview({asOf, journal, readSnapshot: (time) => client.readReviewSnapshot({asOf:time}),
        settings:engineSettings});
      const notionPageId = await publishReview(original, journal, publisher);
      const plan = readEffectiveReviewPlan(original.target_date, journal)!;
      const revision = readReviewRevision(original.target_date,journal);
      const revisionStatus = revision === undefined ? undefined : {
        qb_revision_verified:journal.read(original.target_date,"qb-verified-revision-1") !== undefined,
        notion_revision_verified:journal.read(original.target_date,"notion-revision-1-verified") !== undefined,
      };
      const revisionPending = revisionStatus !== undefined
        && (!revisionStatus.qb_revision_verified || !revisionStatus.notion_revision_verified);
      return {event_code:revisionPending ? "REVIEW_REVISION_PENDING" : "REVIEW_PLAN_READY",
        notion_url:"https://www.notion.so/" + notionPageId.replaceAll("-",""),
        ...(revisionStatus ?? {}),
        manifest:createSetManifest(plan), source:journal.read(plan.target_date,"source-summary"),
        items:plan.items, daily_counts:plan.daily_counts, model_status:plan.model_status,
        ...(plan.recovered_evidence === undefined ? {} : {recovered_evidence:plan.recovered_evidence})};
    }
    if (command === "amend-day") {
      if (!dateArg) throw new Error("REVIEW_EXPLICIT_DATE_REQUIRED");
      const revision = amendReviewDay(day, asOf, journal);
      return {event_code:"REVIEW_DAY_AMENDED",revision:revision.revision,
        manifest:createSetManifest(revision.effective_plan),due_before:revision.effective_plan.due_before};
    }
    const plan = readEffectiveReviewPlan(day, journal);
    if (!plan) throw new Error("REVIEW_PLAN_MISSING");
    if (command === "begin-set") return beginQbSet(plan,journal);
    if (command === "record-set") {
      if (!argument) throw new Error("REVIEW_QB_URL_REQUIRED");
      recordQbSet(plan,journal,argument);
      return {event_code:"REVIEW_QB_SET_RECORDED"};
    }
    if (command === "remaining") return {question_ids:remainingSetItems(createSetManifest(plan),readIds(argument))};
    if (command === "verify-set") {
      finishQbSet(plan,journal,readIds(argument));
      return {event_code:"REVIEW_QB_SET_VERIFIED",count:plan.items.length};
    }
    if (command === "link-set") {
      const page = journal.read<{id:string}>(day,"notion-verified");
      const set = journal.read<{url:string}>(day,"qb-created");
      if (!page || !set || !journal.read(day,qbVerificationKey(plan,journal))) throw new Error("REVIEW_VERIFIED_SET_REQUIRED");
      const existing = await publisher.readExistingSetLink(page.id);
      if (existing !== undefined && existing !== set.url) throw new Error("REVIEW_SET_LINK_CONFLICT");
      if (existing === undefined) {
        let index = 1;
        while (journal.read(day,`notion-set-link-intent-${index}`)) {
          const rejected = journal.read<{retry_at_ms:number}>(day,`notion-set-link-rejected-${index}`);
          if (!rejected) throw new Error("REVIEW_SET_LINK_UNRESOLVED");
          if (Date.now() < rejected.retry_at_ms) throw new Error("REVIEW_SET_LINK_RETRY_LATER");
          index++;
        }
        journal.writeOnce(day,`notion-set-link-intent-${index}`,{page_id:page.id,url:set.url});
        try { await publisher.appendReviewedSetLink(page.id,set.url); }
        catch (error) {
          if (error instanceof NotionSyncError && error.retryable && !error.ambiguous) {
            journal.writeOnce(day,`notion-set-link-rejected-${index}`,
              {retry_at_ms:Date.now() + (error.retryAfterMs ?? 15_000)});
          }
          throw error;
        }
      }
      if (await publisher.readExistingSetLink(page.id) !== set.url) throw new Error("REVIEW_SET_LINK_VERIFY_FAILED");
      journal.writeOnce(day,"notion-set-link-verified",{page_id:page.id,url:set.url});
      const revision = readReviewRevision(day,journal);
      if (revision) await publishReviewRevision(journal.read<SavedReviewPlan>(day,"plan")!,revision,journal,publisher);
      return {event_code:"REVIEW_SET_LINK_READY",url:set.url};
    }
    if (command === "status") {
      const snapshot = await client.readReviewSnapshot({asOf});
      const current = generateDailyReviewPlan({as_of:asOf,...reviewSnapshotEvidence(snapshot),settings:engineSettings});
      const revision = readReviewRevision(day,journal);
      return {event_code:"REVIEW_STATUS",target_date:day,manifest:createSetManifest(plan),
        notion:journal.read(day,"notion-verified"),qb_set:journal.read(day,"qb-created"),
        qb_verified:journal.read(day,qbVerificationKey(plan,journal)) !== undefined,
        revision:revision?.revision ?? 0,
        ...(revision === undefined ? {} : {
          qb_revision_verified:journal.read(day,"qb-verified-revision-1") !== undefined,
          notion_revision_verified:journal.read(day,"notion-revision-1-verified") !== undefined,
        }),
        progress:reviewProgress(plan,snapshot.attempts,snapshot.contexts,asOf),daily_counts:current.daily_counts,
        ...(current.recovered_evidence === undefined ? {} : {recovered_evidence:current.recovered_evidence})};
    }
    throw new Error("REVIEW_COMMAND_INVALID");
  });
  process.stdout.write(JSON.stringify(output) + "\n");
}
void main().catch((error: unknown) => {
  const code = error instanceof NotionSyncError ? error.code
    : error instanceof Error && /^REVIEW_[A-Z_]+$/u.test(error.message) ? error.message : "REVIEW_COMMAND_FAILED";
  process.stderr.write(JSON.stringify({event_code:code}) + "\n");
  process.exitCode = 1;
});
