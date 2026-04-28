import assert from "node:assert/strict";
import test from "node:test";
import { createCompositeDaemonRouter } from "./composite-daemon-router.js";
import type {
  DaemonTransportPayload,
  DaemonTransportRouter,
  DaemonTransportStatus,
} from "./daemon-router.js";

function makeRouter(args: {
  kind: "websocket" | "h2_grpc";
  online?: boolean;
  sendResult?: boolean;
  throws?: boolean;
  calls: string[];
}): DaemonTransportRouter {
  return {
    getActiveBudIds() {
      return args.online === false ? [] : ["b_test"];
    },
    isBudOnline(budId: string) {
      return budId === "b_test" && args.online !== false;
    },
    sendFrameToBud(_budId: string, _payload: DaemonTransportPayload) {
      args.calls.push(args.kind);
      if (args.throws) {
        throw new Error(`${args.kind} send failed`);
      }
      return args.sendResult ?? true;
    },
    getTransportStatus(): DaemonTransportStatus {
      return {
        online: args.online !== false,
        transport_kind: args.online === false ? "none" : args.kind,
      };
    },
  };
}

test("composite control router falls back when preferred H2 refuses a frame", () => {
  const calls: string[] = [];
  const router = createCompositeDaemonRouter({
    routers: {
      h2_grpc: makeRouter({ kind: "h2_grpc", sendResult: false, calls }),
      websocket: makeRouter({ kind: "websocket", calls }),
    },
    orderedKinds: () => ["h2_grpc", "websocket"],
  });

  const sent = router.sendFrameToBud("b_test", { type: "terminal_ensure" });

  assert.equal(sent, true);
  assert.deepEqual(calls, ["h2_grpc", "websocket"]);
});

test("composite control router falls back when preferred H2 throws", () => {
  const calls: string[] = [];
  const router = createCompositeDaemonRouter({
    routers: {
      h2_grpc: makeRouter({ kind: "h2_grpc", throws: true, calls }),
      websocket: makeRouter({ kind: "websocket", calls }),
    },
    orderedKinds: () => ["h2_grpc", "websocket"],
  });

  const sent = router.sendFrameToBud("b_test", { type: "terminal_ensure" });

  assert.equal(sent, true);
  assert.deepEqual(calls, ["h2_grpc", "websocket"]);
});

test("composite control router reports unavailable when no carrier is online", () => {
  const calls: string[] = [];
  const router = createCompositeDaemonRouter({
    routers: {
      h2_grpc: makeRouter({ kind: "h2_grpc", online: false, calls }),
      websocket: makeRouter({ kind: "websocket", online: false, calls }),
    },
    orderedKinds: () => ["h2_grpc", "websocket"],
  });

  assert.equal(router.isBudOnline("b_test"), false);
  assert.equal(router.sendFrameToBud("b_test", { type: "terminal_ensure" }), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(router.getTransportStatus("b_test"), {
    online: false,
    transport_kind: "none",
  });
});
