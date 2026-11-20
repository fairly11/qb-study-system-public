import { QB_ORIGIN, type RouteEvidence } from "./protocol.js";

type SearchOrigin = { readonly observed: boolean; readonly setId?: string };
/** Only observed transitions within this isolated document carry set provenance. */
export class RouteTracker {
  #last = "";
  #search: SearchOrigin | undefined;
  #route: RouteEvidence | undefined;
  #initial: SearchOrigin | undefined;
  readonly #newId: () => string;
  public constructor(newId: () => string, initial?: { readonly referrer: string; readonly navigationType: string }) {
    this.#newId = newId;
    if (initial?.navigationType === "navigate" && initial.referrer.length <= 4_096) {
      try {
        const referrer = new URL(initial.referrer);
        const ids = referrer.searchParams.getAll("questionSetId");
        const id = ids[0];
        if (referrer.origin === QB_ORIGIN && referrer.pathname === "/search" && !referrer.username && !referrer.password
          && ids.length === 1 && id !== undefined && /^[A-Za-z0-9_-]{1,100}$/u.test(id)) this.#initial = { observed: true, setId: id };
      } catch { /* Missing/referrer-policy-redacted evidence remains unresolved. */ }
    }
  }
  public update(href: string): RouteEvidence | undefined {
    const url = new URL(href);
    const key = `${url.origin}${url.pathname}${url.search}`;
    if (key === this.#last) return this.#route;
    const initial = this.#last === "" ? this.#initial : undefined;
    this.#initial = undefined;
    this.#last = key;
    if (url.origin !== QB_ORIGIN || url.username || url.password) { this.reset(); return undefined; }
    if (url.pathname === "/search") {
      const setIds = url.searchParams.getAll("questionSetId");
      const id = setIds[0];
      this.#search = setIds.length === 0 ? { observed: true }
        : setIds.length === 1 && id !== undefined && /^[A-Za-z0-9_-]{1,100}$/u.test(id)
          ? { observed: true, setId: id } : { observed: false };
      this.#route = undefined;
      return undefined;
    }
    if (url.pathname !== "/quiz") { this.reset(); return undefined; }
    if (this.#route !== undefined) return this.#route;
    const search = this.#search ?? initial;
    this.#search = undefined;
    this.#route = Object.freeze({ quiz_id: this.#newId(), classification_policy: "normal_default_v1",
      entry_source: search?.observed === true ? "observed_navigation" : "unresolved",
      ...(search?.observed === true && search.setId !== undefined ? { set_id: search.setId } : {}),
    });
    return this.#route;
  }
  public setStudyMode(quizId: string, mode: "normal" | "review"): boolean {
    if (this.#route?.quiz_id !== quizId) return false;
    this.#route = Object.freeze({ ...this.#route, manual_study_mode: mode });
    return true;
  }
  public reset(): void { this.#last = ""; this.#route = undefined; this.#search = undefined; this.#initial = undefined; }
}
