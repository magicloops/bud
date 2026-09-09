import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAIProvider } from "./openai.js";
import { resolveAgentToolsForEnvironment } from "../../agent/tool-definitions.js";
import { buildAgentEnvironmentSnapshot } from "../../agent/environment.js";

test("OpenAI accepts the full enabled tool catalog without forwarding uniqueItems", async () => {
  const tools = resolveAgentToolsForEnvironment(
    buildAgentEnvironmentSnapshot({ budId: "fixture", online: true }),
    { automations: true, existingContactReviews: true, appPermissions: true },
  );
  const original = structuredClone(tools);
  assert.ok(JSON.stringify(tools).includes('"uniqueItems":true'));
  const provider = new OpenAIProvider("fixture-key");
  let requests = 0;
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    assert.equal(Object.hasOwn(node, "uniqueItems"), false);
    if (node.properties) {
      assert.deepEqual(node.required, Object.keys(node.properties));
      assert.equal(node.additionalProperties, false);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  (provider as any).client.responses.create = async (params: any) => {
    requests++;
    assert.equal(params.model, "gpt-6-astra");
    assert.deepEqual(params.reasoning, { effort: "medium", summary: "auto" });
    assert.deepEqual(params.include, ["reasoning.encrypted_content"]);
    assert.equal(params.temperature, undefined);
    assert.equal(params.top_p, undefined);
    assert.equal(params.tools.length, tools.length);
    for (const tool of params.tools) {
      assert.equal(tool.strict, true);
      visit(tool.parameters);
    }
    const create = params.tools.find((t: any) => t.name === "automations_create_draft");
    assert.equal(create.parameters.properties.sources.properties.source_ids.maxItems, 32);
    assert.equal(create.parameters.properties.max_invocations_per_day.maximum, 100);
    assert.deepEqual(create.parameters.properties.sources.type, ["object", "null"]);
    assert.ok(params.tools.some((t: any) => t.name === "automations_update_draft"));
    assert.ok(params.tools.some((t: any) => t.name === "automations_request_existing_contacts"));
    const response = { id: "fixture", status: "completed", output: [] };
    if (!params.stream) return response;
    return (async function* () { yield { type: "response.completed", response }; })();
  };
  const config = { model: "gpt-6-astra", reasoning: { enabled: true, effort: "medium" as const } };
  await provider.invokeSync([{ role: "user", content: "Schema fixture" }], tools, config);
  for await (const _event of provider.invoke([{ role: "user", content: "Schema fixture" }], tools, config)) { /* consume */ }
  assert.equal(requests, 2);
  assert.deepEqual(tools, original);
});
