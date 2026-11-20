import type { ConsentSenderContext } from "./consent-controller.js";
import { QB_ORIGIN } from "./consent-controller.js";
import type { StudyCaptureContext } from "./study-context.js";
import { qbPageRouteDescriptor, isQbPageRouteDescriptor, type QbPageRouteDescriptor, type StudyRouteEvidence } from "../shared/protocol.js";

export interface StudyRouteEntry {
  readonly tab_id: number;
  readonly question_set_id: string | null;
  readonly uncertain: boolean;
  readonly invalid_set_id?: true;
  readonly document_id: string | null;
  readonly route_kind: "search" | "quiz";
  readonly quiz_id: string | null;
}

export interface StudyRouteState {
  readonly version: 1;
  readonly tabs: readonly StudyRouteEntry[];
}

export interface StudyRouteStore {
  read(): Promise<unknown>;
  write(state: StudyRouteState): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSetId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
}

function validDocumentId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}

function readState(value: unknown): StudyRouteState {
  if (value === undefined) return { version: 1, tabs: [] };
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "tabs,version"
    || value.version !== 1 || !Array.isArray(value.tabs) || value.tabs.length > 10_000
    || !value.tabs.every((tab: unknown) => isRecord(tab)
      && Object.keys(tab).sort().join(",") === (Object.hasOwn(tab, "invalid_set_id")
        ? "document_id,invalid_set_id,question_set_id,quiz_id,route_kind,tab_id,uncertain"
        : "document_id,question_set_id,quiz_id,route_kind,tab_id,uncertain")
      && (tab.invalid_set_id === undefined || tab.invalid_set_id === true)
      && validTabId(tab.tab_id) && typeof tab.uncertain === "boolean"
      && (tab.document_id === null || validDocumentId(tab.document_id))
      && (tab.route_kind === "search" || tab.route_kind === "quiz")
      && (tab.quiz_id === null || validSetId(tab.quiz_id))
      && (tab.question_set_id === null || validSetId(tab.question_set_id)))) {
    throw new Error("STUDY_ROUTE_STORAGE_INVALID");
  }
  const tabs = value.tabs as readonly StudyRouteEntry[];
  if (new Set(tabs.map((tab) => tab.tab_id)).size !== tabs.length) throw new Error("STUDY_ROUTE_STORAGE_INVALID");
  return { version: 1, tabs };
}

function senderUrl(sender: ConsentSenderContext): URL | null {
  if (!validTabId(sender.tab_id) || sender.frame_id !== 0 || sender.origin !== QB_ORIGIN
    || typeof sender.url !== "string" || sender.url.length > 4096) return null;
  try {
    const url = new URL(sender.url);
    return url.origin === QB_ORIGIN && !url.username && !url.password ? url : null;
  } catch { return null; }
}

/** Stores bounded route identities only. Full URLs and QB page contents never enter storage. */
export class StudyRouteContext {
  readonly #store: StudyRouteStore;
  readonly #probeCurrent: (sender: ConsentSenderContext, route?: QbPageRouteDescriptor) => Promise<boolean>;
  readonly #lookup: (questionSetId: string) => Promise<StudyCaptureContext>;
  readonly #prefetch = new Map<number, {readonly id: string; readonly result: Promise<StudyCaptureContext>}>();
  #tail: Promise<void> = Promise.resolve();

  public constructor(ports: {
    readonly store: StudyRouteStore;
    readonly isCurrent: (sender: ConsentSenderContext, route?: QbPageRouteDescriptor) => Promise<boolean>;
    readonly lookup: (questionSetId: string) => Promise<StudyCaptureContext>;
  }) {
    this.#store = ports.store;
    this.#probeCurrent = ports.isCurrent;
    this.#lookup = ports.lookup;
  }

  public handleRoute(sender: ConsentSenderContext, contextLost = false, evidence: StudyRouteEvidence = {}): Promise<boolean> {
    return this.#serialize(async () => {
      const url = senderUrl(sender);
      if (url === null || (evidence.route !== undefined && (!isQbPageRouteDescriptor(evidence.route)
        || !validDocumentId(sender.document_id))) || !await this.#isCurrent(sender, evidence.route)) return false;
      const descriptor = evidence.route ?? qbPageRouteDescriptor(url)!;
      const state = readState(await this.#store.read());
      const previous = state.tabs.find((tab) => tab.tab_id === sender.tab_id);
      const documentId = validDocumentId(sender.document_id) ? sender.document_id : null;
      let next: StudyRouteEntry | undefined;
      if (descriptor.route_kind === "search") {
        next = { tab_id: sender.tab_id,
          question_set_id: descriptor.question_set_id,
          uncertain: descriptor.invalid_set_id,
          ...(descriptor.invalid_set_id ? { invalid_set_id: true as const } : {}),
          document_id: documentId, route_kind: "search", quiz_id: null };
      } else if (descriptor.route_kind === "quiz") {
        const quizId = descriptor.question_id;
        const sameDocument = documentId !== null && documentId === previous?.document_id;
        const verifiedReload = evidence.first_document_navigation === "reload"
          && previous?.route_kind === "quiz" && quizId !== null && quizId === previous.quiz_id;
        const verifiedSearchNavigation = evidence.first_document_navigation === "navigate"
          && previous?.route_kind === "search" && validSetId(evidence.referrer_set_id)
          && previous.question_set_id === evidence.referrer_set_id;
        const inherit = !contextLost && (sameDocument || verifiedReload || verifiedSearchNavigation);
        const lostSetOrigin = !inherit && previous?.question_set_id != null;
        next = { tab_id: sender.tab_id, question_set_id: inherit ? previous?.question_set_id ?? null : null,
          uncertain: contextLost || previous?.uncertain === true || lostSetOrigin,
          ...(previous?.invalid_set_id ? { invalid_set_id: true as const } : {}),
          document_id: documentId, route_kind: "quiz", quiz_id: quizId };
      }
      // Recheck after asynchronous storage access so an old route cannot replace a newer one.
      if (!await this.#isCurrent(sender, evidence.route)) return false;
      await this.#store.write({ version: 1,
        tabs: [...state.tabs.filter((tab) => tab.tab_id !== sender.tab_id), ...(next ? [next] : [])] });
      if (descriptor.route_kind === "search" && next?.question_set_id) {
        const result = this.#lookup(next.question_set_id).catch(() => ({ study_mode: "unclassified" as const }));
        this.#prefetch.set(sender.tab_id, { id: next.question_set_id, result });
        void result.then((context) => {
          if (context.study_mode !== "review" && this.#prefetch.get(sender.tab_id)?.result === result) {
            this.#prefetch.delete(sender.tab_id);
          }
        });
      } else if (!next?.question_set_id) {
        this.#prefetch.delete(sender.tab_id);
      }
      return true;
    });
  }

  /** Registered route only. Caller also probes its live page_session_id before accepting answers. */
  public hasRegisteredQuizRoute(sender: ConsentSenderContext): Promise<boolean> {
    return this.#serialize(async () => {
      if (senderUrl(sender) === null || !validDocumentId(sender.document_id)) return false;
      const route = readState(await this.#store.read()).tabs.find((tab) => tab.tab_id === sender.tab_id);
      return route?.route_kind === "quiz" && route.document_id === sender.document_id;
    });
  }

  public async resolve(sender: ConsentSenderContext): Promise<StudyCaptureContext> {
    const prepared = await this.#serialize<StudyCaptureContext | {result: Promise<StudyCaptureContext>}>(async () => {
      const url = senderUrl(sender);
      if (url === null) {
        return { study_mode: "unclassified" };
      }
      const state = readState(await this.#store.read());
      const route = state.tabs.find((tab) => tab.tab_id === sender.tab_id);
      if (route === undefined || route.route_kind !== "quiz" || route.document_id !== (sender.document_id ?? null)) {
        return {study_mode: "unclassified"};
      }
      if (route.invalid_set_id) return { study_mode: "unclassified" };
      // Missing provenance alone is normal study; never reuse a possibly stale review set.
      if (route.uncertain) return { study_mode: "normal" };
      if (!route?.question_set_id) return { study_mode: "normal" };
      try {
        const cached = this.#prefetch.get(sender.tab_id);
        const result = cached?.id === route.question_set_id ? cached.result : this.#lookup(route.question_set_id);
        return {result};
      }
      catch { return { study_mode: "unclassified" }; }
    });
    if (!("result" in prepared)) return prepared;
    try {
      const resolved = await prepared.result;
      // Negative/unknown results are useful for this entry only, never for later study sessions.
      if (resolved.study_mode !== "review" && this.#prefetch.get(sender.tab_id)?.result === prepared.result) {
        this.#prefetch.delete(sender.tab_id);
      }
      return resolved;
    } catch { return {study_mode: "unclassified"}; }
  }

  public removeTab(tabId: number): Promise<void> {
    return this.#serialize(async () => {
      if (!validTabId(tabId)) return;
      this.#prefetch.delete(tabId);
      const state = readState(await this.#store.read());
      await this.#store.write({ version: 1, tabs: state.tabs.filter((tab) => tab.tab_id !== tabId) });
    });
  }

  async #isCurrent(sender: ConsentSenderContext, route?: QbPageRouteDescriptor): Promise<boolean> {
    try { return await this.#probeCurrent(sender, route); }
    catch { return false; }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
