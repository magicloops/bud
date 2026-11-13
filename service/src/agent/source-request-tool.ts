import type { CanonicalTool } from "../llm/index.js";

/** Asks the user for a data source the agent can't use (bud-mobile `plan/data-sources-ux`, Phase 2b). */
export const SOURCE_REQUEST_CANONICAL_TOOL: CanonicalTool = {
  name: "data_source_request",
  description: "Ask the user for access to one of their personal data sources (location, health, contacts) when a data tool couldn't answer because access is missing: "
    + "a refusal with reason source_off or agent_not_allowed, or a collection note such as permission_not_asked or permission_denied. Also use it for "
    + "location when location_recent is stale and the user wants where they are now: it takes a fresh reading even when access is in order. "
    + "This pauses the turn while the user's phone shows a card; every change is a tap by the user, and you cannot grant access yourself. "
    + "The result says whether the source is usable now. After granted, query the data again before answering. "
    + "After declined, answer without it and ask again only if the user later says they want to share it (a repeat in the same turn is answered declined without being shown).",
  parameters: {
    type: "object", additionalProperties: false,
    properties: {
      source: { type: "string", enum: ["location", "health", "contacts"] },
      purpose: { type: "string", maxLength: 120,
        description: "What it is for, completing the sentence \"Your agent wants this to …\". For example: \"tell you where you are\". Lower case, no full stop." },
      level: { type: "string", enum: ["always"],
        description: "Location only: also ask for background access. Use only when the task needs arrivals or visit history, not for where the user is now." },
    },
    required: ["source", "purpose"],
  },
};
