import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  compileContractSchema,
  normalizeExactTimestamp,
  schemaRegistryV1,
  toTokyoDate,
  validateAttemptEventV1,
  validateContractV1,
  validateHistorySnapshotV1,
} from "../src/index.js";

const fixturesDirectory = new URL("../../../tests/fixtures/contracts/", import.meta.url);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, fixturesDirectory), "utf8")) as unknown;
}

function integerSchemas(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(integerSchemas);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(record.type === "integer" ? [record] : []),
    ...Object.values(record).flatMap(integerSchemas),
  ];
}

describe("V1 JSON Schemas", () => {
  it("compile in Ajv strict mode and have unique identifiers", () => {
    const ids = schemaRegistryV1.map(({ schema }) => schema.$id as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { schema } of schemaRegistryV1) {
      expect(() => compileContractSchema(schema)).not.toThrow();
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });

  it("bounds every JSON integer at Number.MAX_SAFE_INTEGER", () => {
    const integers = schemaRegistryV1.flatMap(({ schema }) => integerSchemas(schema));
    expect(integers).toHaveLength(8);
    for (const schema of integers) {
      expect(schema.maximum).toBe(Number.MAX_SAFE_INTEGER);
    }
  });

  it("accepts the valid AttemptEvent fixture", async () => {
    expect(validateAttemptEventV1(await fixture("valid-attempt-event-v1.json"))).toBe(true);
  });

  it("rejects the invalid AttemptEvent fixture", async () => {
    expect(validateAttemptEventV1(await fixture("invalid-attempt-event-v1.json"))).toBe(false);
  });

  it("accepts a date-only HistorySnapshot without inventing a timestamp", async () => {
    const snapshot = await fixture("valid-history-snapshot-v1.json");
    expect(validateHistorySnapshotV1(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({ last_attempted_on: "2026-08-24" });
    expect(snapshot).not.toHaveProperty("last_attempted_at");
  });

  it("accepts matching exact and unavailable snapshot precision", async () => {
    const snapshot = await fixture("valid-history-snapshot-v1.json") as Record<string, unknown>;
    const quality = snapshot.quality as Record<string, unknown>;
    const exact: Record<string, unknown> = {
      ...snapshot,
      last_attempted_at: "2026-08-24T03:00:00Z",
      quality: { ...quality, temporal_precision: "exact" },
    };
    delete exact.last_attempted_on;
    expect(validateHistorySnapshotV1(exact)).toBe(true);

    const unavailable: Record<string, unknown> = {
      ...snapshot,
      final_state: "unattempted",
      attempt_count: 0,
      quality: { ...quality, temporal_precision: "not_applicable" },
    };
    delete unavailable.last_attempted_on;
    expect(validateHistorySnapshotV1(unavailable)).toBe(true);
  });

  it("rejects unknown fields", async () => {
    const attempt = await fixture("valid-attempt-event-v1.json");
    const result = validateContractV1("attempt_event", { ...attempt as object, question_text: "forbidden" });
    expect(result.valid).toBe(false);
  });

  it("rejects simultaneous exact and date-only history timestamps", async () => {
    expect(validateHistorySnapshotV1(
      await fixture("invalid-history-snapshot-v1.json"),
    )).toBe(false);
  });

  it.each([
    ["exact", undefined, undefined],
    ["date_only", undefined, "2026-08-24T03:00:00Z"],
    ["not_applicable", "2026-08-24", undefined],
  ] as const)("enforces the timestamp fields for %s temporal precision", async (
    temporalPrecision,
    lastAttemptedOn,
    lastAttemptedAt,
  ) => {
    const snapshot = await fixture("valid-history-snapshot-v1.json") as Record<string, unknown>;
    const quality = snapshot.quality as Record<string, unknown>;
    const candidate: Record<string, unknown> = {
      ...snapshot,
      quality: { ...quality, temporal_precision: temporalPrecision },
    };
    delete candidate.last_attempted_on;
    if (lastAttemptedOn !== undefined) candidate.last_attempted_on = lastAttemptedOn;
    if (lastAttemptedAt !== undefined) candidate.last_attempted_at = lastAttemptedAt;
    expect(validateHistorySnapshotV1(candidate)).toBe(false);
  });

  it("requires selected options and exact direct-capture quality for attempts", async () => {
    const attempt = await fixture("valid-attempt-event-v1.json") as Record<string, unknown>;
    expect(validateAttemptEventV1({ ...attempt, selected_option_indices: [] })).toBe(false);
    expect(validateAttemptEventV1({ ...attempt, selected_option_indices: [1, 1] })).toBe(false);
    expect(validateAttemptEventV1({
      ...attempt,
      selected_option_indices: [Number.MAX_SAFE_INTEGER + 1],
    })).toBe(false);
    expect(validateAttemptEventV1({
      ...attempt,
      quality: {
        acquisition_method: "imported_baseline",
        temporal_precision: "date_only",
        state_precision: "final_state_only",
      },
    })).toBe(false);
  });

  it("rejects an unsafe history attempt count", async () => {
    const snapshot = await fixture("valid-history-snapshot-v1.json") as Record<string, unknown>;
    expect(validateHistorySnapshotV1({
      ...snapshot,
      attempt_count: Number.MAX_SAFE_INTEGER + 1,
    })).toBe(false);
  });
});

describe("remaining V1 fixture coverage", () => {
  it.each([
    ["question_state", "question-state-v1"],
    ["review_plan", "review-plan-v1"],
    ["review_plan_item", "review-plan-item-v1"],
    ["set_build_request", "set-build-request-v1"],
    ["set_build_result", "set-build-result-v1"],
    ["sync_result", "sync-result-v1"],
    ["error_envelope", "error-envelope-v1"],
  ] as const)("validates valid and invalid %s fixtures", async (recordType, stem) => {
    const [valid, invalid] = await Promise.all([
      fixture(`valid-${stem}.json`),
      fixture(`invalid-${stem}.json`),
    ]);
    expect(validateContractV1(recordType, valid)).toEqual({ valid: true });
    expect(validateContractV1(recordType, invalid).valid).toBe(false);
  });
});

describe("AttemptEvent and HistorySnapshot separation", () => {
  it("does not validate either contract as the other", async () => {
    const [attempt, snapshot] = await Promise.all([
      fixture("valid-attempt-event-v1.json"),
      fixture("valid-history-snapshot-v1.json"),
    ]);
    expect(validateHistorySnapshotV1(attempt)).toBe(false);
    expect(validateAttemptEventV1(snapshot)).toBe(false);
  });
});

describe("persisted identifier hardening", () => {
  it("rejects prose in provenance and question group identifiers", async () => {
    const attempt = await fixture("valid-attempt-event-v1.json") as Record<string, unknown>;
    const provenance = attempt.provenance as Record<string, unknown>;
    expect(validateAttemptEventV1({
      ...attempt,
      provenance: { ...provenance, producer: "unsafe producer" },
    })).toBe(false);
    expect(validateAttemptEventV1({
      ...attempt,
      provenance: { ...provenance, source_record_id: "問題文の退避" },
    })).toBe(false);
    expect(validateAttemptEventV1({
      ...attempt,
      question_group_id: "group with prose",
    })).toBe(false);
  });

  it("rejects prose in algorithm identifiers", () => {
    const questionState = {
      schema_version: "1",
      record_type: "question_state",
      state_id: "00000000-0000-4000-8000-000000000010",
      question_key: "119A12",
      computed_at: "2026-08-24T15:00:00Z",
      algorithm_id: "review-engine",
      algorithm_version: "1.0.0",
      evidence_watermark: null,
      evidence_sufficiency: "insufficient",
      next_review_on: null,
      provenance: {
        producer: "review-engine",
        producer_version: "1.0.0",
        source_system: "local_review",
        recorded_at: "2026-08-24T15:00:00Z",
      },
      quality: {
        acquisition_method: "derived",
        temporal_precision: "not_applicable",
        state_precision: "not_applicable",
      },
    };
    expect(validateContractV1("question_state", questionState)).toEqual({ valid: true });
    expect(validateContractV1("question_state", {
      ...questionState,
      algorithm_id: "algorithm description",
    }).valid).toBe(false);
  });

  it("keeps set_name as intentional user text", () => {
    const request = {
      schema_version: "1",
      record_type: "set_build_request",
      request_id: "00000000-0000-4000-8000-000000000011",
      set_name: "8月 25日の復習",
      question_keys: ["119A12"],
      dry_run: true,
      provenance: {
        producer: "set-builder",
        producer_version: "1.0.0",
        source_system: "local_user",
        recorded_at: "2026-08-24T15:00:00Z",
      },
      quality: {
        acquisition_method: "manual",
        temporal_precision: "not_applicable",
        state_precision: "not_applicable",
      },
    };
    expect(validateContractV1("set_build_request", request)).toEqual({ valid: true });
  });
});

describe("ISO 8601 and Asia/Tokyo boundaries", () => {
  it("normalizes explicit offsets to UTC", () => {
    expect(normalizeExactTimestamp("2026-08-25T00:00:00+09:00")).toEqual({
      ok: true,
      value: "2026-08-24T15:00:00.000Z",
    });
  });

  it.each([
    ["2026-08-25T00:00:00.1+09:00", "2026-08-24T15:00:00.100Z"],
    ["2026-08-25T00:00:00.12+09:00", "2026-08-24T15:00:00.120Z"],
    ["2026-08-25T00:00:00.123+09:00", "2026-08-24T15:00:00.123Z"],
  ])("normalizes supported millisecond precision in %s", (input, expected) => {
    expect(normalizeExactTimestamp(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["0000-02-29T00:00:00Z", "0000-02-29T00:00:00.000Z"],
    ["0099-01-01T00:00:00Z", "0099-01-01T00:00:00.000Z"],
  ])("normalizes low four-digit years and remains round-trippable", (input, expected) => {
    const normalized = normalizeExactTimestamp(input);
    expect(normalized).toEqual({ ok: true, value: expected });
    expect(normalizeExactTimestamp(expected)).toEqual(normalized);
  });

  it("rejects offset-less and impossible timestamps", () => {
    expect(normalizeExactTimestamp("2026-08-24T15:00:00")).toEqual({
      ok: false,
      code: "invalid_timestamp",
    });
    expect(normalizeExactTimestamp("2026-02-30T15:00:00Z")).toEqual({
      ok: false,
      code: "invalid_timestamp",
    });
    expect(normalizeExactTimestamp("2026-08-24T15:00:00.1234Z")).toEqual({
      ok: false,
      code: "invalid_timestamp",
    });
    expect(normalizeExactTimestamp("0000-01-01T00:00:00+14:00")).toEqual({
      ok: false,
      code: "invalid_timestamp",
    });
    expect(normalizeExactTimestamp("9999-12-31T23:59:59-14:00")).toEqual({
      ok: false,
      code: "invalid_timestamp",
    });
  });

  it("validates low-year date-only evidence on the proleptic Gregorian calendar", async () => {
    const snapshot = await fixture("valid-history-snapshot-v1.json") as Record<
      string,
      unknown
    >;
    expect(
      validateHistorySnapshotV1({ ...snapshot, last_attempted_on: "0000-02-29" }),
    ).toBe(true);
    expect(
      validateHistorySnapshotV1({ ...snapshot, last_attempted_on: "0000-02-30" }),
    ).toBe(false);
  });

  it("keeps standalone schema and runtime aligned at the maximum offset", async () => {
    const attempt = await fixture("valid-attempt-event-v1.json") as Record<
      string,
      unknown
    >;
    const attemptSchema = schemaRegistryV1.find(
      ({ recordType }) => recordType === "attempt_event",
    )?.schema as
      | { properties?: { answered_at?: { pattern?: unknown } } }
      | undefined;
    const timestampPattern = attemptSchema?.properties?.answered_at?.pattern;
    if (typeof timestampPattern !== "string") {
      throw new TypeError("AttemptEventV1 answered_at pattern is missing");
    }
    const standalonePattern = new RegExp(timestampPattern, "u");
    const maximumOffset = "2026-08-24T15:00:00+14:00";
    const beyondMaximumOffset = "2026-08-24T15:00:00+14:01";

    expect(standalonePattern.test(maximumOffset)).toBe(true);
    expect(normalizeExactTimestamp(maximumOffset).ok).toBe(true);
    expect(validateAttemptEventV1({ ...attempt, answered_at: maximumOffset })).toBe(
      true,
    );

    expect(standalonePattern.test(beyondMaximumOffset)).toBe(false);
    expect(normalizeExactTimestamp(beyondMaximumOffset)).toEqual({
      ok: false,
      code: "invalid_timestamp",
    });
    expect(
      validateAttemptEventV1({ ...attempt, answered_at: beyondMaximumOffset }),
    ).toBe(false);
  });

  it("changes Tokyo's calendar date at 15:00 UTC", () => {
    expect(toTokyoDate("2026-08-24T14:59:59.999Z")).toBe("2026-08-24");
    expect(toTokyoDate("2026-08-24T15:00:00.000Z")).toBe("2026-08-25");
  });
});
