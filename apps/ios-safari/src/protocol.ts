import type { AttemptEventV1 } from "@qb-study/contracts";
import { isCanonicalAttemptEventV1 } from "../../browser-extension/src/background/attempt-validator.js";

export const NATIVE_APP = "com.qbstudy.ios";
export const QB_ORIGIN = "https://qb.medilink-study.com";
export const EVENT_PREFIX = "qb-ios-event-v1:";
export const RECEIPT_PREFIX = "qb-ios-receipt-v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => [...required, ...optional].includes(key));
}
export interface RouteEvidence {
  readonly quiz_id: string;
  readonly set_id?: string;
  readonly entry_source: "observed_navigation" | "unresolved";
  readonly classification_policy?: "normal_default_v1";
  readonly manual_study_mode?: "normal" | "review";
}
export interface StagedEvent {
  readonly protocol_version: 1;
  readonly event: AttemptEventV1;
  readonly route: RouteEvidence;
}
export interface NativeReceipt {
  readonly protocol_version: 1;
  readonly ok: true;
  readonly status: "local_saved" | "notion_confirmed";
  readonly event_id: string;
}
export interface LocalStorage {
  get(keys: string | readonly string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
}
export interface MessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly origin?: string;
  readonly frameId?: number;
  readonly tab?: { readonly id?: number };
}
export interface Runtime {
  readonly id: string;
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  sendNativeMessage(application: string, message: unknown): Promise<unknown>;
  readonly onMessage: {
    addListener(listener: (message: unknown, sender: MessageSender) => Promise<unknown> | undefined): void;
    removeListener?(listener: (message: unknown, sender: MessageSender) => Promise<unknown> | undefined): void;
  };
}
export interface SafariBrowser {
  readonly runtime: Runtime;
  readonly tabs: {
    query(query: { active: true; currentWindow: true }): Promise<readonly { readonly id?: number }[]>;
    sendMessage(tabId: number, message: unknown, options: { frameId: 0 }): Promise<unknown>;
  };
  readonly storage: {
    readonly local: LocalStorage;
    readonly onChanged: { addListener(listener: () => void): void; removeListener(listener: () => void): void };
  };
}
export function validRoute(value: unknown): value is RouteEvidence {
  return record(value) && keys(value, ["quiz_id", "entry_source"], ["set_id", "classification_policy", "manual_study_mode"])
    && uuid(value.quiz_id)
    && (value.classification_policy === undefined || value.classification_policy === "normal_default_v1")
    && (value.manual_study_mode === undefined || value.manual_study_mode === "normal" || value.manual_study_mode === "review")
    && (value.entry_source === "observed_navigation" || value.entry_source === "unresolved")
    && (value.set_id === undefined || (typeof value.set_id === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(value.set_id)))
    && (value.entry_source !== "unresolved" || value.set_id === undefined);
}
export function validStaged(value: unknown): value is StagedEvent {
  return record(value) && keys(value, ["protocol_version", "event", "route"])
    && value.protocol_version === 1 && validRoute(value.route) && isCanonicalAttemptEventV1(value.event)
    && value.event.provenance.producer === "browser-extension"
    && value.event.provenance.producer_version === "ios-0.1.0"
    && value.event.provenance.source_system === "qb-web-dom"
    && value.event.provenance.source_record_id === value.route.quiz_id
    && value.event.selected_option_indices.length <= 5
    && value.event.selected_option_indices.every((index) => index <= 5);
}
export function receipt(value: unknown, eventId: string): value is NativeReceipt {
  return record(value) && value.protocol_version === 1 && value.ok === true && value.event_id === eventId
    && (value.status === "local_saved" || value.status === "notion_confirmed");
}
export function trustedQbSender(sender: MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id)
    || (sender.tab?.id ?? -1) < 0) return false;
  try {
    const url = new URL(sender.url ?? "");
    return url.origin === QB_ORIGIN && url.username === "" && url.password === ""
      && (sender.origin === undefined || sender.origin === QB_ORIGIN);
  } catch { return false; }
}
