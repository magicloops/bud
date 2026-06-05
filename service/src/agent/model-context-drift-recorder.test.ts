import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { CanonicalMessage, CanonicalTool, ModelConfig } from "../llm/index.js";
import {
  ModelContextDriftRecorder,
  buildPromptSnapshot,
  createModelContextDriftRecorder,
  hashExact,
  hashSemantic,
  loadModelContextDriftConfig,
  type ModelContextDriftRecorderConfig,
} from "./model-context-drift-recorder.js";

function createLogger() {
  const logs: Array<{ level: "info" | "warn"; meta: unknown; message: string }> = [];
  return {
    logs,
    logger: {
      info(meta: unknown, message?: string) {
        logs.push({ level: "info", meta, message: message ?? String(meta) });
      },
      warn(meta: unknown, message?: string) {
        logs.push({ level: "warn", meta, message: message ?? String(meta) });
      },
    },
  };
}

async function createTempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bud-context-drift-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function createRecorderConfig(outputDir: string): ModelContextDriftRecorderConfig {
  return {
    outputDir,
    includeText: false,
    maxPreviewChars: 40,
    writeJson: true,
    writeMarkdown: true,
    providerRenderedSnapshots: false,
    filters: {
      threadId: null,
      provider: null,
      model: null,
    },
  };
}

const TEST_TOOL: CanonicalTool = {
  name: "terminal_observe",
  description: "Observe terminal output",
  parameters: {
    type: "object",
    properties: {
      view: { type: "string", enum: ["screen", "delta"] },
    },
  },
};

const TEST_MODEL_CONFIG: ModelConfig = {
  model: "deepseek-v4-flash",
  maxOutputTokens: 128000,
  reasoning: { enabled: false },
  responseFormat: "text",
};

const BASE_PROMPT_ARGS = {
  threadId: "thread_test",
  turnId: "turn_test",
  provider: "ds4" as const,
  productModel: "ds4-deepseek-v4-flash",
  providerModel: "deepseek-v4-flash",
  reasoningEffort: "none" as const,
  tools: [TEST_TOOL],
  modelConfig: TEST_MODEL_CONFIG,
};

test("loadModelContextDriftConfig uses defaults when local config is absent", async (t) => {
  const root = await createTempRoot(t);
  const { logger } = createLogger();

  const loaded = loadModelContextDriftConfig({ repoRoot: root, logger });

  assert.equal(loaded.enabled, true);
  if (loaded.enabled) {
    assert.equal(loaded.config.outputDir, ".bud-debug/model-context-drift");
    assert.equal(loaded.config.includeText, false);
    assert.equal(loaded.config.writeJson, true);
    assert.equal(loaded.config.writeMarkdown, true);
    assert.equal(loaded.config.providerRenderedSnapshots, false);
    assert.deepEqual(loaded.config.filters, {
      threadId: null,
      provider: null,
      model: null,
    });
  }
});

test("invalid local config disables recorder creation", async (t) => {
  const root = await createTempRoot(t);
  await mkdir(join(root, ".bud-debug"));
  await writeFile(join(root, ".bud-debug", "model-context-drift.config.json"), "{ invalid", "utf8");
  const { logger, logs } = createLogger();

  const recorder = createModelContextDriftRecorder({
    enabled: true,
    logger,
    cwd: root,
  });

  assert.equal(recorder, null);
  assert.equal(logs[0]?.level, "warn");
  assert.match(logs[0]?.message ?? "", /config JSON is invalid/);
});

test("prompt snapshots redact full text by default and include it when configured", () => {
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: "0123456789abcdefghijklmnopqrstuvwxyz",
    },
  ];

  const redacted = buildPromptSnapshot({
    ...BASE_PROMPT_ARGS,
    sequence: 1,
    capturedAt: "2026-06-02T00:00:00.000Z",
    includeText: false,
    maxPreviewChars: 10,
    messages,
  });
  assert.equal(redacted.messages[0]?.text, undefined);
  assert.equal(redacted.messages[0]?.preview, "0123456789... [truncated 26 chars]");

  const included = buildPromptSnapshot({
    ...BASE_PROMPT_ARGS,
    sequence: 1,
    capturedAt: "2026-06-02T00:00:00.000Z",
    includeText: true,
    maxPreviewChars: 10,
    messages,
  });
  assert.equal(included.messages[0]?.text, messages[0]?.content);
});

test("semantic hashes ignore object key order while exact hashes preserve it", () => {
  const left = { a: 1, b: 2 };
  const right = { b: 2, a: 1 };

  assert.notEqual(hashExact(left), hashExact(right));
  assert.equal(hashSemantic(left), hashSemantic(right));
});

test("recorder writes prompt response and append-only diff artifacts", async (t) => {
  const root = await createTempRoot(t);
  const outputDir = join(root, "model-context-drift");
  const { logger, logs } = createLogger();
  const captureTimes = [
    new Date("2026-06-02T00:00:00.000Z"),
    new Date("2026-06-02T00:00:01.000Z"),
    new Date("2026-06-02T00:00:02.000Z"),
  ];
  let timeIndex = 0;
  const recorder = new ModelContextDriftRecorder({
    config: createRecorderConfig(outputDir),
    logger,
    repoRoot: root,
    now: () => captureTimes[timeIndex++] ?? captureTimes.at(-1) ?? new Date(),
  });
  const firstMessages: CanonicalMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "what is on screen?" },
  ];

  const firstSequence = recorder.capturePrompt({
    ...BASE_PROMPT_ARGS,
    threadId: "thread/one",
    turnId: "turn_1",
    messages: firstMessages,
  });

  assert.equal(firstSequence, 1);
  recorder.captureResponse({
    sequence: firstSequence,
    threadId: "thread/one",
    turnId: "turn_1",
    response: {
      id: "resp_1",
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "terminal_observe",
          input: { view: "screen" },
        },
      ],
      toolCalls: [
        {
          id: "call_1",
          name: "terminal_observe",
          input: { view: "screen" },
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    },
  });

  const secondSequence = recorder.capturePrompt({
    ...BASE_PROMPT_ARGS,
    threadId: "thread/one",
    turnId: "turn_2",
    messages: [
      ...firstMessages,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "terminal_observe",
            input: { view: "screen" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "shell prompt is visible",
          },
        ],
      },
    ],
  });

  assert.equal(secondSequence, 2);
  const artifactDir = join(outputDir, "thread_thread_one");
  assert.ok(existsSync(join(artifactDir, "000001-prompt.json")));
  assert.ok(existsSync(join(artifactDir, "000001-response.json")));
  assert.ok(existsSync(join(artifactDir, "000002-prompt.json")));

  const diff = await readFile(join(artifactDir, "000001-to-000002-diff.md"), "utf8");
  assert.match(diff, /Verdict: append_only/);
  assert.match(diff, /Assistant replay found: true/);
  assert.match(diff, /Tool result found: true/);
  assert.equal(logs.find((log) => log.message === "Model context drift comparison captured")?.level, "info");
});

test("recorder writes provider-rendered request artifacts when enabled", async (t) => {
  const root = await createTempRoot(t);
  const outputDir = join(root, "model-context-drift");
  const { logger } = createLogger();
  const recorder = new ModelContextDriftRecorder({
    config: {
      ...createRecorderConfig(outputDir),
      providerRenderedSnapshots: true,
    },
    logger,
    repoRoot: root,
    now: () => new Date("2026-06-02T00:00:00.000Z"),
  });

  const sequence = recorder.capturePrompt({
    ...BASE_PROMPT_ARGS,
    threadId: "thread/one",
    turnId: "turn_1",
    messages: [{ role: "user", content: "hello" }],
    providerRenderedRequest: {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    },
  });

  assert.equal(sequence, 1);
  const artifact = JSON.parse(
    await readFile(
      join(outputDir, "thread_thread_one", "000001-provider-request.json"),
      "utf8",
    ),
  ) as {
    schema: string;
    sequence: number;
    request: { model: string; messages: Array<{ role: string; content: string }> };
    charCount: number;
  };

  assert.equal(artifact.schema, "agent_model_provider_request_snapshot_v1");
  assert.equal(artifact.sequence, 1);
  assert.equal(artifact.request.model, "deepseek-v4-flash");
  assert.deepEqual(artifact.request.messages[0], { role: "user", content: "hello" });
  assert.ok(artifact.charCount > 0);
});

test("recorder sequence numbers restart per thread artifact directory", async (t) => {
  const root = await createTempRoot(t);
  const outputDir = join(root, "model-context-drift");
  const { logger } = createLogger();
  const recorder = new ModelContextDriftRecorder({
    config: createRecorderConfig(outputDir),
    logger,
    repoRoot: root,
    now: () => new Date("2026-06-02T00:00:00.000Z"),
  });

  const firstThreadSequence = recorder.capturePrompt({
    ...BASE_PROMPT_ARGS,
    threadId: "thread/one",
    turnId: "turn_1",
    messages: [{ role: "user", content: "hello one" }],
  });
  const secondThreadSequence = recorder.capturePrompt({
    ...BASE_PROMPT_ARGS,
    threadId: "thread/two",
    turnId: "turn_2",
    messages: [{ role: "user", content: "hello two" }],
  });
  const firstThreadNextSequence = recorder.capturePrompt({
    ...BASE_PROMPT_ARGS,
    threadId: "thread/one",
    turnId: "turn_3",
    messages: [
      { role: "user", content: "hello one" },
      { role: "assistant", content: "reply one" },
    ],
  });

  assert.equal(firstThreadSequence, 1);
  assert.equal(secondThreadSequence, 1);
  assert.equal(firstThreadNextSequence, 2);
  assert.ok(existsSync(join(outputDir, "thread_thread_one", "000001-prompt.json")));
  assert.ok(existsSync(join(outputDir, "thread_thread_one", "000002-prompt.json")));
  assert.ok(existsSync(join(outputDir, "thread_thread_two", "000001-prompt.json")));
  assert.equal(existsSync(join(outputDir, "thread_thread_two", "000002-prompt.json")), false);
});

test("recorder filters skip non-matching provider captures", async (t) => {
  const root = await createTempRoot(t);
  const outputDir = join(root, "model-context-drift");
  const { logger } = createLogger();
  const recorder = new ModelContextDriftRecorder({
    config: {
      ...createRecorderConfig(outputDir),
      filters: {
        threadId: null,
        provider: "ds4",
        model: null,
      },
    },
    logger,
    repoRoot: root,
  });

  const sequence = recorder.capturePrompt({
    ...BASE_PROMPT_ARGS,
    provider: "openai",
    productModel: "gpt-5.5",
    providerModel: "gpt-5.5",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(sequence, null);
  assert.equal(existsSync(outputDir), false);
});
