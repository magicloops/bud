import type { CanonicalTool } from "../llm/index.js";
import type { AgentEnvironmentSnapshot } from "./environment.js";
import { estimateCanonicalToolsTokens } from "./context-budget.js";
import { ASK_USER_QUESTIONS_TOOL } from "./user-question-contracts.js";

// Canonical tool definitions using standard JSON Schema.
export const AGENT_CANONICAL_TOOLS: CanonicalTool[] = [
  {
    name: "terminal_run",
    description:
      "Run one shell command in the thread terminal and wait for it to finish. Returns the real exit_code, duration_ms, and the command's output. Use this for anything that is a shell command; only works while the terminal is at a shell prompt.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to run. Multi-line input such as heredocs or small pasted scripts is allowed.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_send",
    description:
      "Send one input gesture to the interactive program in the terminal (TUI, REPL, prompt). Provide exactly one of raw_text or key. Waits for the screen to settle and returns the screen delta as proof of what changed. Shell commands belong to terminal_run instead.",
    parameters: {
      type: "object",
      properties: {
        raw_text: {
          type: "string",
          description:
            "Literal text to type. Presses Enter afterward by default; set submit to false to type without submitting (e.g. composing text in an editor buffer).",
        },
        submit: {
          type: "boolean",
          description:
            "Whether to press Enter after raw_text (default true). Ignored for key gestures.",
        },
        key: {
          type: "string",
          description:
            'One semantic key gesture. Use backend-neutral names such as "ctrl+c", "enter", "escape", "up", or "q".',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_observe",
    description:
      "Look at the terminal without sending input: what changed since the last observation (delta), the full rendered screen, or recent scrollback history.",
    parameters: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["delta", "screen", "history"],
          description:
            "Observation view. Defaults to delta. Use screen for the full current screen and history for recent scrollback.",
        },
        lines: {
          type: "integer",
          description:
            "Optional number of scrollback lines to include. Negative values mean recent history.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_wait",
    description:
      "Wait until the terminal needs your attention, then return what changed. There is nothing to configure: " +
      "it returns when the running command finishes (with its exit code), when the shell prompt returns, or when " +
      "output painted during the wait stops changing (a TUI asking a question, a finished step) — and immediately " +
      "if the terminal is already idle. Use this instead of repeatedly observing while anything is working. " +
      "The service owns the wait budget; if nothing has happened when it expires, the result says so and you can call it again.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "web_view_open",
    description:
      "Open or reuse a browser web view for an HTTP server running on the Bud host loopback interface, then attach it to the current thread.",
    parameters: {
      type: "object",
      properties: {
        target_port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "Loopback port where the local web server is listening.",
        },
        target_host: {
          type: "string",
          enum: ["127.0.0.1", "localhost", "::1"],
          description:
            "Loopback host. Defaults to localhost when omitted. If the user names localhost, 127.0.0.1, or ::1 explicitly, preserve that exact host.",
        },
        path: {
          type: "string",
          description: "Absolute path to open on the local app. Defaults to /.",
        },
        title: {
          type: "string",
          description: "Short display name for the proxied site.",
        },
      },
      required: ["target_port"],
      additionalProperties: false,
    },
  },
  {
    name: "web_view_close",
    description:
      "Detach the current thread web view. Optionally disable the proxied site when the user asked to stop exposing it.",
    parameters: {
      type: "object",
      properties: {
        proxied_site_id: {
          type: "string",
          description: "Optional proxied site id to close. Defaults to the current thread web view.",
        },
        disable: {
          type: "boolean",
          description: "When true, disable the proxied site in addition to detaching it.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "web_view_list",
    description:
      "List owned proxied web views for this Bud and identify the current thread attachment.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: ASK_USER_QUESTIONS_TOOL,
    description:
      "Ask the user one or more structured, skippable questions before continuing the current task. Use only when the answer is needed to proceed.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title for the question prompt.",
        },
        body: {
          type: "string",
          description: "Optional context explaining why this input is needed.",
        },
        submit_label: {
          type: "string",
          description: "Optional label for the form submit action.",
        },
        skip_all_label: {
          type: "string",
          description: "Optional label for skipping every question.",
        },
        questions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              question_id: {
                type: "string",
                description: "Stable snake_case or kebab-case id for the question.",
              },
              kind: {
                type: "string",
                enum: ["boolean", "single_choice", "multi_choice", "text", "number"],
              },
              label: {
                type: "string",
                description: "User-visible question text.",
              },
              help_text: {
                type: "string",
                description: "Optional helper text for the question.",
              },
              importance: {
                type: "string",
                enum: ["required", "important", "optional"],
                description: "Advisory importance only; users may still skip.",
              },
              choices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    choice_id: { type: "string" },
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["choice_id", "label"],
                  additionalProperties: false,
                },
              },
              default_answer: {
                type: "object",
                description: "Optional typed default answer matching the question kind.",
              },
              multiline: { type: "boolean" },
              placeholder: { type: "string" },
              min_length: { type: "integer", minimum: 0 },
              max_length: { type: "integer", minimum: 1 },
              min: { type: "number" },
              max: { type: "number" },
              step: { type: "number", minimum: 0 },
              unit: { type: "string" },
            },
            required: ["kind", "label"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
];

const BUD_SPECIFIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "terminal_run",
  "terminal_send",
  "terminal_observe",
  "terminal_wait",
  "web_view_open",
  "web_view_close",
  "web_view_list",
]);

export function resolveAgentToolsForEnvironment(
  environment: AgentEnvironmentSnapshot,
): CanonicalTool[] {
  if (environment.mode === "normal") {
    return AGENT_CANONICAL_TOOLS;
  }

  return AGENT_CANONICAL_TOOLS.filter((tool) => {
    return !BUD_SPECIFIC_TOOL_NAMES.has(tool.name);
  });
}

export const AGENT_TOOL_SCHEMA_TOKENS = estimateCanonicalToolsTokens(AGENT_CANONICAL_TOOLS);
