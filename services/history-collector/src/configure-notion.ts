import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NotionClient } from "./notion-client.js";
import { defaultNotionConfigPath } from "./notion-config.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("NOTION_SETUP_TTY_REQUIRED");
  process.stdout.write("Notion接続用のシークレットを貼り付け、Returnを押してください（入力内容は表示しません）：\n");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\u0003" || char === "\u0004") {
          finish(); reject(new Error("NOTION_SETUP_CANCELLED")); return;
        }
        if (char === "\r" || char === "\n") {
          finish(); resolve(value.trim()); return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (/^[A-Za-z0-9_-]$/u.test(char)) value += char;
        else { finish(); reject(new Error("NOTION_TOKEN_INVALID")); return; }
        if (value.length > 512) { finish(); reject(new Error("NOTION_TOKEN_INVALID")); return; }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const [attemptsDataSourceId, questionsDataSourceId, ...extra] = process.argv.slice(2);
  if (extra.length !== 0 || attemptsDataSourceId === undefined || questionsDataSourceId === undefined
    || !UUID.test(attemptsDataSourceId) || !UUID.test(questionsDataSourceId)
    || attemptsDataSourceId.toLowerCase() === questionsDataSourceId.toLowerCase()) {
    throw new Error("NOTION_SETUP_TARGET_REQUIRED");
  }
  const path = defaultNotionConfigPath();
  const tokenFile = join(dirname(path), "notion-token");
  if (existsSync(path) || existsSync(tokenFile)) throw new Error("NOTION_SETUP_EXISTS");
  const token = await readSecret();
  if (!/^[A-Za-z0-9_-]{20,512}$/u.test(token)) throw new Error("NOTION_TOKEN_INVALID");
  // Validate the exact targets without creating any study record.
  const client = new NotionClient({ token, attemptsDataSourceId, questionsDataSourceId });
  await client.validateSchema();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Never replace an existing credential or configuration implicitly.
  writeFileSync(tokenFile, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    writeFileSync(path, `${JSON.stringify({ schema_version: "1", enabled: true,
      attempts_data_source_id: attemptsDataSourceId, questions_data_source_id: questionsDataSourceId,
      token_file: tokenFile }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    unlinkSync(tokenFile);
    throw new Error("NOTION_SETUP_FAILED");
  }
  process.stdout.write("接続先を確認し、このMac専用の設定を保存しました。収集プログラムを再起動すると、新しい解答の同期を開始します。\n");
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^NOTION_[A-Z_]+$/u.test(error.message) ? error.message : "NOTION_SETUP_FAILED";
  process.stderr.write(`${code}\n設定は完了していません。既存の学習記録は変更していません。\n`);
  process.exitCode = 1;
});
