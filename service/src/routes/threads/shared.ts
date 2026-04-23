import { Buffer } from "node:buffer";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
import { messageTable, threadTable } from "../../db/schema.js";
import { getAuthorizedThread, requireViewer } from "../../auth/session.js";

type AuthorizedThreadAccess = {
  viewer: NonNullable<Awaited<ReturnType<typeof requireViewer>>>;
  thread: NonNullable<Awaited<ReturnType<typeof getAuthorizedThread>>>;
};

type SerializedThread = {
  thread_id: string;
  bud_id: string;
  title: string | null;
  created_at: Date;
  last_activity_at: Date;
  last_message_preview: string | null;
  message_count: number;
  pinned: boolean;
  archived: boolean;
};

type SerializedMessage = {
  message_id: string;
  client_id: string;
  role: string;
  display_role: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
};

export const CreateThreadSchema = z.object({
  bud_id: z.string().min(1),
  title: z.string().optional()
});

export const CreateMessageSchema = z.object({
  text: z.string().min(1),
  client_id: z.string().uuid().optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional()
});

export const MarkThreadReadSchema = z.object({
  last_seen_message_id: z.string().uuid(),
});

export const ThreadParamsSchema = z.object({
  threadId: z.string().uuid()
});

export const ThreadListQuerySchema = z.object({
  bud_id: z.string().optional()
});

export const StreamResumeQuerySchema = z.object({
  after: z.string().min(1).optional(),
  last_event_id: z.string().min(1).optional(),
}).refine((value) => !(value.after && value.last_event_id), {
  message: "after and last_event_id cannot both be set",
});

export const MessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
}).refine((value) => !(value.before && value.after), {
  message: "before and after cannot both be set",
});

export const TerminalEnsureBodySchema = z
  .object({
    shell: z.string().optional(),
    cwd: z.string().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional()
  })
  .partial();

export const TerminalResizeBodySchema = z.object({
  cols: z.number().int().positive().min(1).max(500),
  rows: z.number().int().positive().min(1).max(200)
});

export const TerminalInputBodySchema = z.object({
  input: z.string().min(1)
});

export function serializeThread(row: typeof threadTable.$inferSelect): SerializedThread {
  return {
    thread_id: row.threadId,
    bud_id: row.budId,
    title: row.title,
    created_at: row.createdAt,
    last_activity_at: row.lastActivityAt,
    last_message_preview: row.lastMessagePreview,
    message_count: row.messageCount,
    pinned: row.pinned,
    archived: row.archived
  };
}

export function serializeMessage(row: typeof messageTable.$inferSelect): SerializedMessage {
  return {
    message_id: row.messageId,
    client_id: row.clientId,
    role: row.role,
    display_role: row.displayRole ?? row.role,
    content: row.content,
    metadata: row.metadata ?? {},
    created_at: row.createdAt
  };
}

const MessageCursorSchema = z.object({
  created_at: z.string(),
  message_id: z.string().uuid(),
});

export type MessageCursor = {
  createdAt: Date;
  messageId: string;
};

export function encodeMessageCursor(
  row: Pick<typeof messageTable.$inferSelect, "createdAt" | "messageId">,
): string {
  return Buffer.from(
    JSON.stringify({
      created_at: row.createdAt.toISOString(),
      message_id: row.messageId,
    }),
    "utf-8",
  ).toString("base64url");
}

export function decodeMessageCursor(value: string): MessageCursor | null {
  try {
    const parsed = MessageCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf-8")),
    );
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return {
      createdAt,
      messageId: parsed.message_id,
    };
  } catch {
    return null;
  }
}

export function olderThanMessageCursor(cursor: MessageCursor): ReturnType<typeof or> {
  return or(
    lt(messageTable.createdAt, cursor.createdAt),
    and(eq(messageTable.createdAt, cursor.createdAt), lt(messageTable.messageId, cursor.messageId)),
  );
}

export function newerThanMessageCursor(cursor: MessageCursor): ReturnType<typeof or> {
  return or(
    gt(messageTable.createdAt, cursor.createdAt),
    and(eq(messageTable.createdAt, cursor.createdAt), gt(messageTable.messageId, cursor.messageId)),
  );
}

export async function requireAuthorizedThreadAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  threadId: string,
): Promise<AuthorizedThreadAccess | null> {
  const viewer = await requireViewer(request, reply);
  if (!viewer) {
    return null;
  }

  const thread = await getAuthorizedThread(viewer, threadId);
  if (!thread) {
    reply.code(404).send({ error: "thread_not_found" });
    return null;
  }

  return { viewer, thread };
}

export function readLastEventId(request: FastifyRequest, queryValue?: string): string | null {
  if (queryValue) {
    return queryValue;
  }

  const header = request.headers["last-event-id"];
  if (Array.isArray(header)) {
    return header[0] ?? null;
  }

  return typeof header === "string" && header.length > 0 ? header : null;
}

export async function findOwnedUserMessageByClientId(
  threadId: string,
  userId: string,
  clientId: string,
): Promise<{ messageId: string } | null> {
  const [message] = await db
    .select({ messageId: messageTable.messageId })
    .from(messageTable)
    .where(
      and(
        eq(messageTable.threadId, threadId),
        eq(messageTable.createdByUserId, userId),
        eq(messageTable.role, "user"),
        eq(messageTable.clientId, clientId),
      ),
    )
    .limit(1);

  return message ?? null;
}

export function isUniqueViolation(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
