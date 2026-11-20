import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { renderRecentAttempts } from "../src/popup/recent-attempts-view.js";
import type { PopupStatusV1 } from "../src/shared/protocol.js";

function view(): {
  readonly window: Window;
  readonly list: HTMLUListElement;
  readonly emptyState: HTMLParagraphElement;
} {
  const window = new Window();
  const list = window.document.createElement("ul") as unknown as HTMLUListElement;
  const emptyState = window.document.createElement("p") as unknown as HTMLParagraphElement;
  return { window, list, emptyState };
}

function status(
  overrides: Partial<PopupStatusV1> = {},
): PopupStatusV1 {
  return {
    capture_state: "observing",
    outbox_count: 0,
    collector_endpoint: "http://127.0.0.1:8765/v1/attempt-events",
    delivery_state: "idle",
    last_diagnostic_code: null,
    last_capture_issue_code: null,
    recent_attempts: [],
    ...overrides,
  };
}

describe("recent attempt popup view", () => {
  it("distinguishes no records from an unreadable storage state", () => {
    const empty = view();
    renderRecentAttempts({
      document: empty.window.document as unknown as Document,
      list: empty.list,
      emptyState: empty.emptyState,
    }, status());
    expect(empty.emptyState.textContent).toBe("記録はありません。");
    expect(empty.emptyState.hidden).toBe(false);
    expect(empty.list.hidden).toBe(true);

    renderRecentAttempts({
      document: empty.window.document as unknown as Document,
      list: empty.list,
      emptyState: empty.emptyState,
    }, status({
      delivery_state: "blocked",
      last_diagnostic_code: "storage_state_blocked",
    }));
    expect(empty.emptyState.textContent).toBe("保存状態を読み取れません。");
  });

  it("renders only the safe attempt summary fields as text", () => {
    const rendered = view();
    renderRecentAttempts({
      document: rendered.window.document as unknown as Document,
      list: rendered.list,
      emptyState: rendered.emptyState,
    }, status({
      outbox_count: 1,
      delivery_state: "retry_scheduled",
      recent_attempts: [{
        question_key: "119A12",
        answered_at: "2026-08-26T03:04:05.006Z",
        result: "incorrect",
        selected_option_indices: [1, 3],
        delivery_state: "retry_scheduled",
      }],
    }));

    expect(rendered.list.hidden).toBe(false);
    expect(rendered.emptyState.hidden).toBe(true);
    expect(rendered.list.textContent).toContain("119A12");
    expect(rendered.list.textContent).toContain("不正解");
    expect(rendered.list.textContent).toContain("選択: 1, 3");
    expect(rendered.list.textContent).toContain("再送待ち");
    expect(rendered.list.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-26T03:04:05.006Z",
    );
    expect(rendered.list.querySelectorAll("img, script, a")).toHaveLength(0);
  });
});
