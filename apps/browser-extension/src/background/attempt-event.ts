import type { AttemptEventV1 } from "@qb-study/contracts";
import { normalizeQuestionKey } from "@qb-study/question-normalizer";

import type { AttemptCandidateMessageV1 } from "../shared/protocol.js";
import {
  isCanonicalAttemptEventV1,
  isCanonicalUtcTimestamp,
} from "./attempt-validator.js";
import type { DiagnosticCode } from "./types.js";

export const ATTEMPT_PROVENANCE = Object.freeze({
  producer: "browser-extension",
      producer_version: "0.1.2",
  source_system: "qb-web-dom",
} as const);

export type AttemptEventBuildResult =
  | { readonly ok: true; readonly event: AttemptEventV1 }
  | {
      readonly ok: false;
      readonly code:
        | "candidate_question_key_rejected"
        | "candidate_contract_rejected";
    };

function immutableEvent(event: AttemptEventV1): AttemptEventV1 {
  const selectedOptionIndices = [...event.selected_option_indices];
  Object.freeze(selectedOptionIndices);
  return Object.freeze({
    ...event,
    selected_option_indices: selectedOptionIndices,
    provenance: Object.freeze({ ...event.provenance }),
    quality: Object.freeze({ ...event.quality }),
  });
}

export function cloneAttemptEvent(event: AttemptEventV1): AttemptEventV1 {
  return immutableEvent(event);
}

export function buildAttemptEventV1(
  candidate: AttemptCandidateMessageV1,
  recordedAtEpochMilliseconds: number,
): AttemptEventBuildResult {
  const normalizedQuestion = normalizeQuestionKey(candidate.question_key);
  if (!normalizedQuestion.ok) {
    return { ok: false, code: "candidate_question_key_rejected" };
  }

  if (
    !isCanonicalUtcTimestamp(candidate.answered_at)
    || !Number.isFinite(recordedAtEpochMilliseconds)
  ) {
    return { ok: false, code: "candidate_contract_rejected" };
  }

  let recordedAt: string;
  try {
    recordedAt = new Date(recordedAtEpochMilliseconds).toISOString();
  } catch {
    return { ok: false, code: "candidate_contract_rejected" };
  }

  const event: unknown = {
    schema_version: "1",
    record_type: "attempt_event",
    event_id: candidate.event_id,
    question_key: normalizedQuestion.question_key,
    answered_at: candidate.answered_at,
    result: candidate.result,
    selected_option_indices: [...candidate.selected_option_indices].sort(
      (left, right) => left - right,
    ),
    provenance: {
      ...ATTEMPT_PROVENANCE,
      recorded_at: recordedAt,
    },
    quality: {
      acquisition_method: "direct_capture",
      temporal_precision: "exact",
      state_precision: "exact",
    },
  };

  if (!isCanonicalAttemptEventV1(event)) {
    return { ok: false, code: "candidate_contract_rejected" };
  }

  return { ok: true, event: immutableEvent(event) };
}

export function diagnosticForBuildFailure(
  result: Extract<AttemptEventBuildResult, { readonly ok: false }>,
): DiagnosticCode {
  return result.code;
}
