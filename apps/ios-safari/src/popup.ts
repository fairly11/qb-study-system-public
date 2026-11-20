import { EVENT_PREFIX, record, validRoute, validStaged, type RouteEvidence, type SafariBrowser } from "./protocol.js";

export async function refreshPopup(document: Document, browser: SafariBrowser): Promise<void> {
  const status = document.querySelector("#status");
  if (status === null) return;
  try {
    const entries = await browser.storage.local.get(null);
    const staged = Object.entries(entries).filter(([key, value]) => key.startsWith(EVENT_PREFIX) && validStaged(value)).length;
    const summary = await browser.runtime.sendMessage({ command: "status" });
    if (!record(summary) || summary.ok !== true) {
      status.textContent = `管理アプリへの接続を確認できません。Safari内の転送待ち：${staged}件。管理アプリを開いて設定を確認してください。`;
      return;
    }
    status.textContent = `Safari内の転送待ち：${staged}件\n端末保存済み：${String(summary.saved)}件\nNotion送信待ち：${String(summary.pending)}件\nNotion確認済み：${String(summary.confirmed)}件\n要確認：${String(summary.blocked)}件`;
  } catch { status.textContent = "保存状況を読み取れません。管理アプリを開いて確認してください。"; }
}
/** Binds selection to the exact isolated quiz instance, never to a global preference. */
export async function initializeStudyControls(document: Document, browser: SafariBrowser): Promise<void> {
  const status = document.querySelector("#study-status");
  const normal = document.querySelector<HTMLButtonElement>("#study-normal");
  const review = document.querySelector<HTMLButtonElement>("#study-review");
  if (status === null || normal === null || review === null) return;
  let target: { tabId: number; route: RouteEvidence } | undefined;
  let generation = 0;
  let busy = false;
  const controls = (): void => { normal.disabled = review.disabled = busy || target === undefined; };
  const show = (mode: "normal" | "review" | "unclassified", manual = false): void => {
    const label = mode === "normal" ? "通常学習" : mode === "review" ? "復習課題" : "判定未確認";
    status.textContent = `${label}${manual ? "（手動選択）" : ""}。次の解答から適用します。`;
    normal.setAttribute("aria-pressed", String(mode === "normal"));
    review.setAttribute("aria-pressed", String(mode === "review"));
  };
  const activeTab = async (): Promise<number> => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const id = tabs.length === 1 ? tabs[0]?.id : undefined;
    if (id === undefined || !Number.isSafeInteger(id) || id < 0) throw new Error("TAB_UNAVAILABLE");
    return id;
  };
  const select = async (mode: "normal" | "review"): Promise<void> => {
    const current = target;
    if (busy || current === undefined) return;
    generation += 1; busy = true; controls();
    try {
      if (await activeTab() !== current.tabId) throw new Error("TAB_CHANGED");
      const response = await browser.tabs.sendMessage(current.tabId, {
        command: "set_study_mode", quiz_id: current.route.quiz_id, study_mode: mode,
      }, { frameId: 0 });
      if (!record(response) || response.ok !== true || !validRoute(response.route)
        || response.route.quiz_id !== current.route.quiz_id || response.route.manual_study_mode !== mode) throw new Error("MODE_NOT_CONFIRMED");
      target = { tabId: current.tabId, route: response.route }; show(mode, true);
    } catch {
      target = undefined;
      normal.setAttribute("aria-pressed", "false"); review.setAttribute("aria-pressed", "false");
      status.textContent = "選択を確認できません。現在のQB問題画面で、このメニューを開き直してください。";
    } finally { busy = false; controls(); }
  };
  normal.addEventListener("click", () => { void select("normal"); });
  review.addEventListener("click", () => { void select("review"); });
  controls();
  try {
    const tabId = await activeTab();
    const response = await browser.tabs.sendMessage(tabId, { command: "study_route" }, { frameId: 0 });
    if (!record(response) || response.ok !== true || !validRoute(response.route)) throw new Error("ROUTE_UNAVAILABLE");
    const route = response.route;
    target = { tabId, route }; controls();
    if (route.manual_study_mode !== undefined) { show(route.manual_study_mode, true); return; }
    if (route.set_id === undefined && (route.classification_policy === "normal_default_v1" || route.entry_source === "observed_navigation")) {
      show("normal"); return;
    }
    show("unclassified");
    const requestedGeneration = generation;
    const resolution = await browser.runtime.sendMessage({ command: "study_mode", route });
    if (generation !== requestedGeneration) return;
    const current = await browser.tabs.sendMessage(tabId, { command: "study_route" }, { frameId: 0 });
    if (generation !== requestedGeneration) return;
    if (!record(current) || current.ok !== true || !validRoute(current.route) || current.route.quiz_id !== route.quiz_id) {
      target = undefined; controls();
      status.textContent = "演習画面が変わりました。このメニューを開き直してください。";
      return;
    }
    if (record(resolution) && resolution.ok === true && (resolution.study_mode === "normal" || resolution.study_mode === "review")) show(resolution.study_mode);
  } catch {
    if (target === undefined) status.textContent = "QBの問題画面を開くと、学習区分を選択できます。";
  }
}
const global = globalThis as { browser?: SafariBrowser; document?: Document };
if (global.browser !== undefined && global.document !== undefined) {
  const browser = global.browser; const document = global.document;
  const resume = async (): Promise<void> => {
    const button = document.querySelector<HTMLButtonElement>("#retry");
    if (button !== null) button.disabled = true;
    try { await browser.runtime.sendMessage({ command: "wake" }); }
    catch { /* refresh displays the last independently observed durable state. */ }
    await refreshPopup(document, browser);
    if (button !== null) button.disabled = false;
  };
  document.querySelector("#retry")?.addEventListener("click", () => { void resume(); });
  void initializeStudyControls(document, browser);
  void refreshPopup(document, browser);
  void resume();
}
