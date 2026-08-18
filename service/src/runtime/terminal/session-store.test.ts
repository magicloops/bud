import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../../db/client.js";
import { TerminalSessionStore } from "./session-store.js";

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

function createSessionRow(sessionId: string) {
  return {
    sessionId,
    threadId: "11111111-1111-1111-1111-111111111111",
    budId: "bud-1",
    instanceId: null,
    state: "pending",
    shell: null,
    cwd: null,
    cols: 200,
    rows: 50,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    startedAt: null,
    lastInputAt: null,
    lastOutputAt: null,
    lastActivityAt: null,
    closedAt: null,
    totalInputBytes: 0,
    totalOutputBytes: 0,
    outputLogBytes: 0,
    stateSnapshot: null,
    tenantId: null,
    createdByUserId: "user-1",
  };
}

test("ensureSessionRecordForThread returns the concurrent winner after an active-session uniqueness conflict", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const store = new TerminalSessionStore(createLogger());
  let lookupCount = 0;

  Reflect.set(store, "getSessionForThread", async () => {
    lookupCount += 1;
    return lookupCount === 1
      ? null
      : {
          sessionId: "sess_existing",
          threadId: "11111111-1111-1111-1111-111111111111",
          budId: "bud-1",
          instanceId: null,
          state: "pending",
          cols: 200,
          rows: 50,
          cwd: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          startedAt: null,
          lastActivityAt: null,
          outputLogBytes: 0,
        };
  });

  mock.method(db, "insert", () => ({
    values() {
      return {
        async returning() {
          throw { code: "23505" };
        }
      };
    }
  }) as never);

  const result = await store.ensureSessionRecordForThread(
    "11111111-1111-1111-1111-111111111111",
    "bud-1",
    "user-1",
  );

  assert.equal(result.created, false);
  assert.equal(result.session.sessionId, "sess_existing");
});

test("concurrent create recovers when the 23505 hides inside a wrapped cause", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const store = new TerminalSessionStore(createLogger());
  // First lookup misses (both callers race past it); the post-conflict
  // lookup finds the winner.
  let lookups = 0;
  Reflect.set(store, "getSessionForThread", async () => {
    lookups += 1;
    return lookups === 1 ? null : rowToSessionLike("sess_winner");
  });

  // Drizzle-style wrapping: the pg unique violation sits on `cause`, not the
  // top-level error (the regression that turned this benign race into 500s).
  mock.method(db, "insert", () => ({
    values() {
      return {
        async returning() {
          const pgError = Object.assign(new Error("duplicate key value"), { code: "23505" });
          throw Object.assign(new Error("Failed query: insert into terminal_session"), {
            name: "DrizzleQueryError",
            cause: pgError,
          });
        }
      };
    }
  }) as never);

  const result = await store.ensureSessionRecordForThread(
    "11111111-1111-1111-1111-111111111111",
    "bud-1",
    "user-1",
  );

  assert.equal(result.created, false);
  assert.equal(result.session.sessionId, "sess_winner");
});

function rowToSessionLike(sessionId: string) {
  const store = new TerminalSessionStore(createLogger());
  return Reflect.get(store, "rowToSession").call(store, createSessionRow(sessionId));
}

test("ensureSessionRecordForThread returns a created session when the insert wins", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const store = new TerminalSessionStore(createLogger());
  Reflect.set(store, "getSessionForThread", async () => null);

  mock.method(db, "insert", () => ({
    values() {
      return {
        async returning() {
          return [createSessionRow("sess_created")];
        }
      };
    }
  }) as never);

  const result = await store.ensureSessionRecordForThread(
    "11111111-1111-1111-1111-111111111111",
    "bud-1",
    "user-1",
  );

  assert.equal(result.created, true);
  assert.equal(result.session.sessionId, "sess_created");
});
