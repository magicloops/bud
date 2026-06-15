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
