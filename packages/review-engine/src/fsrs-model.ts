import { createEmptyCard, fsrs, FSRSVersion, Rating, type Card } from "ts-fsrs";

import { compareText, exactTimestamp, ReviewEngineError } from "./evidence.js";
import type { DerivedGrade, ReviewMemoryModel } from "./types.js";

/** The adapter keeps observed correctness separate from a provisional FSRS grade. */
export const fsrsMemoryModel: ReviewMemoryModel = Object.freeze({
  model_id: "fsrs-6",
  model_version: `ts-fsrs-5.4.2:${FSRSVersion}`,
  grade_policy_version: "binary-correct-good-incorrect-again-v1",
  predict({ attempts, as_of, request_retention }: Parameters<ReviewMemoryModel["predict"]>[0]) {
    const at = exactTimestamp(as_of);
    if (!Number.isFinite(request_retention) || request_retention <= 0 || request_retention >= 1) {
      throw new ReviewEngineError("REVIEW_SETTINGS_INVALID");
    }
    const scheduler = fsrs({ request_retention, enable_fuzz: false, enable_short_term: false });
    let card: Card | undefined;
    const derived: DerivedGrade[] = [];
    const ordered = attempts.map((event) => ({ ...event, answered_at: exactTimestamp(event.answered_at) }))
      .sort((a, b) => compareText(a.answered_at, b.answered_at)
      || compareText(a.event_id, b.event_id));
    for (const event of ordered) {
      const answeredAt = exactTimestamp(event.answered_at);
      if (answeredAt > at) throw new ReviewEngineError("REVIEW_MODEL_FUTURE_EVENT");
      const grade = event.result === "correct" ? Rating.Good : event.result === "incorrect" ? Rating.Again : null;
      derived.push({ event_id: event.event_id, answered_at: answeredAt, observed_result: event.result,
        derived_grade: grade === Rating.Good ? "Good" : grade === Rating.Again ? "Again" : null });
      if (grade === null) continue;
      card = scheduler.next(card ?? createEmptyCard(answeredAt), answeredAt, grade).card;
    }
    if (card === undefined) {
      return { next_review_at: null, retrievability: null, stability_days: null, difficulty: null, derived_grades: derived };
    }
    return {
      next_review_at: card.due.toISOString(),
      retrievability: scheduler.get_retrievability(card, at, false),
      stability_days: card.stability,
      difficulty: card.difficulty,
      derived_grades: derived,
    };
  },
});
