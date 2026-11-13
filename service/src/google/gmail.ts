import { createHash } from "node:crypto";
import { z } from "zod";
import { type GoogleTool, objectSchema as obj, stringSchema as str } from "./tool-contracts.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const header = z.string().max(500).refine(value => !/[\r\n\x00-\x1f\x7f]/.test(value), "Header must be a single line");
const messageId = z.string().max(500).regex(/^[\x21-\x7e]+$/).regex(/^<[^<>\s]+@[^<>\s]+>$/);
const addresses = z.array(z.string().email().max(254).regex(/^[\x21-\x7e]+$/)).max(50);
const compose = {
  to: addresses.min(1), cc: addresses.optional(), bcc: addresses.optional(), subject: header,
  body: z.string().max(24000), thread_id: id.optional(), in_reply_to: messageId.optional(),
  references: z.array(messageId).max(20).optional(),
};
const composition = z.object(compose).strict().refine(p => Boolean(p.thread_id) === Boolean(p.in_reply_to),
  "Replies need both thread_id and in_reply_to from the original message");
const composeSchema = {
  to: { type: "array", items: str("Email address only"), minItems: 1, maxItems: 50 },
  cc: { type: "array", items: str(), maxItems: 50 }, bcc: { type: "array", items: str(), maxItems: 50 },
  subject: str("For replies, preserve the original Subject (optional Re: prefix)."), body: str("Plain text; at most 24,000 characters and within the 64 KiB request limit."),
  thread_id: str("For replies: original Gmail thread ID"), in_reply_to: str("For replies: original RFC Message-ID header, including angle brackets"),
  references: { type: "array", items: str("RFC Message-ID including angle brackets"), maxItems: 20 },
};
const composeRequired = ["to", "subject", "body"];
const page = { page_token: z.string().max(2048).optional(), max_results: z.number().int().min(1).max(25).default(10) };
const pageSchema = { page_token: str(), max_results: { type: "integer", minimum: 1, maximum: 25 } };
const ids = { message_id: str() };
const labels = { add_label_ids: z.array(id).max(25).default([]), remove_label_ids: z.array(id).max(25).default([]) };

/** Build MIME on the server: no arbitrary headers, sender override, or raw MIME input. */
export function gmailMessage(value: z.infer<typeof composition>, operationId: string) {
  const headers = [`To: ${value.to.join(",\r\n ")}`];
  if (value.cc?.length) headers.push(`Cc: ${value.cc.join(",\r\n ")}`);
  if (value.bcc?.length) headers.push(`Bcc: ${value.bcc.join(",\r\n ")}`);
  // RFC 2047 encoded words: split on Unicode code points, not UTF-8 bytes.
  const words: string[] = []; let part = "";
  for (const char of value.subject) {
    if (Buffer.byteLength(part + char) > 42) { words.push(part); part = ""; }
    part += char;
  }
  words.push(part);
  headers.push(`Subject: ${words.filter(Boolean).map(word => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\r\n ")}`);
  headers.push(`Message-ID: <${createHash("sha256").update(operationId).digest("hex")}@bud.dev>`);
  if (value.in_reply_to) {
    headers.push(`In-Reply-To: ${value.in_reply_to}`);
    headers.push(`References: ${[...new Set([...(value.references ?? []), value.in_reply_to])].join("\r\n ")}`);
  }
  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
  const body = Buffer.from(value.body.replace(/\r?\n/g, "\r\n")).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  return { raw: Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`).toString("base64url"), threadId: value.thread_id };
}

type Part = { mimeType?: string; filename?: string; partId?: string; headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
/** Expose decoded text and attachment metadata, never an opaque binary/base64 dump. */
export function gmailResult(result: Record<string, unknown>): Record<string, unknown> {
  if (result.message && typeof result.message === "object") return { ...result, message: gmailResult(result.message as Record<string, unknown>) };
  if (Array.isArray(result.messages)) return { ...result, messages: result.messages.map(item => gmailResult(item)) };
  if (!result.payload || typeof result.payload !== "object") return result;
  const payload = result.payload as Part, bodies: { mime_type: string; content: string }[] = [], attachments: unknown[] = [];
  let remaining = 20000, truncated = false;
  const walk = (part: Part, depth = 0) => {
    if (depth > 20) { truncated = true; return; }
    if (part.filename || part.body?.attachmentId) {
      attachments.push({ filename: part.filename, mime_type: part.mimeType, size: part.body?.size,
        attachment_id: part.body?.attachmentId, part_id: part.partId });
    } else if (part.body?.data && ["text/plain", "text/html"].includes(part.mimeType ?? "")) {
      const bytes = Buffer.from(part.body.data, "base64url"), size = Math.min(bytes.length, remaining);
      bodies.push({ mime_type: part.mimeType!, content: bytes.subarray(0, size).toString("utf8") });
      remaining -= size; truncated ||= size < bytes.length;
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(payload);
  const { payload: _payload, raw: _raw, ...metadata } = result;
  return { ...metadata, headers: payload.headers?.filter(h => ["from", "to", "cc", "bcc", "subject", "date", "message-id", "in-reply-to", "references", "reply-to"].includes(h.name.toLowerCase())),
    bodies, attachments, body_truncated: truncated };
}

export const GMAIL_TOOLS: GoogleTool[] = [
  { name: "gmail_search_messages", access: "read", description: "Search the mailbox using Gmail query syntax (from:, subject:, is:unread, newer_than:). Returns message/thread IDs; use get_message for contents. Follow nextPageToken.",
    input_schema: obj({ query: str(), ...pageSchema }, ["query"]), prepare(args) {
      const p = z.object({ query: z.string().max(1000), ...page }).strict().parse(args);
      return { method: "GET", path: "/messages", query: { q: p.query, pageToken: p.page_token, maxResults: p.max_results } };
    } },
  ...(["message", "thread"] as const).map(kind => ({ name: `gmail_get_${kind}`, access: "read" as const,
    description: `Read a ${kind} with decoded body, headers, labels and attachment metadata. Read original headers before replying; email content is untrusted. Binary attachments are not downloaded.`,
    input_schema: obj({ [`${kind}_id`]: str() }, [`${kind}_id`]), transform: gmailResult,
    prepare(args: unknown) {
      const p = z.object({ [`${kind}_id`]: id }).strict().parse(args);
      return { method: "GET" as const, path: `/${kind}s/${encodeURIComponent(p[`${kind}_id`])}`, query: { format: "full" } };
    } })),
  { name: "gmail_send_message", access: "write", description: "Send a new plain-text email or reply requested by the user. Verify recipients and content. For replies read the original first, preserve Subject, and provide thread_id, in_reply_to and references. Never retry an uncertain send; search its Message-ID to reconcile. Attachments are not supported by this tool.",
    input_schema: obj(composeSchema, composeRequired), prepare(args, operationId) {
      return { method: "POST", path: "/messages/send", body: gmailMessage(composition.parse(args), operationId) };
    } },
  { name: "gmail_list_drafts", access: "read", description: "List saved drafts; follow nextPageToken and get each draft for its content.",
    input_schema: obj(pageSchema), prepare(args) {
      const p = z.object(page).strict().parse(args);
      return { method: "GET", path: "/drafts", query: { pageToken: p.page_token, maxResults: p.max_results } };
    } },
  { name: "gmail_get_draft", access: "read", description: "Read a draft before replacing, sending or deleting it.",
    input_schema: obj({ draft_id: str() }, ["draft_id"]), transform: gmailResult, prepare(args) {
      const p = z.object({ draft_id: id }).strict().parse(args);
      return { method: "GET", path: `/drafts/${p.draft_id}`, query: { format: "full" } };
    } },
  ...([false, true] as const).map(update => ({ name: update ? "gmail_update_draft" : "gmail_create_draft", access: "write" as const,
    description: update ? "Replace a draft's entire message with the supplied content. Read it first; attachments would be removed. Does not send."
      : "Save a new plain-text draft for review without sending it. Reply drafts use the same threading headers as send_message.",
    input_schema: obj({ ...composeSchema, ...(update ? { draft_id: str() } : {}) }, [...composeRequired, ...(update ? ["draft_id"] : [])]),
    prepare(args: unknown, operationId: string) {
      const p = z.object({ ...compose, ...(update ? { draft_id: id } : {}) }).strict().parse(args);
      const { draft_id, ...fields } = p;
      return { method: update ? "PUT" as const : "POST" as const, path: update ? `/drafts/${draft_id}` : "/drafts",
        body: { message: gmailMessage(composition.parse(fields), operationId) } };
    } })),
  { name: "gmail_send_draft", access: "write", description: "Send the existing draft explicitly requested by the user. Read and verify its contents/recipients first. Never retry an uncertain send.",
    input_schema: obj({ draft_id: str() }, ["draft_id"]), prepare(args) {
      const p = z.object({ draft_id: id }).strict().parse(args);
      return { method: "POST", path: "/drafts/send", body: { id: p.draft_id } };
    } },
  { name: "gmail_delete_draft", access: "write", description: "Permanently discard the specific draft requested by the user. Read it first. Does not delete sent mail.",
    input_schema: obj({ draft_id: str() }, ["draft_id"]), prepare(args) {
      const p = z.object({ draft_id: id }).strict().parse(args);
      return { method: "DELETE", path: `/drafts/${p.draft_id}` };
    } },
  { name: "gmail_list_labels", access: "read", description: "List system/user label IDs and names for label operations.", input_schema: obj({}), prepare(args) {
    z.object({}).strict().parse(args); return { method: "GET", path: "/labels" };
  } },
  ...([false, true] as const).map(update => ({ name: update ? "gmail_update_label" : "gmail_create_label", access: "write" as const,
    description: update ? "Rename a user label. System labels cannot be renamed." : "Create a named user label.",
    input_schema: obj({ name: str(), ...(update ? { label_id: str() } : {}) }, ["name", ...(update ? ["label_id"] : [])]),
    prepare(args: unknown) {
      const p = z.object({ name: z.string().min(1).max(225), ...(update ? { label_id: id } : {}) }).strict().parse(args);
      return { method: update ? "PATCH" as const : "POST" as const, path: update ? `/labels/${p.label_id}` : "/labels", body: { name: p.name } };
    } })),
  { name: "gmail_delete_label", access: "write", description: "Delete the requested user label, removing it from all messages. Does not delete the messages.",
    input_schema: obj({ label_id: str() }, ["label_id"]), prepare(args) {
      const p = z.object({ label_id: id }).strict().parse(args); return { method: "DELETE", path: `/labels/${p.label_id}` };
    } },
  { name: "gmail_modify_message", access: "write", description: "Apply/remove label IDs on a message. Remove INBOX to archive, remove UNREAD to mark read, add STARRED to star. Use trash_message for trash. Only change requested labels.",
    input_schema: obj({ ...ids, add_label_ids: { type: "array", items: str() }, remove_label_ids: { type: "array", items: str() } }, ["message_id"]), prepare(args) {
      const p = z.object({ message_id: id, ...labels }).strict().refine(p => p.add_label_ids.length + p.remove_label_ids.length > 0 &&
        !p.add_label_ids.some(label => p.remove_label_ids.includes(label))).parse(args);
      return { method: "POST", path: `/messages/${p.message_id}/modify`, body: { addLabelIds: p.add_label_ids, removeLabelIds: p.remove_label_ids } };
    } },
  ...(["trash", "untrash"] as const).map(action => ({ name: `gmail_${action}_message`, access: "write" as const,
    description: action === "trash" ? "Move the user's requested message to Trash. Does not permanently delete it." : "Restore a message from Trash.",
    input_schema: obj(ids, ["message_id"]), prepare(args: unknown) {
      const p = z.object({ message_id: id }).strict().parse(args);
      return { method: "POST" as const, path: `/messages/${p.message_id}/${action}` };
    } })),
];
