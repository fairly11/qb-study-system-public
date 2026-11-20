/** Exact, guarded platform adaptations; shared Mac sources are never edited. */
export function portableSource(path, original) {
  let text = original;
  const replace = (before, after) => {
    if (text.split(before).length !== 2) throw new Error('WINDOWS_ADAPTER_SOURCE_CHANGED: ' + path);
    text = text.replace(before, after);
  };
  if (path === 'services/history-collector/src/notion-config.ts') {
    replace('join(homedir(), "Library", "Application Support", "qb-study-system", "notion-sync.json")',
      'join(friendDataDirectory(), "notion-sync.json")');
    replace('(stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())', '!hasPrivateMode(stat)');
    text = 'import { friendDataDirectory, hasPrivateMode } from "qb-friend-platform";\n' + text;
  } else if (path === 'services/history-collector/src/review-cli.ts') {
    replace('join(homedir(), "Library", "Application Support", "qb-study-system")', 'friendDataDirectory()');
    replace('(stat.mode & 0o077) !== 0', '!hasPrivateMode(stat)');
    replace('if (command === "prepare") {', 'if (command === "prepare") {\n      if (dateArg !== undefined && day !== latestReviewDay(asOf)) throw new Error("REVIEW_DAY_CHANGED");');
    text = 'import { friendDataDirectory, hasPrivateMode } from "qb-friend-platform";\n' + text;
  } else if (path === 'services/history-collector/src/review-set-resolver.ts') {
    replace('join(homedir(), "Library", "Application Support", "qb-study-system")', 'friendDataDirectory()');
    text = 'import { friendDataDirectory } from "qb-friend-platform";\n' + text;
  } else if (path === 'services/history-collector/src/review-service.ts') {
    replace('const directoryFd = openSync(join(this.directory, day), "r");\n      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }',
      'syncJournalDirectory(join(this.directory, day));');
    text = 'import { syncJournalDirectory } from "qb-friend-platform";\n' + text;
  } else if (path === 'services/history-collector/src/cli.ts') {
    replace('writeCliEvent(process.stdout, "COLLECTOR_STOPPED", running.port);',
      'writeCliEvent(process.stdout, "COLLECTOR_STOPPED", running.port);\n      if (process.connected) process.disconnect();');
    replace('  process.once("SIGINT", () => {',
      '  process.on("message", (message: unknown) => {\n    if (typeof message === "object" && message !== null && !Array.isArray(message)\n      && Object.keys(message).length === 1\n      && (message as { type?: unknown }).type === "qb-study-shutdown") void stop();\n  });\n  process.once("SIGINT", () => {');
  }
  return text;
}
