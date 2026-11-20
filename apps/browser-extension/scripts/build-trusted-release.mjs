import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const artifactDirectory = join(repositoryRoot, "artifacts");
const extensionDistDirectory = join(packageRoot, "dist");
const releaseSourceDirectory = join(packageRoot, "release");
const collectorDistEntry = join(
  repositoryRoot,
  "services/history-collector/dist/cli.js",
);
const migrationSourceDirectory = join(repositoryRoot, "packages/storage/migrations");
const contractsNodeModules = join(repositoryRoot, "packages/contracts/node_modules");

const extensionFiles = Object.freeze([
  "content-script.js",
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
  "service-worker.js",
]);

const forbiddenReleasePath = /(?:^|\/)(?:\.DS_Store|\.env(?:\..*)?|\.git|\.npmrc|\.pnpmrc|__MACOSX|node_modules)(?:\/|$)|(?:^|\/)[^/]*\.(?:db|log|map|sqlite(?:-(?:shm|wal))?|tsbuildinfo)$/u;
const privateKeyMaterial = /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u;
const bearerCredential = /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/u;
const temporaryLocalPath = /\/(?:Users|private\/(?:tmp|var\/folders))\//u;
const versionPattern = /^\d+\.\d+\.\d+(?:\.\d+)?$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/u;
const licenseFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

class ReleaseBuildError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReleaseBuildError";
    this.code = code;
  }
}

async function runCommand(command, args, workingDirectory) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: workingDirectory,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let standardOutput = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (standardOutput.length <= 1_048_576) {
        standardOutput += chunk;
      }
    });
    child.stderr.on("data", () => {
      // Drain subprocess diagnostics without copying free-form output into logs.
    });
    child.once("error", () => {
      if (!settled) {
        settled = true;
        rejectPromise(new ReleaseBuildError("RELEASE_COMMAND_FAILED"));
      }
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolvePromise(standardOutput.trim());
      } else {
        rejectPromise(new ReleaseBuildError("RELEASE_COMMAND_FAILED"));
      }
    });
  });
}

function assertPathWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  if (
    pathFromParent.length === 0
    || pathFromParent === ".."
    || pathFromParent.startsWith(`..${sep}`)
  ) {
    throw new ReleaseBuildError("RELEASE_PATH_UNSAFE");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new ReleaseBuildError("RELEASE_METADATA_INVALID");
  }
}

async function collectFiles(directory) {
  const collected = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collected.push(...await collectFiles(entryPath));
      continue;
    }
    if (!entry.isFile()) {
      throw new ReleaseBuildError("RELEASE_NON_FILE_ENTRY");
    }
    collected.push(entryPath);
  }
  return collected;
}

async function copyExtension(releaseRoot) {
  const actualFiles = (await readdir(extensionDistDirectory)).sort();
  if (
    actualFiles.length !== extensionFiles.length
    || !actualFiles.every((entry, index) => entry === extensionFiles[index])
  ) {
    throw new ReleaseBuildError("RELEASE_EXTENSION_FILES_INVALID");
  }

  const destination = join(releaseRoot, "browser-extension");
  await mkdir(destination, { recursive: true, mode: 0o755 });
  for (const fileName of extensionFiles) {
    await copyFile(
      join(extensionDistDirectory, fileName),
      join(destination, fileName),
    );
  }
}

async function bundleCollector(releaseRoot) {
  const collectorRoot = join(releaseRoot, "collector");
  const collectorDist = join(collectorRoot, "dist");
  const migrationDestination = join(collectorRoot, "migrations");
  await mkdir(collectorDist, { recursive: true, mode: 0o755 });
  await mkdir(migrationDestination, { recursive: true, mode: 0o755 });

  await build({
    bundle: true,
    entryPoints: [collectorDistEntry],
    format: "esm",
    legalComments: "external",
    logLevel: "silent",
    minify: false,
    outfile: join(collectorDist, "collector.mjs"),
    platform: "node",
    sourcemap: false,
    target: "node24",
  });

  const migrationFiles = (await readdir(migrationSourceDirectory)).sort();
  if (
    migrationFiles.length === 0
    || !migrationFiles.every((fileName) => migrationPattern.test(fileName))
  ) {
    throw new ReleaseBuildError("RELEASE_MIGRATIONS_INVALID");
  }
  for (const fileName of migrationFiles) {
    await copyFile(
      join(migrationSourceDirectory, fileName),
      join(migrationDestination, fileName),
    );
  }
}

async function copyRuntimeLicenses(releaseRoot) {
  const ajvDirectory = await realpath(join(contractsNodeModules, "ajv"));
  const ajvNodeModules = dirname(ajvDirectory);
  const packages = [
    { directory: ajvDirectory, licenseFile: "LICENSE" },
    {
      directory: await realpath(join(contractsNodeModules, "@sinclair/typebox")),
      licenseFile: "license",
    },
    {
      directory: await realpath(join(ajvNodeModules, "fast-deep-equal")),
      licenseFile: "LICENSE",
    },
    {
      directory: await realpath(join(ajvNodeModules, "fast-uri")),
      licenseFile: "LICENSE",
    },
    {
      directory: await realpath(join(ajvNodeModules, "json-schema-traverse")),
      licenseFile: "LICENSE",
    },
    {
      directory: await realpath(join(ajvNodeModules, "require-from-string")),
      licenseFile: "license",
    },
  ];
  const licenseDirectory = join(releaseRoot, "collector/licenses");
  await mkdir(licenseDirectory, { recursive: true, mode: 0o755 });
  const noticeLines = [
    "Third-party software bundled in collector/dist/collector.mjs",
    "",
  ];

  for (const packageEntry of packages) {
    const metadata = await readJson(join(packageEntry.directory, "package.json"));
    if (
      typeof metadata.name !== "string"
      || typeof metadata.version !== "string"
    ) {
      throw new ReleaseBuildError("RELEASE_LICENSE_METADATA_INVALID");
    }
    const licenseName = `${metadata.name.replaceAll("@", "").replaceAll("/", "-")}-${metadata.version}-LICENSE.txt`;
    if (!licenseFileNamePattern.test(licenseName)) {
      throw new ReleaseBuildError("RELEASE_LICENSE_METADATA_INVALID");
    }
    await copyFile(
      join(packageEntry.directory, packageEntry.licenseFile),
      join(licenseDirectory, licenseName),
    );
    noticeLines.push(
      `${metadata.name} ${metadata.version}`,
      `License text: collector/licenses/${licenseName}`,
      "",
    );
  }

  await writeFile(
    join(releaseRoot, "THIRD_PARTY_NOTICES.txt"),
    `${noticeLines.join("\n")}\n`,
    "utf8",
  );
}

async function renderReleaseDocuments(releaseRoot, version, commit) {
  const replacements = new Map([
    ["__VERSION__", version],
    ["__GIT_COMMIT__", commit],
  ]);
  for (const fileName of ["README.ja.md", "SECURITY_AND_PRIVACY.ja.md"]) {
    let document = await readFile(join(releaseSourceDirectory, fileName), "utf8");
    for (const [token, value] of replacements) {
      document = document.replaceAll(token, value);
    }
    if (document.includes("__VERSION__") || document.includes("__GIT_COMMIT__")) {
      throw new ReleaseBuildError("RELEASE_TEMPLATE_INVALID");
    }
    await writeFile(join(releaseRoot, fileName), document, "utf8");
  }
  await copyFile(
    join(releaseSourceDirectory, "start-collector.command"),
    join(releaseRoot, "start-collector.command"),
  );
  await chmod(join(releaseRoot, "start-collector.command"), 0o755);
}

async function assertReleaseContentsSafe(releaseRoot) {
  const files = await collectFiles(releaseRoot);
  const localHome = homedir();
  for (const filePath of files) {
    const relativePath = relative(releaseRoot, filePath).split(sep).join("/");
    if (forbiddenReleasePath.test(relativePath)) {
      throw new ReleaseBuildError("RELEASE_FORBIDDEN_FILE");
    }
    const contents = await readFile(filePath, "utf8");
    if (
      contents.includes(localHome)
      || temporaryLocalPath.test(contents)
      || privateKeyMaterial.test(contents)
      || bearerCredential.test(contents)
    ) {
      throw new ReleaseBuildError("RELEASE_FORBIDDEN_CONTENT");
    }
  }
  return files;
}

async function writeChecksums(releaseRoot) {
  const files = await assertReleaseContentsSafe(releaseRoot);
  const lines = [];
  for (const filePath of files) {
    const relativePath = relative(releaseRoot, filePath).split(sep).join("/");
    lines.push(`${sha256(await readFile(filePath))}  ${relativePath}`);
  }
  await writeFile(
    join(releaseRoot, "CHECKSUMS.sha256"),
    `${lines.sort().join("\n")}\n`,
    "utf8",
  );
}

async function normalizeTimestamps(releaseRoot, epochSeconds) {
  const timestamp = new Date(epochSeconds * 1_000);
  const files = await collectFiles(releaseRoot);
  for (const filePath of files) {
    await utimes(filePath, timestamp, timestamp);
  }
}

async function main() {
  if (platform() !== "darwin") {
    throw new ReleaseBuildError("RELEASE_PLATFORM_UNSUPPORTED");
  }
  const argumentsList = process.argv.slice(2);
  const allowDirty = argumentsList.length === 1 && argumentsList[0] === "--allow-dirty";
  if (argumentsList.length !== 0 && !allowDirty) {
    throw new ReleaseBuildError("RELEASE_ARGUMENT_INVALID");
  }

  const rootMetadata = await readJson(join(repositoryRoot, "package.json"));
  const extensionManifest = await readJson(join(packageRoot, "manifest.json"));
  if (
    typeof rootMetadata.version !== "string"
    || !versionPattern.test(rootMetadata.version)
    || extensionManifest.version !== rootMetadata.version
  ) {
    throw new ReleaseBuildError("RELEASE_VERSION_INVALID");
  }
  const version = rootMetadata.version;

  const gitStatus = await runCommand(
    "/usr/bin/git",
    ["status", "--porcelain", "--untracked-files=normal"],
    repositoryRoot,
  );
  if (gitStatus.length !== 0 && !allowDirty) {
    throw new ReleaseBuildError("RELEASE_WORKTREE_NOT_CLEAN");
  }
  const commit = await runCommand(
    "/usr/bin/git",
    ["rev-parse", "HEAD"],
    repositoryRoot,
  );
  if (!commitPattern.test(commit)) {
    throw new ReleaseBuildError("RELEASE_COMMIT_INVALID");
  }
  const commitEpochText = await runCommand(
    "/usr/bin/git",
    ["show", "-s", "--format=%ct", "HEAD"],
    repositoryRoot,
  );
  const commitEpoch = Number(commitEpochText);
  if (!Number.isSafeInteger(commitEpoch) || commitEpoch < 1) {
    throw new ReleaseBuildError("RELEASE_COMMIT_TIME_INVALID");
  }

  const releaseName = `qb-study-system-trusted-macos-v${version}`;
  const releaseRoot = join(artifactDirectory, releaseName);
  const zipPath = join(artifactDirectory, `${releaseName}.zip`);
  const zipChecksumPath = `${zipPath}.sha256`;
  for (const candidate of [releaseRoot, zipPath, zipChecksumPath]) {
    assertPathWithin(artifactDirectory, candidate);
  }

  await mkdir(artifactDirectory, { recursive: true, mode: 0o755 });
  await rm(releaseRoot, { force: true, recursive: true });
  await rm(zipPath, { force: true });
  await rm(zipChecksumPath, { force: true });
  await mkdir(releaseRoot, { recursive: true, mode: 0o755 });

  await copyExtension(releaseRoot);
  await bundleCollector(releaseRoot);
  await copyRuntimeLicenses(releaseRoot);
  await renderReleaseDocuments(releaseRoot, version, commit);

  const releaseMetadata = Object.freeze({
    format_version: 1,
    name: "qb-study-system trusted macOS beta",
    version,
    git_commit: commit,
    source_worktree_clean: gitStatus.length === 0,
    platform: "macOS",
    minimum_chrome_version: "127",
    node_version: ">=24.19.0 <25",
    collector: {
      host: "127.0.0.1",
      port: 8_765,
      path: "/v1/attempt-events",
    },
    database_path: "~/Library/Application Support/qb-study-system/qb-study.sqlite",
  });
  await writeFile(
    join(releaseRoot, "RELEASE.json"),
    `${JSON.stringify(releaseMetadata, null, 2)}\n`,
    "utf8",
  );

  await writeChecksums(releaseRoot);
  await normalizeTimestamps(releaseRoot, commitEpoch);

  const zipEntries = (await collectFiles(releaseRoot))
    .map((filePath) => relative(artifactDirectory, filePath))
    .sort();
  await runCommand(
    "/usr/bin/zip",
    ["-X", "-q", zipPath, ...zipEntries],
    artifactDirectory,
  );
  await runCommand("/usr/bin/unzip", ["-tq", zipPath], artifactDirectory);

  const zipChecksum = sha256(await readFile(zipPath));
  await writeFile(
    zipChecksumPath,
    `${zipChecksum}  ${basename(zipPath)}\n`,
    "utf8",
  );
  await rm(releaseRoot, { force: true, recursive: true });

  process.stdout.write(`${JSON.stringify({
    event_code: "TRUSTED_RELEASE_CREATED",
    artifact: relative(repositoryRoot, zipPath),
    checksum_file: relative(repositoryRoot, zipChecksumPath),
    git_commit: commit,
    sha256: zipChecksum,
    source_worktree_clean: gitStatus.length === 0,
    version,
  })}\n`);
}

void main().catch((error) => {
  const eventCode = error instanceof ReleaseBuildError
    ? error.code
    : "RELEASE_BUILD_FAILED";
  process.stderr.write(`${JSON.stringify({ event_code: eventCode })}\n`);
  process.exitCode = 1;
});
