export type ExactTimestampNormalizationResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: "invalid_timestamp" };

const OFFSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const CANONICAL_UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function invalidTimestamp(): ExactTimestampNormalizationResult {
  return { ok: false, code: "invalid_timestamp" };
}

function dateWithUtcParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): Date {
  const candidate = new Date(0);
  candidate.setUTCFullYear(year, month - 1, day);
  candidate.setUTCHours(hour, minute, second, millisecond);
  return candidate;
}

export function isValidLocalDate(input: string): boolean {
  const match = LOCAL_DATE.exec(input);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const candidate = dateWithUtcParts(year, month, day, 0, 0, 0, 0);
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day;
}

export function normalizeExactTimestamp(input: string): ExactTimestampNormalizationResult {
  const match = OFFSET_TIMESTAMP.exec(input);
  if (match === null) {
    return invalidTimestamp();
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const zone = match[8];
  const sign = match[9];
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);

  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 14 || offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return invalidTimestamp();
  }

  const millisecond = Number((fraction + "000").slice(0, 3));
  const offsetSign = sign === "-" ? -1 : 1;
  const offsetMinutes = zone === "Z" ? 0 : offsetSign * (offsetHour * 60 + offsetMinute);
  const local = dateWithUtcParts(
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) {
    return invalidTimestamp();
  }

  const utcMillis = local.getTime() - offsetMinutes * 60_000;
  const normalized = new Date(utcMillis).toISOString();
  if (!CANONICAL_UTC_TIMESTAMP.test(normalized)) {
    return invalidTimestamp();
  }

  return { ok: true, value: normalized };
}

export function toTokyoDate(exactTimestamp: string): string {
  const normalized = normalizeExactTimestamp(exactTimestamp);
  if (!normalized.ok) {
    throw new TypeError("Expected an ISO 8601 timestamp with an explicit offset");
  }
  const instant = new Date(normalized.value);
  const tokyoTimestamp = new Date(
    instant.getTime() + 9 * 60 * 60 * 1_000,
  ).toISOString();
  if (!CANONICAL_UTC_TIMESTAMP.test(tokyoTimestamp)) {
    throw new RangeError("Asia/Tokyo date falls outside the four-digit year range");
  }
  return tokyoTimestamp.slice(0, 10);
}
