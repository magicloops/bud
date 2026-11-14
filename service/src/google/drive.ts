import { randomBytes } from "node:crypto";
import { z } from "zod";
import { GoogleError } from "./config.js";
import { type GoogleRequest, type GoogleTool, objectSchema as obj, stringSchema as str } from "./tool-contracts.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const version = z.string().regex(/^\d{1,30}$/);
const name = z.string().min(1).max(255);
const mime = z.enum(["text/plain", "text/markdown", "text/csv", "text/html", "application/json", "application/pdf", "image/png", "image/jpeg"]);
const content = { content: z.string().max(32000), encoding: z.enum(["utf8", "base64"]).default("utf8"), mime_type: mime.default("text/plain") };
const contentSchema = { content: str("UTF-8 text or base64 bytes; decoded limit 24,000 bytes"), encoding: { type: "string", enum: ["utf8", "base64"] },
  mime_type: { type: "string", enum: mime.options } };
const fields = "id,name,mimeType,size,modifiedTime,parents,trashed,webViewLink,description,capabilities(canEdit,canDownload,canTrash),version";
const fileSchema = { file_id: str("ID from Drive search/get; not a URL or local path") };
const matchSchema = { ...fileSchema, expected_version: str("Latest version from drive_get_file. Checked before dispatch; Google Drive offers no atomic compare-and-swap guarantee here.") };
const page = { page_token: z.string().max(2048).optional(), page_size: z.number().int().min(1).max(25).default(10) };

function upload(p: { content: string; encoding: "utf8" | "base64"; mime_type?: string }, metadata: Record<string, unknown>): Pick<GoogleRequest, "rawBody" | "bodyWithMimeType" | "contentType" | "upload"> {
  if (p.encoding === "base64" && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.content))) {
    throw new z.ZodError([{ code: "custom", path: ["content"], message: "Use canonical base64" }]);
  }
  const bytes = Buffer.from(p.content, p.encoding === "base64" ? "base64" : "utf8");
  if (bytes.length > 24000) throw new z.ZodError([{ code: "custom", path: ["content"], message: "File content exceeds 24,000 bytes" }]);
  const boundary = `bud_${randomBytes(24).toString("hex")}`;
  const makeBody = (mediaType: string) => {
    if (mediaType.length > 255 || !/^[a-z0-9!#$%&'*+.^_|~-]+\/[a-z0-9!#$%&'*+.^_|~-]+$/i.test(mediaType)) {
      throw new GoogleError("google_invalid_file_mime_type");
    }
    return new Uint8Array(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]));
  };
  return { upload: true, contentType: `multipart/related; boundary=${boundary}`,
    ...(p.mime_type ? { rawBody: makeBody(p.mime_type) } : { bodyWithMimeType: makeBody }) };
}

export const DRIVE_TOOLS: GoogleTool[] = [
  { name: "drive_search_files", access: "read", description: "Search existing Drive files with Drive v3 q syntax (name contains 'resume', 'folderId' in parents). Defaults to excluding Trash. Searches user/shared files; pass drive_id to search a specific shared drive. Follow nextPageToken; incompleteSearch means results are incomplete.",
    input_schema: obj({ query: str("Drive q expression; e.g. trashed = false and name contains 'resume'"), ...{ page_token: str(), page_size: { type: "integer", minimum: 1, maximum: 25 } }, drive_id: str() }), prepare(args) {
      const p = z.object({ query: z.string().max(2000).default("trashed = false"), ...page, drive_id: id.optional() }).strict().parse(args);
      return { method: "GET", path: "/files", query: { q: p.query, pageToken: p.page_token, pageSize: p.page_size,
        corpora: p.drive_id ? "drive" : "user", driveId: p.drive_id, includeItemsFromAllDrives: true, supportsAllDrives: true,
        fields: `nextPageToken,incompleteSearch,files(${fields})` } };
    } },
  { name: "drive_get_file", access: "read", description: "Get file metadata, capabilities, web link and version before editing. Does not read file contents.",
    input_schema: obj(fileSchema, ["file_id"]), prepare(args) {
      const p = z.object({ file_id: id }).strict().parse(args);
      return { method: "GET", path: `/files/${p.file_id}`, query: { fields, supportsAllDrives: true } };
    } },
  { name: "drive_read_file", access: "read", description: "Read text files, or export Google Docs/Slides as text/plain and Sheets as text/csv (first sheet). First inspect mimeType with get_file. Text is capped at 24,000 bytes; responses over 1 MiB fail. Binary PDF/image parsing is not supported; use the Drive web link instead.",
    input_schema: obj({ ...fileSchema, export_mime_type: { type: "string", enum: ["text/plain", "text/csv"] } }, ["file_id"]), prepare(args) {
      const p = z.object({ file_id: id, export_mime_type: z.enum(["text/plain", "text/csv"]).optional() }).strict().parse(args);
      return { method: "GET", path: `/files/${p.file_id}${p.export_mime_type ? "/export" : ""}`, responseMode: "text",
        query: p.export_mime_type ? { mimeType: p.export_mime_type } : { alt: "media", supportsAllDrives: true } };
    } },
  { name: "drive_create_folder", access: "write", description: "Create a folder in My Drive or the specified parent folder. Never retry a create with unknown outcome; search for it first.",
    input_schema: obj({ name: str(), parent_id: str() }, ["name"]), prepare(args) {
      const p = z.object({ name, parent_id: id.optional() }).strict().parse(args);
      return { method: "POST", path: "/files", query: { fields, supportsAllDrives: true },
        body: { name: p.name, mimeType: "application/vnd.google-apps.folder", ...(p.parent_id ? { parents: [p.parent_id] } : {}) } };
    } },
  { name: "drive_upload_file", access: "write", description: "Create/upload a small file from supplied content (24,000 bytes decoded limit), optionally in a folder. convert_to_doc imports text/HTML as a Google Doc. No local paths or arbitrary URLs. Verify destination; never retry an uncertain upload.",
    input_schema: obj({ name: str(), parent_id: str(), ...contentSchema, convert_to_doc: { type: "boolean" } }, ["name", "content"]), prepare(args) {
      const p = z.object({ name, parent_id: id.optional(), ...content, convert_to_doc: z.boolean().default(false) }).strict()
        .refine(p => !p.convert_to_doc || ["text/plain", "text/html"].includes(p.mime_type)).parse(args);
      return { method: "POST", path: "/files", query: { uploadType: "multipart", fields, supportsAllDrives: true },
        ...upload(p, { name: p.name, mimeType: p.convert_to_doc ? "application/vnd.google-apps.document" : p.mime_type,
          ...(p.parent_id ? { parents: [p.parent_id] } : {}) }) };
    } },
  { name: "drive_update_file", access: "write", description: "Patch file name/description or replace all content using the latest version. Read metadata/content first. Content replacement is for uploaded files, not Google-native Docs/Sheets/Slides. Omitted fields stay unchanged; replacing content overwrites the entire file.",
    input_schema: obj({ ...matchSchema, name: str(), description: str(), ...contentSchema }, ["file_id", "expected_version"]), prepare(args) {
      const p = z.object({ file_id: id, expected_version: version, name: name.optional(), description: z.string().max(8000).optional(),
        ...content, mime_type: mime.optional(), content: content.content.optional() }).strict().refine(p => p.name !== undefined || p.description !== undefined || p.content !== undefined).parse(args);
      const metadata = { name: p.name, description: p.description };
      return { method: "PATCH", path: `/files/${p.file_id}`, filePreflight: { fileId: p.file_id, version: p.expected_version, uploadedOnly: p.content !== undefined },
        query: { fields, supportsAllDrives: true, ...(p.content !== undefined ? { uploadType: "multipart" } : {}) },
        ...(p.content === undefined ? { body: metadata } : upload({ ...p, content: p.content }, metadata)) };
    } },
  { name: "drive_copy_file", access: "write", description: "Copy an existing file (including Google-native files) with an optional new name/parent. Does not copy a folder tree. Never retry an uncertain copy.",
    input_schema: obj({ ...fileSchema, name: str(), parent_id: str() }, ["file_id"]), prepare(args) {
      const p = z.object({ file_id: id, name: name.optional(), parent_id: id.optional() }).strict().parse(args);
      return { method: "POST", path: `/files/${p.file_id}/copy`, query: { fields, supportsAllDrives: true },
        body: { name: p.name, ...(p.parent_id ? { parents: [p.parent_id] } : {}) } };
    } },
  { name: "drive_move_file", access: "write", description: "Move a file/folder using its current parent IDs and version from get_file. Supply destination parent and all current parents to remove. Does not change sharing permissions.",
    input_schema: obj({ ...matchSchema, parent_id: str(), remove_parent_ids: { type: "array", items: str(), maxItems: 10 } }, ["file_id", "expected_version", "parent_id", "remove_parent_ids"]), prepare(args) {
      const p = z.object({ file_id: id, expected_version: version, parent_id: id, remove_parent_ids: z.array(id).max(10) }).strict()
        .refine(p => !p.remove_parent_ids.includes(p.parent_id)).parse(args);
      return { method: "PATCH", path: `/files/${p.file_id}`, filePreflight: { fileId: p.file_id, version: p.expected_version }, body: {},
        query: { fields, supportsAllDrives: true, addParents: p.parent_id, removeParents: p.remove_parent_ids.join(",") || undefined } };
    } },
  ...([true, false] as const).map(trashed => ({ name: trashed ? "drive_trash_file" : "drive_restore_file", access: "write" as const,
    description: trashed ? "Move the requested file/folder to Trash using its latest version. A folder includes its descendants. No permanent deletion."
      : "Restore a file/folder from Trash using its latest version.", input_schema: obj(matchSchema, ["file_id", "expected_version"]), prepare(args: unknown) {
      const p = z.object({ file_id: id, expected_version: version }).strict().parse(args);
      return { method: "PATCH" as const, path: `/files/${p.file_id}`, filePreflight: { fileId: p.file_id, version: p.expected_version },
        query: { fields, supportsAllDrives: true }, body: { trashed } };
    } })),
];
