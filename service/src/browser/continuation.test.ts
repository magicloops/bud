import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import * as schema from "../db/schema.js";
import { InvocationRepository } from "../agent/invocation-repository.js";
import { BrowserRepository } from "./repository.js";
import { BrowserToolWait } from "../agent/browser-tool-executor.js";
import { BrowserResourceRepository } from "./resource-repository.js";
import { AgentConversationLoader } from "../agent/conversation-loader.js";
import type { CanonicalMessage } from "../llm/types.js";
import { BrowserControlRepository } from "./control-repository.js";

test(
  "durable browser wait survives restart and pairs multi-call continuations once",
  { skip: process.env.BUD_DATA_DB_TEST !== "1" },
  async (t) => {
    assert.ok(
      ["localhost", "127.0.0.1"].includes(new URL(config.databaseUrl).hostname),
    );
    const name = `browser_continuation_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: 3,
      options: `-c search_path=${name}`,
    });
    t.after(async () => {
      await pool.query(`drop schema ${name} cascade`);
      await pool.end();
    });
    await pool.query(`create schema ${name}`);
    // Isolate worker tables from the running development service. Migrations/FKs
    // are separately exercised by repository.test.ts; LIKE does not clone FKs.
    const tables = (
      await pool.query(
        "select tablename from pg_tables where schemaname='public'",
      )
    ).rows;
    for (const { tablename } of tables) {
      if (!/^[a-z_]+$/.test(tablename)) continue;
      await pool.query(
        `create table ${name}.${tablename} (like public.${tablename} including all)`,
      );
    }
    const database = drizzle(pool, { schema });
    const repo = new InvocationRepository(database);
    const controls = new BrowserControlRepository(pool);
    await database.insert(schema.budTable).values({
      budId: "bud",
      name: "Fixture",
      os: "test",
      arch: "test",
      createdByUserId: "alice",
    });
    for (const provider of [
      "openai",
      "anthropic",
      "ds4",
      "cancel",
      "user-tool",
      "return-control",
      "restart",
      "repl", "repl-cancel", "repl-restart",
      "stop-browser",
    ]) {
      const repl = provider.startsWith("repl");
      const restarting = provider === "restart" || provider === "repl-restart";
      const canceling = provider === "cancel" || provider === "repl-cancel";
      const returnControl = repl || provider === "return-control" || provider === "user-tool";
      const userTakeover = returnControl;
      const idle = false;
      const thread = randomUUID();
      await database
        .insert(schema.threadTable)
        .values({ threadId: thread, budId: "bud", createdByUserId: "alice" });
      await repo.admit({
        owner: "alice",
        threadId: thread,
        origin: "human",
        idempotencyKey: thread,
        text: "Use browser",
        model: "fixture",
        reasoningEffort: "none",
      });
      const lease = await repo.claim("worker", "alice");
      assert.ok(lease);
      await repo.start(lease);
      await pool.query("update agent_invocation set work_started_at=clock_timestamp()-interval '2 seconds' where id=$1", [lease.id]);
      const callId = randomUUID(),
        clientId = randomUUID(),
        llmId = randomUUID(),
        sessionId = `browser_${randomUUID()}`;
      if (!userTakeover)
        await repo.recordAction(lease, callId, "browser_request_handoff");
      const resources = new BrowserResourceRepository(pool);
      const resource = await resources.ensure("alice", "bud");
      await database.insert(schema.browserSessionTable).values({
        browserId: resource.id,
        id: sessionId,
        threadId: thread,
        budId: "bud",
        createdByUserId: "alice",
        generation: "generation",
        bootId: "boot",
      });

      await database.insert(schema.llmCallTable).values({
        llmCallId: llmId,
        threadId: thread,
        turnId: lease.turnId,
        stepIndex: 0,
        provider,
        model: "fixture",
        requestMode: provider,
        createdByUserId: "alice",
      });
      if (!idle)
        await database.insert(schema.llmCallItemTable).values(
          [
            {
              id: callId,
              name: repl ? "browser_exec" : userTakeover
                ? "browser_exec"
                : "browser_request_handoff",
              input: userTakeover ? {code:"saved++"} : { reason: "Sign in" },
            },
            {
              id: `later-${callId}`,
              name: "browser_exec",
              input: {code:"saved++"},
            },
          ].map((block, sequence) => ({
            llmCallItemId: randomUUID(),
            llmCallId: llmId,
            threadId: thread,
            direction: "output",
            kind: "tool_use",
            sequence,
            toolCallId: block.id,
            canonicalPayload: { type: "tool_use", ...block },
            createdByUserId: "alice",
          })),
        );
      if (returnControl) {
        await pool.query("update browser_resource set control_state='human_private',private_content=true,control_session_id=$1 where bud_id='bud'",[sessionId]);
        await repo.recordAction(lease,callId,"browser_exec");
        await assert.rejects(new BrowserRepository(pool).prepare({ownerUserId:"alice",threadId:thread,budId:"bud",
          turnId:lease.turnId, invocation:{id:lease.id,fence:lease.fence,workerId:lease.workerId!},
          callId,waitClientId:clientId,signal:new AbortController().signal},"boot",{action:"exec",code:"saved++"}),BrowserToolWait);
        assert.equal((await pool.query("select evidence->>'browser_dispatched' as dispatched from agent_invocation_action where invocation_id=$1",[lease.id])).rows[0].dispatched,"false");
      }
      const handoff = returnControl ? null : await controls.requestAgent({
            ownerUserId: "alice",
            threadId: thread,
            budId: "bud",
            turnId: lease.turnId,
            invocation: {
              id: lease.id,
              fence: lease.fence,
              workerId: lease.workerId!,
            },
            signal: new AbortController().signal,
            directive: {
              type: "tool_call",
              tool: "browser_request_handoff",
              callId,
              args: { reason: "Sign in" },
            },
            clientId,
          });
      let paused = await controls.prepare(
        "alice",
        sessionId,
        "boot",
        (await controls.get("alice", sessionId)).revision,
        "pause",
        { action: "control", operation: "pause" },
        "paused",
      );
      if (returnControl) { /* Already atomically parked at admission. */ }
      else if (userTakeover)
        assert.ok(
          await repo.parkUserBrowserHandoff(
            lease,
            idle ? undefined : { callId, tool: "browser_exec" },
          ),
        );
      else
        await repo.parkBrowserHandoff(
          lease,
          callId,
          (handoff as { id: string }).id,
        );
      const timingAtPark = (await pool.query("select work_duration_ms,work_started_at from agent_invocation where id=$1", [lease.id])).rows[0];
      assert.equal(timingAtPark.work_started_at, null);
      assert.ok(Number(timingAtPark.work_duration_ms) >= 2000);
      await assert.rejects(repo.heartbeat(lease), /lease_lost/);
      assert.equal(await repo.claim("other", "alice"), null);
      const recovered = await new InvocationRepository(
        database,
      ).pendingBrowserHandoffForThread("alice", thread);
      assert.ok(recovered?.pending_tool.client_id);
      if (!userTakeover)
        assert.equal(recovered?.pending_tool.client_id, clientId);
      assert.equal(
        await repo.pendingBrowserHandoffForThread("bob", thread),
        null,
      );
      assert.ok(await controls.pending("alice", sessionId));
      {
        paused = await controls.prepare("alice", sessionId, "boot", paused.session.revision,
          "acquire", { action: "control", operation: "acquire" }, "human_private");
      }
      if (returnControl) {
        await repo.admit({owner:"alice",threadId:thread,origin:"human",idempotencyKey:`${thread}-second`,text:"Browse too",model:"fixture",reasoningEffort:"none"});
        const second=await repo.claim("second","alice"); assert.ok(second); await repo.start(second);
        await repo.recordAction(second,"second-call","browser_exec");
        await assert.rejects(new BrowserRepository(pool).prepare({ownerUserId:"alice",threadId:thread,budId:"bud",
          turnId:second.turnId,invocation:{id:second.id,fence:second.fence,workerId:second.workerId!},
          callId:"second-call",waitClientId:randomUUID(),signal:new AbortController().signal},"boot",{action:"exec",code:"await handle.click()"}),BrowserToolWait);
        assert.equal((await repo.pendingBrowserWaitsForThread("alice",thread)).length,2);
        await repo.requestCancel("alice",second.id);
        assert.equal((await repo.pendingBrowserWaitsForThread("alice",thread)).length,1);
      }
      // Private browser work must not reserve the entire conversation. A newer
      // chat can execute, while the original handoff remains durably parked.
      const followup = await repo.admit({ owner: "alice", threadId: thread,
        origin: "human", idempotencyKey: `${thread}-followup`, text: "Explain this while I sign in",
        model: "fixture", reasoningEffort: "none" });
      const chatting = await repo.claim("chat-worker", "alice");
      assert.equal(chatting?.id, followup.invocation.id);
      assert.ok(chatting);
      await repo.start(chatting);
      assert.deepEqual(await repo.prepareQuestionContinuation(chatting), []);
      assert.equal(await repo.claim("concurrent", "alice"), null);
      if (canceling) await repo.requestCancel("alice", lease.id);
      if (provider === "stop-browser") {
        const current = (await resources.get("alice", "bud"))!;
        const stopping = await resources.requestLifecycle("alice", "bud", current.revision, "stop");
        await resources.acknowledgeLifecycle(stopping);
        await repo.recoverExpired("alice");
        assert.equal((await repo.findForThread("alice", thread, lease.id))?.status, "canceled", "stop stranded a browser wait");
        assert.equal((await repo.findForThread("alice", thread, chatting.id))?.status, "running", "stop canceled unrelated chat");
        await repo.finish(chatting, "succeeded", "done");
        continue;
      }
      if (restarting) {
        await pool.query("update browser_session set state='interrupted' where id=$1",[sessionId]);
        await repo.recoverExpired("alice");
        assert.equal((await repo.findForThread("alice",thread,lease.id))?.status,"waiting_for_user");
        const candidate=await controls.prepareEnsure("alice",sessionId,"new-boot",false);
        await controls.acknowledgeRecovery(candidate.resource,candidate.session);
      } else {
      let returning = await controls.prepare(
        "alice",
        sessionId,
        "boot",
        paused.session.revision,
        "return",
        { action: "control", operation: "prepare_return" },
        "resume_pending",
      );
      returning = await controls.prepare("alice", sessionId, "boot", returning.session.revision,
        "finish", { action: "control", operation: "finish_return" }, "resume_pending");
      await controls.returned("alice", sessionId, returning.session.revision);
      }
      // Return does not run two model loops in the same conversation.
      assert.equal(await repo.claim("while-chatting", "alice"), null);
      await repo.finish(chatting, "succeeded", "done");
      if (canceling) {
        assert.equal(await repo.claim("after-cancel", "alice"), null);
        continue;
      }
      const resumed = await new InvocationRepository(database).claim(
        "resumed",
        "alice",
      );
      assert.ok(resumed);
      assert.equal(resumed.id, lease.id);
      assert.equal(resumed.turnId, lease.turnId);
      await repo.start(resumed);
      await pool.query("update agent_invocation set work_started_at=clock_timestamp()-interval '3 seconds' where id=$1", [resumed.id]);
      const results = await repo.prepareQuestionContinuation(resumed);
      assert.equal(results.length, idle ? 1 : 2);
      if (idle) {
        assert.equal(results[0].role, "system");
        assert.match(results[0].content, /Observe the current page/);
      }
      if (!idle) {
        if (userTakeover)
          assert.match(
            results[0].content,
            /not_executed_due_to_browser_handoff/,
          );
        else {
          assert.equal(results[0].clientId, clientId);
          assert.equal(JSON.parse(results[0].content).ok, provider !== "restart");
          if(restarting) assert.equal(JSON.parse(results[0].content).error,"browser_handoff_interrupted");
        }
        assert.match(results[1].content, /not_executed_due_to_browser_handoff/);
        for (const result of userTakeover ? results : results.slice(1)) {
          const payload = JSON.parse(result.content);
          assert.equal(payload.ok, false, "return must not claim the queued action ran");
          assert.equal(payload.executed, false);
          if (repl) {
            assert.equal(payload.execution_state, "not_executed");
            assert.match(payload.summary, /do not replay the queued cell/);
          }
          for (const toolUseFromProviderLedger of [true, false]) {
            const replay: CanonicalMessage[] = [];
            const loader = new AgentConversationLoader();
            Reflect.get(loader, "appendStoredMessage").call(loader,
              (message: CanonicalMessage) => replay.push(message), result, { toolUseFromProviderLedger });
            const blocks = replay.at(-1)?.content;
            assert.ok(Array.isArray(blocks));
            assert.equal(blocks[0]?.type, "tool_result");
            assert.equal(blocks[0]?.type === "tool_result" && blocks[0].content, result.content);
          }
          assert.deepEqual(payload.handoff, {
            status: restarting ? "interrupted" : "returned", control_state: "agent", private_content: false,
          });
        }
      }
      assert.deepEqual(await repo.prepareQuestionContinuation(resumed), []);
      await repo.finish(resumed, "succeeded", "done");
      const completed = (await pool.query("select work_duration_ms,work_started_at from agent_invocation where id=$1", [resumed.id])).rows[0];
      assert.equal(completed.work_started_at, null);
      assert.ok(Number(completed.work_duration_ms) >= Number(timingAtPark.work_duration_ms) + 3000);
    }
  },
);
