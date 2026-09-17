import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { config } from "../config.js";
import { BrowserRepository } from "./repository.js";
import { BrowserControlRepository } from "./control-repository.js";
import type { BrowserAgentContext } from "../agent/browser-tool-executor.js";

test(
  "browser migration and repository: ownership, durable admission, fences, reuse and deletion",
  { skip: process.env.BUD_DATA_DB_TEST !== "1" },
  async (t) => {
    assert.ok(
      ["localhost", "127.0.0.1"].includes(new URL(config.databaseUrl).hostname),
    );
    const schema = `browser_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    t.after(async () => {
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    });
    await pool.query(`create schema ${schema}`);
    await pool.query(`create table bud(bud_id text primary key,created_by_user_id text,tenant_id text,device_secret text,unique(bud_id,created_by_user_id));
    create table thread(thread_id uuid primary key,bud_id text,created_by_user_id text,tenant_id text,deleted_at timestamptz,
      unique(thread_id,bud_id,created_by_user_id));
    create table agent_invocation(id text primary key,thread_id uuid,turn_id text,created_by_user_id text,
      fence integer,worker_id text,status text,lease_expires_at timestamptz,cancel_requested_at timestamptz);
    create table agent_invocation_action(id text primary key,invocation_id text,call_id text,fence integer,
      created_by_user_id text,status text,evidence jsonb);`);
    const migration = await readFile(
      new URL("../../drizzle/migrations/0039_tiny_loners.sql", import.meta.url),
      "utf8",
    );
    await pool.query(migration.replaceAll('"public".', `"${schema}".`));
    await pool.query(`alter table agent_invocation add column bud_id text default 'bud';
    alter table agent_invocation add column reserves_thread boolean default true;
    alter table agent_invocation add constraint invocation_context unique(id,thread_id,bud_id,created_by_user_id);
    alter table agent_invocation_action add column kind text default 'browser_request_handoff';`);
    const handoffMigration = await readFile(
      new URL(
        "../../drizzle/migrations/0040_broad_cassandra_nova.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(handoffMigration.replaceAll('"public".', `"${schema}".`));
    await pool.query(
      await readFile(
        new URL("../../drizzle/migrations/0041_cool_lyja.sql", import.meta.url),
        "utf8",
      ),
    );
    for (const name of ["0044_dry_princess_powerful.sql", "0045_gorgeous_luke_cage.sql", "0046_tired_johnny_blaze.sql"]) {
      await pool.query((await readFile(new URL(`../../drizzle/migrations/${name}`, import.meta.url), "utf8")).replaceAll('"public".', `"${schema}".`));
    }
    const thread = randomUUID();
    await pool.query("insert into bud values('bud','alice','tenant','secret');");
    await pool.query(
      "insert into thread values($1,'bud','alice','tenant',null)",
      [thread],
    );
    await pool.query(
      "insert into agent_invocation(id,thread_id,turn_id,created_by_user_id,fence,worker_id,status,lease_expires_at,cancel_requested_at) values('inv',$1,'turn','alice',1,'worker','running',now()+interval '2 minutes',null)",
      [thread],
    );
    let calls = 0;
    const context: BrowserAgentContext = {
      threadId: thread,
      budId: "bud",
      ownerUserId: "alice",
      turnId: "turn",
      invocation: { id: "inv", fence: 1, workerId: "worker" },
      signal: new AbortController().signal,
    };
    const next = async () => {
      const callId = `call-${++calls}`;
      await pool.query(
        "insert into agent_invocation_action(id,invocation_id,call_id,fence,created_by_user_id,status,evidence) values($1,'inv',$1,1,'alice','intent',null)",
        [callId],
      );
      return { ...context, callId };
    };
    const repo = new BrowserRepository(pool);
    const first = await next();
    for (const bad of [
      { ownerUserId: "bob" },
      { budId: "other" },
      { invocation: { id: "inv", fence: 2, workerId: "worker" } },
    ]) {
      await assert.rejects(
        repo.prepare({ ...first, ...bad }, "boot", { action: "open" }),
        /authority_lost|not_found/,
      );
    }
    const r = await repo.prepare(first, "boot", { action: "open" });
    await assert.rejects(
      repo.prepare(first, "boot", { action: "open" }),
      /already_dispatched/,
    );
    await assert.rejects(
      repo.prepare(await next(), "boot", { action: "open" }),
      /browser_busy/,
    );
    await repo.complete(r, { ok: true, outcome: "completed" });
    const second = await repo.prepare(await next(), "boot", {
      action: "observe",
    });
    assert.equal(second.session_id, r.session_id);
    assert.equal(second.sequence, r.sequence + 1);
    await repo.complete(second, { ok: true, outcome: "completed" });
    assert.equal(await repo.evidenceAllowed(second), true);
    await repo.complete(second, { ok:false, outcome:"rejected", error:"browser_locator_ambiguous" });
    assert.equal((await pool.query("select state from browser_session where id=$1", [second.session_id])).rows[0].state,"ready");
    const reobserve = await repo.prepare(await next(), "boot", { action:"inspect", operation:"snapshot" });
    await repo.complete(reobserve, { ok:true, outcome:"completed" });
    const busy = await repo.prepare(await next(), "boot", { action:"navigate", url:"https://example.com" });
    const beforeBusy = (await pool.query("select * from browser_session where id=$1", [busy.session_id])).rows[0];
    await repo.complete(busy, { ok:false, outcome:"rejected", error:"browser_busy" });
    const afterBusy = (await pool.query("select * from browser_session where id=$1", [busy.session_id])).rows[0];
    assert.equal(afterBusy.state, "ready");
    assert.equal(afterBusy.pending_until, null);
    for (const key of ["id", "generation", "control_epoch", "control_state", "private_content", "revision", "closed_at"])
      assert.deepEqual(afterBusy[key], beforeBusy[key]);
    const afterRejection = await repo.prepare(await next(), "boot", { action:"observe" });
    assert.equal(afterRejection.session_id, busy.session_id);
    await repo.complete(afterRejection, { ok:false, outcome:"unknown", error:"browser_busy" });
    assert.equal((await pool.query("select state from browser_session where id=$1", [busy.session_id])).rows[0].state, "interrupted");
    // Restore fixture state to continue testing the unrelated handoff paths.
    await repo.complete(afterRejection, { ok:true, outcome:"completed" });
    const controls = new BrowserControlRepository(pool);
    assert.equal((await controls.list("bob", thread)).length, 0);
    await assert.rejects(controls.get("bob", r.session_id), /not_found/);
    const handoffCall = await next();
    const handoff = await controls.requestAgent({
      ...handoffCall,
      clientId: randomUUID(),
      llmCallId: "llm",
      startedAt: new Date(),
      remainingCalls: [],
      directive: {
        type: "tool_call",
        tool: "browser_request_handoff",
        callId: handoffCall.callId,
        args: { reason: "Sign in" },
      },
    });
    assert.equal(
      (await controls.pending("alice", r.session_id)).id,
      handoff.id,
    );
    const paused = await controls.prepare(
      "alice",
      r.session_id,
      "boot",
      handoff.session.revision,
      "pause",
      { action: "control", operation: "pause" },
      "paused",
    );
    assert.equal(await repo.evidenceAllowed(second), false);
    for (const controlState of ["paused", "human_private", "resume_pending"]) {
      await pool.query("update browser_resource set control_state=$1,private_content=true,control_session_id=$2 where id=(select browser_id from browser_session where id=$2)", [controlState, r.session_id]);
      for (const action of ["open", "observe", "click", "close"]) {
        await assert.rejects(repo.prepare(await next(), "boot", { action }), /private_or_paused/);
      }
      assert.equal((await controls.get("alice", r.session_id)).boot_id, "boot");
    }
    await pool.query("update browser_resource set control_state='paused' where id=(select browser_id from browser_session where id=$1)", [r.session_id]);
    await assert.rejects(
      controls.prepare(
        "alice",
        r.session_id,
        "boot",
        handoff.session.revision,
        "stale",
        { action: "control", operation: "acquire" },
        "human_private",
      ),
      /revision_conflict/,
    );
    await pool.query("update agent_invocation set status='waiting_for_user'");
    const acquired = await controls.prepare("alice", r.session_id, "boot", paused.session.revision,
      "acquire", { action:"control", operation:"acquire" }, "human_private");
    const returning = await controls.prepare(
      "alice",
      r.session_id,
      "boot",
      acquired.session.revision,
      "return",
      { action: "control", operation: "prepare_return" },
      "resume_pending",
    );
    const finished = await controls.prepare("alice", r.session_id, "boot", returning.session.revision,
      "finish", { action:"control", operation:"finish_return" }, "resume_pending");
    await controls.returned(
      "alice",
      r.session_id,
      finished.session.revision,
      "returned",
    );
    assert.equal(
      (
        await pool.query("select status from browser_handoff where id=$1", [
          handoff.id,
        ])
      ).rows[0].status,
      "returned",
    );
    await assert.rejects(
      controls.returned(
        "alice",
        r.session_id,
        returning.session.revision,
        "duplicate",
      ),
      /revision_conflict/,
    );
    await pool.query("update agent_invocation set status='running'");
    // Service restart preserves live state; daemon restart retains recoverable inventory.
    const recovered = await new BrowserRepository(pool).prepare(
      await next(),
      "boot",
      { action: "observe" },
    );
    assert.equal(recovered.session_id, r.session_id);
    await repo.complete(recovered, { ok: true, outcome: "completed" });
    await assert.rejects(
      repo.prepare(await next(), "new-boot", { action: "observe" }),
      /recovery_required/,
    );
    await assert.rejects(repo.prepare(await next(), "new-boot", { action: "open" }), /recovery_required/);
    assert.equal((await controls.list("alice", thread))[0].id, r.session_id);
    const beforeRecovery = await controls.get("alice", r.session_id);
    await assert.rejects(controls.prepare("bob",r.session_id,"new-boot",beforeRecovery.revision,
      "recover",{action:"control",operation:"pause"},"paused"), /not_found/);
    const recovering = await controls.prepare("alice",r.session_id,"new-boot",beforeRecovery.revision,
      "recover",{action:"control",operation:"pause"},"paused");
    assert.equal(recovering.session.id,r.session_id);
    assert.notEqual(recovering.session.generation,r.generation);
    assert.equal(recovering.session.boot_id,"new-boot");
    await repo.complete(recovered,{ok:true,outcome:"completed"});
    assert.equal((await controls.get("alice",r.session_id)).generation,recovering.session.generation);
    const replacement = recovering.request;
    // Restart cannot release the browser-wide private latch. Only explicit
    // takeover of the new process and acknowledged return can resume agents.
    const live = replacement;
    const liveBoot = "new-boot";
    for (const state of ["paused", "human_private", "resume_pending"]) {
      await pool.query("update browser_resource set control_state=$1,private_content=true,control_session_id=$2", [state,live.session_id]);
      await assert.rejects(repo.prepare(await next(), liveBoot, { action:"open" }), /private_or_paused/);
      await assert.rejects(repo.prepare(await next(), "restarted", { action:"open" }), /private_or_paused/);
      assert.equal((await controls.get("alice",live.session_id)).private_content,true);
    }
    // Isolate the cleanup assertions from the separately tested return handshake.
    await pool.query("update browser_resource set control_state='agent',private_content=false");
    const current = await controls.get("alice", live.session_id);
    await assert.rejects(
      controls.requestClose("bob", live.session_id, current.revision),
      /not_found/,
    );
    const closing = await controls.requestClose(
      "alice",
      live.session_id,
      current.revision,
    );
    assert.equal(closing.session.desired_state, "closed");
    assert.deepEqual(closing.invocations, []);
    await assert.rejects(
      controls.requestClose("alice", live.session_id, current.revision),
      /revision_conflict/,
    );
    await pool.query("update thread set deleted_at=now()");
    await assert.rejects(
      repo.prepare(await next(), "boot", { action: "observe" }),
      /authority_lost/,
    );
    const candidates = await repo.cleanupCandidates();
    assert.equal(candidates.length, 1);
    const close = await repo.prepareCleanup(candidates[0], "another-boot");
    assert.ok(close);
    assert.ok(close.control_epoch > r.control_epoch);
    await repo.complete(close, { ok: true, outcome: "completed" });
    assert.equal((await repo.cleanupCandidates()).length, 0);
    // Claim rotation quarantines even the same owner's existing profile.
    const oldResource = (await pool.query("select browser_id from browser_session where id=$1", [r.session_id])).rows[0].browser_id;
    await pool.query("update bud set device_secret='replacement' where bud_id='bud'");
    assert.ok((await pool.query("select retired_at from browser_resource where id=$1", [oldResource])).rows[0].retired_at);
    assert.equal(
      (await pool.query("select tenant_id,closed_at from browser_session"))
        .rows[0].tenant_id,
      "tenant",
    );
  },
);
