import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  TerminalOutputStore,
  type StoredOutputChunk,
  type TerminalOutputPersistence,
} from "./output-store.js";
import type { TerminalEventBus } from "../event-bus.js";

type EmittedEvent = { event: string; data: Record<string, unknown>; id?: string };

class InMemoryOutputPersistence implements TerminalOutputPersistence {
  readonly chunks = new Map<string, Map<number, Buffer>>();
  readonly statBumps: Array<{ sessionId: string; totalDelta: number; storedDelta: number }> = [];

  private sessionChunks(sessionId: string): Map<number, Buffer> {
    let chunks = this.chunks.get(sessionId);
    if (!chunks) {
      chunks = new Map();
      this.chunks.set(sessionId, chunks);
    }
    return chunks;
  }

  private sorted(sessionId: string): StoredOutputChunk[] {
    return [...this.sessionChunks(sessionId).entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([byteOffset, data]) => ({ byteOffset, data }));
  }

  async pruneOldestChunks(sessionId: string, minBytesToRemove: number): Promise<number> {
    const chunks = this.sessionChunks(sessionId);
    let removed = 0;
    for (const { byteOffset, data } of this.sorted(sessionId)) {
      if (removed >= minBytesToRemove) {
        break;
      }
      chunks.delete(byteOffset);
      removed += data.length;
    }
    return removed;
  }

  async insertChunk(sessionId: string, byteOffset: number, data: Buffer): Promise<boolean> {
    const chunks = this.sessionChunks(sessionId);
    if (chunks.has(byteOffset)) {
      return false;
    }
    chunks.set(byteOffset, Buffer.from(data));
    return true;
  }

  async bumpOutputStats(
    sessionId: string,
    args: { totalDelta: number; storedDelta: number; at: Date },
  ): Promise<void> {
    this.statBumps.push({ sessionId, totalDelta: args.totalDelta, storedDelta: args.storedDelta });
  }

  async getStoredOutputBytes(sessionId: string): Promise<number> {
    return this.sorted(sessionId).reduce((acc, chunk) => acc + chunk.data.length, 0);
  }

  async findCoveringChunk(sessionId: string, offset: number): Promise<StoredOutputChunk | null> {
    const candidates = this.sorted(sessionId).filter((chunk) => chunk.byteOffset <= offset);
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }

  async listChunksFrom(
    sessionId: string,
    fromOffset: number,
    limit: number,
    beforeOffset?: number,
  ): Promise<StoredOutputChunk[]> {
    return this.sorted(sessionId)
      .filter(
        (chunk) =>
          chunk.byteOffset >= fromOffset &&
          (beforeOffset === undefined || chunk.byteOffset < beforeOffset),
      )
      .slice(0, limit);
  }

  async listTailChunks(
    sessionId: string,
    beforeOffset: number | null,
    limit: number,
  ): Promise<StoredOutputChunk[]> {
    return this.sorted(sessionId)
      .filter((chunk) => beforeOffset === null || chunk.byteOffset < beforeOffset)
      .reverse()
      .slice(0, limit);
  }

  async getStoredEndOffset(sessionId: string): Promise<number> {
    const chunks = this.sorted(sessionId);
    if (chunks.length === 0) {
      return 0;
    }
    return Math.max(...chunks.map((chunk) => chunk.byteOffset + chunk.data.length));
  }
}

function createLogger() {
  return {
    info() {
      // noop
    },
    warn() {
      // noop
    },
    error() {
      // noop
    },
  } as never;
}

function createStore(events: EmittedEvent[] = []) {
  const persistence = new InMemoryOutputPersistence();
  const store = new TerminalOutputStore(
    createLogger(),
    {
      emit(_sessionId: string, event: EmittedEvent) {
        events.push(event);
      },
    } as unknown as TerminalEventBus,
    persistence,
  );
  return { store, persistence };
}

async function ingest(
  store: TerminalOutputStore,
  sessionId: string,
  byteOffset: number,
  text: string,
) {
  await store.handleTerminalOutput(sessionId, {
    data: Buffer.from(text, "utf-8").toString("base64"),
    byte_offset: byteOffset,
  });
}

test("ingest is idempotent on (session_id, byte_offset): redelivery neither re-counts nor re-emits", async () => {
  const events: EmittedEvent[] = [];
  const { store, persistence } = createStore(events);

  await ingest(store, "sess_a", 0, "hello ");
  await ingest(store, "sess_a", 6, "world");
  // At-least-once redelivery of both chunks.
  await ingest(store, "sess_a", 0, "hello ");
  await ingest(store, "sess_a", 6, "world");

  assert.equal(persistence.statBumps.length, 2);
  assert.deepEqual(
    persistence.statBumps.map((bump) => bump.totalDelta),
    [6, 5],
  );
  assert.equal(events.length, 2);
  assert.equal(events[0]?.event, "terminal.output");
  assert.deepEqual(events[0]?.data, {
    data: Buffer.from("hello ", "utf-8").toString("base64"),
    byte_offset: 0,
  });
  assert.equal("seq" in (events[0]?.data ?? {}), false);
  // SSE event id is the stringified end offset (the resume cursor).
  assert.equal(events[0]?.id, "6");
  assert.equal(events[1]?.id, "11");

  assert.equal(await store.getStoredEndOffset("sess_a"), 11);
});

test("readRange from a mid-chunk since_offset includes the covering chunk with leading bytes trimmed", async () => {
  const { store } = createStore();
  await ingest(store, "sess_a", 0, "0123456789");
  await ingest(store, "sess_a", 10, "abcdefghij");

  const read = await store.readRange("sess_a", { startOffset: 4, maxBytes: 1024 });
  assert.equal(read.data.toString("utf-8"), "456789abcdefghij");
  assert.equal(read.startOffset, 4);
  assert.equal(read.endOffset, 20);
  assert.equal(read.truncated, false);
  assert.equal(read.nextOffset, null);
});

test("readRange slices an explicit byte range across chunk boundaries", async () => {
  const { store } = createStore();
  await ingest(store, "sess_a", 0, "0123456789");
  await ingest(store, "sess_a", 10, "abcdefghij");
  await ingest(store, "sess_a", 20, "KLMNOPQRST");

  const read = await store.readRange("sess_a", { startOffset: 7, endOffset: 23, maxBytes: 1024 });
  assert.equal(read.data.toString("utf-8"), "789abcdefghijKLM");
  assert.equal(read.startOffset, 7);
  assert.equal(read.endOffset, 23);
  assert.equal(read.truncated, false);
});

test("readRange paginates large ranges and reports explicit truncation with a continuation offset", async () => {
  const { store } = createStore();
  // 300 chunks of 4 bytes: forces multiple internal pagination batches.
  for (let index = 0; index < 300; index += 1) {
    await ingest(store, "sess_a", index * 4, `x${String(index % 10)}y_`.slice(0, 4));
  }

  const first = await store.readRange("sess_a", { startOffset: 0, maxBytes: 500 });
  assert.equal(first.data.length, 500);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 500);

  // The continuation loop serves the remainder of the requested range.
  const second = await store.readRange("sess_a", { startOffset: first.nextOffset!, maxBytes: 10_000 });
  assert.equal(second.data.length, 1200 - 500);
  assert.equal(second.truncated, false);
  assert.equal(second.endOffset, 1200);
});

test("tailOutput serves the byte budget across many rows without a fixed row cap", async () => {
  const { store } = createStore();
  for (let index = 0; index < 250; index += 1) {
    await ingest(store, "sess_a", index * 4, "abcd");
  }

  const tail = await store.tailOutput("sess_a", 600);
  assert.equal(tail.data.length, 600);
  assert.equal(tail.endOffset, 1000);
  assert.equal(tail.startOffset, 400);
  assert.equal(tail.totalBytesStored, 1000);
});

test("tailOutput trims mid-chunk when the budget lands inside a chunk", async () => {
  const { store } = createStore();
  await ingest(store, "sess_a", 0, "0123456789");
  await ingest(store, "sess_a", 10, "abcdefghij");

  const tail = await store.tailOutput("sess_a", 13);
  assert.equal(tail.data.toString("utf-8"), "789abcdefghij");
  assert.equal(tail.startOffset, 7);
  assert.equal(tail.endOffset, 20);
});

test("readRange returns an empty result and no truncation for offsets past the stored end", async () => {
  const { store } = createStore();
  await ingest(store, "sess_a", 0, "0123456789");

  const read = await store.readRange("sess_a", { startOffset: 50, maxBytes: 100 });
  assert.equal(read.data.length, 0);
  assert.equal(read.truncated, false);
  assert.equal(read.nextOffset, null);
});

test("retention cap prunes oldest chunks but never mutes new output", async () => {
  const { config } = await import("../../config.js");
  const originalCap = config.terminalOutputSoftCapBytes;
  (config as { terminalOutputSoftCapBytes: number }).terminalOutputSoftCapBytes = 30;
  try {
    const events: EmittedEvent[] = [];
    const { store, persistence } = createStore(events);

    // 5 chunks x 10 bytes = 50 bytes against a 30-byte cap.
    let offset = 0;
    for (let i = 0; i < 5; i++) {
      await ingest(store, "sess_cap", offset, `chunk-${i}--`.slice(0, 10));
      offset += 10;
    }

    // EVERY chunk was emitted to SSE (the old lifetime cap silently muted
    // sessions once total output crossed it — the bricked-display regression).
    const outputEvents = events.filter((e) => e.event === "terminal.output");
    assert.equal(outputEvents.length, 5, "post-cap output must still emit");

    // Retention holds: oldest rows pruned, newest retained, total <= cap.
    const retained = await persistence.getStoredOutputBytes("sess_cap");
    assert.ok(retained <= 30, `retained ${retained} exceeds cap`);
    const tail = await store.tailOutput("sess_cap", 1000);
    assert.ok(tail.data.toString("utf8").includes("chunk-4"), "newest chunk retained");
    assert.ok(!tail.data.toString("utf8").includes("chunk-0"), "oldest chunk pruned");
  } finally {
    (config as { terminalOutputSoftCapBytes: number }).terminalOutputSoftCapBytes = originalCap;
  }
});
