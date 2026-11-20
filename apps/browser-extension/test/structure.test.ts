import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import { Window } from "happy-dom";
import { beforeAll, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const fixtureRoot = join(repoRoot, "tests/fixtures/browser-extension");
const distRoot = join(packageRoot, "dist");
const manifestPath = join(packageRoot, "manifest.json");
const distributedManifestPath = join(distRoot, "manifest.json");
const tsconfigPath = join(packageRoot, "tsconfig.json");
const bundleNames = ["content-script.js", "service-worker.js", "popup.js"] as const;
const distributedFileNames = [
  ...bundleNames,
  "manifest.json",
  "popup.css",
  "popup.html",
].sort();

const allowedQbFixtureQuestionKeys = new Set(["119A12", "119A13"]);
const allowedQbFixtureTags = new Set([
  "HTML",
  "HEAD",
  "BODY",
  "MAIN",
  "DIV",
  "SPAN",
  "BUTTON",
  "TABLE",
  "TBODY",
  "TR",
  "TD",
]);
const allowedQbFixtureClassNames = new Set([
  "flex",
  "flex-col",
  "gap-2",
  "max-w-2xl",
  "mx-auto",
  "rounded-lg",
  "bg-white",
  "p-3",
  "sm:p-4",
  "gap-3",
  "font-semibold",
  "text-qb-blue",
  "text-left",
  "border-qb-green",
  "text-qb-green",
  "bg-qb-sky",
  "h-6",
  "items-center",
  "justify-center",
  "rounded-full",
  "shrink-0",
  "text-white",
  "w-6",
  "flex-1",
  "gap-4",
  "min-w-0",
  "bg-slate-300",
  "ml-auto",
  "relative",
  "w-16",
  "absolute",
  "bottom-0",
  "left-0",
  "top-0",
  "bg-gray-100",
  "flex-wrap",
  "sm:flex-nowrap",
  "border",
  "grow",
  "border-collapse",
  "text-gray-600",
  "w-full",
  "border-y",
  "p-1",
  "text-center",
  "text-qb-pink",
]);

interface ManifestContentScript {
  readonly matches?: unknown;
  readonly js?: unknown;
  readonly run_at?: unknown;
  readonly all_frames?: unknown;
  readonly match_about_blank?: unknown;
  readonly match_origin_as_fallback?: unknown;
  readonly world?: unknown;
}

interface ExtensionManifest extends Record<string, unknown> {
  readonly manifest_version?: unknown;
  readonly minimum_chrome_version?: unknown;
  readonly permissions?: unknown;
  readonly host_permissions?: unknown;
  readonly background?: unknown;
  readonly content_scripts?: readonly ManifestContentScript[];
  readonly action?: unknown;
}

interface TextNodeLike {
  readonly nodeType: number;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<TextNodeLike>;
}

function readManifest(path = manifestPath): ExtensionManifest {
  return JSON.parse(readFileSync(path, "utf8")) as ExtensionManifest;
}

function fixturePaths(): readonly string[] {
  return readdirSync(fixtureRoot)
    .filter((name) => name.endsWith(".html"))
    .sort()
    .map((name) => join(fixtureRoot, name));
}

function collectVisibleText(node: TextNodeLike): readonly string[] {
  const text: string[] = [];
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes[index];
    if (child === undefined) {
      continue;
    }
    if (child.nodeType === 3) {
      const value = child.nodeValue?.trim();
      if (value !== undefined && value.length > 0) {
        text.push(value);
      }
    } else {
      text.push(...collectVisibleText(child));
    }
  }
  return text;
}

function manifestReferences(manifest: ExtensionManifest): readonly string[] {
  const references: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string") {
      references.push(value);
    }
  };

  if (manifest.background !== null && typeof manifest.background === "object") {
    add((manifest.background as Record<string, unknown>).service_worker);
  }
  if (manifest.action !== null && typeof manifest.action === "object") {
    add((manifest.action as Record<string, unknown>).default_popup);
  }
  for (const contentScript of manifest.content_scripts ?? []) {
    if (Array.isArray(contentScript.js)) {
      contentScript.js.forEach(add);
    }
  }
  return references;
}

beforeAll(() => {
  execFileSync(process.execPath, [join(packageRoot, "scripts/build.mjs")], {
    cwd: packageRoot,
    stdio: "pipe",
  });
}, 30_000);

describe("browser extension structure", () => {
  it("keeps TypeScript typecheck output outside the loadable extension", () => {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
      readonly compilerOptions?: {
        readonly outDir?: unknown;
        readonly tsBuildInfoFile?: unknown;
      };
    };
    const outDir = tsconfig.compilerOptions?.outDir;
    const tsBuildInfoFile = tsconfig.compilerOptions?.tsBuildInfoFile;

    expect(typeof outDir).toBe("string");
    expect(typeof tsBuildInfoFile).toBe("string");
    if (typeof outDir !== "string" || typeof tsBuildInfoFile !== "string") {
      return;
    }
    const resolvedOutDir = resolve(packageRoot, outDir);
    const resolvedBuildInfo = resolve(packageRoot, tsBuildInfoFile);
    expect(resolvedOutDir).not.toBe(distRoot);
    expect(resolvedOutDir.startsWith(`${distRoot}/`)).toBe(false);
    expect(resolvedBuildInfo.startsWith(`${distRoot}/`)).toBe(false);
  });

  it("uses the reviewed MV3 permission and static bootstrap allowlist", () => {
    const manifest = readManifest();

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("127");
    expect(manifest.permissions).toEqual(["alarms", "storage"]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(manifest).not.toHaveProperty("web_accessible_resources");
    expect(manifest.background).toEqual({ service_worker: "service-worker.js" });
    expect(manifest.action).toEqual({
      default_title: "QB capture status",
      default_popup: "popup.html",
    });
    expect(manifest.content_scripts).toEqual([{
      matches: [
        "https://qb.medilink-study.com:443/*",
      ],
      js: ["content-script.js"],
      run_at: "document_start",
      all_frames: false,
      match_about_blank: false,
      match_origin_as_fallback: false,
      world: "ISOLATED",
    }]);

    const declaredPermissions = [
      ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
      ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
    ];
    expect(declaredPermissions).not.toContain("tabs");
    expect(declaredPermissions).not.toContain("webNavigation");
    expect(declaredPermissions).not.toContain("activeTab");
    expect(declaredPermissions).not.toContain("scripting");
    expect(declaredPermissions).not.toContain("cookies");
    expect(declaredPermissions).not.toContain("webRequest");
    expect(declaredPermissions).not.toContain("https://qb.medilink-study.com/*");
    expect(declaredPermissions.join("\n")).not.toMatch(
      /google|gmail|sheets|<all_urls>|\*\.medilink-study\.com/iu,
    );
  });

  it("keeps every browser-extension fixture content-free", () => {
    const paths = fixturePaths();
    expect(paths.length).toBeGreaterThan(0);

    for (const path of paths) {
      const contents = readFileSync(path, "utf8");
      const sanitizedContents = contents.replaceAll(
        'data-testid="explanation-box-title"',
        "",
      );
      expect(contents, path).not.toMatch(
        /<(?:img|picture|svg|canvas|video|audio|iframe|object|embed|script|style|template|form|input|textarea)\b/iu,
      );
      expect(contents, path).not.toContain("<!--");
      expect(sanitizedContents, path).not.toMatch(
        /question[_ -]?(?:text|body)|choice[_ -]?text|explanation|cookie|password|credential|access[_ -]?token|refresh[_ -]?token/iu,
      );

      const window = new Window();
      window.document.write(contents);
      const visibleText = collectVisibleText(window.document);
      if (!basename(path).startsWith("qb-quiz-")) {
        expect(visibleText, path).toEqual([]);
        continue;
      }

      expect(visibleText.length, path).toBeGreaterThan(0);
      expect(
        visibleText.filter((value) => !allowedQbFixtureQuestionKeys.has(value)),
        path,
      ).toEqual([]);

      for (const element of window.document.querySelectorAll("*")) {
        expect(allowedQbFixtureTags.has(element.tagName), path).toBe(true);
        for (const attribute of element.attributes) {
          expect(["class", "data-testid"], path).toContain(attribute.name);
          if (attribute.name === "class") {
            expect(
              [...element.classList].filter(
                (className) => !allowedQbFixtureClassNames.has(className),
              ),
              path,
            ).toEqual([]);
          } else {
            expect(attribute.value, path).toBe("explanation-box-title");
          }
        }
      }
    }
  });

  it("builds self-contained MV3 bundles and all referenced files", () => {
    expect(readFileSync(distributedManifestPath, "utf8")).toBe(
      readFileSync(manifestPath, "utf8"),
    );
    const manifest = readManifest(distributedManifestPath);
    for (const reference of manifestReferences(manifest)) {
      expect(existsSync(join(distRoot, reference)), reference).toBe(true);
    }

    const popupHtml = readFileSync(join(distRoot, "popup.html"), "utf8");
    const popupReferences = [...popupHtml.matchAll(/(?:src|href)="([^"]+)"/gu)]
      .map((match) => match[1])
      .filter((reference): reference is string => reference !== undefined);
    expect(popupReferences).toEqual(["popup.css", "popup.js"]);
    for (const reference of popupReferences) {
      expect(existsSync(join(distRoot, reference)), reference).toBe(true);
    }

    expect(readdirSync(distRoot).sort()).toEqual(distributedFileNames);
    for (const bundleName of bundleNames) {
      const bundle = readFileSync(join(distRoot, bundleName), "utf8");
      expect(bundle, bundleName).not.toMatch(/sourceMappingURL\s*=/u);
      expect(bundle, bundleName).not.toMatch(
        /(?:^|\n)\s*(?:import(?:\s|["'{*])|export(?:\s|[{*])|import\s*\()/u,
      );
      expect(bundle, bundleName).not.toMatch(/["']node:[^"']+["']/u);
      expect(bundle, bundleName).not.toMatch(
        /data-qb-study-(?:synthetic-fixture|field|value)/u,
      );
      expect(bundle, bundleName).not.toMatch(/\beval\s*\(|\bnew\s+Function\s*\(/u);
    }
  });
});
