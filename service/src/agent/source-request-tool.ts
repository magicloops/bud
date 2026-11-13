import type { CanonicalTool } from "../llm/index.js";

/** Asks the user for a data source the agent can't use (bud-mobile `plan/data-sources-ux`, Phase 2b). */
export const SOURCE_REQUEST_CANONICAL_TOOL: CanonicalTool = {
  name: "data_source_request",
  description: "Ask the user to turn on one of their personal data sources (location, health, contacts). Call this whenever the task needs data that a data tool "
    + "couldn't give because access is missing: a refusal with reason source_off or agent_not_allowed, or a collection note such as permission_not_asked or "
    + "permission_denied. Call it too when the user asks you to turn a source on. Prefer it to telling the user to change settings. Also use it for "
    + "location when location_recent is stale and the user wants where they are now: it takes a fresh reading even when access is in order. "
    + "This pauses the turn while the user's phone shows a card; one tap by the user turns the source on (you cannot turn it on any other way). "
    + "The result says whether the source is usable now. After granted, query the data again before answering. "
    + "After declined, answer without it and ask again only if the user later says they want to share it (a repeat in the same turn is answered declined without being shown).",
  parameters: {
    type: "object", additionalProperties: false,
    properties: {
      source: { type: "string", enum: ["location", "health", "contacts"] },
      purpose: { type: "string", maxLength: 120,
        description: "What it is for, completing the sentence \"Your agent wants this to …\". For example: \"tell you where you are\". Lower case, no full stop." },
      level: { type: "string", enum: ["always"],
        description: "Optional; leave it out for most requests, including where the user is now. Location only: also asks for background access, for tasks that need arrivals or visit history." },
    },
    required: ["source", "purpose"],
  },
};
