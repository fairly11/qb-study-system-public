import { describe, expect, it, vi } from "vitest";
import { createChromeStudyRouteProbePort, createChromeConsentCaptureStartPort,
  createChromeConsentUiPort } from "../src/background/chrome-consent-ports.js";
import type { ConsentDocumentSessionV1, ConsentSenderContext } from "../src/background/consent-controller.js";

const sender: ConsentSenderContext = { tab_id: 7, window_id: 3, tab_active: true, frame_id: 0,
  origin: "https://qb.medilink-study.com", url: "https://qb.medilink-study.com/search?questionSetId=example-set",
  document_id: "document-7" };

describe("Chrome automatic study ports", () => {
  it("probes current bounded route in the exact document despite an old sender URL", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, code: "study_route_current" }));
    const route = { route_kind: "quiz", question_id: "next-question" } as const;
    const probe = createChromeStudyRouteProbePort({ sendMessage });
    expect(await probe(sender, route)).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(7, { kind: "qb_page_route_probe_v1", expected_route: route }, { documentId: "document-7" });
    const withoutDocument = { ...sender }; delete withoutDocument.document_id;
    expect(await probe(withoutDocument, route)).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("checks the exact content document without reading privileged tab URL fields", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, code: "study_route_current" }));
    const probe = createChromeStudyRouteProbePort({ sendMessage });
    expect(await probe(sender)).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(7, {
      kind: "qb_page_route_probe_v1", expected_url: sender.url,
    }, { documentId: "document-7" });
    expect(await probe({ ...sender, frame_id: 1 })).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects unavailable, malformed, or wrong route-probe responses", async () => {
    for (const result of [undefined, { ok: false, code: "study_route_unavailable" },
      { ok: true, code: "consent_document_present" }, { ok: true, code: "study_route_current", extra: true }]) {
      expect(await createChromeStudyRouteProbePort({ sendMessage: async () => result })(sender)).toBe(false);
    }
    expect(await createChromeStudyRouteProbePort({ sendMessage: async () => { throw new Error("missing"); } })(sender)).toBe(false);
  });

  it("sends STOP only to the exact page session and accepts an idempotent stop", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, code: "capture_already_stopped" }));
    const capture = createChromeConsentCaptureStartPort({ sendMessage });
    const session: ConsentDocumentSessionV1 = { tab_id: 7, window_id: 3,
      page_session_id: "10000000-0000-4000-8000-000000000001", document_id: "document-7",
      decision: "consented", capture_state: "paused", auto_popup_state: "suppressed", study_mode: "review" };
    expect(await capture.stop?.(session)).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(7, {
      kind: "stop_capture_v1", page_session_id: session.page_session_id,
    }, { documentId: "document-7" });
  });

  it("shows distinct ordinary, review, and uncertain status badges", async () => {
    const setBadgeText = vi.fn(async () => undefined);
    const ui = createChromeConsentUiPort({ setBadgeText,
      setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined },
    { query: async () => [] });
    await ui.showCapturing?.(7, "normal");
    await ui.showCapturing?.(8, "review");
    await ui.showCapturing?.(9, "unclassified");
    expect(setBadgeText.mock.calls).toEqual([
      [{ tabId: 7, text: "記録" }], [{ tabId: 8, text: "復習" }], [{ tabId: 9, text: "?" }],
    ]);
  });
});
