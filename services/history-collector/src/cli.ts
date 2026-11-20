import {
  CollectorConfigurationError,
  readHistoryCollectorConfig,
  startHistoryCollector,
} from "./index.js";
import { openSqliteNotionSyncStorage } from "@qb-study/storage/notion-sync";
import { NotionClient } from "./notion-client.js";
import { readNotionSyncConfig, type NotionSyncConfig } from "./notion-config.js";
import { NotionSyncWorker } from "./notion-sync.js";
import { VerifiedReviewSetResolver, readReviewSetReaderOptions,
  type ReviewSetResolution } from "./review-set-resolver.js";

function reviewSetResolver(client?: NotionClient): (id: string) => Promise<ReviewSetResolution> {
  try {
    const options = readReviewSetReaderOptions();
    const resolver = new VerifiedReviewSetResolver({ ...options,
      ...(client === undefined ? {} : { client }) });
    return (id) => resolver.resolve(id);
  } catch {
    return () => Promise.reject(new Error("REVIEW_SET_RESOLUTION_UNAVAILABLE"));
  }
}

function startNotionSync(databasePath: string, config: NotionSyncConfig, client: NotionClient): { close(): Promise<void> } {
  const storage = openSqliteNotionSyncStorage({ databasePath });
  let worker: NotionSyncWorker;
  try {
    storage.activateTarget(config.target);
    worker = new NotionSyncWorker({ storage, target: config.target, client });
  } catch (error) {
    storage.close();
    throw error;
  }
  let stopping = false;
  let active: Promise<void> | undefined;
  const tick = (): void => {
    if (stopping || active !== undefined) return;
    active = worker.runOnce().then((report) => {
      if (report.checked > 0 || report.code !== undefined) {
        process.stdout.write(`${JSON.stringify({ component: "notion-sync", event_code: report.code ?? "NOTION_SYNC_CHECKED",
          checked: report.checked, confirmed: report.confirmed, pending: report.pending,
          blocked: report.blocked, repaired: report.repaired })}\n`);
      }
    }).catch(() => {
      process.stderr.write(`${JSON.stringify({ component: "notion-sync", event_code: "NOTION_SYNC_UNAVAILABLE" })}\n`);
    }).finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, 15_000);
  tick();
  return { async close(): Promise<void> {
    stopping = true;
    clearInterval(timer);
    await active;
    storage.close();
  } };
}

type CliEventCode =
  | "COLLECTOR_CONFIGURATION_BLOCKED"
  | "COLLECTOR_LISTENING"
  | "COLLECTOR_PORT_UNAVAILABLE"
  | "COLLECTOR_START_BLOCKED"
  | "COLLECTOR_STOPPED";

function writeCliEvent(
  destination: NodeJS.WriteStream,
  eventCode: CliEventCode,
  port?: number,
): void {
  destination.write(`${JSON.stringify({
    component: "history-collector",
    event_code: eventCode,
    ...(port === undefined ? {} : { port }),
  })}\n`);
}

function isPortUnavailable(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "EADDRINUSE";
}

async function main(): Promise<void> {
  let config;
  try {
    config = readHistoryCollectorConfig();
  } catch (error) {
    writeCliEvent(
      process.stderr,
      error instanceof CollectorConfigurationError
        ? "COLLECTOR_CONFIGURATION_BLOCKED"
        : "COLLECTOR_START_BLOCKED",
    );
    process.exitCode = 1;
    return;
  }

  let syncing: { close(): Promise<void> } | undefined;
  let notionClient: NotionClient | undefined;
  try {
    const notionConfig = readNotionSyncConfig();
    if (notionConfig !== undefined) {
      notionClient = new NotionClient(notionConfig);
      syncing = startNotionSync(config.databasePath, notionConfig, notionClient);
    }
  } catch {
    // Configuration/API problems must not interrupt durable local capture.
    process.stderr.write(`${JSON.stringify({ component: "notion-sync", event_code: "NOTION_CONFIGURATION_BLOCKED" })}\n`);
  }
  let running;
  try {
    running = await startHistoryCollector({
      port: config.port,
      databasePath: config.databasePath,
      resolveReviewSet: reviewSetResolver(notionClient),
    });
  } catch (error) {
    await syncing?.close();
    writeCliEvent(
      process.stderr,
      isPortUnavailable(error)
        ? "COLLECTOR_PORT_UNAVAILABLE"
        : "COLLECTOR_START_BLOCKED",
      config.port,
    );
    process.exitCode = 1;
    return;
  }

  writeCliEvent(process.stdout, "COLLECTOR_LISTENING", running.port);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      await running.close();
      await syncing?.close();
      writeCliEvent(process.stdout, "COLLECTOR_STOPPED", running.port);
    } catch {
      writeCliEvent(process.stderr, "COLLECTOR_START_BLOCKED", running.port);
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}

void main();
