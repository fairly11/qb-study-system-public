/* global process */

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { schemaRegistryV1 } from "../src/schemas-v1.js";

import { studySchemaRegistryV1 } from "../src/study-context.js";
import { recoveredSchemaRegistryV1 } from "../src/recovered-attempt.js";

const schemas = [...schemaRegistryV1, ...studySchemaRegistryV1, ...recoveredSchemaRegistryV1];

const CHECK_FLAG = "--check";
const checking = process.argv.includes(CHECK_FLAG);
const schemaDirectory = fileURLToPath(new URL("../schemas/v1/", import.meta.url));
const staleFiles: string[] = [];
const expectedFileNames = new Set<string>(
  schemas.map(({ fileName }) => fileName),
);

if (!checking) {
  await mkdir(schemaDirectory, { recursive: true });
}

for (const { fileName, schema } of schemas) {
  const path = `${schemaDirectory}${fileName}`;
  const expected = `${JSON.stringify(schema, null, 2)}\n`;

  if (checking) {
    let actual: string | undefined;
    try {
      actual = await readFile(path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (actual !== expected) {
      staleFiles.push(fileName);
    }
  } else {
    await writeFile(path, expected, "utf8");
  }
}

const schemaDirectoryEntries = await readdir(schemaDirectory, {
  withFileTypes: true,
}).catch((error: unknown) => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return [];
  }
  throw error;
});

for (const entry of schemaDirectoryEntries) {
  if (
    !entry.isFile() ||
    !entry.name.endsWith(".schema.json") ||
    expectedFileNames.has(entry.name)
  ) {
    continue;
  }
  if (checking) {
    staleFiles.push(`unexpected:${entry.name}`);
  } else {
    await unlink(`${schemaDirectory}${entry.name}`);
  }
}

if (staleFiles.length > 0) {
  process.stderr.write(`Generated JSON Schema files are stale: ${staleFiles.join(", ")}\n`);
  process.exitCode = 1;
}
