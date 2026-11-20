import type { StagedEvent, LocalStorage } from "../src/protocol.js";

export const SESSION = "20000000-0000-4000-8000-000000000001";
export function staged(id = "10000000-0000-4000-8000-000000000001"): StagedEvent {
  return { protocol_version: 1, route: { quiz_id: SESSION, entry_source: "unresolved" }, event: {
    schema_version: "1", record_type: "attempt_event", event_id: id, question_key: "119A12", answered_at: "2026-10-25T00:00:00.000Z",
    result: "correct", selected_option_indices: [2],
    provenance: { producer: "browser-extension", producer_version: "ios-0.1.0", source_system: "qb-web-dom", source_record_id: SESSION, recorded_at: "2026-10-25T00:00:00.000Z" },
    quality: { acquisition_method: "direct_capture", temporal_precision: "exact", state_precision: "exact" },
  } };
}
export class MemoryStorage implements LocalStorage {
  public data: Record<string, unknown> = {};
  public failWrite = false;
  public async get(keys: string | readonly string[] | null): Promise<Record<string, unknown>> {
    if (keys === null) return structuredClone(this.data);
    return Object.fromEntries((typeof keys === "string" ? [keys] : keys).filter((key) => Object.hasOwn(this.data, key)).map((key) => [key, structuredClone(this.data[key])]));
  }
  public async set(items: Record<string, unknown>): Promise<void> {
    if (this.failWrite) throw new Error("SYNTHETIC_STORAGE_FAILURE");
    Object.assign(this.data, structuredClone(items));
  }
  public async remove(keys: string | readonly string[]): Promise<void> { for (const key of typeof keys === "string" ? [keys] : keys) delete this.data[key]; }
}
