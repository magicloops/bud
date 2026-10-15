import { z } from 'zod';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
export const MAX_USER_BYTES = 1024 * 1024 * 1024;
export const fileId = z.string().regex(/^file_[0-9A-HJKMNP-TV-Z]{26}$/);
export const attachmentIds = z.array(fileId).max(10).refine(ids => new Set(ids).size === ids.length);
export const fileIntent = z.object({
  name: z.string().trim().min(1).max(240).refine(name => Buffer.byteLength(name) <= 255 &&
    !/[\x00-\x1f\x7f/\\]/.test(name) && name !== '.' && name !== '..'),
  mime_type: z.string().max(200).regex(/^[\w.+-]+\/[\w.+-]+$/).default('application/octet-stream'),
  size_bytes: z.number().int().min(1).max(MAX_FILE_BYTES),
}).strict();
export type FileIntent = z.infer<typeof fileIntent>;
export const fileSearch = z.object({ query: z.string().trim().max(200).default(''),
  cursor: fileId.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export type FileAttachment = { file_id: string; name: string; mime_type: string; size_bytes: number };
export class FileError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function assertFileId(id: string) {
  if (!fileId.safeParse(id).success) throw new FileError('file_not_found', 404);
}
