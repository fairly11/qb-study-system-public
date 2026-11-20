import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { TSchema } from "@sinclair/typebox";

import {
  schemaRegistryV1,
  type AttemptEventV1,
  type ContractRecordV1,
  type HistorySnapshotV1,
} from "./schemas-v1.js";
import { isValidLocalDate, normalizeExactTimestamp } from "./time.js";

export interface ContractValidationIssue {
  readonly instance_path: string;
  readonly keyword: string;
  readonly schema_path: string;
}

export type ContractValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly ContractValidationIssue[] };

function createAjv(): Ajv2020 {
  const instance = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  instance.addFormat("date-time", (value: string) => normalizeExactTimestamp(value).ok);
  instance.addFormat("date", isValidLocalDate);
  instance.addFormat(
    "uuid",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  return instance;
}

const ajv = createAjv();

const validatorsByRecordType = new Map<
  ContractRecordV1["record_type"],
  ValidateFunction
>();

for (const entry of schemaRegistryV1) {
  validatorsByRecordType.set(entry.recordType, ajv.compile(entry.schema));
}

const attemptEventValidator = getValidator("attempt_event");
const historySnapshotValidator = getValidator("history_snapshot");

function getValidator(recordType: ContractRecordV1["record_type"]): ValidateFunction {
  const validator = validatorsByRecordType.get(recordType);
  if (validator === undefined) {
    throw new Error(`Missing validator for record type: ${recordType}`);
  }
  return validator;
}

function safeIssues(errors: ErrorObject[] | null | undefined): readonly ContractValidationIssue[] {
  return (errors ?? []).map(({ instancePath, keyword, schemaPath }) => ({
    instance_path: instancePath,
    keyword,
    schema_path: schemaPath,
  }));
}

export function compileContractSchema(schema: TSchema): ValidateFunction {
  return createAjv().compile(schema);
}

export function validateAttemptEventV1(value: unknown): value is AttemptEventV1 {
  return attemptEventValidator(value);
}

export function validateHistorySnapshotV1(value: unknown): value is HistorySnapshotV1 {
  return historySnapshotValidator(value);
}

export function validateContractV1(
  recordType: ContractRecordV1["record_type"],
  value: unknown,
): ContractValidationResult {
  const validator = getValidator(recordType);
  if (validator(value)) {
    return { valid: true };
  }
  return { valid: false, issues: safeIssues(validator.errors) };
}
