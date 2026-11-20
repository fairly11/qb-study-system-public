import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ["src/content.ts", "src/background.ts", "src/popup.ts"], outdir: dist,
  bundle: true, format: "iife", platform: "browser", target: "safari16.4", charset: "utf8", sourcemap: false, legalComments: "none" });
for (const asset of ["manifest.json", "popup.html", "popup.css"]) await copyFile(`${root}${asset}`, `${dist}${asset}`);
for (const name of await readdir(dist)) {
  if (!name.endsWith(".js")) continue;
  const content = await readFile(`${dist}${name}`, "utf8");
  for (const forbidden of [/\beval\s*\(/u, /\bnew\s+Function\s*\(/u, /["']node:/u, /127\.0\.0\.1/u, /localhost/u, /api\.notion\.com/u, /sourceMappingURL/u, /data-qb-study-synthetic/u]) {
    if (forbidden.test(content)) throw new Error(`UNSAFE_WEB_BUNDLE:${name}`);
  }
}
