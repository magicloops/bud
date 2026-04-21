import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import { initializeProviders, providerRegistry } from "./index.js";

test("initializeProviders allows provider-less startup", () => {
  const originalOpenaiApiKey = config.openaiApiKey;
  const originalAnthropicApiKey = config.anthropicApiKey;

  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");
  config.openaiApiKey = "";
  config.anthropicApiKey = "";

  try {
    assert.doesNotThrow(() => initializeProviders());
    assert.deepEqual(providerRegistry.listProviders(), []);
  } finally {
    config.openaiApiKey = originalOpenaiApiKey;
    config.anthropicApiKey = originalAnthropicApiKey;
    providerRegistry.unregister("openai");
    providerRegistry.unregister("anthropic");
  }
});
