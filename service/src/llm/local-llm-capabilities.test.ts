import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBudLocalModelId,
  parseBudLocalModelId,
  listBudLocalGenericModels,
  synthesizeBudLocalCatalogEntry,
  registerBudLocalModelsFromCapabilities,
  hasHealthyBudLocalDs4Capability,
} from "./local-llm-capabilities.js";
import { getCatalogEntry, clearDynamicCatalogEntries } from "./model-catalog.js";

const CAPABILITIES = {
  llm: {
    local_api: true,
    servers: [
      {
        id: "ds4",
        provider: "ds4",
        compatibility: ["openai_responses"],
        request_mode: "ds4_openai_responses",
        generation_path: "/v1/responses",
        models: [{ id: "deepseek-v4-flash", display_name: "ds4 DeepSeek V4" }],
        concurrency: 1,
        healthy: true,
      },
      {
        id: "local",
        provider: "bud_local",
        compatibility: ["openai_chat_completions"],
        request_mode: "openai_chat_completions",
        generation_path: "/v1/chat/completions",
        models: [
          { id: "deepseek-v4-flash-0731", display_name: "deepseek-v4-flash-0731", validated: true, context_window_tokens: 1048576 },
          { id: "llama-3.3-70b", display_name: "llama-3.3-70b", validated: false, context_window_tokens: 131072 },
          { id: "tiny-no-metadata", display_name: "tiny-no-metadata", validated: false },
        ],
        concurrency: 1,
        healthy: true,
      },
    ],
  },
};

test("bud-local model id round-trips, including served ids with colons", () => {
  const id = formatBudLocalModelId("b_01ABC", "llama3:70b-instruct");
  assert.equal(id, "bud-local:b_01ABC:llama3:70b-instruct");
  assert.deepEqual(parseBudLocalModelId(id), {
    budId: "b_01ABC",
    servedModelId: "llama3:70b-instruct",
  });
  assert.equal(parseBudLocalModelId("ds4-deepseek-v4-flash"), null);
  assert.equal(parseBudLocalModelId("bud-local:missing-served"), null);
});

test("generic listing excludes validated families (they surface via curated entries)", () => {
  const models = listBudLocalGenericModels(CAPABILITIES);
  assert.deepEqual(
    models.map((m) => m.id),
    ["llama-3.3-70b", "tiny-no-metadata"],
  );
  assert.equal(models[0].contextWindowTokens, 131072);
  assert.equal(models[1].contextWindowTokens, null);
  // ds4 compat entry still detected by the legacy matcher.
  assert.equal(hasHealthyBudLocalDs4Capability(CAPABILITIES), true);
});

test("synthesized entries use dynamic context with conservative fallbacks", () => {
  const [llama, tiny] = listBudLocalGenericModels(CAPABILITIES);
  const llamaEntry = synthesizeBudLocalCatalogEntry("b_01ABC", llama);
  assert.equal(llamaEntry.id, "bud-local:b_01ABC:llama-3.3-70b");
  assert.equal(llamaEntry.provider, "bud_local");
  assert.equal(llamaEntry.providerModel, "llama-3.3-70b");
  assert.equal(llamaEntry.capabilities.contextWindowTokens, 131072);
  assert.equal(llamaEntry.capabilities.maxOutputTokens, 32768);
  assert.equal(llamaEntry.capabilities.tools, true);
  assert.equal(llamaEntry.reasoning.kind, "none");

  const tinyEntry = synthesizeBudLocalCatalogEntry("b_01ABC", tiny);
  assert.equal(tinyEntry.capabilities.contextWindowTokens, 8192, "fallback context");
  assert.equal(tinyEntry.capabilities.maxOutputTokens, 4096, "half of fallback context");
});

test("registration makes dynamic entries resolvable via getCatalogEntry", () => {
  registerBudLocalModelsFromCapabilities("b_01REG", CAPABILITIES);
  const entry = getCatalogEntry("bud-local:b_01REG:llama-3.3-70b");
  assert.equal(entry?.provider, "bud_local");
  assert.equal(entry?.capabilities.contextWindowTokens, 131072);
  // Validated family ids do NOT get generic entries.
  assert.equal(getCatalogEntry("bud-local:b_01REG:deepseek-v4-flash-0731"), null);

  // Refresh with no generic server clears the bud's set.
  registerBudLocalModelsFromCapabilities("b_01REG", { llm: { servers: [] } });
  assert.equal(getCatalogEntry("bud-local:b_01REG:llama-3.3-70b"), null);
  clearDynamicCatalogEntries("b_01REG");
});

test("static catalog is never shadowed by dynamic entries", () => {
  registerBudLocalModelsFromCapabilities("b_01SHADOW", CAPABILITIES);
  const ds4 = getCatalogEntry("ds4-deepseek-v4-flash");
  assert.equal(ds4?.provider, "ds4");
  clearDynamicCatalogEntries("b_01SHADOW");
});
