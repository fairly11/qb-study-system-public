import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CollectorConfigurationError,
  DEFAULT_HISTORY_COLLECTOR_PORT,
  HISTORY_COLLECTOR_HOST,
  readHistoryCollectorConfig,
} from "../src/index.js";

describe("history collector configuration", () => {
  it("uses the loopback defaults", () => {
    const config = readHistoryCollectorConfig({});
    expect(config.host).toBe(HISTORY_COLLECTOR_HOST);
    expect(config.port).toBe(DEFAULT_HISTORY_COLLECTOR_PORT);
    expect(isAbsolute(config.databasePath)).toBe(true);
    expect(config.databasePath).toMatch(/qb-study\.sqlite$/u);
  });

  it("accepts only a bounded explicit port and absolute database path", () => {
    expect(readHistoryCollectorConfig({
      QB_STUDY_COLLECTOR_PORT: "12345",
      QB_STUDY_DB_PATH: "/tmp/qb-study.sqlite",
    })).toEqual({
      host: HISTORY_COLLECTOR_HOST,
      port: 12_345,
      databasePath: "/tmp/qb-study.sqlite",
    });

    for (const value of ["", "0", "065", "65536", "8765 ", "localhost:8765"]) {
      expect(() => readHistoryCollectorConfig({
        QB_STUDY_COLLECTOR_PORT: value,
      })).toThrowError(expect.objectContaining({
        code: "COLLECTOR_PORT_INVALID",
      }));
    }
    for (const value of ["relative.sqlite", "\0blocked"]) {
      expect(() => readHistoryCollectorConfig({
        QB_STUDY_DB_PATH: value,
      })).toThrowError(expect.objectContaining({
        code: "COLLECTOR_DATABASE_PATH_INVALID",
      }));
    }
  });

  it("uses a stable configuration error type", () => {
    expect(() => readHistoryCollectorConfig({
      QB_STUDY_COLLECTOR_PORT: "invalid",
    })).toThrowError(CollectorConfigurationError);
  });
});
