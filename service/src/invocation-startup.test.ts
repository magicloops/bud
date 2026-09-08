import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { acquireInvocationMode, readInvocationSettings, verifyAutomationProposalSchema, verifyBootstrapProposalSchema } from "./invocation-startup.js";

test("admission settings reject ambiguous modes and invalid capacity", () => {
  assert.deepEqual(readInvocationSettings({}), { mode: "legacy", automationConcurrencyPerBud: 1, automationsEnabled: false, appKeysEnabled: false, automationProposalsEnabled: false, bootstrapProposalsEnabled: false });
  assert.throws(() => readInvocationSettings({ APP_DATA_KEYS_ENABLED: "1" }), /app_data_keys_require_durable/);
  assert.throws(() => readInvocationSettings({ APP_DATA_KEYS_ENABLED: "true" }), /invalid_app_data_keys_enabled/);
  assert.equal(readInvocationSettings({ AGENT_INVOCATION_MODE: "durable", APP_DATA_KEYS_ENABLED: "1" }).appKeysEnabled, true);
  assert.equal(readInvocationSettings({ AGENT_INVOCATION_MODE: "durable" }).mode, "durable");
  assert.throws(() => readInvocationSettings({ AGENT_INVOCATION_MODE: "yes" }), /invalid_agent_invocation_mode/);
  assert.throws(() => readInvocationSettings({ AUTOMATIONS_ENABLED: "1" }), /require_durable/);
  assert.throws(() => readInvocationSettings({ AUTOMATIONS_ENABLED: "true" }), /invalid_automations_enabled/);
  assert.equal(readInvocationSettings({ AGENT_INVOCATION_MODE: "durable", AUTOMATIONS_ENABLED: "1" }).automationsEnabled, true);
  for (const cap of ["0", "33", "1.5", "oops", ""]) {
    assert.throws(() => readInvocationSettings({ AGENT_AUTOMATION_CONCURRENCY_PER_BUD: cap }), /invalid_automation_concurrency/);
  }
});

test("proposal enablement requires explicit durable automation admission", () => {
  for (const value of ["true", "", "yes", "2"]) {
    assert.throws(() => readInvocationSettings({ AUTOMATION_PROPOSALS_ENABLED: value }), /invalid_automation_proposals_enabled/);
  }
  for (const mode of ["legacy", "durable"]) {
    assert.throws(() => readInvocationSettings({ AGENT_INVOCATION_MODE: mode,
      AUTOMATION_PROPOSALS_ENABLED: "1" }), /automation_proposals_require_enabled_durable_automations/);
  }
  const base = { AGENT_INVOCATION_MODE: "durable", AUTOMATIONS_ENABLED: "1" };
  assert.equal(readInvocationSettings(base).automationProposalsEnabled, false);
  assert.equal(readInvocationSettings({ ...base, AUTOMATION_PROPOSALS_ENABLED: "1" }).automationProposalsEnabled, true);
  assert.equal(readInvocationSettings({ ...base, AUTOMATION_PROPOSALS_ENABLED: "0" }).automationProposalsEnabled, false);
});

test("proposal readiness rejects missing and partial schema and accepts migration 0033 columns", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async () => {
  const { config } = await import("./config.js");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const schema = `proposal_readiness_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const isolated = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`create schema ${schema}`);
    await assert.rejects(verifyAutomationProposalSchema(isolated), /does not exist/);
    await isolated.query("create table automation_proposal(id text)");
    await assert.rejects(verifyAutomationProposalSchema(isolated), /does not exist/);
    await isolated.query("drop table automation_proposal");
    // Apply the checked-in CREATE TABLE, including its column/check definitions;
    // foreign-key coverage lives in the proposal storage migration fixture.
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile(new URL("../drizzle/migrations/0033_natural_avengers.sql", import.meta.url), "utf8");
    await isolated.query(migration.split("--> statement-breakpoint")[0]!);
    await verifyAutomationProposalSchema(isolated);
  } finally {
    await isolated.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});

test("mode guard survives process crash and reports loss of its dedicated database session", {
  skip: process.env.BUD_DATA_DB_TEST !== "1", timeout: 20_000,
}, async t => {
  const { config } = await import("./config.js");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const schema = `invocation_process_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema}`, max: 3 });
  const children: { child: ReturnType<typeof spawn>; exited: Promise<unknown> }[] = [];
  const releases: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(entry => entry.exited));
    for (const release of releases) await release();
    await pool.end();
    try { await admin.query(`drop schema if exists ${schema} cascade`); }
    finally { await admin.end(); }
  });
  await admin.query(`create schema ${schema}`);
  await pool.query("create table agent_invocation(thread_id text, turn_id text, status text, reserves_thread boolean)");
  await pool.query("create table agent_question_request(thread_id text, turn_id text, status text)");
  const start = async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { Pool } from 'pg';
      import { acquireInvocationMode } from ${JSON.stringify(new URL("./invocation-startup.ts", import.meta.url).href)};
      setTimeout(() => process.exit(2), 15000).unref();
      process.once('message', async ({ connectionString, schema }) => {
        const pool = new Pool({ connectionString, options: '-c search_path=' + schema, max: 3 });
        let release;
        let backendPid;
        let losing = false;
        try {
          release = await acquireInvocationMode({ connect: async () => {
            const client = await pool.connect();
            backendPid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
            return client;
          } }, 'durable', () => {
            if (losing) return;
            losing = true;
            process.send({ lost: true });
            Promise.resolve().then(() => release()).then(() => pool.end()).then(() => process.exit(0));
          });
          process.send({ ready: true, backendPid });
        } catch {
          process.send({ failed: true });
          await pool.end();
          process.exit(1);
        }
      });
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = new Promise(resolve => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ failed: true }));
    });
    children.push({ child, exited });
    let lost = false;
    const ready = new Promise<number>((resolve, reject) => {
      child.on("message", (message: { ready?: boolean; backendPid?: number; lost?: boolean }) => {
        if (message.lost) lost = true;
        if (message.ready && typeof message.backendPid === "number") resolve(message.backendPid);
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("guard_child_exited_before_ready")));
    });
    // Credentials travel over private IPC, never command arguments or output.
    child.send!({ connectionString: config.databaseUrl, schema });
    return { child, exited, backendPid: await ready, lost: () => lost };
  };
  const acquireLegacy = async () => {
    const release = await acquireInvocationMode(pool, "legacy", () => assert.fail("unexpected session loss"));
    releases.push(release);
    return release;
  };
  const crashed = await start();
  await assert.rejects(acquireLegacy(), /mode_conflict/);
  crashed.child.kill("SIGKILL");
  assert.deepEqual(await crashed.exited, { code: null, signal: "SIGKILL" });
  // TCP close observation can lag child exit; retry only the specific lock conflict.
  let release: (() => Promise<void>) | undefined;
  for (let attempt = 0; attempt < 40 && !release; attempt++) {
    try { release = await acquireLegacy(); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "agent_invocation_mode_conflict") throw error;
      await delay(25);
    }
  }
  assert.ok(release, "process death releases its session lock");
  await release();
  const disconnected = await start();
  const terminated = await admin.query("select pg_terminate_backend($1) as terminated", [disconnected.backendPid]);
  assert.equal(terminated.rows[0].terminated, true);
  assert.deepEqual(await disconnected.exited, { code: 0, signal: null });
  assert.equal(disconnected.lost(), true, "dedicated session loss reaches the shutdown callback");
  await acquireLegacy();
});

test("database guard permits same-mode replicas and rejects unsafe cutovers", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async () => {
  const { config } = await import("./config.js");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const schema = `invocation_startup_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  await admin.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema}`, max: 5 });
  const releases: (() => Promise<void>)[] = [];
  const acquire = async (mode: "legacy" | "durable") => {
    const release = await acquireInvocationMode(pool, mode, () => assert.fail("unexpected session loss"));
    releases.push(release);
    return release;
  };
  try {
    await assert.rejects(acquire("durable"), /migrations_required/);
    const old = await acquire("legacy");
    await old();
    await pool.query("create table agent_invocation(thread_id text, turn_id text, status text, reserves_thread boolean)");
    await pool.query("create table agent_question_request(thread_id text, turn_id text, status text)");
    const a = await acquire("durable");
    const b = await acquire("durable");
    await assert.rejects(acquire("legacy"), /mode_conflict/);
    await a();
    await assert.rejects(acquire("legacy"), /mode_conflict/);
    await b();
    await pool.query("insert into agent_invocation values ('thread', 'turn', 'pending', false)");
    await assert.rejects(acquire("legacy"), /require_reconciliation/);
    await pool.query("update agent_invocation set status = 'needs_review', reserves_thread = true");
    await assert.rejects(acquire("legacy"), /require_reconciliation/);
    await pool.query("update agent_invocation set status = 'succeeded', reserves_thread = false");
    const legacy = await acquire("legacy");
    await assert.rejects(acquire("durable"), /mode_conflict/);
    await legacy();
    await pool.query("insert into agent_question_request values ('other', 'turn', 'pending')");
    await assert.rejects(acquire("durable"), /legacy_questions_require_drain/);
    await pool.query("update agent_question_request set status = 'answered'");
    await acquire("durable");
  } finally {
    for (const release of releases) await release();
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
});


test("existing-contact reviews require the full explicit automation capability chain", () => {
  const base = { AGENT_INVOCATION_MODE: "durable", AUTOMATIONS_ENABLED: "1", AUTOMATION_PROPOSALS_ENABLED: "1" };
  assert.equal(readInvocationSettings(base).bootstrapProposalsEnabled, false);
  assert.equal(readInvocationSettings({ ...base, AUTOMATION_EXISTING_CONTACT_REVIEWS_ENABLED: "1" }).bootstrapProposalsEnabled, true);
  for (const value of ["true", "", "2"]) assert.throws(() => readInvocationSettings({ ...base,
    AUTOMATION_EXISTING_CONTACT_REVIEWS_ENABLED: value }), /invalid_existing_contact_reviews_enabled/);
  for (const settings of [{}, { AGENT_INVOCATION_MODE: "durable" }, { AGENT_INVOCATION_MODE: "durable", AUTOMATIONS_ENABLED: "1" }]) {
    assert.throws(() => readInvocationSettings({ ...settings, AUTOMATION_EXISTING_CONTACT_REVIEWS_ENABLED: "1" }), /existing_contact_reviews_require/);
  }
});

test("bootstrap readiness requires complete proposal and membership schema", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async () => {
  const { config } = await import("./config.js");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const schema = `bootstrap_readiness_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const isolated = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`create schema ${schema}`);
    await assert.rejects(verifyBootstrapProposalSchema(isolated), /does not exist/);
    await isolated.query("create table automation_bootstrap_proposal(id text)");
    await assert.rejects(verifyBootstrapProposalSchema(isolated), /does not exist/);
    await isolated.query("drop table automation_bootstrap_proposal");
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(new URL("../drizzle/migrations/0034_bored_butterfly.sql", import.meta.url), "utf8");
    const statements = sql.split("--> statement-breakpoint");
    await isolated.query(statements[1]!);
    await assert.rejects(verifyBootstrapProposalSchema(isolated), /does not exist/);
    await isolated.query(statements[0]!);
    await verifyBootstrapProposalSchema(isolated);
    await isolated.query("alter table automation_bootstrap_proposal_member drop column tenant_id");
    await assert.rejects(verifyBootstrapProposalSchema(isolated), /does not exist/);
  } finally {
    await isolated.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});
