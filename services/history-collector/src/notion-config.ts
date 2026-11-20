import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface NotionSyncConfig {
  readonly token: string;
  readonly attemptsDataSourceId: string;
  readonly questionsDataSourceId: string;
  readonly target: string;
}

export function defaultNotionConfigPath(): string {
  return join(homedir(), "Library", "Application Support", "qb-study-system", "notion-sync.json");
}

function readPrivateFile(path: string, maximum: number): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("NOTION_CONFIG_INVALID");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum
    || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) {
    throw new Error("NOTION_CONFIG_PERMISSIONS");
  }
  return readFileSync(path, "utf8");
}

/** No connector credentials are reused; each Mac receives a private integration token file. */
export function readNotionSyncConfig(path = process.env.QB_STUDY_NOTION_CONFIG ?? defaultNotionConfigPath()): NotionSyncConfig | undefined {
  if (!existsSync(path)) {
    if (process.env.QB_STUDY_NOTION_CONFIG !== undefined) throw new Error("NOTION_CONFIG_MISSING");
    return undefined;
  }
  try {
    const raw: unknown = JSON.parse(readPrivateFile(path, 8_192));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("NOTION_CONFIG_INVALID");
    const config = raw as Record<string, unknown>;
    const allowed = ["schema_version", "enabled", "attempts_data_source_id", "questions_data_source_id", "token_file"];
    if (Object.keys(config).some((key) => !allowed.includes(key)) || config.schema_version !== "1"
      || typeof config.enabled !== "boolean") throw new Error("NOTION_CONFIG_INVALID");
    if (!config.enabled) return undefined;
    if (typeof config.attempts_data_source_id !== "string" || !UUID.test(config.attempts_data_source_id)
      || typeof config.questions_data_source_id !== "string" || !UUID.test(config.questions_data_source_id)
      || typeof config.token_file !== "string"
      || config.attempts_data_source_id.toLowerCase() === config.questions_data_source_id.toLowerCase()) {
      throw new Error("NOTION_CONFIG_INVALID");
    }
    const token = readPrivateFile(config.token_file, 4_096).trim();
    if (!/^[A-Za-z0-9_-]{20,512}$/u.test(token)) throw new Error("NOTION_TOKEN_INVALID");
    const attemptsDataSourceId = config.attempts_data_source_id.toLowerCase();
    const questionsDataSourceId = config.questions_data_source_id.toLowerCase();
    const target = createHash("sha256").update(`notion-v1:${attemptsDataSourceId}:${questionsDataSourceId}`).digest("hex");
    return { token, attemptsDataSourceId, questionsDataSourceId, target };
  } catch (error) {
    if (error instanceof Error && /^NOTION_[A-Z_]+$/u.test(error.message)) throw error;
    // eslint-disable-next-line preserve-caught-error -- A cause may retain credential bytes or private paths.
    throw new Error("NOTION_CONFIG_INVALID");
  }
}
