import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyBaseLogger } from "fastify";
import type { SseEvent } from "./event-bus.js";
import type { SessionEventBus } from "./event-bus.js";
import { SessionManager } from "./session-manager.js";

const noopLogger: FastifyBaseLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  debug: () => {},
  child: () => noopLogger,
  level: "info"
};

const createEventRecorder = () => {
  const emitted: Array<{ channelId: string; event: SseEvent }> = [];
  return {
    emitted,
    bus: {
      emit: (channelId: string, event: SseEvent) => {
        emitted.push({ channelId, event });
      }
    } as unknown as SessionEventBus
  };
};

const createFakeDb = () => ({
  insert: () => ({
    values: () => ({
      onConflictDoNothing: () => ({
        returning: async () => []
      })
    })
  }),
  update: () => ({
    set: () => ({
      where: async () => {}
    })
  }),
  query: {
    threadTable: { findFirst: async () => null },
    budTable: { findFirst: async () => null }
  }
});

const baseContext = () => ({
  sessionId: "sess_test",
  budId: "bud_1",
  threadId: "thread_1",
  backend: "pty" as const,
  attachToken: "sess_att_test",
  status: "open" as const,
  writer: null,
  spectators: new Set(),
  logsBytes: 0,
  logTruncated: false,
  bytesOut: 0,
  bytesIn: 0,
  lastActivity: Date.now()
});

class FakeSocket {
  public closeCalled = false;
  public readyState = 1;
  on() {
    // noop
  }
  send() {
    // noop
  }
  close() {
    this.closeCalled = true;
  }
}

test("takeWriter rotates attach token and detaches old writer", () => {
  const { bus } = createEventRecorder();
  const manager = new SessionManager(noopLogger, bus as never);
  const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
  const fakeSocket = new FakeSocket();
  sessions.set("sess_test", {
    ...baseContext(),
    writer: fakeSocket
  });

  const result = manager.takeWriter("sess_test");
  assert.equal(result.ok, true);
  assert.ok(result.attachToken);
  assert.notEqual(result.attachToken, "sess_att_test");
  assert.equal(fakeSocket.closeCalled, true);
  const ctx = sessions.get("sess_test") as { writer: FakeSocket | null; attachToken: string };
  assert.equal(ctx.writer, null);
  assert.equal(ctx.attachToken, result.attachToken);
});

test("handleSessionOutput marks truncated and emits SSE status when soft cap exceeded", async () => {
  const recorder = createEventRecorder();
  const manager = new SessionManager(noopLogger, recorder.bus as never, {
    db: createFakeDb() as never,
    logLimit: 8
  });
  const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
  sessions.set("sess_test", {
    ...baseContext(),
    writer: null
  });

  const payload = {
    session_id: "sess_test",
    seq: 1,
    data: Buffer.from("1234567890").toString("base64")
  };
  await manager.handleSessionOutput(payload);
  const ctx = sessions.get("sess_test") as { logTruncated: boolean; logsBytes: number };
  assert.equal(ctx.logTruncated, true);
  assert.equal(ctx.logsBytes, 8);
  const statusEvent = recorder.emitted.find(
    (evt) => evt.channelId === "sess_test" && evt.event.event === "session.status"
  );
  assert.ok(statusEvent);
  assert.equal(statusEvent?.event.data.truncated, true);
});
