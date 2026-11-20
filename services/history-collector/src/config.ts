import { isAbsolute } from "node:path";

import { defaultDatabasePath } from "@qb-study/storage/history-collector";

export const HISTORY_COLLECTOR_HOST = "127.0.0.1" as const;
export const DEFAULT_HISTORY_COLLECTOR_PORT = 8_765;

const MAX_DATABASE_PATH_LENGTH = 4_096;
const DECIMAL_PORT = /^[1-9][0-9]{0,4}$/u;

export type CollectorConfigurationErrorCode =
  | "COLLECTOR_DATABASE_PATH_INVALID"
  | "COLLECTOR_PORT_INVALID";

export class CollectorConfigurationError extends Error {
  public override readonly name = "CollectorConfigurationError";

  public constructor(public readonly code: CollectorConfigurationErrorCode) {
    super(code);
  }
}

export interface HistoryCollectorConfig {
  readonly host: typeof HISTORY_COLLECTOR_HOST;
  readonly port: number;
  readonly databasePath: string;
}

export interface HistoryCollectorEnvironment {
  readonly QB_STUDY_COLLECTOR_PORT?: string;
  readonly QB_STUDY_DB_PATH?: string;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_HISTORY_COLLECTOR_PORT;
  }
  if (!DECIMAL_PORT.test(value)) {
    throw new CollectorConfigurationError("COLLECTOR_PORT_INVALID");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CollectorConfigurationError("COLLECTOR_PORT_INVALID");
  }
  return port;
}

function parseDatabasePath(value: string | undefined): string {
  if (value === undefined) {
    return defaultDatabasePath();
  }
  if (
    value.length === 0
    || value.length > MAX_DATABASE_PATH_LENGTH
    || value.includes("\0")
    || !isAbsolute(value)
  ) {
    throw new CollectorConfigurationError("COLLECTOR_DATABASE_PATH_INVALID");
  }
  return value;
}

export function readHistoryCollectorConfig(
  environment: HistoryCollectorEnvironment = process.env,
): HistoryCollectorConfig {
  return Object.freeze({
    host: HISTORY_COLLECTOR_HOST,
    port: parsePort(environment.QB_STUDY_COLLECTOR_PORT),
    databasePath: parseDatabasePath(environment.QB_STUDY_DB_PATH),
  });
}
