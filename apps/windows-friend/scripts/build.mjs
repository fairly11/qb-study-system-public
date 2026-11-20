import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableSource } from './portable-source.mjs';
import { packageFiles, writeChecksums } from './checksums.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '../..');
const require = createRequire(join(repo, 'apps/browser-extension/package.json'));
const { build } = require('esbuild');
export const version = '1.1.0-preview';
export const releaseName = 'QBStudyFriend-Windows11-' + version;
export const output = join(root, 'dist', releaseName);
const digest = value => createHash('sha256').update(value).digest('hex');
const aliases = {
  '@qb-study/contracts': 'packages/contracts/src/index.ts',
  '@qb-study/storage/history-collector': 'packages/storage/src/history-collector.ts',
  '@qb-study/storage/notion-sync': 'packages/storage/src/notion-sync.ts',
  '@qb-study/storage/migrations': 'packages/storage/src/migrations.ts',
  '@qb-study/storage': 'packages/storage/src/index.ts',
  '@qb-study/question-normalizer': 'packages/question-normalizer/src/index.ts',
  '@qb-study/review-engine': 'packages/review-engine/src/index.ts',
  '@qb-study/set-builder': 'apps/set-builder/src/index.ts',
  'qb-friend-platform': 'apps/windows-friend/src/platform.ts',
};
const alias = Object.fromEntries(Object.entries(aliases).map(([name, path]) => [name, join(repo, path)]));
const sourceFiles = new Map();
const adaptations = new Set();
const plugin = {
  name: 'windows-friend-platform',
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async args => {
      const path = relative(repo, args.path).replaceAll('\\', '/');
      const original = await readFile(args.path, 'utf8');
      const contents = portableSource(path, original);
      sourceFiles.set(path, digest(original));
      if (contents !== original) adaptations.add(path);
      return { contents, loader: 'ts', resolveDir: dirname(args.path) };
    });
  },
};
async function bundle(entry, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const result = await build({ absWorkingDir: repo, entryPoints: [join(repo, entry)],
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    sourcemap: false, legalComments: 'external', outfile: destination,
    alias, plugins: [plugin], metafile: true, logLevel: 'silent' });
  for (const file of Object.keys(result.metafile.inputs)) {
    const path = relative(repo, resolve(repo, file)).replaceAll('\\', '/');
    sourceFiles.set(path, digest(await readFile(resolve(repo, file))));
  }
}
async function copyDirectory(from, to) {
  await cp(from, to, { recursive: true, dereference: false, errorOnExist: true });
}
async function licenses() {
  const packages = [
    ['@sinclair/typebox', 'packages/contracts/package.json', 'sinclair-typebox'],
    ['ajv', 'packages/contracts/package.json', 'ajv'],
    ['fast-deep-equal', 'packages/contracts/node_modules/ajv/package.json', 'fast-deep-equal'],
    ['fast-uri', 'packages/contracts/node_modules/ajv/package.json', 'fast-uri'],
    ['json-schema-traverse', 'packages/contracts/node_modules/ajv/package.json', 'json-schema-traverse'],
    ['require-from-string', 'packages/contracts/node_modules/ajv/package.json', 'require-from-string'],
    ['ts-fsrs', 'packages/review-engine/package.json', 'ts-fsrs'],
  ];
  await rm(join(output, 'licenses'), { recursive: true, force: true });
  await mkdir(join(output, 'licenses'), { recursive: true });
  const notices = [];
  for (const [name, requester, safeName] of packages) {
    const resolver = createRequire(await realpath(join(repo, requester)));
    let packageFile;
    try { packageFile = resolver.resolve(name + '/package.json'); }
    catch {
      let directory = dirname(resolver.resolve(name));
      for (let i = 0; i < 6; i++, directory = dirname(directory)) {
        try {
          const candidate = join(directory, 'package.json');
          if (JSON.parse(await readFile(candidate, 'utf8')).name === name) { packageFile = candidate; break; }
        } catch { /* Search only the resolved installed dependency's ancestors. */ }
      }
    }
    if (!packageFile) throw new Error('LICENSE_PACKAGE_NOT_FOUND');
    const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
    const directory = dirname(packageFile);
    const names = await readdir(directory);
    const license = names.find(file => /^licen[sc]e(?:\.txt|\.md)?$/iu.test(file));
    if (!license) throw new Error('LICENSE_TEXT_NOT_FOUND: ' + name);
    const filename = safeName + '-' + metadata.version + '-LICENSE.txt';
    await cp(join(directory, license), join(output, 'licenses', filename));
    notices.push({ name, version: metadata.version, license: metadata.license, license_file: 'licenses/' + filename });
  }
  await writeFile(join(output, 'THIRD_PARTY_NOTICES.json'), JSON.stringify(notices, null, 2) + '\n');
}

await mkdir(dirname(output), { recursive: true });
// This exact directory contains only this builder's generated distribution, never installed user data.
await rm(output, { recursive: true, force: true });
await copyDirectory(join(root, 'template'), output);
await copyDirectory(join(root, 'docs'), join(output, 'docs'));
await bundle('services/history-collector/src/cli.ts', join(output, 'collector/dist/collector.mjs'));
await bundle('services/history-collector/src/review-cli.ts', join(output, 'collector/dist/review.mjs'));
await bundle('apps/windows-friend/src/core.ts', join(output, 'app/core.mjs'));
await copyDirectory(join(repo, 'packages/storage/migrations'), join(output, 'collector/migrations'));
await copyDirectory(join(repo, 'apps/browser-extension/dist'), join(output, 'browser-extension'));
await licenses();
const adapterFiles = ['scripts/build.mjs', 'scripts/portable-source.mjs', 'scripts/checksums.mjs', 'scripts/package.py', 'src/platform.ts', 'src/core.ts'];
for (const directory of ['template', 'docs']) {
  for (const file of await packageFiles(join(root, directory))) adapterFiles.push(directory + '/' + file);
}
for (const file of adapterFiles) sourceFiles.set('apps/windows-friend/' + file, digest(await readFile(join(root, file))));
await writeFile(join(output, 'SOURCE-MANIFEST.json'), JSON.stringify({
  source: 'current shared QB recording and daily-review implementation',
  baseline: JSON.parse(await readFile(join(root, 'BASELINE.json'), 'utf8')),
  platform_adaptations: [...adaptations].sort(),
  source_sha256: Object.fromEntries([...sourceFiles].sort(([a], [b]) => a.localeCompare(b))),
}, null, 2) + '\n');
await writeFile(join(output, 'RELEASE.json'), JSON.stringify({
  product: 'QB Study Friend', version, release_date: '2026-10-29', target: 'Windows 11 + Google Chrome',
  architectures: ['x64', 'ARM64'], runtime: 'Node.js v24.21.0',
  base_extension_version: JSON.parse(await readFile(join(output, 'browser-extension/manifest.json'), 'utf8')).version,
  codex_required: false, claude_optional: true,
  features: ['Chrome capture', 'Safari Notion record compatibility', 'personal Notion setup and sync',
    'FSRS-6 calculation', 'maximum 100 review questions through next 04:00 Asia/Tokyo',
    'immutable daily plan', 'QB set verification', 'Claude setup and operating guides'],
  not_included: ['iPhone application', 'preconfigured scheduled tasks', 'personal credentials', 'study history', 'QB text or images'],
  verification: { windows_device_tested: false, live_friend_notion_tested: false,
    live_friend_qb_tested: false, automated_checks: 'Run verification before packaging.' },
}, null, 2) + '\n');
await writeChecksums(output);
console.log(JSON.stringify({ event_code: 'WINDOWS_DISTRIBUTION_BUILT', directory: relative(repo, output), adaptations: adaptations.size }));
