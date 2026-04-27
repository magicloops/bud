import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import { grpcSessions, type GrpcSessionTracker } from "../transport/grpc-daemon-router.js";
import { sessions as websocketSessions } from "../ws/session-trackers.js";
import { finalizeGrpcSessionTracker } from "./control-gateway.js";

function makeLogger() {
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
  };
}

function makeCall(): GrpcSessionTracker["call"] {
  return {
    destroyed: false,
    end() {
      // noop
    },
  } as GrpcSessionTracker["call"];
}

function makeTerminalSessionManager(calls: string[]) {
  return {
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
  };
}

test("finalizeGrpcSessionTracker closes durable rows and runs offline side effects", async (t) => {
  t.after(() => {
    mock.restoreAll();
    grpcSessions.clear();
    websocketSessions.clear();
  });

  const closedTransports: unknown[] = [];
  const closedDevices: unknown[] = [];
  mock.method(DaemonStateStore.prototype, "closeTransportSession", async (args: unknown) => {
    closedTransports.push(args);
  });
  mock.method(DaemonStateStore.prototype, "closeDeviceSession", async (args: unknown) => {
    closedDevices.push(args);
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
  const tracker: GrpcSessionTracker = {
    budId: "bud-1",
    sessionId: "s-1",
    deviceSessionId: "ds-1",
    transportSessionId: "ts-1",
    drainState: "active",
    lastHeartbeat: Date.now(),
    call: makeCall(),
    timeout: setTimeout(() => undefined, 60_000),
  };
  grpcSessions.set(tracker.budId, tracker);

  await finalizeGrpcSessionTracker({
    tracker,
    reason: "grpc_control_gateway_shutdown",
    markDraining: true,
    terminalSessionManager: makeTerminalSessionManager(calls) as never,
    logger: makeLogger() as never,
  });

  assert.equal(grpcSessions.has("bud-1"), false);
  assert.equal(tracker.finalized, true);
  assert.equal(tracker.drainState, "draining");
  assert.equal(tracker.timeout, undefined);
  assert.deepEqual(closedTransports, [
    {
      transportSessionId: "ts-1",
      reason: "grpc_control_gateway_shutdown",
      markUnknown: undefined,
      markDraining: true,
    },
  ]);
  assert.deepEqual(closedDevices, [
    {
      deviceSessionId: "ds-1",
      reason: "grpc_control_gateway_shutdown",
      markDraining: true,
    },
  ]);
  assert.deepEqual(calls, [
    "rejectPendingRequestsForBud",
    "clearCachesForBud",
    "clearEventBuffersForBud",
    "suspendSessionsForBud",
    "emitBudOfflineForSessions",
  ]);
});
