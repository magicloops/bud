import test from "node:test";
import assert from "node:assert/strict";
import { GMAIL_TOOLS, gmailResult } from "./gmail.js";
import { DRIVE_TOOLS } from "./drive.js";
import { GoogleAgentExecutor } from "./agent-executor.js";
import { GoogleError, GoogleHttpError, SERVICE_SCOPES, serviceGranted } from "./config.js";
import { GoogleOAuth } from "./oauth.js";
import { googleFixture } from "./test-fixture.js";
import { googleFetch, googleJson } from "./http.js";
import type { AgentExecutionHooks } from "../agent/execution-lifecycle.js";
import type { GoogleToolCallDirective } from "../agent/contracts.js";

const prepare = (name: string, args: unknown) => [...GMAIL_TOOLS, ...DRIVE_TOOLS].find(t => t.name === name)!.prepare(args, "operation");
const mail = { to: ["friend@example.com"], subject: "Résumé 🌱", body: "Hello café\nThanks" };
const signal = new AbortController().signal;

test("incremental OAuth requests only selected service scopes and keeps Google identity hint", async () => {
  const fixture = googleFixture(), oauth = new GoogleOAuth(fixture.config, fixture.fetcher);
  for (const service of ["gmail", "drive"] as const) {
    const flow = await oauth.authorize("state", [{ service, access: "read_write" }], "alice@example.com"), url = new URL(flow.url);
    const scope = url.searchParams.get("scope")!;
    assert.ok(scope.includes(SERVICE_SCOPES[service][0]));
    assert.ok(!scope.includes("calendar"));
    assert.equal(url.searchParams.get("include_granted_scopes"), "true");
    assert.equal(url.searchParams.get("login_hint"), "alice@example.com");
    fixture.authorize(flow.url, "alice");
    const grant = await oauth.exchange("alice", flow.verifier, signal);
    assert.ok(serviceGranted(grant.scopes, service));
  }
  assert.ok(!serviceGranted(["https://www.googleapis.com/auth/drive.file"], "drive"));
  assert.ok(serviceGranted(["https://www.googleapis.com/auth/gmail.readonly"], "gmail"));
});

test("MIME preserves Unicode, recipient lists and reply headers; rejects header/account injection", () => {
  const reply = { ...mail, thread_id: "thread1", in_reply_to: "<original@example.com>", references: ["<earlier@example.com>"] };
  const request = prepare("gmail_send_message", reply), message = request.body as { raw: string; threadId: string };
  const raw = Buffer.from(message.raw, "base64url").toString();
  assert.equal(message.threadId, "thread1");
  assert.match(raw, /In-Reply-To: <original@example.com>/);
  assert.match(raw, /References: <earlier@example.com>\r\n <original@example.com>/);
  assert.ok(raw.includes(`=?UTF-8?B?${Buffer.from(mail.subject).toString("base64")}?=`));
  assert.equal(Buffer.from(raw.split("\r\n\r\n")[1], "base64").toString(), "Hello café\r\nThanks");
  assert.match(raw, /Message-ID: <[a-f0-9]{64}@bud.dev>/);
  assert.deepEqual(request, prepare("gmail_send_message", reply));
  for (const bad of [{ subject: "Hello\r\nBcc: attacker@example.com" }, { to: ["me@example.com\nBcc: bad@example.com"] },
    { from: "forged@example.com" }, { user_id: "other" }, { thread_id: "thread1" }, { body: "x".repeat(24001) },
    { in_reply_to: "<bad\u0000@example.com>", thread_id: "thread1" }]) {
    assert.throws(() => prepare("gmail_send_message", { ...mail, ...bad }));
  }
  const long = Buffer.from((prepare("gmail_send_message", { ...mail, subject: "🌱".repeat(100), to: Array(50).fill("friend@example.com") }).body as { raw: string }).raw, "base64url").toString();
  assert.ok(long.split("\r\n").every(line => Buffer.byteLength(line) < 998));
});

test("Gmail supports draft lifecycle, label changes and reversible message trash", () => {
  assert.equal(prepare("gmail_create_draft", mail).path, "/drafts");
  assert.equal(prepare("gmail_update_draft", { ...mail, draft_id: "draft1" }).method, "PUT");
  assert.deepEqual(prepare("gmail_send_draft", { draft_id: "draft1" }).body, { id: "draft1" });
  assert.equal(prepare("gmail_delete_draft", { draft_id: "draft1" }).method, "DELETE");
  assert.equal(prepare("gmail_update_label", { label_id: "Label_1", name: "Work" }).path, "/labels/Label_1");
  assert.deepEqual(prepare("gmail_modify_message", { message_id: "123", remove_label_ids: ["INBOX", "UNREAD"] }).body,
    { addLabelIds: [], removeLabelIds: ["INBOX", "UNREAD"] });
  assert.throws(() => prepare("gmail_modify_message", { message_id: "123" }));
  for (const action of ["trash", "untrash"]) assert.equal(prepare(`gmail_${action}_message`, { message_id: "123" }).path, `/messages/123/${action}`);
  assert.ok(!GMAIL_TOOLS.some(tool => tool.name === "gmail_delete_message"));
  assert.equal(prepare("gmail_search_messages", { query: "from:friend@example.com", page_token: "next" }).query?.pageToken, "next");
});

test("Gmail decodes nested messages and lists attachments without dumping bytes", () => {
  const result = gmailResult({ id: "thread", messages: [{ id: "message", payload: { headers: [{ name: "Subject", value: "Test" }, { name: "X-Private", value: "skip" }],
    parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Résumé 🌱").toString("base64url") } },
      { mimeType: "application/pdf", filename: "resume.pdf", body: { data: "BINARY-SECRET", attachmentId: "att1", size: 123 } }] } }] });
  assert.match(JSON.stringify(result), /Résumé 🌱/); assert.match(JSON.stringify(result), /resume.pdf/);
  assert.doesNotMatch(JSON.stringify(result), /BINARY-SECRET|X-Private|payload/);
  const huge = gmailResult({ payload: { mimeType: "text/plain", body: { data: Buffer.from("x".repeat(30000)).toString("base64url") } } });
  assert.equal(huge.body_truncated, true);
});

test("Gmail bounds escaped Unicode, headers, attachments and omitted IDs without losing newest text", () => {
  const messages = Array.from({ length: 80 }, (_, index) => ({ id: `message_${index}_${"a".repeat(200)}`, internalDate: String(index + 1),
    payload: { headers: [{ name: "Subject", value: '"🌱\\'.repeat(3000) }], parts: [
      { mimeType: "text/html", body: { data: Buffer.from("duplicate HTML".repeat(1000)).toString("base64url") } },
      { mimeType: "text/plain", body: { data: Buffer.from(`message ${index}: ` + '🌱\n"\\'.repeat(3000)).toString("base64url") } },
      { mimeType: "application/pdf", filename: "f".repeat(20000), body: { attachmentId: "attachment", data: "BINARY-SECRET" } },
    ] } }));
  const result = gmailResult({ id: "thread", historyId: "h".repeat(40000), messages });
  const serialized = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serialized) < 32768);
  assert.doesNotMatch(serialized, /\ufffd|BINARY-SECRET|duplicate HTML/);
  const included = result.messages as { id: string; bodies: { content: string }[]; body_truncated: boolean; metadata_truncated: boolean }[];
  assert.equal(included[0].id, messages.at(-1)!.id);
  assert.match(included[0].bodies[0].content, /^message 79: 🌱/);
  assert.equal(included[0].body_truncated, true);
  assert.equal(included[0].metadata_truncated, true);
  assert.equal(result.truncated, true);
  assert.equal(result.omitted_messages, messages.length - included.length);
  const omitted = result.omitted_message_ids as string[];
  assert.ok(omitted.length > 0 && Buffer.byteLength(JSON.stringify(omitted)) <= 4000);
  assert.ok(omitted.every(messageId => messages.some(message => message.id === messageId) && !included.some(message => message.id === messageId)));
  assert.equal(result.omitted_message_ids_truncated, true);
  assert.match(String(result.note), /gmail_get_message/);
  const draft = gmailResult({ id: "draft", message: messages.at(-1) });
  assert.ok(Buffer.byteLength(JSON.stringify(draft)) < 32768);
  assert.equal(draft.truncated, true);
});

test("Drive upload constructs byte-correct multipart, preserves metadata, and rejects unsafe/oversized inputs", () => {
  for (const [content, encoding, expected] of [["Résumé 🌱", "utf8", Buffer.from("Résumé 🌱")], ["AP8NCg==", "base64", Buffer.from([0, 255, 13, 10])]] as const) {
    const request = prepare("drive_upload_file", { name: "test.txt", parent_id: "folder", content, encoding });
    assert.equal(request.upload, true); assert.equal(request.query?.uploadType, "multipart");
    const bytes = Buffer.from(request.rawBody!);
    assert.ok(bytes.includes(expected)); assert.match(bytes.toString(), /"parents":\["folder"\]/);
    assert.match(request.contentType!, /^multipart\/related; boundary=bud_[a-f0-9]+$/);
  }
  for (const bad of [{ content: "é".repeat(13000) }, { content: "%%%", encoding: "base64" }, { url: "https://evil.example" }, { name: "x", parent_id: "../other" }]) {
    assert.throws(() => prepare("drive_upload_file", { name: "test.txt", content: "ok", ...bad }));
  }
  const patch = prepare("drive_update_file", { file_id: "file", expected_version: "123", name: "New" });
  assert.equal(JSON.stringify(patch.body), '{"name":"New"}');
  assert.equal(patch.filePreflight?.version, "123");
  assert.equal(prepare("drive_update_file", { file_id: "file", expected_version: "123", content: "new" }).filePreflight?.uploadedOnly, true);
  assert.throws(() => prepare("drive_update_file", { file_id: "file", expected_version: "123" }));
  assert.ok(!DRIVE_TOOLS.some(tool => tool.name === "drive_delete_file"));
  assert.equal(prepare("drive_search_files", { page_token: "next", drive_id: "shared" }).query?.corpora, "drive");
  assert.equal(prepare("drive_read_file", { file_id: "file", export_mime_type: "text/plain" }).path, "/files/file/export");
});

test("Google transport uses fixed account/hosts, blocks redirects and binary text, and bounds exports", async () => {
  const text = await googleJson(googleFetch(async () => new Response("x".repeat(25000), { headers: { "content-type": "text/plain" } })),
    "https://www.googleapis.com/drive/v3/files/file/export", "token", undefined, "text");
  assert.equal(text.truncated, true); assert.equal(String(text.content).length, 24000);
  await assert.rejects(googleJson(googleFetch(async () => new Response("binary", { headers: { "content-type": "application/pdf" } })),
    "https://www.googleapis.com/drive/v3/files/file", "token", undefined, "text"), /google_binary_content_requires_download/);
  const fetcher = googleFetch(async request => Response.json({ path: new URL(String(request instanceof Request ? request.url : request)).pathname }));
  for (const url of ["https://gmail.googleapis.com/gmail/v1/users/other/messages", "https://www.googleapis.com/admin/users", "https://evil.example/drive/v3/files"])
    await assert.rejects(fetcher(url), /google_destination_denied/);
  let called = false;
  await assert.rejects(googleFetch(async () => { called = true; return Response.json({}); })("https://www.googleapis.com/upload/drive/v3/files",
    { method: "POST", body: new Uint8Array(65537) }), /google_request_too_large/);
  assert.equal(called, false);
});

test("service-specific discovery, consent, disabled API guidance and uncertain writes", async () => {
  const hooks: AgentExecutionHooks = { googleEnabled: true, invocation: { id: "inv", workerId: "worker", fence: 1 }, async checkpoint() {}, async beforeTool() {}, async afterTool() {} };
  for (const service of ["gmail", "drive"] as const) {
    const discovery: GoogleToolCallDirective = { type: "tool_call", tool: "google_search_tools", callId: "discover", args: { service, query: "" } };
    const missing = new GoogleAgentExecutor({ list: async () => [], call: async () => { throw new Error("must not dispatch"); } }, async () => true);
    assert.deepEqual((await missing.execute("thread", discovery, "alice", signal, hooks)).payload.connect_request,
      { provider: `google_${service}`, thread_id: "thread", access: "read_only" });
    const available = new GoogleAgentExecutor({ list: async () => [{ connection_id: "conn", email: "alice@example.com", status: "connecting", calendar_access: true,
      calendar_write_access: true, gmail_write_access: true, drive_write_access: true,
      access: { calendar: "read_write", gmail: "read_write", drive: "read_write" },
      gmail_access: service === "gmail", drive_access: service === "drive", updated_at: "now" }], call: async () => ({}) }, async () => true);
    const found = (await available.execute("thread", discovery, "alice", signal, hooks)).payload.tools as { name: string }[];
    assert.ok(found.length > 5 && found.every(t => t.name.startsWith(`${service}_`)));
    const directive: GoogleToolCallDirective = { ...discovery, tool: "google_call", args: { connection_id: "conn",
      tool_name: service === "gmail" ? "gmail_send_message" : "drive_create_folder", arguments_json: JSON.stringify(service === "gmail" ? mail : { name: "Test" }) } };
    let attempts = 0;
    for (const failure of [new GoogleError(`google_${service}_permissions_required`), new GoogleHttpError(403, "service_disabled"), new Error("network lost")]) {
      const executor = new GoogleAgentExecutor({ list: async () => [], call: async (_owner, _id, _request, _signal, before, actualService) => {
        assert.equal(actualService, service);
        if (failure.message.endsWith("permissions_required")) throw failure;
        await before("dispatch"); attempts++; throw failure;
      } }, async () => true);
      if (failure.message === "network lost") await assert.rejects(executor.execute("thread", directive, "alice", signal, hooks), /google_outcome_unknown/);
      else {
        const result = await executor.execute("thread", directive, "alice", signal, hooks);
        if (failure.message.endsWith("permissions_required")) assert.deepEqual(result.payload.connect_request, { provider: `google_${service}`, thread_id: "thread", access: "read_write" });
        else assert.match(result.summary, service === "gmail" ? /Enable Gmail API/ : /Enable Google Drive API/);
      }
    }
    assert.equal(attempts, 2);
  }
});
