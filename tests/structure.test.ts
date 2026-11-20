import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const requiredComponents = [
  "apps/browser-extension",
  "apps/set-builder",
  "services/history-collector",
  "packages/contracts",
  "packages/storage",
  "packages/question-normalizer",
  "packages/review-engine"
] as const;

function collectJsonFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectJsonFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  });
}

function collectFilesWithExtension(directory: string, extension: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectFilesWithExtension(path, extension);
    }
    return entry.isFile() && entry.name.endsWith(extension) ? [path] : [];
  });
}

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectObjectKeys);
  }
  if (value === null || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => [
    key.toLowerCase(),
    ...collectObjectKeys(child)
  ]);
}

describe("repository safety boundaries", () => {
  it("contains every independently addressable component", () => {
    for (const component of requiredComponents) {
      expect(existsSync(join(repoRoot, component, "package.json"))).toBe(true);
    }
  });

  it("keeps the browser extension permissions on the reviewed minimum allowlist", () => {
    const manifestPath = join(repoRoot, "apps/browser-extension/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("127");
    expect(manifest.permissions).toEqual([
      "alarms",
      "storage"
    ]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(manifest.content_scripts).toEqual([{
      matches: [
        "https://qb.medilink-study.com:443/*"
      ],
      js: ["content-script.js"],
      run_at: "document_start",
      all_frames: false,
      match_about_blank: false,
      match_origin_as_fallback: false,
      world: "ISOLATED"
    }]);
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(manifest.background).toEqual({
      service_worker: "service-worker.js"
    });
    expect(manifest.action).toEqual({
      default_title: "QB capture status",
      default_popup: "popup.html"
    });

    const declaredPermissions = JSON.stringify([
      manifest.permissions,
      manifest.host_permissions
    ]);
    expect(declaredPermissions).not.toMatch(
      /activeTab|scripting|tabs|webNavigation|cookies|webRequest|<all_urls>|google|gmail|sheets/iu
    );
  });

  it("keeps the pure review engine independent from storage", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "packages/review-engine/package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies).not.toHaveProperty("@qb-study/storage");
  });

  it("does not define prohibited content or credential fields in schemas or fixtures", () => {
    const jsonFiles = [
      ...collectJsonFiles(join(repoRoot, "packages/contracts/schemas")),
      ...collectJsonFiles(join(repoRoot, "tests/fixtures"))
    ];
    const prohibitedKeys = new Set([
      "question_text",
      "question_body",
      "choice_text",
      "choices",
      "options",
      "explanation",
      "image",
      "images",
      "password",
      "credential",
      "access_token",
      "refresh_token"
    ]);

    expect(jsonFiles.length).toBeGreaterThan(0);
    for (const path of jsonFiles) {
      const keys = collectObjectKeys(JSON.parse(readFileSync(path, "utf8")));
      expect(keys.filter((key) => prohibitedKeys.has(key)), path).toEqual([]);
    }
  });

  it("keeps browser-extension HTML fixtures content-free", () => {
    const fixturePaths = collectFilesWithExtension(
      join(repoRoot, "tests/fixtures/browser-extension"),
      ".html"
    );

    expect(fixturePaths.length).toBeGreaterThan(0);
    for (const path of fixturePaths) {
      const contents = readFileSync(path, "utf8");
      const sanitizedContents = contents
        .replace(/>\s*(?:119A12|119A13)\s*</gu, "><")
        .replaceAll('data-testid="explanation-box-title"', 'data-testid=""');
      expect(contents, path).not.toMatch(
        /<(?:img|picture|svg|canvas|video|audio|iframe|object|embed|script|style|template|form|input|textarea)\b/iu
      );
      expect(sanitizedContents, path).not.toMatch(/>\s*[^<\s][^<]*</u);
      expect(sanitizedContents, path).not.toMatch(
        /question[_ -]?(?:text|body)|choice[_ -]?text|explanation|access[_ -]?token|refresh[_ -]?token/iu
      );
    }
  });

  it("keeps the capture path read-only", () => {
    const capturePaths = [
      join(repoRoot, "apps/browser-extension/src/content-script.ts"),
      join(repoRoot, "apps/browser-extension/src/capture-controller.ts"),
      ...collectFilesWithExtension(
        join(repoRoot, "apps/browser-extension/src/adapters"),
        ".ts"
      )
    ];
    const forbiddenOperations = [
      /\.click\s*\(/u,
      /dispatchEvent\s*\(/u,
      /\.submit\s*\(/u,
      /\.(?:setAttribute|removeAttribute|append|appendChild|prepend|remove|replaceWith|replaceChildren)\s*\(/u,
      /\.(?:innerHTML|outerHTML|textContent|value)\s*=/u,
      /location\s*=/u,
      /history\.(?:pushState|replaceState)\s*\(/u,
      /chrome\.tabs\.(?:create|remove|update)\s*\(/u
    ];

    for (const path of capturePaths) {
      const contents = readFileSync(path, "utf8");
      for (const pattern of forbiddenOperations) {
        expect(contents, `${path}: ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });
});
