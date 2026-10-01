import { z } from "zod";
const Cursor = z.object({ v: z.literal(1), owner: z.string(), bud_id: z.string().nullable(),
  at: z.string().datetime(), created: z.string().datetime(), id: z.string().uuid() }).strict();
export type ThreadListCursor = z.infer<typeof Cursor>;
export function encodeThreadListCursor(owner: string, budId: string | undefined,
  row: { last_conversation_at: Date; created_at: Date; thread_id: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, owner, bud_id: budId ?? null,
    at: row.last_conversation_at.toISOString(), created: row.created_at.toISOString(), id: row.thread_id })).toString("base64url");
}
export function decodeThreadListCursor(value: string, owner: string, budId?: string): ThreadListCursor | null {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = Cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.owner === owner && parsed.bud_id === (budId ?? null) ? parsed : null;
  } catch { return null; }
}
