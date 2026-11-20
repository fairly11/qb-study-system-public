import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readNotionSyncConfig } from "../src/notion-config.js";

const directories: string[] = [];
const token = "ntn_synthetic_not_a_real_credential_00000000";
function setup(): { directory: string; path: string; secret: string; config: Record<string, unknown> } {
  const directory = mkdtempSync(join(tmpdir(), "qb-notion-config-"));
  directories.push(directory);
  const secret = join(directory, "notion-token");
  writeFileSync(secret, token, { mode: 0o600 });
  return { directory, secret, path: join(directory, "config.json"), config: {
    schema_version: "1", enabled: true,
    attempts_data_source_id: "10000000-0000-4000-8000-000000000001",
    questions_data_source_id: "10000000-0000-4000-8000-000000000002", token_file: secret,
  } };
}
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
describe("private Notion configuration", () => {
  it("reads a protected configuration and keeps target identity independent of credential rotation", () => {
    const data = setup();
    writeFileSync(data.path, JSON.stringify(data.config), { mode: 0o600 });
    const first = readNotionSyncConfig(data.path)!;
    expect(first.token).toBe(token);
    writeFileSync(data.secret, `${token}_rotated`);
    expect(readNotionSyncConfig(data.path)?.target).toBe(first.target);
  });
  it("disables sync without reading a token", () => {
    const data = setup();
    writeFileSync(data.path, JSON.stringify({ schema_version: "1", enabled: false }), { mode: 0o600 });
    expect(readNotionSyncConfig(data.path)).toBeUndefined();
  });
  it("rejects group-readable secrets and symlink secrets", () => {
    const data = setup();
    writeFileSync(data.path, JSON.stringify(data.config), { mode: 0o600 });
    chmodSync(data.secret, 0o640);
    expect(() => readNotionSyncConfig(data.path)).toThrow("NOTION_CONFIG_PERMISSIONS");
    chmodSync(data.secret, 0o600);
    const link = join(data.directory, "link");
    symlinkSync(data.secret, link);
    writeFileSync(data.path, JSON.stringify({ ...data.config, token_file: link }));
    expect(() => readNotionSyncConfig(data.path)).toThrow("NOTION_CONFIG_PERMISSIONS");
  });
  it("rejects same targets, extra properties and malformed secret JSON without leaking values", () => {
    const data = setup();
    writeFileSync(data.path, JSON.stringify({ ...data.config, questions_data_source_id: data.config.attempts_data_source_id }), { mode: 0o600 });
    expect(() => readNotionSyncConfig(data.path)).toThrow("NOTION_CONFIG_INVALID");
    writeFileSync(data.path, JSON.stringify({ ...data.config, token }));
    expect(() => readNotionSyncConfig(data.path)).toThrow("NOTION_CONFIG_INVALID");
    writeFileSync(data.path, `{${token}`);
    try { readNotionSyncConfig(data.path); throw new Error("EXPECTED_FAILURE"); }
    catch (error) {
      expect((error as Error).message).toBe("NOTION_CONFIG_INVALID");
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain(token);
    }
  });
});
