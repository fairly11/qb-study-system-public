import type { AttemptEventV1 } from "@qb-study/contracts";
import type { AttemptDomAdapter } from "../../browser-extension/src/adapters/types.js";
import { validStaged, type RouteEvidence, type StagedEvent } from "./protocol.js";

interface Submission { readonly questionKey: string; readonly eventId: string; readonly route: RouteEvidence }
/** One browser-trusted submit arms one answer; revisiting/redrawing a result never arms capture. */
export class SafariCapture {
  readonly #adapter: AttemptDomAdapter;
  readonly #newId: () => string;
  readonly #now: () => Date;
  #submission: Submission | undefined;
  public constructor(adapter: AttemptDomAdapter, newId: () => string = () => crypto.randomUUID(), now: () => Date = () => new Date()) {
    this.#adapter = adapter; this.#newId = newId; this.#now = now;
  }
  public reset(): void { this.#submission = undefined; }
  public submit(root: ParentNode, route: RouteEvidence): boolean {
    const observation = this.#adapter.inspect(root);
    if (observation.kind !== "pending") return false;
    if (this.#submission?.questionKey === observation.question_key && this.#submission.route.quiz_id === route.quiz_id) return true;
    this.#submission = { questionKey: observation.question_key, eventId: this.#newId(), route };
    return true;
  }
  public inspect(root: ParentNode, route: RouteEvidence): { readonly state: "observing" | "unsupported"; readonly staged?: StagedEvent } {
    const observation = this.#adapter.inspect(root);
    const submission = this.#submission;
    if (submission !== undefined && submission.route.quiz_id !== route.quiz_id) this.reset();
    if (observation.kind === "unsupported") return { state: "unsupported" };
    if (submission === undefined || this.#submission === undefined) return { state: "observing" };
    if (observation.question_key !== submission.questionKey) { this.reset(); return { state: "observing" }; }
    if (observation.kind === "pending") return { state: "observing" };
    if (observation.kind !== "resolved") return { state: "unsupported" };
    this.reset();
    const now = this.#now().toISOString();
    const event: AttemptEventV1 = {
      schema_version: "1", record_type: "attempt_event", event_id: submission.eventId,
      question_key: observation.question_key, answered_at: now, result: observation.result,
      selected_option_indices: [...observation.selected_option_indices].sort((a, b) => a - b),
      provenance: { producer: "browser-extension", producer_version: "ios-0.1.0", source_system: "qb-web-dom", source_record_id: route.quiz_id, recorded_at: now },
      quality: { acquisition_method: "direct_capture", temporal_precision: "exact", state_precision: "exact" },
    };
    const staged: StagedEvent = { protocol_version: 1, event, route: submission.route };
    return validStaged(staged) ? { state: "observing", staged } : { state: "unsupported" };
  }
}
