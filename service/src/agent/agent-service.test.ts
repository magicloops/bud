import assert from "node:assert/strict";
import test from "node:test";
import { AgentService } from "./agent-service.js";

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
  };
}

test("cancelThread aborts the active turn and rejects pending terminal waits", async () => {
  const terminalCalls: Array<{ threadId: string; errorMessage: string }> = [];
  const service = new AgentService(
    {
      async rejectPendingRequestsForThread(threadId: string, errorMessage: string) {
        terminalCalls.push({ threadId, errorMessage });
      },
    } as never,
    {} as never,
    createLogger() as never,
    false,
    false,
  );

  const controller = new AbortController();
  (service as any).cancellations.set("thread-1", controller);

  await service.cancelThread("thread-1");

  assert.equal(controller.signal.aborted, true);
  assert.equal(service.isThreadActive("thread-1"), false);
  assert.deepEqual(terminalCalls, [
    {
      threadId: "thread-1",
      errorMessage: "agent_canceled",
    },
  ]);
});
