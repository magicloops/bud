import { z } from "zod";
import { PROTO_VERSION, TERMINAL_PROTO_VERSION } from "../config.js";

export const EnvelopeSchema = z.object({
  proto: z.literal(PROTO_VERSION),
  type: z.string(),
  id: z.string(),
  ts: z.number(),
  ext: z.record(z.unknown()).default({})
});

export const TerminalEnvelopeSchema = z.object({
  proto: z.literal(TERMINAL_PROTO_VERSION),
  type: z.string(),
  id: z.string(),
  ts: z.number(),
  ext: z.record(z.unknown()).default({})
});

const CapabilitiesSchema = z
  .object({
    max_concurrency: z.number().int().positive().default(1),
    shell_default: z.string().optional(),
    sessions: z.boolean().default(false),
    terminal: z.boolean().optional().default(false),
    terminal_proto: z.string().optional(),
    supports_pty: z.boolean().optional(),
    sessions_backends: z.array(z.string()).optional(),
    tmux_version: z.string().optional(),
    terminal_backends: z.array(z.string()).optional()
  })
  .transform((capabilities) => ({
    max_concurrency: capabilities.max_concurrency,
    ...(capabilities.shell_default ? { shell_default: capabilities.shell_default } : {}),
    sessions: capabilities.sessions,
    terminal: capabilities.terminal,
    ...(capabilities.terminal_proto ? { terminal_proto: capabilities.terminal_proto } : {}),
  }));

export const HelloSchema = EnvelopeSchema.extend({
  type: z.literal("hello"),
  name: z.string(),
  os: z.string(),
  arch: z.string(),
  version: z.string().optional(),
  installation_id: z.string().optional(),
  token: z.string().optional(),
  bud_id: z.string().optional(),
  capabilities: CapabilitiesSchema
});

export type HelloFrame = z.infer<typeof HelloSchema>;
export type HelloWithBudId = HelloFrame & { bud_id: string };

export const HelloProofSchema = EnvelopeSchema.extend({
  type: z.literal("hello_proof"),
  bud_id: z.string(),
  hmac: z.string()
});

export const TerminalStatusSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_status"),
  session_id: z.string(),
  state: z.string(),
  info: z
    .object({
      pid: z.number().int().optional(),
      shell: z.string().optional(),
      cwd: z.string().optional(),
      cols: z.number().int().optional(),
      rows: z.number().int().optional(),
      output_log_bytes: z.number().int().optional(),
      started_at: z.string().optional(),
      last_activity_at: z.string().optional()
    })
    .passthrough()
    .optional()
});

export const TerminalOutputSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_output"),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.string(),
  byte_offset: z.number().int().nonnegative()
});

export const TerminalReadySchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_ready"),
  session_id: z.string(),
  assessment: z.record(z.unknown()),
});

const ReadinessSchema = z.object({
  ready: z.boolean(),
  confidence: z.number(),
  trigger: z.string(),
  prompt_type: z.string().optional(),
  hints: z.record(z.boolean()).optional(),
  quiet_for_ms: z.number().optional(),
  activity_checks: z.number().optional(),
  stable_checks: z.number().optional()
});

export const TerminalObserveResultSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_observe_result"),
  session_id: z.string(),
  request_id: z.string(),
  view: z.enum(["delta", "screen", "history"]),
  output: z.string(),
  output_bytes: z.number().int().nonnegative(),
  lines_captured: z.number().int().nonnegative(),
  changed: z.boolean().nullable().optional(),
  truncated: z.boolean().nullable().optional(),
  readiness: ReadinessSchema,
  error: z.string().nullable()
});

export const TerminalSendResultSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_send_result"),
  session_id: z.string(),
  request_id: z.string(),
  submitted: z.boolean(),
  delta: z
    .object({
      changed: z.boolean(),
      text: z.string(),
      truncated: z.boolean()
    })
    .nullable()
    .optional(),
  readiness: ReadinessSchema,
  error: z.string().nullable()
});

export const ErrorFrameSchema = EnvelopeSchema.extend({
  type: z.literal("error"),
  code: z.string(),
  message: z.string()
});

export type ConnectionState =
  | { kind: "awaiting_hello" }
  | {
      kind: "awaiting_proof";
      budId: string;
      deviceSecret: string;
      nonce: string;
      hello: HelloFrame;
    }
  | {
      kind: "connected";
      budId: string;
      sessionId: string;
      hello: HelloFrame;
    }
  | { kind: "closed" };

