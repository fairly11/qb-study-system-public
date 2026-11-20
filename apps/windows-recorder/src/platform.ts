import type { Stats } from "node:fs";
import { isAbsolute } from "node:path";

/** The ACL-checked recorder launcher selects a private per-user directory. */
export function recorderDataDirectory(): string {
  const value = process.env.QB_STUDY_HOME;
  if (value === undefined || value.length === 0 || value.length > 4096 || value.includes("\0") || !isAbsolute(value)) {
    throw new Error("QB_RECORDER_HOME_REQUIRED");
  }
  return value;
}

/** On Windows, access is checked with the native ACL before starting either executable. */
export function hasPrivateMode(stat: Stats): boolean {
  return process.platform === "win32" || ((stat.mode & 0o077) === 0
    && (process.getuid === undefined || stat.uid === process.getuid()));
}
