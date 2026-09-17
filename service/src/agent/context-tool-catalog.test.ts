import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AgentService } from "./agent-service.js";
import { BrowserToolExecutor } from "./browser-tool-executor.js";
import { BrowserBroker } from "../browser/broker.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";
import { sessions, type SessionTracker } from "../ws/session-trackers.js";
import type { AgentExecutionHooks } from "./execution-lifecycle.js";

test("browser catalog is available for durable execution and idle accounting without dispatch", async t => {
  const budId = randomUUID();
  sessions.set(budId, {
    budId, sessionId: "device",
    browserCapability: { version: 1, available: true, boot_id: "boot", managed: true, profile_mode: "ephemeral" },
    socket: { readyState: 1, OPEN: 1, send() { assert.fail("catalog lookup must not dispatch"); } },
  } as unknown as SessionTracker);
  t.after(() => sessions.delete(budId));
  const executor = new BrowserToolExecutor(new BrowserBroker(), async () => true);
  const makeService = (durable: boolean) => new AgentService(
    {} as never, {} as never, { info() {}, warn() {}, error() {} } as never,
    false, false, durable ? {} as never : undefined, false, false, false, executor,
  );
  const environment = buildAgentEnvironmentSnapshot({ budId, online: true, lastSeenAt: null });
  const hooks: AgentExecutionHooks = {
    invocation: { id: "invocation", fence: 1, workerId: "worker" },
    async checkpoint() {}, async beforeTool() {}, async afterTool() {},
  };
  const service = makeService(true);
  const live = await service.getContextTools(environment, "thread", "owner", hooks);
  const idle = await service.getContextTools(environment, "thread", "owner");
  assert.deepEqual(live, idle);
  assert.ok(live.some(tool => tool.name === "browser_open"));
  for (const tools of [
    await makeService(false).getContextTools(environment, "thread", "owner"),
    await service.getContextTools(environment, "thread", "owner", { ...hooks, invocation: undefined }),
    await service.getContextTools(buildAgentEnvironmentSnapshot({ budId, online: false, lastSeenAt: null }), "thread", "owner", hooks),
  ]) assert.equal(tools.some(tool => tool.name === "browser_open"), false);
  sessions.delete(budId);
  assert.equal((await service.getContextTools(environment, "thread", "owner", hooks))
    .some(tool => tool.name === "browser_open"), false);
});
