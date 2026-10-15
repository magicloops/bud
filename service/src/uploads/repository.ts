import { and, eq, inArray, isNull, sql, desc, lt } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, type Database } from '../db/client.js';
import { userFileTable, type UserFile } from './schema.js';
import { attachmentIds, assertFileId, FileError, MAX_MESSAGE_BYTES, MAX_USER_BYTES, type FileIntent } from './contracts.js';

export const attachment = (file: UserFile) => ({ file_id: file.id, name: file.name,
  mime_type: file.mimeType, size_bytes: file.sizeBytes });

export class FileRepository {
  constructor(private readonly database: Database = db) {}
  async search(owner: string, input: { query: string; cursor?: string; limit: number }) {
    // Literal substring search, scoped in SQL before pagination. Extracted text is
    // searchable only after a file has been read; never parse the whole library.
    const pattern = `%${input.query.replace(/[\\%_]/g, value => '\\' + value)}%`;
    const rows = await this.database.select({ id: userFileTable.id, name: userFileTable.name,
      mimeType: userFileTable.mimeType, sizeBytes: userFileTable.sizeBytes }).from(userFileTable).where(and(
      eq(userFileTable.createdByUserId, owner), isNull(userFileTable.deletedAt), eq(userFileTable.state, 'ready'),
      input.cursor ? lt(userFileTable.id, input.cursor) : undefined,
      input.query ? sql`(${userFileTable.name} ilike ${pattern} or ${userFileTable.document}->>'pages' ilike ${pattern})` : undefined,
    )).orderBy(desc(userFileTable.id)).limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    return { files: page.map(file => ({ file_id: file.id, name: file.name, mime_type: file.mimeType, size_bytes: file.sizeBytes })),
      next_cursor: rows.length > input.limit ? page.at(-1)!.id : null };
  }
  async reserve(owner: string, intent: FileIntent) {
    return this.database.transaction(async tx => {
      // Serialize reservations per owner, including parallel requests/instances.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`files:${owner}`}, 0))`);
      const [usage] = await tx.select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${userFileTable.sizeBytes}),0)::float8` })
        .from(userFileTable).where(and(eq(userFileTable.createdByUserId, owner), isNull(userFileTable.deletedAt),
          sql`(${userFileTable.state} = 'ready' or (${userFileTable.state} in ('pending','uploading') and ${userFileTable.createdAt} > now() - interval '1 hour'))`));
      if (usage.count >= 1000) throw new FileError('file_count_quota_exceeded', 413);
      if (Number(usage.bytes) + intent.size_bytes > MAX_USER_BYTES) throw new FileError('file_quota_exceeded', 413);
      const [row] = await tx.insert(userFileTable).values({ id: `file_${ulid()}`, createdByUserId: owner,
        name: intent.name, mimeType: intent.mime_type, sizeBytes: intent.size_bytes }).returning();
      return row;
    });
  }
  async owned(owner: string, id: string, ready = true) {
    assertFileId(id);
    const [row] = await this.database.select().from(userFileTable).where(and(eq(userFileTable.id, id),
      eq(userFileTable.createdByUserId, owner), isNull(userFileTable.deletedAt),
      ...(ready ? [eq(userFileTable.state, 'ready')] : []))).limit(1);
    if (!row) throw new FileError('file_not_found', 404);
    return row;
  }
  async begin(owner: string, id: string) {
    await this.owned(owner, id, false);
    const [row] = await this.database.update(userFileTable).set({ state: 'uploading', updatedAt: new Date() })
      .where(and(eq(userFileTable.id, id), eq(userFileTable.createdByUserId, owner), isNull(userFileTable.deletedAt),
        eq(userFileTable.state, 'pending'), sql`${userFileTable.createdAt} > now() - interval '1 hour'`)).returning();
    if (!row) throw new FileError('upload_already_started_or_expired', 409);
    return row;
  }
  async finish(owner: string, id: string, sha256: string) {
    const [row] = await this.database.update(userFileTable).set({ state: 'ready', sha256, updatedAt: new Date() })
      .where(and(eq(userFileTable.id, id), eq(userFileTable.createdByUserId, owner), isNull(userFileTable.deletedAt),
        eq(userFileTable.state, 'uploading'))).returning();
    if (!row) throw new FileError('file_not_found', 404);
    return row;
  }
  async fail(owner: string, id: string) {
    await this.database.update(userFileTable).set({ state: 'failed', updatedAt: new Date() }).where(and(
      eq(userFileTable.id, id), eq(userFileTable.createdByUserId, owner), eq(userFileTable.state, 'uploading')));
  }
  async attachments(owner: string, input: unknown) {
    const parsed = attachmentIds.safeParse(input ?? []);
    if (!parsed.success) throw new FileError('invalid_attachments');
    const files = await Promise.all(parsed.data.map(id => this.owned(owner, id)));
    if (files.reduce((sum, file) => sum + file.sizeBytes, 0) > MAX_MESSAGE_BYTES) throw new FileError('attachments_too_large', 413);
    return files.map(attachment);
  }
  async saveDocument(owner: string, id: string, document: NonNullable<UserFile['document']>) {
    await this.database.update(userFileTable).set({ document, processingState: 'ready', updatedAt: new Date() })
      .where(and(eq(userFileTable.id, id), eq(userFileTable.createdByUserId, owner), isNull(userFileTable.deletedAt), eq(userFileTable.state, 'ready')));
  }
  async remove(owner: string, id: string) {
    await this.owned(owner, id, false);
    await this.database.update(userFileTable).set({ deletedAt: new Date(), document: null, updatedAt: new Date() })
      .where(and(eq(userFileTable.id, id), eq(userFileTable.createdByUserId, owner)));
  }
  async cleanupCandidates() {
    return this.database.select({ id: userFileTable.id }).from(userFileTable).where(sql`
      ${userFileTable.deletedAt} is not null or ${userFileTable.state} = 'failed' or
      (${userFileTable.state} in ('pending','uploading') and ${userFileTable.createdAt} < now() - interval '1 hour')`).limit(100);
  }
  async forget(ids: string[]) {
    if (ids.length) await this.database.delete(userFileTable).where(and(inArray(userFileTable.id, ids), sql`
      ${userFileTable.deletedAt} is not null or ${userFileTable.state} = 'failed' or
      (${userFileTable.state} in ('pending','uploading') and ${userFileTable.createdAt} < now() - interval '1 hour')`));
  }
}
export const files = new FileRepository();
