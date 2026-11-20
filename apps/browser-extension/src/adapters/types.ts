import type {
  AttemptResultV1,
  CaptureUnsupportedDomReasonV1,
} from "../shared/protocol.js";

export type UnsupportedDomReason = CaptureUnsupportedDomReasonV1;

export type AttemptDomObservation =
  | {
      readonly kind: "pending";
      readonly question_key: string;
    }
  | {
      readonly kind: "resolved";
      readonly question_key: string;
      readonly result: AttemptResultV1;
      readonly selected_option_indices: readonly number[];
    }
  | {
      readonly kind: "resolved_without_selection";
      readonly question_key: string;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: UnsupportedDomReason;
    };

export interface AttemptDomAdapter {
  readonly observedAttributeNames: readonly string[];
  inspect(root: ParentNode): AttemptDomObservation;
}
