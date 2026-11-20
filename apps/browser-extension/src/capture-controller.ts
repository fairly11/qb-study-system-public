import type { AttemptDomAdapter, AttemptDomObservation } from "./adapters/index.js";
import {
  ATTEMPT_CANDIDATE_MESSAGE_KIND,
  CAPTURE_STATUS_MESSAGE_KIND,
  captureUnsupportedDomDiagnosticCode,
  isAttemptCandidateMessageV1,
  type AttemptCandidateMessageV1,
  type CaptureStatusMessageV1,
} from "./shared/protocol.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface CaptureControllerDependencies {
  readonly createEventId: () => string;
  readonly now: () => Date;
}

export interface CaptureControllerOutput {
  readonly candidate?: AttemptCandidateMessageV1;
  readonly status?: CaptureStatusMessageV1;
}

function defaultDependencies(): CaptureControllerDependencies {
  return {
    createEventId: () => globalThis.crypto.randomUUID(),
    now: () => new Date(),
  };
}

function statusMessage(
  state: CaptureStatusMessageV1["state"],
  code: CaptureStatusMessageV1["code"],
): CaptureStatusMessageV1 {
  return {
    kind: CAPTURE_STATUS_MESSAGE_KIND,
    state,
    code,
  };
}

export class CaptureController {
  readonly #adapter: AttemptDomAdapter;
  readonly #dependencies: CaptureControllerDependencies;
  #previousObservation: Exclude<AttemptDomObservation, { readonly kind: "unsupported" }> | undefined;
  #reportedState: CaptureStatusMessageV1["state"] | undefined;
  #reportedUnsupportedCode: CaptureStatusMessageV1["code"] | undefined;
  #terminalQuestionKey: string | undefined;
  readonly #ambiguousQuestionKeys = new Set<string>();
  #submittedQuestionKey: string | undefined;

  public constructor(
    adapter: AttemptDomAdapter,
    dependencies: CaptureControllerDependencies = defaultDependencies(),
  ) {
    this.#adapter = adapter;
    this.#dependencies = dependencies;
  }

  public get observedAttributeNames(): readonly string[] {
    return this.#adapter.observedAttributeNames;
  }

  public resetObservationBaseline(): void {
    this.#previousObservation = undefined;
    this.#reportedState = undefined;
    this.#reportedUnsupportedCode = undefined;
    this.#ambiguousQuestionKeys.clear();
    this.#submittedQuestionKey = undefined;
  }

  /** Called only after the content script verifies a trusted answer-button click. */
  public confirmSubmission(root: ParentNode): boolean {
    const current = this.#adapter.inspect(root);
    if (current.kind !== "pending" || !this.#ambiguousQuestionKeys.has(current.question_key)
      || current.question_key !== this.#previousObservation?.question_key
      || current.question_key === this.#terminalQuestionKey) return false;
    this.#previousObservation = current;
    this.#submittedQuestionKey = current.question_key;
    return true;
  }

  public observe(root: ParentNode): CaptureControllerOutput {
    const current = this.#adapter.inspect(root);
    const previous = this.#previousObservation;

    if (current.kind === "unsupported") {
      // Partial renders provide no new question/result evidence. Retain the last
      // valid observation, and require a matching valid result before capture.
      // An explicit departure from the quiz is not a partial render.
      if (current.reason === "qb_location_unsupported") {
        this.#previousObservation = undefined;
        this.#ambiguousQuestionKeys.clear();
        this.#submittedQuestionKey = undefined;
      }
      const code = captureUnsupportedDomDiagnosticCode(current.reason);
      if (
        this.#reportedState === "unsupported"
        && this.#reportedUnsupportedCode === code
      ) {
        return {};
      }
      this.#reportedState = "unsupported";
      this.#reportedUnsupportedCode = code;
      return {
        status: statusMessage("unsupported", code),
      };
    }
    this.#previousObservation = current;
    if (this.#submittedQuestionKey !== undefined && this.#submittedQuestionKey !== current.question_key) {
      this.#submittedQuestionKey = undefined;
    }

    const recoveredStatus = this.#reportedState === "observing"
      ? undefined
      : statusMessage("observing", "capture_observing");
    this.#reportedState = "observing";
    this.#reportedUnsupportedCode = undefined;

    if (this.#terminalQuestionKey !== undefined) {
      if (current.question_key === this.#terminalQuestionKey) {
        return recoveredStatus === undefined ? {} : { status: recoveredStatus };
      }
      // Returning to an already-seen result after another question also needs
      // a new submission, not merely the old result's pending redraw.
      this.#ambiguousQuestionKeys.add(this.#terminalQuestionKey);
      this.#terminalQuestionKey = undefined;
    }

    if (previous === undefined) {
      if (current.kind !== "pending") {
        this.#terminalQuestionKey = current.question_key;
      }
      return recoveredStatus === undefined ? {} : { status: recoveredStatus };
    }

    if (current.kind === "pending") {
      return recoveredStatus === undefined ? {} : { status: recoveredStatus };
    }

    if (previous.kind !== "pending") {
      // A new question can mount its identifier before the prior result is
      // removed. A later pending render alone cannot distinguish that case
      // from an old answer being redrawn, so require a verified submission.
      if (previous.question_key !== current.question_key) this.#ambiguousQuestionKeys.add(current.question_key);
      return recoveredStatus === undefined ? {} : { status: recoveredStatus };
    }

    if (previous.question_key !== current.question_key) {
      this.#ambiguousQuestionKeys.add(current.question_key);
      this.#reportedState = "unsupported";
      return {
        status: statusMessage("unsupported", "capture_candidate_rejected"),
      };
    }

    if (this.#ambiguousQuestionKeys.has(current.question_key) && this.#submittedQuestionKey !== current.question_key) {
      return recoveredStatus === undefined ? {} : { status: recoveredStatus };
    }

    this.#terminalQuestionKey = current.question_key;
    this.#ambiguousQuestionKeys.delete(current.question_key);
    this.#submittedQuestionKey = undefined;
    if (current.kind === "resolved_without_selection") {
      return recoveredStatus === undefined ? {} : { status: recoveredStatus };
    }

    const candidate = this.#createCandidate(current);
    if (candidate === undefined) {
      this.#reportedState = "unsupported";
      return {
        status: statusMessage("unsupported", "capture_candidate_rejected"),
      };
    }

    if (recoveredStatus === undefined) {
      return { candidate };
    }
    return { candidate, status: recoveredStatus };
  }

  #createCandidate(
    observation: Extract<AttemptDomObservation, { readonly kind: "resolved" }>,
  ): AttemptCandidateMessageV1 | undefined {
    const eventId = this.#dependencies.createEventId();
    if (!UUID_PATTERN.test(eventId)) {
      return undefined;
    }

    let answeredAt: string;
    try {
      answeredAt = this.#dependencies.now().toISOString();
    } catch {
      return undefined;
    }

    const selectedOptionIndices = [...observation.selected_option_indices];
    if (
      selectedOptionIndices.length === 0
      || selectedOptionIndices.some((index) => !Number.isSafeInteger(index) || index < 1)
      || new Set(selectedOptionIndices).size !== selectedOptionIndices.length
    ) {
      return undefined;
    }

    const candidate: AttemptCandidateMessageV1 = Object.freeze({
      kind: ATTEMPT_CANDIDATE_MESSAGE_KIND,
      event_id: eventId,
      question_key: observation.question_key,
      answered_at: answeredAt,
      result: observation.result,
      selected_option_indices: Object.freeze(selectedOptionIndices),
    });

    return isAttemptCandidateMessageV1(candidate) ? candidate : undefined;
  }
}
