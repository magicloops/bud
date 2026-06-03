import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalProviderId,
  CanonicalResponse,
  CanonicalTool,
  ModelConfig,
  ReasoningConfig,
  TokenUsage,
} from "../llm/index.js";
import type { ReasoningEffortSetting } from "../config.js";

export type ModelContextDriftRecorderConfig = {
  outputDir: string;
  includeText: boolean;
  maxPreviewChars: number;
  writeJson: boolean;
  writeMarkdown: boolean;
  providerRenderedSnapshots: boolean;
  filters: {
    threadId: string | null;
    provider: string | null;
    model: string | null;
  };
};

export type ModelContextDriftPromptCaptureArgs = {
  threadId: string;
  turnId: string;
  provider: CanonicalProviderId;
  productModel: string;
  providerModel: string;
  reasoningEffort: ReasoningEffortSetting;
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  modelConfig: ModelConfig;
  providerRenderedRequest?: unknown;
};

export type ModelContextDriftResponseCaptureArgs = {
  sequence: number | null;
  threadId: string;
  turnId: string;
  response: CanonicalResponse;
};

export type ModelContextDriftRecorderLike = {
  capturePrompt(args: ModelContextDriftPromptCaptureArgs): number | null;
  captureResponse(args: ModelContextDriftResponseCaptureArgs): void;
};

type DriftLogger = Pick<FastifyBaseLogger, "info" | "warn">;

type PromptMessageSummary = {
  index: number;
  role: CanonicalMessage["role"];
  source: MessageSource;
  blockSummary: string;
  blockExactHashes: string[];
  blockSemanticHashes: string[];
  toolUseIds: string[];
  toolResultIds: string[];
  charCount: number;
  exactHash: string;
  semanticHash: string;
  preview?: string;
  text?: string;
};

type PromptToolSummary = {
  index: number;
  name: string;
  exactHash: string;
  semanticHash: string;
  schemaCharCount: number;
};

type ModelConfigSummary = {
  model: string;
  maxOutputTokens?: number;
  responseFormat?: ModelConfig["responseFormat"];
  toolChoice?: unknown;
  reasoningEnabled?: boolean;
  reasoning?: ReasoningConfig;
  temperature?: number;
  topP?: number;
  topK?: number;
};

type PromptSnapshot = {
  schema: "agent_model_context_snapshot_v1";
  sequence: number;
  capturedAt: string;
  threadId: string;
  turnId: string;
  provider: CanonicalProviderId;
  productModel: string;
  providerModel: string;
  reasoningEffort: ReasoningEffortSetting;
  messageCount: number;
  toolCount: number;
  hashes: {
    canonicalExact: string;
    canonicalSemantic: string;
    messagesExact: string;
    toolsExact: string;
    modelConfigExact: string;
    modelConfigSemantic: string;
  };
  messages: PromptMessageSummary[];
  tools: PromptToolSummary[];
  modelConfig: ModelConfigSummary;
};

type ResponseBlockSummary = {
  index: number;
  type: CanonicalContentBlock["type"];
  id?: string;
  name?: string;
  toolUseId?: string;
  charCount?: number;
  exactHash: string;
  semanticHash: string;
  argumentsHash?: string;
  preview?: string;
  text?: string;
};

type ResponseSnapshot = {
  schema: "agent_model_response_snapshot_v1";
  sequence: number;
  capturedAt: string;
  threadId: string;
  turnId: string;
  responseId: string;
  stopReason: CanonicalResponse["stopReason"];
  usage?: TokenUsage;
  content: ResponseBlockSummary[];
  toolCalls: Array<{
    id: string;
    name: string;
    exactHash: string;
    semanticHash: string;
    argumentsHash: string;
  }>;
  providerData?: {
    provider: CanonicalProviderId;
    exactHash: string;
    semanticHash: string;
    charCount: number;
    preview?: string;
  };
};

type ProviderRenderedRequestSnapshot = {
  schema: "agent_model_provider_request_snapshot_v1";
  sequence: number;
  capturedAt: string;
  threadId: string;
  turnId: string;
  provider: CanonicalProviderId;
  productModel: string;
  providerModel: string;
  exactHash: string;
  semanticHash: string;
  charCount: number;
  request: unknown;
};

type DriftKind =
  | "none"
  | "message_changed"
  | "message_removed"
  | "message_inserted"
  | "tools_changed"
  | "model_config_changed"
  | "assistant_replay_missing";

type PromptDiff = {
  schema: "agent_model_context_diff_v1";
  previousSequence: number;
  currentSequence: number;
  threadId: string;
  turnId: string;
  provider: CanonicalProviderId;
  productModel: string;
  status: "append_only" | "drift";
  driftKind: DriftKind;
  commonPrefixMessages: number;
  previousMessageCount: number;
  currentMessageCount: number;
  firstDriftIndex: number | null;
  before?: PromptMessageSummary;
  after?: PromptMessageSummary;
  toolsChanged: boolean;
  toolDiffs: string[];
  modelConfigChanged: boolean;
  modelConfigDiffs: string[];
  assistantReplayFound: boolean | null;
  toolResultFound: boolean | null;
  toolCallIdMatch: boolean | null;
};

type ThreadCaptureState = {
  lastPrompt: PromptSnapshot;
  lastResponse: ResponseSnapshot | null;
};

type MessageSource =
  | "base_system"
  | "runtime_environment"
  | "runtime_terminal_freshness"
  | "transcript_user"
  | "transcript_assistant"
  | "assistant_tool_use"
  | "tool_result"
  | "unknown";

const DEFAULT_CONTEXT_DRIFT_CONFIG: ModelContextDriftRecorderConfig = {
  outputDir: ".bud-debug/model-context-drift",
  includeText: false,
  maxPreviewChars: 240,
  writeJson: true,
  writeMarkdown: true,
  providerRenderedSnapshots: false,
  filters: {
    threadId: null,
    provider: null,
    model: null,
  },
};

const CONFIG_PATH = ".bud-debug/model-context-drift.config.json";
const REPO_ROOT = findRepoRoot();

export function createModelContextDriftRecorder(args: {
  enabled: boolean;
  logger: DriftLogger;
  cwd?: string;
  now?: () => Date;
}): ModelContextDriftRecorder | null {
  if (!args.enabled) {
    return null;
  }

  const root = findRepoRoot(args.cwd ?? REPO_ROOT);
  const loaded = loadModelContextDriftConfig({ repoRoot: root, logger: args.logger });
  if (!loaded.enabled) {
    return null;
  }

  return new ModelContextDriftRecorder({
    config: loaded.config,
    repoRoot: root,
    logger: args.logger,
    now: args.now,
  });
}

export function loadModelContextDriftConfig(args: {
  repoRoot?: string;
  logger: DriftLogger;
}): { enabled: true; config: ModelContextDriftRecorderConfig } | { enabled: false } {
  const repoRoot = args.repoRoot ?? REPO_ROOT;
  const configPath = join(repoRoot, CONFIG_PATH);
  if (!existsSync(configPath)) {
    return { enabled: true, config: { ...DEFAULT_CONTEXT_DRIFT_CONFIG } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (err) {
    args.logger.warn(
      {
        err,
        component: "agent",
        configPath,
      },
      "Disabling model context drift recorder because config JSON is invalid",
    );
    return { enabled: false };
  }

  if (!isRecord(parsed)) {
    args.logger.warn(
      { component: "agent", configPath },
      "Disabling model context drift recorder because config JSON root is not an object",
    );
    return { enabled: false };
  }

  const knownKeys = new Set([
    "outputDir",
    "includeText",
    "maxPreviewChars",
    "writeJson",
    "writeMarkdown",
    "providerRenderedSnapshots",
    "filters",
  ]);
  for (const key of Object.keys(parsed)) {
    if (!knownKeys.has(key)) {
      args.logger.warn(
        { component: "agent", configPath, key },
        "Ignoring unknown model context drift recorder config key",
      );
    }
  }

  return {
    enabled: true,
    config: normalizeRecorderConfig(parsed),
  };
}

export class ModelContextDriftRecorder implements ModelContextDriftRecorderLike {
  private readonly config: ModelContextDriftRecorderConfig;
  private readonly outputDir: string;
  private readonly logger: DriftLogger;
  private readonly now: () => Date;
  private readonly states = new Map<string, ThreadCaptureState>();
  private readonly threadSequences = new Map<string, number>();
  private disabled = false;

  constructor(args: {
    config: ModelContextDriftRecorderConfig;
    logger: DriftLogger;
    repoRoot?: string;
    now?: () => Date;
  }) {
    this.config = args.config;
    const repoRoot = args.repoRoot ?? REPO_ROOT;
    this.outputDir = isAbsolute(args.config.outputDir)
      ? args.config.outputDir
      : resolve(repoRoot, args.config.outputDir);
    this.logger = args.logger;
    this.now = args.now ?? (() => new Date());
  }

  capturePrompt(args: ModelContextDriftPromptCaptureArgs): number | null {
    if (this.disabled || !this.matchesFilters(args)) {
      return null;
    }

    try {
      const sequence = this.nextThreadSequence(args.threadId);
      const prompt = buildPromptSnapshot({
        ...args,
        sequence,
        capturedAt: this.now().toISOString(),
        includeText: this.config.includeText,
        maxPreviewChars: this.config.maxPreviewChars,
      });
      const previous = this.states.get(args.threadId) ?? null;
      const diff = previous
        ? diffPromptSnapshots(previous.lastPrompt, prompt, previous.lastResponse)
        : null;

      if (this.config.writeJson) {
        this.writeJson(args.threadId, `${padSequence(sequence)}-prompt.json`, prompt);
        if (
          this.config.providerRenderedSnapshots &&
          args.providerRenderedRequest !== undefined
        ) {
          this.writeJson(
            args.threadId,
            `${padSequence(sequence)}-provider-request.json`,
            buildProviderRenderedRequestSnapshot({
              ...args,
              sequence,
              capturedAt: prompt.capturedAt,
              request: args.providerRenderedRequest,
            }),
          );
        }
      }
      if (diff && this.config.writeMarkdown) {
        this.writeText(
          args.threadId,
          `${padSequence(diff.previousSequence)}-to-${padSequence(diff.currentSequence)}-diff.md`,
          renderPromptDiffMarkdown(diff),
        );
      }

      if (diff) {
        this.logger.info(
          {
            component: "agent",
            event: "model_context_drift",
            threadId: args.threadId,
            turnId: args.turnId,
            provider: args.provider,
            model: args.productModel,
            status: diff.status,
            commonPrefixMessages: diff.commonPrefixMessages,
            previousMessageCount: diff.previousMessageCount,
            currentMessageCount: diff.currentMessageCount,
            firstDriftIndex: diff.firstDriftIndex,
            driftKind: diff.driftKind,
            toolsChanged: diff.toolsChanged,
            modelConfigChanged: diff.modelConfigChanged,
            assistantReplayFound: diff.assistantReplayFound,
            toolResultFound: diff.toolResultFound,
          },
          "Model context drift comparison captured",
        );
      }

      this.states.set(args.threadId, {
        lastPrompt: prompt,
        lastResponse: null,
      });
      return sequence;
    } catch (err) {
      this.disabled = true;
      this.logger.warn(
        { err, component: "agent" },
        "Disabling model context drift recorder after prompt capture failure",
      );
      return null;
    }
  }

  captureResponse(args: ModelContextDriftResponseCaptureArgs): void {
    if (this.disabled || args.sequence === null) {
      return;
    }

    try {
      const state = this.states.get(args.threadId);
      if (!state || state.lastPrompt.sequence !== args.sequence) {
        return;
      }

      const response = buildResponseSnapshot({
        ...args,
        sequence: args.sequence,
        capturedAt: this.now().toISOString(),
        includeText: this.config.includeText,
        maxPreviewChars: this.config.maxPreviewChars,
      });

      if (this.config.writeJson) {
        this.writeJson(args.threadId, `${padSequence(args.sequence)}-response.json`, response);
      }

      this.states.set(args.threadId, {
        lastPrompt: state.lastPrompt,
        lastResponse: response,
      });
    } catch (err) {
      this.disabled = true;
      this.logger.warn(
        { err, component: "agent" },
        "Disabling model context drift recorder after response capture failure",
      );
    }
  }

  private matchesFilters(args: ModelContextDriftPromptCaptureArgs): boolean {
    const { filters } = this.config;
    if (filters.threadId && filters.threadId !== args.threadId) {
      return false;
    }
    if (filters.provider && filters.provider !== args.provider) {
      return false;
    }
    if (
      filters.model &&
      filters.model !== args.productModel &&
      filters.model !== args.providerModel
    ) {
      return false;
    }
    return true;
  }

  private nextThreadSequence(threadId: string): number {
    const sequence = (this.threadSequences.get(threadId) ?? 0) + 1;
    this.threadSequences.set(threadId, sequence);
    return sequence;
  }

  private writeJson(threadId: string, fileName: string, value: unknown): void {
    this.writeText(threadId, fileName, `${JSON.stringify(value, null, 2)}\n`);
  }

  private writeText(threadId: string, fileName: string, value: string): void {
    const dir = join(this.outputDir, `thread_${sanitizePathPart(threadId)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), value, "utf8");
  }
}

export function buildProviderRenderedRequestSnapshot(args: {
  sequence: number;
  capturedAt: string;
  threadId: string;
  turnId: string;
  provider: CanonicalProviderId;
  productModel: string;
  providerModel: string;
  request: unknown;
}): ProviderRenderedRequestSnapshot {
  const serialized = stringifyJson(args.request, false);
  return {
    schema: "agent_model_provider_request_snapshot_v1",
    sequence: args.sequence,
    capturedAt: args.capturedAt,
    threadId: args.threadId,
    turnId: args.turnId,
    provider: args.provider,
    productModel: args.productModel,
    providerModel: args.providerModel,
    exactHash: hashExact(args.request),
    semanticHash: hashSemantic(args.request),
    charCount: serialized.length,
    request: args.request,
  };
}

export function buildPromptSnapshot(args: ModelContextDriftPromptCaptureArgs & {
  sequence: number;
  capturedAt: string;
  includeText: boolean;
  maxPreviewChars: number;
}): PromptSnapshot {
  const modelConfig = summarizeModelConfig(args.modelConfig);
  const messages = args.messages.map((message, index) =>
    summarizeMessage(message, index, args.includeText, args.maxPreviewChars),
  );
  const tools = args.tools.map((tool, index) => summarizeTool(tool, index));

  return {
    schema: "agent_model_context_snapshot_v1",
    sequence: args.sequence,
    capturedAt: args.capturedAt,
    threadId: args.threadId,
    turnId: args.turnId,
    provider: args.provider,
    productModel: args.productModel,
    providerModel: args.providerModel,
    reasoningEffort: args.reasoningEffort,
    messageCount: messages.length,
    toolCount: tools.length,
    hashes: {
      canonicalExact: hashExact({
        messages: args.messages,
        tools: args.tools,
        modelConfig: args.modelConfig,
      }),
      canonicalSemantic: hashSemantic({
        messages: args.messages,
        tools: args.tools,
        modelConfig: args.modelConfig,
      }),
      messagesExact: hashExact(args.messages),
      toolsExact: hashExact(args.tools),
      modelConfigExact: hashExact(modelConfig),
      modelConfigSemantic: hashSemantic(modelConfig),
    },
    messages,
    tools,
    modelConfig,
  };
}

export function buildResponseSnapshot(args: ModelContextDriftResponseCaptureArgs & {
  sequence: number;
  capturedAt: string;
  includeText: boolean;
  maxPreviewChars: number;
}): ResponseSnapshot {
  return {
    schema: "agent_model_response_snapshot_v1",
    sequence: args.sequence,
    capturedAt: args.capturedAt,
    threadId: args.threadId,
    turnId: args.turnId,
    responseId: args.response.id,
    stopReason: args.response.stopReason,
    usage: args.response.usage,
    content: args.response.content.map((block, index) =>
      summarizeResponseBlock(block, index, args.includeText, args.maxPreviewChars),
    ),
    toolCalls: (args.response.toolCalls ?? []).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      exactHash: hashExact(toolCall),
      semanticHash: hashSemantic(toolCall),
      argumentsHash: hashSemantic(toolCall.input),
    })),
    providerData: args.response.providerData
      ? summarizeProviderData(args.response.providerData, args.maxPreviewChars)
      : undefined,
  };
}

export function diffPromptSnapshots(
  previous: PromptSnapshot,
  current: PromptSnapshot,
  previousResponse: ResponseSnapshot | null,
): PromptDiff {
  const commonPrefixMessages = longestCommonMessagePrefix(previous.messages, current.messages);
  const firstDriftIndex = commonPrefixMessages < previous.messages.length ||
    commonPrefixMessages < current.messages.length
    ? commonPrefixMessages
    : null;
  const toolsChanged = previous.hashes.toolsExact !== current.hashes.toolsExact;
  const modelConfigChanged =
    previous.hashes.modelConfigSemantic !== current.hashes.modelConfigSemantic;
  const continuity = checkResponseContinuity(previousResponse, current);
  const messageDriftKind = messageDriftKindFor(previous, current, firstDriftIndex);
  const driftKind = firstNonNone([
    messageDriftKind,
    toolsChanged ? "tools_changed" : "none",
    modelConfigChanged ? "model_config_changed" : "none",
    continuity.assistantReplayFound === false ? "assistant_replay_missing" : "none",
  ]);
  const status = driftKind === "none" ? "append_only" : "drift";

  return {
    schema: "agent_model_context_diff_v1",
    previousSequence: previous.sequence,
    currentSequence: current.sequence,
    threadId: current.threadId,
    turnId: current.turnId,
    provider: current.provider,
    productModel: current.productModel,
    status,
    driftKind,
    commonPrefixMessages,
    previousMessageCount: previous.messageCount,
    currentMessageCount: current.messageCount,
    firstDriftIndex,
    before: firstDriftIndex !== null ? previous.messages[firstDriftIndex] : undefined,
    after: firstDriftIndex !== null ? current.messages[firstDriftIndex] : undefined,
    toolsChanged,
    toolDiffs: toolsChanged ? summarizeToolDiffs(previous.tools, current.tools) : [],
    modelConfigChanged,
    modelConfigDiffs: modelConfigChanged
      ? summarizeModelConfigDiffs(previous.modelConfig, current.modelConfig)
      : [],
    assistantReplayFound: continuity.assistantReplayFound,
    toolResultFound: continuity.toolResultFound,
    toolCallIdMatch: continuity.toolCallIdMatch,
  };
}

export function hashExact(value: unknown): string {
  return hashString(stringifyJson(value, false));
}

export function hashSemantic(value: unknown): string {
  return hashString(stringifyJson(value, true));
}

function normalizeRecorderConfig(raw: Record<string, unknown>): ModelContextDriftRecorderConfig {
  const defaults = DEFAULT_CONTEXT_DRIFT_CONFIG;
  const filters = isRecord(raw.filters) ? raw.filters : {};
  return {
    outputDir: typeof raw.outputDir === "string" && raw.outputDir.trim()
      ? raw.outputDir
      : defaults.outputDir,
    includeText: typeof raw.includeText === "boolean" ? raw.includeText : defaults.includeText,
    maxPreviewChars: normalizePositiveInteger(raw.maxPreviewChars, defaults.maxPreviewChars),
    writeJson: typeof raw.writeJson === "boolean" ? raw.writeJson : defaults.writeJson,
    writeMarkdown: typeof raw.writeMarkdown === "boolean"
      ? raw.writeMarkdown
      : defaults.writeMarkdown,
    providerRenderedSnapshots: typeof raw.providerRenderedSnapshots === "boolean"
      ? raw.providerRenderedSnapshots
      : defaults.providerRenderedSnapshots,
    filters: {
      threadId: nullableString(filters.threadId),
      provider: nullableString(filters.provider),
      model: nullableString(filters.model),
    },
  };
}

function summarizeMessage(
  message: CanonicalMessage,
  index: number,
  includeText: boolean,
  maxPreviewChars: number,
): PromptMessageSummary {
  const text = flattenMessageText(message);
  const blocks = contentBlocksForMessage(message);
  return {
    index,
    role: message.role,
    source: inferMessageSource(message, index, text),
    blockSummary: blockSummary(message.content),
    blockExactHashes: blocks.map(hashExact),
    blockSemanticHashes: blocks.map(hashSemantic),
    toolUseIds: blocks
      .filter((block): block is Extract<CanonicalContentBlock, { type: "tool_use" }> =>
        block.type === "tool_use"
      )
      .map((block) => block.id),
    toolResultIds: blocks
      .filter((block): block is Extract<CanonicalContentBlock, { type: "tool_result" }> =>
        block.type === "tool_result"
      )
      .map((block) => block.tool_use_id),
    charCount: text.length,
    exactHash: hashExact(message),
    semanticHash: hashSemantic(message),
    preview: truncateForPreview(text, maxPreviewChars),
    ...(includeText ? { text } : {}),
  };
}

function summarizeTool(tool: CanonicalTool, index: number): PromptToolSummary {
  return {
    index,
    name: tool.name,
    exactHash: hashExact(tool),
    semanticHash: hashSemantic(tool),
    schemaCharCount: stringifyJson(tool.parameters, false).length,
  };
}

function summarizeModelConfig(config: ModelConfig): ModelConfigSummary {
  return {
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
    responseFormat: config.responseFormat,
    toolChoice: config.toolChoice,
    reasoningEnabled: config.reasoning?.enabled,
    reasoning: config.reasoning,
    temperature: config.temperature,
    topP: config.topP,
    topK: config.topK,
  };
}

function summarizeResponseBlock(
  block: CanonicalContentBlock,
  index: number,
  includeText: boolean,
  maxPreviewChars: number,
): ResponseBlockSummary {
  const text = textForContentBlock(block);
  const base = {
    index,
    type: block.type,
    exactHash: hashExact(block),
    semanticHash: hashSemantic(block),
  };

  switch (block.type) {
    case "text":
      return {
        ...base,
        charCount: block.text.length,
        preview: truncateForPreview(block.text, maxPreviewChars),
        ...(includeText ? { text: block.text } : {}),
      };
    case "tool_use":
      return {
        ...base,
        id: block.id,
        name: block.name,
        argumentsHash: hashSemantic(block.input),
      };
    case "tool_result":
      return {
        ...base,
        toolUseId: block.tool_use_id,
        charCount: text.length,
        preview: truncateForPreview(text, maxPreviewChars),
        ...(includeText ? { text } : {}),
      };
    case "reasoning":
      return {
        ...base,
        charCount: block.text.length,
        preview: truncateForPreview(block.text, maxPreviewChars),
        ...(includeText ? { text: block.text } : {}),
      };
    case "reasoning_redacted":
      return base;
    case "image":
      return {
        ...base,
        charCount: block.source.data.length,
      };
  }
}

function summarizeProviderData(
  providerData: NonNullable<CanonicalResponse["providerData"]>,
  maxPreviewChars: number,
): NonNullable<ResponseSnapshot["providerData"]> {
  const serialized = stringifyJson(providerData.payload, false);
  return {
    provider: providerData.provider,
    exactHash: hashExact(providerData.payload),
    semanticHash: hashSemantic(providerData.payload),
    charCount: serialized.length,
    preview: truncateForPreview(serialized, maxPreviewChars),
  };
}

function inferMessageSource(
  message: CanonicalMessage,
  index: number,
  text: string,
): MessageSource {
  if (index === 0 && message.role === "system") {
    return "base_system";
  }
  if (message.role === "system" && text.includes("selected Bud is currently offline")) {
    return "runtime_environment";
  }
  if (
    message.role === "system" &&
    (text.includes("Terminal state may have changed") ||
      text.includes("terminal activity may have changed") ||
      text.includes("human terminal input"))
  ) {
    return "runtime_terminal_freshness";
  }
  if (message.role === "assistant" && messageHasBlock(message, "tool_use")) {
    return "assistant_tool_use";
  }
  if (message.role === "assistant") {
    return "transcript_assistant";
  }
  if (message.role === "user" && messageHasBlock(message, "tool_result")) {
    return "tool_result";
  }
  if (message.role === "user") {
    return "transcript_user";
  }
  return "unknown";
}

function messageHasBlock(message: CanonicalMessage, type: CanonicalContentBlock["type"]): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === type);
}

function blockSummary(content: CanonicalMessage["content"]): string {
  if (typeof content === "string") {
    return "text";
  }
  return content.map((block) => block.type).join(",");
}

function contentBlocksForMessage(message: CanonicalMessage): CanonicalContentBlock[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

function flattenMessageText(message: CanonicalMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content.map(textForContentBlock).join("\n");
}

function textForContentBlock(block: CanonicalContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use":
      return stringifyJson({
        id: block.id,
        name: block.name,
        input: block.input,
      }, true);
    case "tool_result":
      return typeof block.content === "string"
        ? block.content
        : block.content.map(textForContentBlock).join("\n");
    case "reasoning":
      return block.text;
    case "reasoning_redacted":
      return stringifyJson(block.providerData ?? {}, true);
    case "image":
      return `[image:${block.source.media_type}:${block.source.data.length} chars]`;
  }
}

function longestCommonMessagePrefix(
  previous: PromptMessageSummary[],
  current: PromptMessageSummary[],
): number {
  const length = Math.min(previous.length, current.length);
  let index = 0;
  while (index < length && previous[index]?.exactHash === current[index]?.exactHash) {
    index += 1;
  }
  return index;
}

function messageDriftKindFor(
  previous: PromptSnapshot,
  current: PromptSnapshot,
  firstDriftIndex: number | null,
): DriftKind {
  if (firstDriftIndex === null) {
    return "none";
  }
  if (firstDriftIndex >= previous.messageCount && firstDriftIndex < current.messageCount) {
    return "none";
  }
  if (firstDriftIndex >= current.messageCount) {
    return "message_removed";
  }
  if (firstDriftIndex >= previous.messageCount) {
    return "message_inserted";
  }
  return "message_changed";
}

function checkResponseContinuity(
  previousResponse: ResponseSnapshot | null,
  current: PromptSnapshot,
): Pick<PromptDiff, "assistantReplayFound" | "toolResultFound" | "toolCallIdMatch"> {
  if (!previousResponse) {
    return {
      assistantReplayFound: null,
      toolResultFound: null,
      toolCallIdMatch: null,
    };
  }

  const toolBlocks = previousResponse.content.filter((block) => block.type === "tool_use");
  if (toolBlocks.length > 0) {
    const assistantReplayFound = toolBlocks.every((toolBlock) => {
      const toolId = toolBlock.id;
      return toolId !== undefined && current.messages.some((message) =>
        message.role === "assistant" &&
        message.toolUseIds.includes(toolId) &&
        message.blockSemanticHashes.includes(toolBlock.semanticHash),
      );
    });
    const toolResultFound = toolBlocks.every((toolBlock) => {
      const toolId = toolBlock.id;
      return toolId !== undefined && current.messages.some((message) =>
        message.source === "tool_result" &&
        message.toolResultIds.includes(toolId),
      );
    });
    return {
      assistantReplayFound,
      toolResultFound,
      toolCallIdMatch: assistantReplayFound,
    };
  }

  const textBlocks = previousResponse.content.filter((block) => block.type === "text");
  if (textBlocks.length > 0) {
    return {
      assistantReplayFound: textBlocks.every((block) =>
        current.messages.some((message) =>
          message.role === "assistant" && message.blockSemanticHashes.includes(block.semanticHash),
        ),
      ),
      toolResultFound: null,
      toolCallIdMatch: null,
    };
  }

  return {
    assistantReplayFound: null,
    toolResultFound: null,
    toolCallIdMatch: null,
  };
}

function summarizeToolDiffs(previous: PromptToolSummary[], current: PromptToolSummary[]): string[] {
  const diffs: string[] = [];
  if (previous.length !== current.length) {
    diffs.push(`tool count changed ${previous.length} -> ${current.length}`);
  }
  const length = Math.max(previous.length, current.length);
  for (let index = 0; index < length; index += 1) {
    const before = previous[index];
    const after = current[index];
    if (!before && after) {
      diffs.push(`tool added at ${index}: ${after.name}`);
      continue;
    }
    if (before && !after) {
      diffs.push(`tool removed at ${index}: ${before.name}`);
      continue;
    }
    if (!before || !after) {
      continue;
    }
    if (before.name !== after.name) {
      diffs.push(`tool name changed at ${index}: ${before.name} -> ${after.name}`);
    } else if (before.semanticHash !== after.semanticHash) {
      diffs.push(`tool schema changed at ${index}: ${before.name}`);
    }
  }
  return diffs;
}

function summarizeModelConfigDiffs(
  previous: ModelConfigSummary,
  current: ModelConfigSummary,
): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of [...keys].sort()) {
    const before = (previous as Record<string, unknown>)[key];
    const after = (current as Record<string, unknown>)[key];
    if (hashSemantic(before) !== hashSemantic(after)) {
      diffs.push(`${key}: ${stringifyJson(before, true)} -> ${stringifyJson(after, true)}`);
    }
  }
  return diffs;
}

function renderPromptDiffMarkdown(diff: PromptDiff): string {
  const lines = [
    `# Model Context Drift ${padSequence(diff.previousSequence)} -> ${padSequence(diff.currentSequence)}`,
    "",
    `Verdict: ${diff.status}`,
    "",
    `- Thread: \`${diff.threadId}\``,
    `- Turn: \`${diff.turnId}\``,
    `- Provider: \`${diff.provider}\``,
    `- Model: \`${diff.productModel}\``,
    `- Common prefix messages: ${diff.commonPrefixMessages}`,
    `- First drift index: ${diff.firstDriftIndex ?? "none"}`,
    `- Drift kind: \`${diff.driftKind}\``,
    "",
    "## Message Drift",
    "",
    "| Side | Index | Role | Source | Chars | Hash | Preview |",
    "| --- | ---: | --- | --- | ---: | --- | --- |",
    renderMessageDiffRow("Before", diff.before),
    renderMessageDiffRow("After", diff.after),
    "",
    "## Tool Diff",
    "",
    diff.toolDiffs.length > 0 ? diff.toolDiffs.map((entry) => `- ${entry}`).join("\n") : "- none",
    "",
    "## Model Config Diff",
    "",
    diff.modelConfigDiffs.length > 0
      ? diff.modelConfigDiffs.map((entry) => `- ${entry}`).join("\n")
      : "- none",
    "",
    "## Response Continuity",
    "",
    `- Assistant replay found: ${diff.assistantReplayFound ?? "n/a"}`,
    `- Tool result found: ${diff.toolResultFound ?? "n/a"}`,
    `- Tool call id match: ${diff.toolCallIdMatch ?? "n/a"}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderMessageDiffRow(side: string, message: PromptMessageSummary | undefined): string {
  if (!message) {
    return `| ${side} | - | - | - | - | - | - |`;
  }
  return [
    `| ${side}`,
    String(message.index),
    message.role,
    message.source,
    String(message.charCount),
    message.exactHash.slice(0, 19),
    escapeMarkdownTable(message.preview ?? ""),
  ].join(" | ") + " |";
}

function firstNonNone(kinds: DriftKind[]): DriftKind {
  return kinds.find((kind) => kind !== "none") ?? "none";
}

function stringifyJson(value: unknown, semantic: boolean): string {
  const normalized = semantic ? sortJsonValue(value) : value;
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(normalized, (_key, nested) => {
    if (typeof nested === "bigint") {
      return nested.toString();
    }
    if (typeof nested === "object" && nested !== null) {
      if (seen.has(nested)) {
        return "[Circular]";
      }
      seen.add(nested);
    }
    return nested;
  });
  return serialized ?? "undefined";
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonValue(value[key]);
  }
  return sorted;
}

function hashString(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function truncateForPreview(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160);
}

function padSequence(sequence: number): string {
  return String(sequence).padStart(6, "0");
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "\\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findRepoRoot(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, "bud.spec.md")) && existsSync(join(current, "service"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir);
    }
    current = parent;
  }
}
