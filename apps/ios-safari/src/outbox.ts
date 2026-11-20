import { EVENT_PREFIX, RECEIPT_PREFIX, receipt, validStaged, type LocalStorage, type NativeReceipt, type StagedEvent } from "./protocol.js";

export type DeliveryState = "saving" | "web_saved" | "local_saved" | "notion_confirmed" | "save_failed";
/** Content writes independent keys: no read-modify-write array can lose simultaneous answers. */
export class StagingWriter {
  readonly #storage: LocalStorage;
  readonly #wake: () => Promise<unknown>;
  readonly #status: (eventId: string, status: DeliveryState) => void;
  readonly #retry = new Map<string, StagedEvent>();
  readonly #inflight = new Map<string, Promise<void>>();
  public constructor(storage: LocalStorage, wake: () => Promise<unknown>, status: (eventId: string, status: DeliveryState) => void) {
    this.#storage = storage; this.#wake = wake; this.#status = status;
  }
  public stage(staged: StagedEvent): Promise<void> {
    if (!validStaged(staged)) return Promise.reject(new Error("INVALID_CAPTURE"));
    const eventId = staged.event.event_id;
    const current = this.#inflight.get(eventId);
    if (current !== undefined) return current;
    this.#retry.set(eventId, staged);
    this.#status(eventId, "saving");
    // Start the browser-owned persistent write in this call stack, before any
    // routing, native messaging or Notion request. pagehide never cancels it.
    let write: Promise<void>;
    try { write = this.#storage.set({ [`${EVENT_PREFIX}${eventId}`]: staged }); }
    catch { write = Promise.reject(new Error("LOCAL_WRITE_FAILED")); }
    const pending = write.then(async () => {
      this.#retry.delete(eventId);
      this.#status(eventId, "web_saved");
      try { await this.#wake(); } catch { /* Durable staged entry survives a missing background. */ }
    }, () => { this.#status(eventId, "save_failed"); }).finally(() => { this.#inflight.delete(eventId); });
    this.#inflight.set(eventId, pending);
    return pending;
  }
  public async retry(): Promise<void> { await Promise.all([...this.#retry.values()].map((value) => this.stage(value))); }
}

export class NativeOutbox {
  readonly #storage: LocalStorage;
  readonly #send: (message: unknown) => Promise<unknown>;
  readonly #receiptWrites = new Map<string, Promise<void>>();
  #inflight: Promise<void> | undefined;
  public constructor(storage: LocalStorage, send: (message: unknown) => Promise<unknown>) { this.#storage = storage; this.#send = send; }
  public drain(): Promise<void> {
    if (this.#inflight !== undefined) return this.#inflight;
    const run = this.#drain().finally(() => { this.#inflight = undefined; });
    this.#inflight = run;
    return run;
  }
  async #drain(): Promise<void> {
    const entries = await this.#storage.get(null);
    for (const [key, value] of Object.entries(entries)) {
      if (!key.startsWith(EVENT_PREFIX) || !validStaged(value) || key !== `${EVENT_PREFIX}${value.event.event_id}`) continue;
      try {
        const result = await this.#send({ ...value, command: "ingest" });
        if (!receipt(result, value.event.event_id)) continue;
        await this.#saveReceipt(result);
        // Only the native store's durable ACK permits removal of the web copy.
        // A missing ACK/failed receipt write retains the same event ID for replay.
        await this.#storage.remove(key);
      } catch { /* Do not replace, delete, log, or regenerate uncertain events. */ }
    }
  }
  public async eventStatus(eventId: string): Promise<NativeReceipt | undefined> {
    const key = `${RECEIPT_PREFIX}${eventId}`;
    try {
      const remote = await this.#send({ protocol_version: 1, command: "status", event_id: eventId });
      if (receipt(remote, eventId)) await this.#saveReceipt(remote);
    } catch { /* Last durable native ACK remains valid when native messaging is unavailable. */ }
    const local = (await this.#storage.get(key))[key];
    return receipt(local, eventId) ? local : undefined;
  }
  async #saveReceipt(value: NativeReceipt): Promise<void> {
    const key = `${RECEIPT_PREFIX}${value.event_id}`;
    // Ingest and status responses can overlap. Serialize their read/check/write
    // for this event so a slow local receipt cannot replace Notion confirmation.
    const previous = this.#receiptWrites.get(value.event_id) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const existing = (await this.#storage.get(key))[key];
      if (receipt(existing, value.event_id) && existing.status === "notion_confirmed") return;
      const safe: NativeReceipt = { protocol_version: 1, ok: true, event_id: value.event_id, status: value.status };
      await this.#storage.set({ [key]: safe });
    });
    this.#receiptWrites.set(value.event_id, pending);
    try { await pending; }
    finally { if (this.#receiptWrites.get(value.event_id) === pending) this.#receiptWrites.delete(value.event_id); }
  }
}
