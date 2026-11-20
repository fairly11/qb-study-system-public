import { describe, expect, it } from "vitest";

import {
  ASIA_TOKYO_TIME_ZONE,
  toTokyoCalendarDate
} from "../src/index.js";

describe("Asia/Tokyo calendar boundaries", () => {
  it("uses the UTC 15:00 boundary for the next Tokyo date", () => {
    expect(toTokyoCalendarDate("2026-08-24T14:59:59.999Z")).toBe(
      "2026-08-24"
    );
    expect(toTokyoCalendarDate("2026-08-24T15:00:00.000Z")).toBe(
      "2026-08-25"
    );
  });

  it("accepts an equivalent explicit offset", () => {
    expect(toTokyoCalendarDate("2026-08-25T00:00:00+09:00")).toBe(
      "2026-08-25"
    );
  });

  it("rejects offset-free and date-only values rather than inventing an instant", () => {
    expect(() => toTokyoCalendarDate("2026-08-25T00:00:00")).toThrow(
      TypeError
    );
    expect(() => toTokyoCalendarDate("2026-08-25")).toThrow(TypeError);
  });

  it("exposes the fixed user time zone", () => {
    expect(ASIA_TOKYO_TIME_ZONE).toBe("Asia/Tokyo");
  });
});
