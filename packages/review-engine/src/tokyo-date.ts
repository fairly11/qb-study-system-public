import { toTokyoDate } from "@qb-study/contracts";

export const ASIA_TOKYO_TIME_ZONE = "Asia/Tokyo" as const;

/**
 * Maps an exact, offset-bearing ISO 8601 instant to its Asia/Tokyo calendar date.
 * Date-only evidence must not be passed here because it is not an instant.
 */
export function toTokyoCalendarDate(exactInstant: string): string {
  return toTokyoDate(exactInstant);
}
