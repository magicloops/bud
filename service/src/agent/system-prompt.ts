import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SYSTEM_PROMPT_PATH = new URL("./default-system-prompt.md", import.meta.url);

function loadSystemPrompt(): string {
  try {
    return readFileSync(SYSTEM_PROMPT_PATH, "utf8").replace(/\r\n/g, "\n").trim();
  } catch (error) {
    throw new Error(`Failed to load agent system prompt from ${SYSTEM_PROMPT_PATH}`, {
      cause: error,
    });
  }
}

export const AGENT_SYSTEM_PROMPT = loadSystemPrompt();

/** Content hash of the default prompt; surfaced as the prompt `version` so clients can tell when it changed. */
export const AGENT_SYSTEM_PROMPT_VERSION = `sha256:${createHash("sha256")
  .update(AGENT_SYSTEM_PROMPT)
  .digest("hex")
  .slice(0, 16)}`;

export type SystemPromptScope = "default";

export type ResolvedSystemPrompt = {
  text: string;
  scope: SystemPromptScope;
  version: string;
};

/**
 * The single place that decides which system prompt a thread gets. Today
 * every thread gets the default file. Bud- and thread-level overrides
 * (design/full-transcript-mode.md §4.D) plug in here — callers only ever see
 * `{ text, scope, version }`.
 */
export async function resolveSystemPrompt(_args: {
  threadId: string;
  budId?: string | null;
}): Promise<ResolvedSystemPrompt> {
  return {
    text: AGENT_SYSTEM_PROMPT,
    scope: "default",
    version: AGENT_SYSTEM_PROMPT_VERSION,
  };
}
