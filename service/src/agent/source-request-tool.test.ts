import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolArgs, isSourceRequestToolDirective, toolNameForConversation } from "./contracts.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";
import { AgentModelRunner } from "./model-runner.js";
import { resolveAgentToolsForEnvironment } from "./tool-definitions.js";
import { parseSourceRequestInput } from "../personal-data/source-requests.js";
import { OpenAIProvider } from "../llm/providers/openai.js";

const environment = buildAgentEnvironmentSnapshot({ budId: "bud", online: false });
const logger = { info() {}, warn() {}, error() {} };

test("the source request tool is offered only when a turn can park, and replaces the question kind", () => {
  assert.ok(!resolveAgentToolsForEnvironment(environment).some(tool => tool.name === "data_source_request"));
  const tools = resolveAgentToolsForEnvironment(environment, { sourceRequests: true });
  const tool = tools.find(candidate => candidate.name === "data_source_request");
  assert.ok(tool);
  assert.deepEqual((tool.parameters as { required: string[] }).required, ["source", "purpose"]);
  // Nothing in the question form asks for a data source any more.
  const questions = tools.find(candidate => candidate.name === "ask_user_questions");
  assert.doesNotMatch(JSON.stringify(questions), /source_access/);
});

test("a source request keeps its arguments for validation when it runs", () => {
  const runner = new AgentModelRunner({} as never, logger as never, false, false);
  const input = { source: "location", purpose: "tell you where you are", level: "always" };
  const [directive] = runner.extractToolCalls({ id: "response", content: [], stopReason: "tool_use",
    toolCalls: [{ id: "call", name: "data_source_request", input }] });
  assert.ok(isSourceRequestToolDirective(directive));
  assert.equal(toolNameForConversation(directive.tool), "data_source_request");
  assert.deepEqual(buildToolArgs(directive), input);
  assert.deepEqual(parseSourceRequestInput(input), input);
  assert.deepEqual(parseSourceRequestInput({ source: "health", purpose: "  check your sleep " }), { source: "health", purpose: "check your sleep" });
  // A strict-schema provider must send every property, so "not set" arrives as null.
  assert.deepEqual(parseSourceRequestInput({ source: "health", purpose: "check your sleep", level: null }), { source: "health", purpose: "check your sleep" });
  assert.deepEqual(parseSourceRequestInput({ source: "contacts", purpose: "find a number", level: null }), { source: "contacts", purpose: "find a number" });
  for (const bad of [{ source: "health", purpose: "x", level: "always" }, { source: "calendar", purpose: "x" }, { source: "location" },
    { source: "location", purpose: "x".repeat(121) }, { source: "location", purpose: "x", grant: true }])
    assert.throws(() => parseSourceRequestInput(bad), /purpose/);
});

test("the strict OpenAI schema lets a request leave level unset", () => {
  const tool = resolveAgentToolsForEnvironment(environment, { sourceRequests: true }).find(candidate => candidate.name === "data_source_request")!;
  const [strict] = (new OpenAIProvider("fixture-key") as any).transformTools([tool]);
  assert.deepEqual(strict.parameters.required, ["source", "purpose", "level"]);
  assert.deepEqual(strict.parameters.properties.level.type, ["string", "null"]);
  assert.ok(strict.parameters.properties.level.enum.includes(null));
});
