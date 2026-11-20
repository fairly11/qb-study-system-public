import type { AttemptDomAdapter, AttemptDomObservation } from "./types.js";

/**
 * Distribution-safe default until a reviewed production QB DOM contract exists.
 */
export class UnsupportedAttemptAdapter implements AttemptDomAdapter {
  public readonly observedAttributeNames = Object.freeze([]);

  public inspect(): AttemptDomObservation {
    return {
      kind: "unsupported",
      reason: "production_adapter_unavailable",
    };
  }
}
