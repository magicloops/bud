import type { CanonicalTool } from "../llm/index.js";
import type { AgentEnvironmentSnapshot } from "./environment.js";
import { estimateCanonicalToolsTokens } from "./context-budget.js";
import { ASK_USER_QUESTIONS_TOOL } from "./user-question-contracts.js";

// Canonical tool definitions using standard JSON Schema.
export const AGENT_CANONICAL_TOOLS: CanonicalTool[] = [
  {
    name: "terminal_send",
    description:
      "Send input to the current terminal program. Use for shell commands, multiline shell input, REPL/TUI input, confirmations, launching interactive programs, and single-key actions.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Optional text to send literally to the terminal.",
        },
        submit: {
          type: "boolean",
          description: "When true, press Enter after sending the text.",
        },
        key: {
          type: "string",
          description:
            'Optional semantic key gesture. Use backend-neutral names such as "ctrl+c", "enter", or "escape".',
        },
        observe_after_ms: {
          type: "integer",
          description:
            'Optional delay before the final capture when wait_for:"none" is used. Defaults to 1000ms for that explicit fast path.',
        },
        wait_for: {
          type: "string",
          enum: ["none", "changed", "settled"],
          description:
            'Optional wait mode after sending input. Defaults to "settled" when omitted.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_observe",
    description:
      "Observe the rendered terminal screen or recent scrollback after interactive work or when more visibility is needed.",
    parameters: {
      type: "object",
      properties: {
        lines: {
          type: "integer",
          description: "Optional number of scrollback lines to include. Negative values mean recent history.",
        },
        wait_for: {
          type: "string",
          enum: ["none", "changed", "settled"],
          description: "Optional wait mode before observing.",
        },
        view: {
          type: "string",
          enum: ["delta", "screen", "history"],
          description: "Observation view. Defaults to delta. Use screen for the full current screen and history for recent scrollback.",
        },
      },
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
  "terminal_send",
  "terminal_observe",
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
