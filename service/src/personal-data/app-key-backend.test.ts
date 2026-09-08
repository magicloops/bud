import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, symlink, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { BudAppData, type AppSetupContext } from "./app-key-backend.mjs";
import { appKeyRecipient, createAppQueryCredential, sealAppQueryCredential, verifyAppKeyProof } from "./app-key-crypto.js";

test("backend setup persists before receipt and recovers a lost acknowledgement without retrieving again", async t => {
  const root = await mkdtemp(join(tmpdir(), "bud-app-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const issued = createAppQueryCredential();
  let context: AppSetupContext;
  let envelope: ReturnType<typeof sealAppQueryCredential>;
  let recipient: ReturnType<typeof appKeyRecipient>;
  let retrieveCount = 0; let receiptCount = 0; let dropReceipt = true;
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const url = String(input);
    assert.ok(url.startsWith("https://bud.example/"));
    if (url.endsWith("/retrieve")) {
      retrieveCount++;
      assert.equal(verifyAppKeyProof(recipient, "retrieve", context, JSON.parse(String(init?.body)).signature), true);
      return Response.json({ status: "handoff_pending", key_id: issued.key_id, envelope });
    }
    if (url.endsWith("/installed")) {
      receiptCount++;
      const stored = JSON.parse(await readFile(join(root, "example", `${issued.key_id}.json`), "utf8"));
      assert.equal(stored.credential, issued.credential, "credential must be on disk before acknowledgement");
      assert.equal(verifyAppKeyProof(recipient, "installed", context, JSON.parse(String(init?.body)).signature, envelope.ciphertext_sha256), true);
      if (dropReceipt) { dropReceipt = false; throw new Error("network failed after server committed"); }
      return Response.json({ status: "installed", key_id: issued.key_id });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${issued.credential}`);
    assert.equal(url, "https://bud.example/api/app-data/contacts?search=Ada");
    return Response.json({ data: { items: [] } });
  };
  const options = { appId: "example", apiOrigin: "https://bud.example", stateRoot: root, fetch: fakeFetch };
  const helper = new BudAppData(options);
  const initialized = await Promise.all([helper.initialize(), new BudAppData(options).initialize()]);
  assert.equal(initialized[0].recipient_fingerprint, initialized[1].recipient_fingerprint, "concurrent initialization preserves one identity");
  recipient = appKeyRecipient(initialized[0].public_key);
  context = { key_id: issued.key_id, request_id: `dar_${ulid()}`, recipient_fingerprint: recipient.fingerprint,
    expires_at: new Date(Date.now() + 86400_000).toISOString() };
  envelope = sealAppQueryCredential(issued.credential, recipient, context);
  await assert.rejects(helper.install(context), /app_data_connection_failed/);
  const restarted = new BudAppData(options);
  assert.deepEqual(await restarted.install(context), { status: "installed", key_id: issued.key_id });
  assert.equal(retrieveCount, 1); assert.equal(receiptCount, 2);
  assert.deepEqual(await restarted.query(issued.key_id, "contacts", { search: "Ada" }), { data: { items: [] } });
  const serialized = JSON.stringify([initialized, await restarted.install(context)]);
  assert.equal(serialized.includes(issued.credential), false);
  assert.equal(serialized.includes("PRIVATE KEY"), false);
  assert.equal((await stat(join(root, "example"))).mode & 0o777, 0o700);
  for (const file of ["installation.json", `${issued.key_id}.json`])
    assert.equal((await stat(join(root, "example", file))).mode & 0o777, 0o600);
  await assert.rejects(new BudAppData({ ...options, apiOrigin: "https://other.example" }).query(issued.key_id, "contacts"), /app_data_identity_mismatch/);
  await assert.rejects(helper.query(issued.key_id, "https://other.example/steal"), /invalid_app_data_query/);
  await assert.rejects(helper.query(issued.key_id, "contacts", { owner: "foreign" }), /invalid_app_data_query/);
});

test("backend setup rejects unsafe state and mismatched delivery without acknowledging it", async t => {
  const root = await mkdtemp(join(tmpdir(), "bud-app-helper-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const issued = createAppQueryCredential();
  let envelope: ReturnType<typeof sealAppQueryCredential>;
  let calls = 0;
  const helper = new BudAppData({ appId: "invalid", apiOrigin: "http://127.0.0.1:1234", stateRoot: root,
    fetch: async () => { calls++; return Response.json({ status: "handoff_pending", envelope: { ...envelope, ciphertext_sha256: "0".repeat(64) } }); } });
  const initialized = await helper.initialize();
  const context = { key_id: issued.key_id, request_id: `dar_${ulid()}`, recipient_fingerprint: initialized.recipient_fingerprint,
    expires_at: new Date(Date.now() + 86400_000).toISOString() };
  envelope = sealAppQueryCredential(issued.credential, appKeyRecipient(initialized.public_key), context);
  await assert.rejects(helper.install(context), /invalid_app_data_delivery/);
  assert.equal(calls, 1);
  await assert.rejects(stat(join(root, "invalid", `${issued.key_id}.json`)), { code: "ENOENT" });
  await chmod(join(root, "invalid", "installation.json"), 0o644);
  await assert.rejects(helper.initialize(), /app_data_state_unavailable/);
  assert.throws(() => new BudAppData({ appId: "../escape", apiOrigin: "https://bud.example", stateRoot: root }), /invalid_app_data_config/);
  assert.throws(() => new BudAppData({ appId: "safe", apiOrigin: "http://remote.example", stateRoot: root }), /invalid_app_data_origin/);
  const target = join(root, "symlink-target.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, join(root, "invalid", `${issued.key_id}.json`));
  await chmod(join(root, "invalid", "installation.json"), 0o600);
  await assert.rejects(helper.install(context), /app_data_state_unavailable/);
});
