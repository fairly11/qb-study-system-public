/** Exact, guarded platform adaptations; shared Mac sources are never edited. */
export function portableSource(path, original) {
  let text = original;
  const replace = (before, after) => {
    if (text.split(before).length !== 2) throw new Error('WINDOWS_ADAPTER_SOURCE_CHANGED: ' + path);
    text = text.replace(before, after);
  };
  if (path === 'services/history-collector/src/notion-config.ts') {
    replace('join(homedir(), "Library", "Application Support", "qb-study-system", "notion-sync.json")',
      'join(recorderDataDirectory(), "notion-sync.json")');
    replace('(stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())', '!hasPrivateMode(stat)');
    text = 'import { recorderDataDirectory, hasPrivateMode } from "qb-recorder-platform";\n' + text;
  } else if (path === 'services/history-collector/src/review-set-resolver.ts') {
    replace('join(homedir(), "Library", "Application Support", "qb-study-system")', 'recorderDataDirectory()');
    text = 'import { recorderDataDirectory } from "qb-recorder-platform";\n' + text;
  } else if (path === 'services/history-collector/src/cli.ts') {
    // Initial sync-target activation must succeed before this Windows recorder accepts answers.
    // Remote outages are handled later by the async worker and do not stop local capture.
    replace('    // Configuration/API problems must not interrupt durable local capture.',
      '    // Windows startup requires a valid and activated sync target before accepting answers.');
    replace('  }\n  let running;', '    process.exitCode = 1;\n    return;\n  }\n  let running;');
    replace('writeCliEvent(process.stdout, "COLLECTOR_STOPPED", running.port);',
      'writeCliEvent(process.stdout, "COLLECTOR_STOPPED", running.port);\n      if (process.connected) process.disconnect();');
    replace('  process.once("SIGINT", () => {',
      '  process.on("message", (message: unknown) => {\n    if (typeof message === "object" && message !== null && !Array.isArray(message)\n      && Object.keys(message).length === 1\n      && (message as { type?: unknown }).type === "qb-study-shutdown") void stop();\n  });\n  process.once("SIGINT", () => {');
  }
  return text;
}
