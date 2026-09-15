import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import * as schema from "../db/schema.js";
import { InvocationRepository } from "../agent/invocation-repository.js";
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
      "user-idle",
    ]) {
      const userTakeover = provider.startsWith("user-");
      const idle = provider === "user-idle";
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
      const callId = randomUUID(),
        clientId = randomUUID(),
        llmId = randomUUID(),
        sessionId = `browser_${randomUUID()}`;
      if (!userTakeover)
        await repo.recordAction(lease, callId, "browser_request_handoff");
      await database.insert(schema.browserSessionTable).values({
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
              name: userTakeover
                ? "browser_observe"
                : "browser_request_handoff",
              input: { reason: "Sign in" },
            },
            {
              id: `later-${callId}`,
              name: "browser_act",
              input: { action: "click", reference: "old-reference" },
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
      const handoff = userTakeover
        ? await controls.requestUser("alice", sessionId)
        : await controls.requestAgent({
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
            llmCallId: llmId,
            startedAt: new Date(),
            remainingCalls: [],
          });
      let paused = await controls.prepare(
        "alice",
        sessionId,
        "boot",
        0,
        "pause",
        { action: "control", operation: "pause" },
        "paused",
      );
      if (userTakeover)
        assert.ok(
          await repo.parkUserBrowserHandoff(
            lease,
            idle ? undefined : { callId, tool: "browser_observe" },
          ),
        );
      else
        await repo.parkBrowserHandoff(
          lease,
          callId,
          (handoff as { id: string }).id,
        );
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
      if (provider === "openai") {
        paused = await controls.prepare("alice", sessionId, "boot", paused.session.revision,
          "acquire", { action: "control", operation: "acquire" }, "human_private");
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
      if (provider === "cancel") await repo.requestCancel("alice", lease.id);
      const returning = await controls.prepare(
        "alice",
        sessionId,
        "boot",
        paused.session.revision,
        "return",
        { action: "control", operation: "prepare_return" },
        "resume_pending",
      );
      await controls.returned(
        "alice",
        sessionId,
        returning.session.revision,
        "done",
      );
      // Return does not run two model loops in the same conversation.
      assert.equal(await repo.claim("while-chatting", "alice"), null);
      await repo.finish(chatting, "succeeded", "done");
      if (provider === "cancel") {
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
          assert.equal(JSON.parse(results[0].content).ok, true);
        }
        assert.match(results[1].content, /not_executed_due_to_browser_handoff/);
      }
      assert.deepEqual(await repo.prepareQuestionContinuation(resumed), []);
      await repo.finish(resumed, "succeeded", "done");
    }
  },
);
