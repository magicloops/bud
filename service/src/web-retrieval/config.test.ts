import assert from "node:assert/strict";
import { test } from "node:test";
import { retrievalAvailable, retrievalConfig } from "./config.js";

test("retrieval defaults on, retains explicit overrides, and requires a key", t => {
  const names = ["WEB_RETRIEVAL_ENABLED", "FIRECRAWL_API_KEY"] as const;
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => {
    const value = previous[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }));

  delete process.env.WEB_RETRIEVAL_ENABLED;
  process.env.FIRECRAWL_API_KEY = "fixture";
  assert.equal(retrievalConfig().enabled, true);
  assert.equal(retrievalAvailable(), true);
  for (const flag of ["0", "false", "", "invalid"]) {
    process.env.WEB_RETRIEVAL_ENABLED = flag;
    assert.equal(retrievalAvailable(), false);
  }
  for (const flag of ["1", "true"]) {
    process.env.WEB_RETRIEVAL_ENABLED = flag;
    assert.equal(retrievalAvailable(), true);
  }
  delete process.env.WEB_RETRIEVAL_ENABLED;
  delete process.env.FIRECRAWL_API_KEY;
  assert.equal(retrievalAvailable(), false);
  process.env.FIRECRAWL_API_KEY = "   ";
  assert.equal(retrievalAvailable(), false);
});
