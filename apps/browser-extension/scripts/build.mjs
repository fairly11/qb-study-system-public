import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const bundleNames = ["content-script.js", "service-worker.js", "popup.js"];

const bundleRejections = [
  ["MV3_CSP_UNSAFE_CODE", /\beval\s*\(|\bnew\s+Function\s*\(/u],
  ["MV3_SOURCE_MAP_REFERENCE", /sourceMappingURL\s*=/u],
  [
    "MV3_ESM_SYNTAX",
    /(?:^|\n)\s*(?:import(?:\s|["'{*])|export(?:\s|[{*])|import\s*\()/u,
  ],
  ["MV3_NODE_BUILTIN", /["']node:[^"']+["']/u],
  [
    "MV3_SYNTHETIC_FIXTURE_SELECTOR",
    /data-qb-study-(?:synthetic-fixture|field|value)/u,
  ],
];

function manifestFileReferences(manifest) {
  const references = new Set();
  const add = (value) => {
    if (typeof value === "string") {
      references.add(value);
    }
  };
  const addMapValues = (value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const entry of Object.values(value)) {
        add(entry);
      }
    }
  };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  addMapValues(manifest.action?.default_icon);
  addMapValues(manifest.icons);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  add(manifest.devtools_page);
  add(manifest.side_panel?.default_path);
  addMapValues(manifest.chrome_url_overrides);

  if (Array.isArray(manifest.content_scripts)) {
    for (const contentScript of manifest.content_scripts) {
      if (Array.isArray(contentScript?.js)) {
        contentScript.js.forEach(add);
      }
      if (Array.isArray(contentScript?.css)) {
        contentScript.css.forEach(add);
      }
    }
  }

  return references;
}

function assertSafeRelativeReference(reference) {
  const segments = reference.split("/");
  if (
    reference.length === 0
    || reference.startsWith("/")
    || reference.includes("\\")
    || reference.includes(":")
    || reference.includes("?")
    || reference.includes("#")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`MV3_MANIFEST_REFERENCE_UNSAFE:${reference}`);
  }
}

await rm(distDirectory, { force: true, recursive: true });
await mkdir(distDirectory, { recursive: true });

await build({
  absWorkingDir: packageRoot,
  bundle: true,
  charset: "utf8",
  entryNames: "[name]",
  entryPoints: {
    "content-script": "src/content-script.ts",
    "service-worker": "src/background/service-worker.ts",
    popup: "src/popup/index.ts",
  },
  format: "iife",
  legalComments: "none",
  logLevel: "info",
  minify: false,
  outdir: distDirectory,
  platform: "browser",
  sourcemap: false,
  splitting: false,
  target: "es2022",
});

for (const bundleName of bundleNames) {
  const bundle = await readFile(
    fileURLToPath(new URL(`../dist/${bundleName}`, import.meta.url)),
    "utf8",
  );
  for (const [code, pattern] of bundleRejections) {
    if (pattern.test(bundle)) {
      throw new Error(`${code}:${bundleName}`);
    }
  }
}

await Promise.all([
  copyFile(
    fileURLToPath(new URL("../manifest.json", import.meta.url)),
    fileURLToPath(new URL("../dist/manifest.json", import.meta.url)),
  ),
  copyFile(
    fileURLToPath(new URL("../popup.html", import.meta.url)),
    fileURLToPath(new URL("../dist/popup.html", import.meta.url)),
  ),
  copyFile(
    fileURLToPath(new URL("../popup.css", import.meta.url)),
    fileURLToPath(new URL("../dist/popup.css", import.meta.url)),
  ),
]);

const sourceManifest = await readFile(
  fileURLToPath(new URL("../manifest.json", import.meta.url)),
  "utf8",
);
const distributedManifest = await readFile(
  fileURLToPath(new URL("../dist/manifest.json", import.meta.url)),
  "utf8",
);
if (distributedManifest !== sourceManifest) {
  throw new Error("MV3_MANIFEST_COPY_MISMATCH");
}

const manifest = JSON.parse(distributedManifest);
for (const reference of manifestFileReferences(manifest)) {
  assertSafeRelativeReference(reference);
  try {
    await access(fileURLToPath(new URL(`../dist/${reference}`, import.meta.url)));
  } catch {
    throw new Error(`MV3_MANIFEST_REFERENCE_MISSING:${reference}`);
  }
}

const distEntries = await readdir(distDirectory);
const sourceMap = distEntries.find((entry) => entry.endsWith(".map"));
if (sourceMap !== undefined) {
  throw new Error(`MV3_SOURCE_MAP_FILE:${sourceMap}`);
}
