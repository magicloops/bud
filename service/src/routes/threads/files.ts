import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
import { messageTable } from "../../db/schema.js";
import {
  DEFAULT_FILE_SESSION_TTL_SECONDS,
  DEFAULT_FILE_ROOT_KEY,
  FILE_SESSION_PERMISSIONS,
  FileSessionValidationError,
  VIEWER_FILE_SESSION_MAX_BYTES,
  createFileSession,
  parseViewerFilePath,
  serializeFileSession,
} from "../../files/file-session.js";
import {
  ThreadParamsSchema,
  requireAuthorizedThreadAccess,
} from "./shared.js";

const OpenThreadFileBodySchema = z.object({
  path: z.string().trim().min(1).max(4096),
  source: z
    .object({
      kind: z.enum(["assistant_message", "markdown_preview", "unknown"]).optional().default("unknown"),
      message_id: z.string().uuid().optional(),
      client_id: z.string().uuid().optional(),
      text_range: z
        .object({
          start: z.number().int().min(0),
          end: z.number().int().min(0),
        })
        .refine((value) => value.end >= value.start, {
          message: "text_range.end must be greater than or equal to text_range.start",
        })
        .optional(),
    })
    .optional(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  viewer_intent: z.literal("preview").optional().default("preview"),
});

type ViewerKind = "markdown" | "code" | "text" | "unknown";

const extensionLanguageMap = new Map<string, string>([
  [".c", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cs", "csharp"],
  [".css", "css"],
  [".go", "go"],
  [".html", "html"],
  [".java", "java"],
  [".js", "javascript"],
  [".json", "json"],
  [".jsx", "jsx"],
  [".kt", "kotlin"],
  [".mdx", "mdx"],
  [".mjs", "javascript"],
  [".py", "python"],
  [".rb", "ruby"],
  [".rs", "rust"],
  [".sh", "bash"],
  [".sql", "sql"],
  [".swift", "swift"],
  [".toml", "toml"],
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);

export async function registerThreadFileRoutes(server: FastifyInstance): Promise<void> {
  server.post("/api/threads/:threadId/files/open", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const bodyResult = OpenThreadFileBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "invalid_file_open_request",
        message: bodyResult.error.issues[0]?.message ?? "Invalid file open request",
      });
    }

    const { thread, viewer } = access;
    let parsedPath: ReturnType<typeof parseViewerFilePath>;
    try {
      parsedPath = parseViewerFilePath(bodyResult.data.path, {
        line: bodyResult.data.line,
        column: bodyResult.data.column,
      });
    } catch (err) {
      if (err instanceof FileSessionValidationError) {
        return reply.status(400).send({
          error: "invalid_file_path",
          code: err.code,
          message: err.message,
        });
      }
      throw err;
    }

    const pathContext = await loadSourceMessagePathContext({
      threadId: thread.threadId,
      viewerUserId: viewer.userId,
      source: bodyResult.data.source,
    });
    const displayMetadata = compactRecord({
      raw_path: parsedPath.rawPath,
      source: bodyResult.data.source,
      path_context: pathContext,
      line: parsedPath.line,
      column: parsedPath.column,
      viewer_intent: bodyResult.data.viewer_intent,
    });

    const result = await createFileSession({
      viewer,
      budId: thread.budId,
      body: {
        root_key: DEFAULT_FILE_ROOT_KEY,
        relative_path: parsedPath.relativePath,
        permissions: [...FILE_SESSION_PERMISSIONS],
        max_bytes: VIEWER_FILE_SESSION_MAX_BYTES,
        ttl_seconds: DEFAULT_FILE_SESSION_TTL_SECONDS,
        thread_id: thread.threadId,
        display_metadata: displayMetadata,
      },
    });

    return reply.status(201).send({
      file_session: serializeFileSession(result.session, result.transportStatus),
      viewer: buildViewerHint({
        relativePath: parsedPath.relativePath,
        line: parsedPath.line,
        column: parsedPath.column,
      }),
    });
  });
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

async function loadSourceMessagePathContext(args: {
  threadId: string;
  viewerUserId: string;
  source: z.infer<typeof OpenThreadFileBodySchema>["source"] | undefined;
}): Promise<Record<string, unknown> | undefined> {
  const messageId = args.source?.message_id;
  if (!messageId) {
    return undefined;
  }

  const [message] = await db
    .select({ metadata: messageTable.metadata })
    .from(messageTable)
    .where(
      and(
        eq(messageTable.threadId, args.threadId),
        eq(messageTable.createdByUserId, args.viewerUserId),
        eq(messageTable.messageId, messageId),
      ),
    )
    .limit(1);

  return extractTerminalPathContext(message?.metadata);
}

function extractTerminalPathContext(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const pathContext = metadata.path_context;
  if (!isRecord(pathContext)) {
    return undefined;
  }
  if (
    pathContext.schema !== "terminal_cwd_v1" ||
    pathContext.source !== "terminal_runtime_cache" ||
    pathContext.reported_by !== "tmux_pane_current_path" ||
    typeof pathContext.terminal_session_id !== "string" ||
    typeof pathContext.host_cwd !== "string" ||
    typeof pathContext.captured_at !== "string"
  ) {
    return undefined;
  }
  return pathContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildViewerHint(args: {
  relativePath: string;
  line?: number;
  column?: number;
}): Record<string, unknown> {
  const displayName = args.relativePath.split("/").at(-1) ?? args.relativePath;
  const extension = extensionForPath(displayName);
  const markdown = extension === ".md" || extension === ".markdown" || extension === ".mdx";
  const language = extensionLanguageMap.get(extension);
  const suggestedKind: ViewerKind = markdown ? "markdown" : language ? "code" : "unknown";

  return compactRecord({
    suggested_kind: suggestedKind,
    language,
    display_name: displayName,
    line: args.line,
    column: args.column,
    max_display_bytes: VIEWER_FILE_SESSION_MAX_BYTES,
  });
}

function extensionForPath(path: string): string {
  const basename = path.split("/").at(-1) ?? path;
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) {
    return "";
  }
  return basename.slice(dotIndex).toLowerCase();
}
