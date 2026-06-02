import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import { initializeProviders, providerRegistry, type LLMProvider } from "./index.js";

test("initializeProviders allows provider-less startup", () => {
  const originalOpenaiApiKey = config.openaiApiKey;
  const originalAnthropicApiKey = config.anthropicApiKey;
  const originalDs4DirectBaseUrl = config.ds4DirectBaseUrl;
  const previousOpenAI = providerRegistry.getProvider("openai");
  const previousAnthropic = providerRegistry.getProvider("anthropic");
  const previousDs4 = providerRegistry.getProvider("ds4");

  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");
  providerRegistry.unregister("ds4");
  config.openaiApiKey = "";
  config.anthropicApiKey = "";
  config.ds4DirectBaseUrl = null;

  try {
    assert.doesNotThrow(() => initializeProviders());
    assert.deepEqual(providerRegistry.listProviders(), []);
  } finally {
    config.openaiApiKey = originalOpenaiApiKey;
    config.anthropicApiKey = originalAnthropicApiKey;
    config.ds4DirectBaseUrl = originalDs4DirectBaseUrl;
    providerRegistry.unregister("openai");
    providerRegistry.unregister("anthropic");
    providerRegistry.unregister("ds4");
    restoreProvider(previousOpenAI);
    restoreProvider(previousAnthropic);
    restoreProvider(previousDs4);
  }
});

test("initializeProviders registers direct ds4 provider from local-dev config", () => {
  const originalOpenaiApiKey = config.openaiApiKey;
  const originalAnthropicApiKey = config.anthropicApiKey;
  const originalDs4DirectBaseUrl = config.ds4DirectBaseUrl;
  const originalDs4DirectModel = config.ds4DirectModel;
  const originalDs4DirectContextTokens = config.ds4DirectContextTokens;
  const originalDs4DirectMaxOutputTokens = config.ds4DirectMaxOutputTokens;
  const previousOpenAI = providerRegistry.getProvider("openai");
  const previousAnthropic = providerRegistry.getProvider("anthropic");
  const previousDs4 = providerRegistry.getProvider("ds4");

  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");
  providerRegistry.unregister("ds4");
  config.openaiApiKey = "";
  config.anthropicApiKey = "";
  config.ds4DirectBaseUrl = "http://127.0.0.1:4444/v1";
  config.ds4DirectModel = "deepseek-v4-flash";
  config.ds4DirectContextTokens = 100_000;
  config.ds4DirectMaxOutputTokens = 128_000;

  try {
    initializeProviders();

    assert.deepEqual(providerRegistry.listProviders(), ["ds4"]);
    const provider = providerRegistry.getProviderForModel("ds4-deepseek-v4-flash");
    assert.equal(provider.name, "ds4");
    assert.equal(provider.supportsModel("deepseek-v4-flash"), true);
  } finally {
    config.openaiApiKey = originalOpenaiApiKey;
    config.anthropicApiKey = originalAnthropicApiKey;
    config.ds4DirectBaseUrl = originalDs4DirectBaseUrl;
    config.ds4DirectModel = originalDs4DirectModel;
    config.ds4DirectContextTokens = originalDs4DirectContextTokens;
    config.ds4DirectMaxOutputTokens = originalDs4DirectMaxOutputTokens;
    providerRegistry.unregister("openai");
    providerRegistry.unregister("anthropic");
    providerRegistry.unregister("ds4");
    restoreProvider(previousOpenAI);
    restoreProvider(previousAnthropic);
    restoreProvider(previousDs4);
  }
});

function restoreProvider(provider: LLMProvider | undefined): void {
  if (provider) {
    providerRegistry.register(provider);
  }
}
