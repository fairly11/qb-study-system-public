import type {
  PopupStatusV1,
  RecentAttemptDeliveryStateV1,
} from "../shared/protocol.js";

const RESULT_LABELS = Object.freeze({
  correct: "正解",
  incorrect: "不正解",
  unknown: "不明",
} as const);

const DELIVERY_LABELS: Readonly<Record<RecentAttemptDeliveryStateV1, string>> =
  Object.freeze({
    pending: "送信待ち",
    retry_scheduled: "再送待ち",
    blocked: "送信停止",
    delivered: "送信済み",
  });

export interface RecentAttemptsView {
  readonly document: Document;
  readonly list: HTMLUListElement;
  readonly emptyState: HTMLParagraphElement;
}

function span(document: Document, text: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.textContent = text;
  return element;
}

export function renderRecentAttempts(
  view: RecentAttemptsView,
  status: PopupStatusV1,
): void {
  view.list.replaceChildren();

  for (const attempt of status.recent_attempts) {
    const item = view.document.createElement("li");
    const questionKey = view.document.createElement("strong");
    questionKey.textContent = attempt.question_key;

    const answeredAt = view.document.createElement("time");
    answeredAt.dateTime = attempt.answered_at;
    answeredAt.textContent = attempt.answered_at;

    item.append(
      questionKey,
      span(view.document, RESULT_LABELS[attempt.result]),
      span(
        view.document,
        `選択: ${attempt.selected_option_indices.join(", ")}`,
      ),
      answeredAt,
      span(view.document, DELIVERY_LABELS[attempt.delivery_state]),
    );
    view.list.append(item);
  }

  const hasAttempts = status.recent_attempts.length > 0;
  view.list.hidden = !hasAttempts;
  view.emptyState.hidden = hasAttempts;
  view.emptyState.textContent = status.last_diagnostic_code === "storage_state_blocked"
    ? "保存状態を読み取れません。"
    : "記録はありません。";
}
