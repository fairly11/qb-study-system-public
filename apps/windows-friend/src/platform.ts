import { closeSync, fsyncSync, openSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";

/** The launcher or ACL-checked review entry point selects a private per-user directory. */
export function friendDataDirectory(): string {
  const value = process.env.QB_STUDY_HOME;
  if (value === undefined || value.length === 0 || value.length > 4096 || value.includes("\0") || !isAbsolute(value)) {
    throw new Error("QB_FRIEND_HOME_REQUIRED");
  }
  return value;
}

/** On Windows, access is checked with the native ACL before starting either executable. */
export function hasPrivateMode(stat: Stats): boolean {
  return process.platform === "win32" || ((stat.mode & 0o077) === 0
    && (process.getuid === undefined || stat.uid === process.getuid()));
}

export function syncJournalDirectory(path: string): void {
  // Windows does not support opening directories with the POSIX fsync contract.
  // The file is flushed before its atomic no-replace hard-link publication.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
