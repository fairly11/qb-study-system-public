import { describe, expect, it, vi } from "vitest";

import { runPopupCommand } from "../src/popup/command-runner.js";
import { RETRY_OUTBOX_MESSAGE_KIND } from "../src/shared/protocol.js";

describe("popup command runner", () => {
  it("shows the command result only after status refresh succeeds", async () => {
    const busyStates: boolean[] = [];
    const codes: string[] = [];

    await runPopupCommand({ kind: RETRY_OUTBOX_MESSAGE_KIND }, {
      setBusy: (busy) => busyStates.push(busy),
      renderCode: (code) => codes.push(code),
      sendMessage: () => Promise.resolve({ ok: true, code: "retry_requested" }),
      refreshAllStatus: () => Promise.resolve(true),
    });

    expect(busyStates).toEqual([true, false]);
    expect(codes).toEqual(["popup_command_pending", "retry_requested"]);
  });

  it("does not overwrite a refresh error with a stale success code", async () => {
    const codes: string[] = [];
    const renderCode = (code: string): void => {
      codes.push(code);
    };

    await runPopupCommand({ kind: RETRY_OUTBOX_MESSAGE_KIND }, {
      setBusy: vi.fn(),
      renderCode,
      sendMessage: () => Promise.resolve({ ok: true, code: "retry_requested" }),
      refreshAllStatus: () => {
        renderCode("popup_status_response_invalid");
        return Promise.resolve(false);
      },
    });

    expect(codes).toEqual([
      "popup_command_pending",
      "popup_status_response_invalid",
    ]);
  });
});
