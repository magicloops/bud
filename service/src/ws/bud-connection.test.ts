import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import { BudConnection } from "./bud-connection.js";

function createServer() {
  return {
    log: {
      info() {
        // noop
      },
      warn() {
        // noop
      },
      error() {
        // noop
      },
    },
  };
}

function createSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    on() {
      // noop
    },
    send() {
      // noop
    },
    close() {
      // noop
    },
  };
}

test("handleOfflineTransition rejects pending waits before suspending Bud-owned sessions", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(db, "update", () => ({
    set() {
      return {
        async where() {
          return undefined;
        },
      };
    },
  }) as never);

  const calls: string[] = [];
  const connection = new BudConnection(
    createServer() as never,
    createSocket() as never,
    {
      async rejectPendingRequestsForBud() {
        calls.push("rejectPendingRequestsForBud");
      },
      async clearCachesForBud() {
        calls.push("clearCachesForBud");
      },
      async clearEventBuffersForBud() {
        calls.push("clearEventBuffersForBud");
      },
      async suspendSessionsForBud() {
        calls.push("suspendSessionsForBud");
      },
      async emitBudOfflineForSessions() {
        calls.push("emitBudOfflineForSessions");
      },
    } as never,
  );
  const handleOfflineTransition = Reflect.get(connection, "handleOfflineTransition") as (
    budId: string,
  ) => Promise<void>;

  await handleOfflineTransition("bud-1");

  assert.deepEqual(calls, [
    "rejectPendingRequestsForBud",
    "clearCachesForBud",
    "clearEventBuffersForBud",
    "suspendSessionsForBud",
    "emitBudOfflineForSessions",
  ]);
});
