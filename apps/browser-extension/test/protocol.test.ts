import { describe, expect, it } from "vitest";

import {
  CAPTURE_STATUS_MESSAGE_KIND,
  CAPTURE_UNSUPPORTED_DOM_REASONS,
  MAX_RECENT_ATTEMPT_SUMMARIES,
  captureUnsupportedDomDiagnosticCode,
  isCaptureStatusMessageV1,
  isPopupStatusV1,
  type PopupStatusV1,
} from "../src/shared/protocol.js";

const POPUP_STATUS = {
  capture_state: "observing",
  outbox_count: 1,
  collector_endpoint: "http://127.0.0.1:8765/v1/attempt-events",
  delivery_state: "retry_scheduled",
  last_diagnostic_code: "delivery_network_retry",
  last_capture_issue_code: "capture_unsupported_dom:option_count_invalid",
  recent_attempts: [{
    question_key: "119A12",
    answered_at: "2026-08-26T03:04:05.006Z",
    result: "incorrect",
    selected_option_indices: [1],
    delivery_state: "retry_scheduled",
  }],
} as const satisfies PopupStatusV1;

describe("extension internal protocol", () => {
  it("accepts every allowlisted DOM failure code and rejects free-form details", () => {
    for (const reason of CAPTURE_UNSUPPORTED_DOM_REASONS) {
      expect(isCaptureStatusMessageV1({
        kind: CAPTURE_STATUS_MESSAGE_KIND,
        state: "unsupported",
        code: captureUnsupportedDomDiagnosticCode(reason),
      }), reason).toBe(true);
    }

    expect(isCaptureStatusMessageV1({
      kind: CAPTURE_STATUS_MESSAGE_KIND,
      state: "unsupported",
      code: "capture_unsupported_dom:free-form-page-content",
    })).toBe(false);
    expect(isCaptureStatusMessageV1({
      kind: CAPTURE_STATUS_MESSAGE_KIND,
      state: "unsupported",
      code: "capture_unsupported_dom:main_missing",
      detail: "unexpected",
    })).toBe(false);
    expect(isCaptureStatusMessageV1({
      kind: CAPTURE_STATUS_MESSAGE_KIND,
      state: "observing",
      code: "capture_unsupported_dom:main_missing",
    })).toBe(false);

    expect(isCaptureStatusMessageV1({
      kind: CAPTURE_STATUS_MESSAGE_KIND,
      state: "unsupported",
      code: "capture_unsupported_dom:correct_markers_deduplicated_mapping_differs_from_selection",
    })).toBe(true);
  });

  it("strictly validates bounded, allowlisted recent attempt summaries", () => {
    expect(isPopupStatusV1(POPUP_STATUS)).toBe(true);
    expect(isPopupStatusV1({
      ...POPUP_STATUS,
      recent_attempts: [{
        ...POPUP_STATUS.recent_attempts[0],
        event_id: "10000000-0000-4000-8000-000000000001",
      }],
    })).toBe(false);
    expect(isPopupStatusV1({
      ...POPUP_STATUS,
      recent_attempts: [{
        ...POPUP_STATUS.recent_attempts[0],
        answered_at: "not-a-timestamp",
      }],
    })).toBe(false);
    expect(isPopupStatusV1({
      ...POPUP_STATUS,
      recent_attempts: [{
        ...POPUP_STATUS.recent_attempts[0],
        selected_option_indices: [1, 1],
      }],
    })).toBe(false);
    expect(isPopupStatusV1({
      ...POPUP_STATUS,
      recent_attempts: Array.from(
        { length: MAX_RECENT_ATTEMPT_SUMMARIES + 1 },
        () => POPUP_STATUS.recent_attempts[0],
      ),
    })).toBe(false);
    expect(isPopupStatusV1({
      ...POPUP_STATUS,
      last_diagnostic_code: "<unsafe free-form detail>",
    })).toBe(false);
  });
});
