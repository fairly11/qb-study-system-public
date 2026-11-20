import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONSENT_ATTENTION_BADGE_TEXT,
  CONSENT_ATTENTION_TITLE,
  CONSENT_PROBE_MESSAGE_KIND,
  CONSENT_SESSION_STORAGE_KEY,
  CONSENT_START_CAPTURE_MESSAGE_KIND,
  createChromeConsentCaptureStartPort,
  createChromeConsentSessionStorePort,
  createChromeConsentUiPort,
  consentSenderContextFromChrome,
  restrictChromeConsentStorageToTrustedContexts,
} from "../src/background/chrome-consent-ports.js";
import {
  ConsentController,
  isConsentDocumentLifecycleStatus,
  type ConsentCaptureStartPort,
  type ConsentDocumentSessionV1,
  type ConsentReadyInput,
  type ConsentSenderContext,
  type ConsentSessionStateV1,
  type ConsentSessionStorePort,
  type ConsentUiPort,
} from "../src/background/consent-controller.js";

const PAGE_A = "10000000-0000-4000-8000-000000000001";
const PAGE_B = "10000000-0000-4000-8000-000000000002";
const PAGE_C = "10000000-0000-4000-8000-000000000003";

class MemoryConsentStore implements ConsentSessionStorePort {
  public value: unknown;

  public async read(): Promise<unknown> {
    return structuredClone(this.value);
  }

  public async write(state: ConsentSessionStateV1): Promise<void> {
    this.value = structuredClone(state);
  }
}

class RecordingConsentUi implements ConsentUiPort {
  public readonly activeTabs = new Set<string>();
  public readonly openedWindows: number[] = [];
  public readonly attentionShown: number[] = [];
  public readonly attentionCleared: number[] = [];
  public openSucceeds = true;
  public deactivateOnAttention = false;

  public activate(tabId: number, windowId: number): void {
    this.activeTabs.add(`${windowId}:${tabId}`);
  }

  public deactivate(tabId: number, windowId: number): void {
    this.activeTabs.delete(`${windowId}:${tabId}`);
  }

  public async isTabActive(tabId: number, windowId: number): Promise<boolean> {
    return this.activeTabs.has(`${windowId}:${tabId}`);
  }

  public async showAttention(tabId: number): Promise<void> {
    this.attentionShown.push(tabId);
    if (this.deactivateOnAttention) {
      this.activeTabs.clear();
    }
  }

  public async clearAttention(tabId: number): Promise<void> {
    this.attentionCleared.push(tabId);
  }

  public async openPopup(windowId: number): Promise<boolean> {
    this.openedWindows.push(windowId);
    return this.openSucceeds;
  }
}

class RecordingCaptureStart implements ConsentCaptureStartPort {
  public readonly currentPages = new Map<number, string>();
  public readonly probeCalls: ConsentDocumentSessionV1[] = [];
  public readonly startCalls: ConsentDocumentSessionV1[] = [];
  public probeThrows = false;
  public startSucceeds = true;

  public async probe(session: ConsentDocumentSessionV1): Promise<boolean> {
    this.probeCalls.push(session);
    if (this.probeThrows) {
      throw new Error("probe unavailable");
    }
    return this.currentPages.get(session.tab_id) === session.page_session_id;
  }

  public async start(session: ConsentDocumentSessionV1): Promise<boolean> {
    this.startCalls.push(session);
    return this.startSucceeds;
  }
}

interface TestController {
  readonly controller: ConsentController;
  readonly store: MemoryConsentStore;
  readonly ui: RecordingConsentUi;
  readonly capture: RecordingCaptureStart;
}

function createController(store = new MemoryConsentStore()): TestController {
  const ui = new RecordingConsentUi();
  const capture = new RecordingCaptureStart();
  return {
    controller: new ConsentController({ store, ui, capture }),
    store,
    ui,
    capture,
  };
}

function sender(
  tabId: number,
  windowId: number,
  active: boolean,
  documentId: string | null = `document-${tabId}`,
): ConsentSenderContext {
  return {
    tab_id: tabId,
    window_id: windowId,
    tab_active: active,
    frame_id: 0,
    origin: "https://qb.medilink-study.com",
    url: "https://qb.medilink-study.com/quiz?ignored=yes#ignored",
    ...(documentId === null ? {} : { document_id: documentId }),
  };
}

function ready(
  pageSessionId: string,
  tabId = 7,
  windowId = 3,
  active = true,
  documentId: string | null = `document-${tabId}`,
): ConsentReadyInput {
  return {
    page_session_id: pageSessionId,
    sender: sender(tabId, windowId, active, documentId),
  };
}

function session(
  pageSessionId: string,
  documentId: string | null,
): ConsentDocumentSessionV1 {
  return {
    tab_id: 7,
    window_id: 3,
    page_session_id: pageSessionId,
    document_id: documentId,
    decision: "undecided",
    capture_state: "not_started",
    auto_popup_state: "pending",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConsentController automatic popup", () => {
  it.each(["loading", "complete"] as const)(
    "reconciles the exact document on the %s lifecycle status",
    (status) => {
      expect(isConsentDocumentLifecycleStatus(status)).toBe(true);
    },
  );

  it.each([undefined, "unloaded", null])(
    "ignores the non-lifecycle status %s",
    (status) => {
      expect(isConsentDocumentLifecycleStatus(status)).toBe(false);
    },
  );

  it("opens once for an active QB document and deduplicates READY", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);

    expect(await test.controller.handleReady(ready(PAGE_A))).toEqual({
      ok: true,
      code: "consent_popup_opened",
    });
    expect(await test.controller.handleReady(ready(PAGE_A))).toEqual({
      ok: true,
      code: "consent_ready_duplicate",
    });
    expect(await test.controller.handleReady(ready(PAGE_B))).toEqual({
      ok: false,
      code: "consent_document_unavailable",
    });

    expect(test.ui.openedWindows).toEqual([3]);
    expect(await test.controller.getTabStatus(7)).toEqual({
      tab_id: 7,
      page_session_id: PAGE_A,
      decision: "undecided",
      capture_state: "not_started",
      auto_popup_state: "opened",
      study_mode: "unclassified",
    });
  });

  it("waits for the exact background tab to become active", async () => {
    const test = createController();
    test.capture.currentPages.set(7, PAGE_A);

    expect(await test.controller.handleReady(ready(PAGE_A, 7, 3, false))).toEqual({
      ok: true,
      code: "consent_ready_registered",
    });
    expect(await test.controller.handleTabActivated(8, 3)).toEqual({
      ok: true,
      code: "consent_activation_ignored",
    });
    expect(test.ui.openedWindows).toEqual([]);

    test.ui.activate(7, 3);
    expect(await test.controller.handleTabActivated(7, 3)).toEqual({
      ok: true,
      code: "consent_popup_opened",
    });
    expect(test.ui.openedWindows).toEqual([3]);
  });

  it("does not open over a different tab when activation changes mid-attempt", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.ui.deactivateOnAttention = true;
    test.capture.currentPages.set(7, PAGE_A);

    expect(await test.controller.handleReady(ready(PAGE_A))).toEqual({
      ok: true,
      code: "consent_ready_registered",
    });
    expect(test.ui.openedWindows).toEqual([]);
    expect(test.ui.attentionCleared).toContain(7);
    expect(await test.controller.getTabStatus(7)).toMatchObject({
      decision: "undecided",
      auto_popup_state: "pending",
    });
  });

  it("retains the current document while reconciling tab loading and completion", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);

    await test.controller.handleReady(ready(PAGE_A));
    await test.controller.startCapture(7, PAGE_A);

    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_retained",
    });
    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_retained",
    });
    expect(await test.controller.getTabStatus(7)).toMatchObject({
      page_session_id: PAGE_A,
      decision: "consented",
      capture_state: "observing",
      auto_popup_state: "suppressed",
    });
    expect(test.ui.openedWindows).toEqual([3]);
  });

  it("clears a stale document before registering a reloaded document", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.ui.activate(9, 4);
    test.capture.currentPages.set(7, PAGE_A);
    test.capture.currentPages.set(9, PAGE_B);

    await test.controller.handleReady(ready(PAGE_A));
    await test.controller.handleReady(ready(PAGE_B, 9, 4, true));
    expect(test.ui.openedWindows).toEqual([3, 4]);

    test.capture.currentPages.delete(7);
    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_cleared",
    });
    test.capture.currentPages.set(7, PAGE_C);
    expect(await test.controller.handleReady(
      ready(PAGE_C, 7, 3, true, "replacement-document"),
    )).toEqual({ ok: true, code: "consent_popup_opened" });
    expect(test.ui.openedWindows).toEqual([3, 4, 3]);
    expect(await test.controller.getTabStatus(9)).not.toBeNull();
  });

  it("retains a newer READY session when a delayed tab update is reconciled", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);
    await test.controller.handleReady(ready(PAGE_A));

    test.capture.currentPages.set(7, PAGE_B);
    await test.controller.handleReady(ready(
      PAGE_B,
      7,
      3,
      true,
      "replacement-document",
    ));

    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_retained",
    });
    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_retained",
    });
    expect(await test.controller.handleReady(ready(
      PAGE_B,
      7,
      3,
      true,
      "replacement-document",
    ))).toEqual({
      ok: true,
      code: "consent_ready_duplicate",
    });
    expect(await test.controller.getTabStatus(7)).toMatchObject({
      page_session_id: PAGE_B,
      decision: "undecided",
      capture_state: "not_started",
      auto_popup_state: "opened",
    });
    expect(test.ui.openedWindows).toEqual([3, 3]);
  });

  it("retains an inactive document and opens its popup only after activation", async () => {
    const test = createController();
    test.capture.currentPages.set(7, PAGE_A);

    expect(await test.controller.handleReady(ready(PAGE_A, 7, 3, false))).toEqual({
      ok: true,
      code: "consent_ready_registered",
    });
    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_retained",
    });
    expect(test.ui.openedWindows).toEqual([]);

    test.ui.activate(7, 3);
    expect(await test.controller.handleTabActivated(7, 3)).toEqual({
      ok: true,
      code: "consent_popup_opened",
    });
    expect(test.ui.openedWindows).toEqual([3]);
  });

  it("uses completion reconciliation to clear a document retained during loading", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);
    await test.controller.handleReady(ready(PAGE_A));

    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_retained",
    });
    test.capture.currentPages.delete(7);
    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_cleared",
    });
    expect(await test.controller.getTabStatus(7)).toBeNull();
  });

  it("uses the page-session fallback when Chrome documentId is unavailable", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);
    await test.controller.handleReady(ready(PAGE_A, 7, 3, true, null));

    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_retained",
    });
    test.capture.currentPages.set(7, PAGE_B);
    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_cleared",
    });
  });

  it("fails closed with attention state when popup opening fails", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.ui.openSucceeds = false;
    test.capture.currentPages.set(7, PAGE_A);

    expect(await test.controller.handleReady(ready(PAGE_A))).toEqual({
      ok: false,
      code: "consent_popup_failed",
    });
    expect(test.capture.startCalls).toEqual([]);
    expect(test.ui.attentionShown).toEqual([7, 7]);
    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_retained",
    });
    expect(await test.controller.handleReady(ready(PAGE_A))).toEqual({
      ok: true,
      code: "consent_ready_duplicate",
    });
    expect(test.ui.openedWindows).toEqual([3]);
    expect((await test.controller.getTabStatus(7))?.auto_popup_state).toBe("failed");
  });

  it("fails closed and clears attention when the exact-document probe throws", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);
    await test.controller.handleReady(ready(PAGE_A));
    const clearedBeforeReconcile = test.ui.attentionCleared.length;

    test.capture.probeThrows = true;
    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_cleared",
    });
    expect(await test.controller.getTabStatus(7)).toBeNull();
    expect(test.ui.attentionCleared).toHaveLength(clearedBeforeReconcile + 1);
  });

  it("rejects non-QB, non-top-frame, and malformed READY senders", async () => {
    const test = createController();
    const wrongPath = ready(PAGE_A);
    const wrongFrame = ready(PAGE_A);

    expect(await test.controller.handleReady({
      ...wrongPath,
      sender: { ...wrongPath.sender, url: "https://qb.medilink-study.com/other" },
    })).toEqual({ ok: false, code: "consent_ready_rejected" });
    expect(await test.controller.handleReady({
      ...wrongFrame,
      sender: { ...wrongFrame.sender, frame_id: 1 },
    })).toEqual({ ok: false, code: "consent_ready_rejected" });
    expect(await test.controller.handleReady(ready("not-a-session"))).toEqual({
      ok: false,
      code: "consent_ready_rejected",
    });
    expect(test.ui.openedWindows).toEqual([]);
  });
});

describe("ConsentController explicit decisions", () => {
  it("declines without starting and permits a later manual start", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);
    await test.controller.handleReady(ready(PAGE_A));

    expect(await test.controller.declineCapture(7, PAGE_A)).toEqual({
      ok: true,
      code: "consent_declined",
    });
    expect(test.capture.startCalls).toEqual([]);
    expect((await test.controller.getTabStatus(7))?.decision).toBe("declined");
    expect(await test.controller.reconcileTabDocument(7)).toEqual({
      ok: true,
      code: "consent_session_retained",
    });
    expect(await test.controller.handleReady(ready(PAGE_A))).toEqual({
      ok: true,
      code: "consent_ready_duplicate",
    });
    expect(test.ui.openedWindows).toEqual([3]);

    expect(await test.controller.startCapture(7, PAGE_A)).toEqual({
      ok: true,
      code: "consent_capture_started",
    });
    expect(test.capture.startCalls).toHaveLength(1);
    expect(await test.controller.startCapture(7, PAGE_A)).toEqual({
      ok: true,
      code: "consent_capture_already_started",
    });
  });

  it("does not authorize a sender until capture start is accepted", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);
    await test.controller.handleReady(ready(PAGE_A));
    const authorizedSender = {
      ...sender(7, 3, false),
      page_session_id: PAGE_A,
    };

    expect(await test.controller.isSenderConsented(authorizedSender)).toBe(false);
    test.capture.startSucceeds = false;
    expect(await test.controller.startCapture(7, PAGE_A)).toEqual({
      ok: false,
      code: "consent_capture_start_blocked",
    });
    expect(await test.controller.isSenderConsented(authorizedSender)).toBe(false);

    test.capture.startSucceeds = true;
    expect(await test.controller.startCapture(7, PAGE_A)).toEqual({
      ok: true,
      code: "consent_capture_started",
    });
    expect(await test.controller.isSenderConsented(authorizedSender)).toBe(true);
    expect(await test.controller.isSenderConsented({
      ...authorizedSender,
      document_id: "different-document",
    })).toBe(false);
    expect(await test.controller.isSenderConsented({
      ...authorizedSender,
      page_session_id: PAGE_B,
    })).toBe(false);
  });

  it("uses the generated page session identity when documentId is unavailable", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);
    await test.controller.handleReady(ready(PAGE_A, 7, 3, true, null));
    await test.controller.startCapture(7, PAGE_A);

    expect(await test.controller.isSenderConsented({
      ...sender(7, 3, false, null),
      page_session_id: PAGE_A,
    })).toBe(true);
    expect(await test.controller.isSenderConsented({
      ...sender(7, 3, false, null),
      page_session_id: PAGE_B,
    })).toBe(false);
  });

  it("clears only ephemeral consent state on tab removal", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);
    await test.controller.handleReady(ready(PAGE_A));
    await test.controller.startCapture(7, PAGE_A);
    const probeCountBeforeRemoval = test.capture.probeCalls.length;

    expect(await test.controller.handleTabRemoved(7)).toEqual({
      ok: true,
      code: "consent_session_cleared",
    });
    expect(test.capture.probeCalls).toHaveLength(probeCountBeforeRemoval);
    expect(await test.controller.getTabStatus(7)).toBeNull();
    expect(await test.controller.isSenderConsented(sender(7, 3, false))).toBe(false);
  });

  it("restores session state after coordinator recreation", async () => {
    const store = new MemoryConsentStore();
    const first = createController(store);
    first.ui.activate(7, 3);
    first.capture.currentPages.set(7, PAGE_A);
    await first.controller.handleReady(ready(PAGE_A));
    await first.controller.declineCapture(7, PAGE_A);

    const second = createController(store);
    expect(await second.controller.getTabStatus(7)).toMatchObject({
      page_session_id: PAGE_A,
      decision: "declined",
      auto_popup_state: "suppressed",
    });
  });
});

describe("Chrome consent ports", () => {
  it("derives only bounded routing context from a Chrome message sender", () => {
    expect(consentSenderContextFromChrome({
      tab: {
        id: 7,
        windowId: 3,
        active: true,
      } as chrome.tabs.Tab,
      frameId: 0,
      origin: "https://qb.medilink-study.com",
      url: "https://qb.medilink-study.com/quiz?ignored=yes",
      documentId: "document-7",
    }, PAGE_A)).toEqual({
      tab_id: 7,
      window_id: 3,
      tab_active: true,
      frame_id: 0,
      origin: "https://qb.medilink-study.com",
      url: "https://qb.medilink-study.com/quiz?ignored=yes",
      document_id: "document-7",
      page_session_id: PAGE_A,
    });
    expect(consentSenderContextFromChrome({ frameId: 0 })).toBeNull();
  });

  it("feature-detects openPopup and manages a tab-specific attention badge", async () => {
    const badgeCalls: chrome.action.BadgeTextDetails[] = [];
    const titleCalls: chrome.action.TitleDetails[] = [];
    const actionWithoutOpenPopup = {
      setBadgeText: async (details: chrome.action.BadgeTextDetails) => {
        badgeCalls.push(details);
      },
      setBadgeBackgroundColor: async () => undefined,
      setTitle: async (details: chrome.action.TitleDetails) => {
        titleCalls.push(details);
      },
    };
    const ui = createChromeConsentUiPort(actionWithoutOpenPopup, {
      query: async () => [{ id: 7 } as chrome.tabs.Tab],
    });

    expect(await ui.isTabActive(7, 3)).toBe(true);
    expect(await ui.openPopup(3)).toBe(false);
    await ui.showAttention(7);
    await ui.clearAttention(7);
    expect(badgeCalls).toEqual([
      { tabId: 7, text: CONSENT_ATTENTION_BADGE_TEXT },
      { tabId: 7, text: "" },
    ]);
    expect(titleCalls[0]).toEqual({ tabId: 7, title: CONSENT_ATTENTION_TITLE });

    const rejectingUi = createChromeConsentUiPort({
      ...actionWithoutOpenPopup,
      openPopup: async () => {
        throw new Error("popup rejected");
      },
    }, {
      query: async () => [{ id: 7 } as chrome.tabs.Tab],
    });
    expect(await rejectingUi.openPopup(3)).toBe(false);
  });

  it("targets documentId when available and frame zero for the fallback", async () => {
    const calls: Array<{
      readonly tabId: number;
      readonly message: { readonly kind: string; readonly page_session_id: string };
      readonly options: chrome.tabs.MessageSendOptions;
    }> = [];
    const port = createChromeConsentCaptureStartPort({
      sendMessage: async (tabId, message, options) => {
        calls.push({ tabId, message, options });
        return {
          ok: true,
          code: message.kind === CONSENT_PROBE_MESSAGE_KIND
            ? "consent_document_present"
            : "capture_started",
        };
      },
    });

    expect(await port.probe(session(PAGE_A, "document-7"))).toBe(true);
    expect(await port.start(session(PAGE_B, null))).toBe(true);
    expect(calls).toEqual([
      {
        tabId: 7,
        message: { kind: CONSENT_PROBE_MESSAGE_KIND, page_session_id: PAGE_A },
        options: { documentId: "document-7" },
      },
      {
        tabId: 7,
        message: { kind: CONSENT_START_CAPTURE_MESSAGE_KIND, page_session_id: PAGE_B },
        options: { frameId: 0 },
      },
    ]);
  });

  it("stores only the bounded session state in storage.session", async () => {
    const values: Record<string, unknown> = {};
    let restricted = false;
    vi.stubGlobal("chrome", { runtime: { lastError: undefined } });
    const storage = {
      get: (key: string, callback: (items: Record<string, unknown>) => void) => {
        callback({ [key]: values[key] });
      },
      set: (items: Record<string, unknown>, callback: () => void) => {
        Object.assign(values, items);
        callback();
      },
      setAccessLevel: async (options: { readonly accessLevel: "TRUSTED_CONTEXTS" }) => {
        restricted = options.accessLevel === "TRUSTED_CONTEXTS";
      },
    };
    const port = createChromeConsentSessionStorePort(storage);
    const state: ConsentSessionStateV1 = {
      version: 1,
      sessions: [session(PAGE_A, "document-7")],
    };

    await port.write(state);
    expect(await port.read()).toEqual(state);
    expect(Object.keys(values)).toEqual([CONSENT_SESSION_STORAGE_KEY]);
    expect(JSON.stringify(values)).not.toMatch(/https?:|question|option|explanation|cookie|token/iu);
    await restrictChromeConsentStorageToTrustedContexts(storage);
    expect(restricted).toBe(true);
  });
});


describe("document-scoped study purpose", () => {
  it("keeps different tab purposes independent and fixes the choice across restarts and repeated start", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.ui.activate(8, 3);
    test.capture.currentPages.set(7, PAGE_A);
    test.capture.currentPages.set(8, PAGE_B);
    await test.controller.handleReady(ready(PAGE_A));
    await test.controller.handleReady(ready(PAGE_B, 8));
    await test.controller.startCapture(7, PAGE_A, "review");
    await test.controller.startCapture(8, PAGE_B, "normal");
    const restarted = new ConsentController({ store: test.store, ui: test.ui, capture: test.capture });
    await restarted.startCapture(7, PAGE_A, "normal");
    expect(await restarted.getSenderStudyMode({ ...sender(7, 3, true), page_session_id: PAGE_A }))
      .toBe("review");
    expect(await restarted.getSenderStudyMode({ ...sender(8, 3, true), page_session_id: PAGE_B }))
      .toBe("normal");
    expect(await restarted.getSenderStudyMode({ ...sender(7, 3, true), page_session_id: PAGE_B }))
      .toBeNull();
    expect(test.capture.startCalls).toHaveLength(2);
  });

  it("reads a legacy consented session as unclassified and cannot relabel it through start", async () => {
    const test = createController();
    test.capture.currentPages.set(7, PAGE_A);
    test.store.value = { version: 1, sessions: [{ ...session(PAGE_A, "document-7"),
      decision: "consented", capture_state: "observing" }] };
    await test.controller.startCapture(7, PAGE_A, "review");
    expect(await test.controller.getSenderStudyMode({ ...sender(7, 3, true), page_session_id: PAGE_A }))
      .toBe("unclassified");
    expect(test.capture.startCalls).toHaveLength(0);
  });

  it("holds the persisted purpose when starting partially fails and is retried", async () => {
    const test = createController();
    test.ui.activate(7, 3);
    test.capture.currentPages.set(7, PAGE_A);
    await test.controller.handleReady(ready(PAGE_A));
    test.capture.startSucceeds = false;
    await test.controller.startCapture(7, PAGE_A, "review");
    expect(await test.controller.declineCapture(7, PAGE_A))
      .toEqual({ ok: false, code: "consent_decline_blocked" });
    test.capture.startSucceeds = true;
    await test.controller.startCapture(7, PAGE_A, "normal");
    expect(test.capture.startCalls.map((value) => value.study_mode)).toEqual(["review", "review"]);
  });
});
