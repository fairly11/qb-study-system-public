import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { MigrationError } from "./errors.js";
import type { MigrationResult } from "./types.js";

const MIGRATION_FILE = /^(?<version>\d{4})_(?<name>[a-z0-9_]+)\.sql$/u;

const MIGRATION_METADATA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT;
`;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function migrationDirectoryUrl(): URL {
  const candidate = new URL("../migrations/", import.meta.url);
  if (existsSync(candidate)) {
    return candidate;
  }

  throw new MigrationError(
    "MIGRATION_DIRECTORY_NOT_FOUND",
    `Migration directory not found relative to ${fileURLToPath(import.meta.url)}`,
  );
}

export function readMigrations(directory: string | URL = migrationDirectoryUrl()): Migration[] {
  const entries: Dirent[] = readdirSync(directory, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry): Migration => {
      const match = MIGRATION_FILE.exec(entry.name);
      if (match?.groups === undefined) {
        throw new MigrationError(
          "MIGRATION_FILENAME_INVALID",
          `Invalid migration filename: ${entry.name}`,
        );
      }

      const versionText = match.groups.version;
      const name = match.groups.name;
      if (versionText === undefined || name === undefined) {
        throw new MigrationError(
          "MIGRATION_FILENAME_INVALID",
          `Invalid migration filename: ${entry.name}`,
        );
      }

      const sql = readFileSync(new URL(entry.name, asDirectoryUrl(directory)), "utf8");
      return {
        version: Number.parseInt(versionText, 10),
        name,
        fileName: entry.name,
        sql,
        checksum: sha256(sql),
      };
    })
    .sort((left, right) => left.version - right.version);

  validateMigrationSequence(migrations);
  return migrations;
}

function asDirectoryUrl(directory: string | URL): URL {
  if (directory instanceof URL) {
    return directory.href.endsWith("/") ? directory : new URL(`${directory.href}/`);
  }

  const absolute = resolve(directory);
  return pathToFileURL(absolute.endsWith(sep) ? absolute : `${absolute}${sep}`);
}

export function validateMigrationSequence(migrations: readonly Migration[]): void {
  if (migrations.length === 0) {
    throw new MigrationError(
      "MIGRATION_SEQUENCE_INVALID",
      "At least one numbered migration is required",
    );
  }

  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationError(
        "MIGRATION_SEQUENCE_INVALID",
        `Migration sequence expected version ${expected}, found ${migration.version}`,
      );
    }
  });
}

function readAppliedMigrations(database: DatabaseSync): AppliedMigrationRow[] {
  const rows = database
    .prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC",
    )
    .all();

  return rows.map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
  }));
}

function assertHistoryMatches(
  applied: readonly AppliedMigrationRow[],
  available: readonly Migration[],
): void {
  applied.forEach((row, index) => {
    const expectedVersion = index + 1;
    const migration = available[index];
    if (row.version !== expectedVersion || migration === undefined) {
      throw new MigrationError(
        "MIGRATION_HISTORY_DIVERGED",
        `Applied migration history diverged at version ${row.version}`,
      );
    }

    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new MigrationError(
        "MIGRATION_HISTORY_DIVERGED",
        `Applied migration ${row.version} no longer matches its recorded checksum`,
      );
    }
  });
}

export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[] = readMigrations(),
): MigrationResult {
  validateMigrationSequence(migrations);
  database.exec(MIGRATION_METADATA_SQL);

  const applied = readAppliedMigrations(database);
  assertHistoryMatches(applied, migrations);

  const appliedVersions: number[] = [];
  for (const migration of migrations.slice(applied.length)) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          new Date().toISOString(),
        );
      database.exec("COMMIT");
      appliedVersions.push(migration.version);
    } catch {
      database.exec("ROLLBACK");
      throw new MigrationError(
        "MIGRATION_APPLY_FAILED",
        `Migration ${migration.fileName} failed and was rolled back`,
      );
    }
  }

  return {
    applied_versions: appliedVersions,
    current_version: migrations.at(-1)?.version ?? 0,
  };
}

export function currentSchemaVersion(database: DatabaseSync): number {
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (table === undefined) {
    return 0;
  }

  const row = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get();
  return row === undefined ? 0 : Number(row.version);
}
