import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { messageTable, threadTable } from "../db/schema.js";
import {
  providerRegistry,
  type CanonicalMessage,
  type CanonicalResponse,
  type CanonicalStreamEvent,
  type ModelConfig,
} from "../llm/index.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";

const THREAD_TITLE_EVENT = "thread.title";
const THREAD_TITLE_MODEL = "claude-haiku-4-5";
const THREAD_TITLE_SOURCE = "generated_first_user_message";
const THREAD_TITLE_MAX_OUTPUT_TOKENS = 24;
const THREAD_TITLE_TIMEOUT_MS = 8_000;

const TITLE_SYSTEM_PROMPT = [
  "You generate short conversation titles.",
  "Summarize the user's first message in 3 to 5 words.",
  "Return plain text only.",
  "Do not use quotes, labels, markdown, or trailing punctuation unless required.",
  "Prefer concrete wording over generic phrases.",
].join(" ");

type PersistedThreadTitle = {
  threadId: string;
  title: string;
  updatedAt: string;
};

type GenerateThreadTitleInput = {
  threadId: string;
  userMessageId: string;
  userMessageText: string;
};

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

function extractResponseText(response: CanonicalResponse): string {
  return normalizeWhitespace(
    response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(" "),
  );
}

export function resolveThreadTitleModel(): string | null {
  const candidates = [
    config.defaultModel,
    THREAD_TITLE_MODEL,
    ...providerRegistry.listModels(),
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      providerRegistry.getProviderForModel(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

export function normalizeGeneratedThreadTitle(candidate: string): string | null {
  const trimmedCandidate = candidate.trim();
  if (!trimmedCandidate) {
    return null;
  }

  const firstLine = candidate
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return null;
  }

  let title = normalizeWhitespace(firstLine);
  title = title.replace(/^title\s*:\s*/i, "");
  title = title.replace(/^["'`]+|["'`]+$/g, "");
  title = title.replace(/[.!?]+$/g, "");
  title = normalizeWhitespace(title);

  if (!title) {
    return null;
  }

  if (title.length === 0 || title.length > 80) {
    return null;
  }

  return title;
}

export class ThreadTitleService {
  private readonly runtime: AgentRuntimeStateManager;
  private readonly logger: FastifyBaseLogger;

  constructor(runtime: AgentRuntimeStateManager, logger: FastifyBaseLogger) {
    this.runtime = runtime;
    this.logger = logger;
  }

  async maybeGenerateFromFirstUserMessage(input: GenerateThreadTitleInput): Promise<void> {
    const { threadId, userMessageId, userMessageText } = input;
    const shouldGenerate = await this.isFirstUserMessageWithoutTitle(threadId, userMessageId);

    if (!shouldGenerate) {
      return;
    }

    const title = await this.generateTitle(userMessageText);
    if (!title) {
      this.logger.warn(
        { threadId, messageId: userMessageId, component: "thread_title" },
        "Skipping empty or invalid generated thread title",
      );
      return;
    }

    const persisted = await this.persistThreadTitle(threadId, title);
    if (!persisted) {
      return;
    }

    const cursor = this.runtime.emit(threadId, {
      event: THREAD_TITLE_EVENT,
      data: {
        thread_id: persisted.threadId,
        title: persisted.title,
        source: THREAD_TITLE_SOURCE,
        updated_at: persisted.updatedAt,
      },
    });
    this.runtime.advanceCursor(threadId, cursor);

    this.logger.info(
      {
        threadId: persisted.threadId,
        title: persisted.title,
        component: "thread_title",
      },
      "Generated thread title",
    );
  }

  private async isFirstUserMessageWithoutTitle(
    threadId: string,
    userMessageId: string,
  ): Promise<boolean> {
    const [thread] = await db
      .select({ title: threadTable.title })
      .from(threadTable)
      .where(eq(threadTable.threadId, threadId))
      .limit(1);

    if (!thread || thread.title !== null) {
      return false;
    }

    const [firstMessage] = await db
      .select({ messageId: messageTable.messageId })
      .from(messageTable)
      .where(and(eq(messageTable.threadId, threadId), eq(messageTable.role, "user")))
      .orderBy(asc(messageTable.createdAt), asc(messageTable.messageId))
      .limit(1);

    return firstMessage?.messageId === userMessageId;
  }

  private async generateTitle(userMessageText: string): Promise<string | null> {
    const model = resolveThreadTitleModel();
    if (!model) {
      return null;
    }

    const provider = providerRegistry.getProviderForModel(model);
    const resolvedModel = providerRegistry.resolveModelAlias(model);
    const modelConfig: ModelConfig = {
      model: resolvedModel,
      maxOutputTokens: THREAD_TITLE_MAX_OUTPUT_TOKENS,
      temperature: 0,
      toolChoice: "none",
      reasoning: {
        enabled: false,
      },
    };

    const messages: CanonicalMessage[] = [
      {
        role: "system",
        content: TITLE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: userMessageText,
      },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), THREAD_TITLE_TIMEOUT_MS);

    try {
      const response = provider.invokeSync
        ? await provider.invokeSync(messages, [], modelConfig, controller.signal)
        : await this.collectResponse(provider.invoke(messages, [], modelConfig, controller.signal));

      return normalizeGeneratedThreadTitle(extractResponseText(response));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async collectResponse(
    stream: AsyncIterable<CanonicalStreamEvent>,
  ): Promise<CanonicalResponse> {
    const content: CanonicalResponse["content"] = [];
    let responseId = "";
    let stopReason: CanonicalResponse["stopReason"] = "end_turn";
    let usage: CanonicalResponse["usage"] | undefined;
    let activeTextIndex = -1;

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          responseId = event.id ?? responseId;
          break;
        case "content_start":
          if (event.content_type === "text") {
            content.push({ type: "text", text: "" });
            activeTextIndex = content.length - 1;
          }
          break;
        case "text_delta":
          {
            const activeTextBlock = activeTextIndex >= 0 ? content[activeTextIndex] : undefined;
            if (activeTextBlock?.type !== "text") {
              break;
            }
            content[activeTextIndex] = {
              type: "text",
              text: `${activeTextBlock.text}${event.delta ?? ""}`,
            };
          }
          break;
        case "reasoning_done":
        case "reasoning_redacted":
          if (event.block) {
            content.push(event.block);
          }
          activeTextIndex = -1;
          break;
        case "content_done":
          activeTextIndex = -1;
          break;
        case "message_done":
          stopReason = event.stop_reason ?? stopReason;
          usage = event.usage;
          break;
        case "error":
          throw event.error;
        default:
          break;
      }
    }

    return {
      id: responseId,
      content,
      stopReason,
      usage,
    };
  }

  private async persistThreadTitle(threadId: string, title: string): Promise<PersistedThreadTitle | null> {
    const updatedAt = new Date();
    const [thread] = await db
      .update(threadTable)
      .set({ title })
      .where(and(eq(threadTable.threadId, threadId), isNull(threadTable.title)))
      .returning({
        threadId: threadTable.threadId,
        title: threadTable.title,
      });

    if (!thread?.title) {
      return null;
    }

    return {
      threadId: thread.threadId,
      title: thread.title,
      updatedAt: updatedAt.toISOString(),
    };
  }
}
