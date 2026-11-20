import { describe, expect, it, vi } from "vitest";
import { NativeOutbox, StagingWriter, type DeliveryState } from "../src/outbox.js";
import { EVENT_PREFIX, RECEIPT_PREFIX, type StagedEvent } from "../src/protocol.js";
import { MemoryStorage, staged } from "./helpers.js";

describe("content durable staging", () => {
  it("requests storage immediately and reports saved only after the browser acknowledges it", async () => {
    const storage = new MemoryStorage(); const order: string[] = []; let complete: (() => void) | undefined;
    storage.set = () => { order.push("write_requested"); return new Promise<void>((resolve) => { complete = resolve; }); };
    const writer = new StagingWriter(storage, async () => { order.push("native_wake"); }, (_id, state) => { order.push(state); });
    const saving = writer.stage(staged());
    expect(order).toEqual(["saving", "write_requested"]);
    complete!(); await saving;
    expect(order).toEqual(["saving", "write_requested", "web_saved", "native_wake"]);
  });
  it("does not claim saved on quota failure; retry retains the original event ID", async () => {
    const storage = new MemoryStorage(); storage.failWrite = true;
    const states: DeliveryState[] = []; const wake = vi.fn(async () => undefined);
    const writer = new StagingWriter(storage, wake, (_id, state) => { states.push(state); });
    await writer.stage(staged()); expect(states).toEqual(["saving", "save_failed"]); expect(wake).not.toHaveBeenCalled();
    storage.failWrite = false; await writer.retry();
    expect(Object.keys(storage.data)).toEqual([`${EVENT_PREFIX}${staged().event.event_id}`]);
    expect(states.at(-1)).toBe("web_saved");
  });
  it("keeps independent simultaneous events and survives an absent background", async () => {
    const storage = new MemoryStorage();
    const writer = new StagingWriter(storage, async () => { throw new Error("SYNTHETIC_SUSPEND"); }, () => undefined);
    await Promise.all([writer.stage(staged()), writer.stage(staged("10000000-0000-4000-8000-000000000002"))]);
    expect(Object.keys(storage.data)).toHaveLength(2);
  });
});
describe("native handoff and restart", () => {
  it("keeps confirmation when a delayed ingest receipt overlaps a Notion status receipt", async () => {
    const storage = new MemoryStorage(); const value = staged(); const eventId = value.event.event_id;
    const receiptKey = `${RECEIPT_PREFIX}${eventId}`;
    await storage.set({ [`${EVENT_PREFIX}${eventId}`]: value });
    const originalSet = storage.set.bind(storage);
    let releaseLocal!: () => void; let beganLocal!: () => void; let beganStatus!: () => void;
    const localStarted = new Promise<void>((resolve) => { beganLocal = resolve; });
    const statusStarted = new Promise<void>((resolve) => { beganStatus = resolve; });
    const localGate = new Promise<void>((resolve) => { releaseLocal = resolve; });
    storage.set = async (items) => {
      if ((items[receiptKey] as { status?: string } | undefined)?.status === "local_saved") {
        beganLocal(); await localGate;
      }
      await originalSet(items);
    };
    const outbox = new NativeOutbox(storage, async (message) => {
      const status = (message as { command: string }).command === "status";
      if (status) beganStatus();
      return { protocol_version: 1, ok: true, status: status ? "notion_confirmed" : "local_saved", event_id: eventId };
    });
    const draining = outbox.drain(); await localStarted;
    const checking = outbox.eventStatus(eventId); await statusStarted;
    // Let the remote receipt reach the storage boundary while the older write is held.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    releaseLocal(); await draining;
    expect(await checking).toMatchObject({ status: "notion_confirmed" });
    expect(storage.data[receiptKey]).toMatchObject({ status: "notion_confirmed" });
    expect(storage.data[`${EVENT_PREFIX}${eventId}`]).toBeUndefined();
  });
  it("replays the same event after a lost ACK/restart and removes web copy only after durable native receipt", async () => {
    const storage = new MemoryStorage(); const value = staged(); await storage.set({ [`${EVENT_PREFIX}${value.event.event_id}`]: value });
    const received: StagedEvent[] = [];
    const first = new NativeOutbox(storage, async (message) => { received.push(message as StagedEvent); throw new Error("SYNTHETIC_ACK_LOST_AFTER_SAVE"); });
    await first.drain(); expect(storage.data[`${EVENT_PREFIX}${value.event.event_id}`]).toBeDefined();
    const second = new NativeOutbox(storage, async (message) => { received.push(message as StagedEvent); return { protocol_version: 1, ok: true, status: "local_saved", event_id: value.event.event_id }; });
    await second.drain();
    expect(received.map((event) => event.event.event_id)).toEqual([value.event.event_id, value.event.event_id]);
    expect(storage.data[`${EVENT_PREFIX}${value.event.event_id}`]).toBeUndefined();
    expect(storage.data[`${RECEIPT_PREFIX}${value.event.event_id}`]).toMatchObject({ status: "local_saved" });
  });
  it.each([undefined, { protocol_version: 1, ok: false, status: "local_saved" }, { protocol_version: 1, ok: true, status: "local_saved", event_id: "different" }, { protocol_version: 1, ok: true, status: "saving" }])("retains event on missing, failed, malformed, or unbound response", async (response) => {
    const storage = new MemoryStorage(); const value = staged(); const key = `${EVENT_PREFIX}${value.event.event_id}`; await storage.set({ [key]: value });
    await new NativeOutbox(storage, async () => response).drain(); expect(storage.data[key]).toEqual(value);
  });
  it("retains durable event if recording the native receipt fails", async () => {
    const storage = new MemoryStorage(); const value = staged(); const key = `${EVENT_PREFIX}${value.event.event_id}`; await storage.set({ [key]: value }); storage.failWrite = true;
    await new NativeOutbox(storage, async () => ({ protocol_version: 1, ok: true, status: "local_saved", event_id: value.event.event_id })).drain(); expect(storage.data[key]).toEqual(value);
  });
  it("does not forward corrupt persisted content or an event stored under another ID", async () => {
    const storage = new MemoryStorage(); storage.data = { [`${EVENT_PREFIX}wrong`]: staged(), [`${EVENT_PREFIX}${staged().event.event_id}`]: { ...staged(), text: "synthetic" } };
    const send = vi.fn(async () => undefined); await new NativeOutbox(storage, send).drain(); expect(send).not.toHaveBeenCalled(); expect(Object.keys(storage.data)).toHaveLength(2);
  });
  it("serializes concurrent drains; status promotes only a matching verified Notion receipt", async () => {
    const storage = new MemoryStorage(); const value = staged(); await storage.set({ [`${EVENT_PREFIX}${value.event.event_id}`]: value });
    const send = vi.fn(async () => ({ protocol_version: 1, ok: true, status: "notion_confirmed", event_id: value.event.event_id, ignored: "never-stored" }));
    const outbox = new NativeOutbox(storage, send); await Promise.all([outbox.drain(), outbox.drain()]); expect(send).toHaveBeenCalledTimes(1);
    expect(await outbox.eventStatus(value.event.event_id)).toEqual({ protocol_version: 1, ok: true, status: "notion_confirmed", event_id: value.event.event_id });
    expect(storage.data[`${RECEIPT_PREFIX}${value.event.event_id}`]).not.toHaveProperty("ignored");
  });
  it("keeps an already verified receipt if an older response arrives after confirmation", async () => {
    const storage = new MemoryStorage(); const eventId = staged().event.event_id;
    await storage.set({ [`${RECEIPT_PREFIX}${eventId}`]: { protocol_version: 1, ok: true, status: "notion_confirmed", event_id: eventId } });
    const outbox = new NativeOutbox(storage, async () => ({ protocol_version: 1, ok: true, status: "local_saved", event_id: eventId }));
    expect(await outbox.eventStatus(eventId)).toMatchObject({ status: "notion_confirmed" });
  });
});
