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
    bud_envelope: z
      .object({
        version: z.number().int().positive(),
        websocket_binary: z.boolean().optional().default(false),
        stream_frames: z.boolean().optional().default(false)
      })
      .passthrough()
      .optional(),
    supports_pty: z.boolean().optional(),
    sessions_backends: z.array(z.string()).optional(),
    tmux_version: z.string().optional(),
    terminal_backends: z.array(z.string()).optional(),
    proxy: z.record(z.unknown()).optional(),
    files: z.record(z.unknown()).optional(),
    llm: z.record(z.unknown()).optional()
  })
  .transform((capabilities) => ({
    max_concurrency: capabilities.max_concurrency,
    ...(capabilities.shell_default ? { shell_default: capabilities.shell_default } : {}),
    sessions: capabilities.sessions,
    terminal: capabilities.terminal,
    ...(capabilities.terminal_proto ? { terminal_proto: capabilities.terminal_proto } : {}),
    ...(capabilities.bud_envelope ? { bud_envelope: capabilities.bud_envelope } : {}),
    ...(capabilities.proxy ? { proxy: capabilities.proxy } : {}),
    ...(capabilities.files ? { files: capabilities.files } : {}),
    ...(capabilities.llm ? { llm: capabilities.llm } : {}),
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
      cwd: z.string().optional(),
      cols: z.number().int().optional(),
      rows: z.number().int().optional(),
      ring_next_offset: z.number().int().nonnegative().optional(),
      mode: z.string().optional(),
      integration: z.string().optional()
    })
    .passthrough()
    .optional()
});

export const TerminalOutputSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_output"),
  session_id: z.string(),
  data: z.string(),
  byte_offset: z.number().int().nonnegative()
});

export const TerminalEventSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_event"),
  session_id: z.string(),
  event: z.string(),
  data: z.record(z.unknown()).default({})
});

// Grid-sync delta frame (proto §6.8.2). The service forwards these live to
// SSE without interpreting cell contents, so runs stay loosely typed; the
// structural fields are validated for ownership routing and client sanity.
export const TerminalGridSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_grid"),
  session_id: z.string(),
  generation: z.number().int().nonnegative(),
  full: z.boolean(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  alt_screen: z.boolean(),
  cursor: z.object({
    row: z.number().int().nonnegative(),
    col: z.number().int().nonnegative(),
    visible: z.boolean(),
    // DECSCUSR facts (§6.8.6) — optional on older daemons.
    shape: z.enum(["block", "underline", "beam"]).optional(),
    blink: z.boolean().optional()
  }),
  dirty_rows: z.array(
    z.object({
      row: z.number().int().nonnegative(),
      runs: z.array(z.record(z.unknown()))
    })
  ),
  scrollback_push: z.array(z.array(z.record(z.unknown()))).default([]),
  scrollback_dropped: z.number().int().nonnegative().default(0),
  // Predictive echo (§6.8.3) — optional: absent on pre-phase-3 daemons.
  predict_ok: z.boolean().optional(),
  applied_input_seq: z.number().int().nonnegative().optional(),
  // Scroll-hint delta (§6.8.5) — shift-then-patch; omitted when zero.
  row_shift: z.number().int().optional(),
  // DECCKM application-cursor fact (§6.8.4) — optional on older daemons.
  app_cursor: z.boolean().optional(),
  // Mouse-reporting facts (§6.8.4) — optional: absent on older daemons.
  mouse: z
    .object({
      report: z.enum(["none", "click", "drag", "motion"]),
      sgr: z.boolean(),
      alt_scroll: z.boolean()
    })
    .optional()
});

const TerminalEventOutcomeSchema = z.object({
  event: z.string(),
  data: z.record(z.unknown()).default({})
});

export const TerminalObserveResultSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_observe_result"),
  session_id: z.string(),
  request_id: z.string(),
  view: z.enum(["delta", "screen", "history"]),
  output: z.string(),
  lines_captured: z.number().int().nonnegative(),
  changed: z.boolean().nullable().optional(),
  mode: z.string().optional(),
  integration: z.string().optional(),
  alt_screen: z.boolean().optional(),
  cursor_row: z.number().int().optional(),
  cursor_col: z.number().int().optional(),
  // Stream watermark the daemon's emulator reflects at observe time: the next
  // output byte offset a stream resume from this observation should use.
  ring_next_offset: z.number().int().nonnegative().optional(),
  // view "screen" only: the grid serialized as ANSI (SGR runs + cursor
  // position), base64 — replaying it reproduces colors/styles/cursor.
  output_ansi: z.string().optional(),
  // Awaited observes (§6.1 `await`): the terminating fact the wait resolved
  // on. Absent on plain snapshots and on pre-wait daemons.
  outcome: TerminalEventOutcomeSchema.nullable().optional(),
  error: z.string().nullable()
});

export const TerminalSendResultSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_send_result"),
  session_id: z.string(),
  request_id: z.string(),
  dispatched: z.boolean(),
  outcome: TerminalEventOutcomeSchema.nullable().optional(),
  error: z.string().nullable(),
  // §6.7.4 unified-send facts (daemon ≥ v0.1.15).
  resolved_await: z.enum(["command", "settled", "auto"]).optional(),
  gated_ms: z.number().optional(),
  program_ready: z.boolean().optional()
});

export const ErrorFrameSchema = EnvelopeSchema.extend({
  type: z.literal("error"),
  code: z.string(),
  message: z.string()
});

const ReconnectOperationReportSchema = z.object({
  operation_id: z.string(),
  state: z.string(),
  operation_type: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

const ReconnectStreamReportSchema = z.object({
  stream_id: z.string(),
  operation_id: z.string().nullable().optional(),
  stream_type: z.string(),
  state: z.string(),
  send_offset: z.number().int().nonnegative().optional().default(0),
  receive_offset: z.number().int().nonnegative().optional().default(0),
  updated_at: z.string().nullable().optional(),
});

export const ReconnectReportSchema = EnvelopeSchema.extend({
  type: z.literal("reconnect_report"),
  bud_id: z.string(),
  device_session_id: z.string().optional(),
  operations: z.array(ReconnectOperationReportSchema).optional().default([]),
  streams: z.array(ReconnectStreamReportSchema).optional().default([]),
  terminal_sessions: z.array(z.string()).optional().default([]),
  local_policy_version: z.string().nullable().optional(),
});

export type ConnectionState =
  | { kind: "awaiting_hello" }
  | {
      kind: "awaiting_proof";
      budId: string;
      deviceSecret: string;
      nonce: string;
      hello: HelloFrame;
      /** Owner + stored name carried from the challenge lookup so the
       * proof step can stabilize the display name (hello re-sends the raw
       * requested name; a deduped `host-2` must not flip back). */
      ownerUserId: string | null;
      currentName: string | null;
    }
  | {
      kind: "connected";
      budId: string;
      sessionId: string;
      hello: HelloFrame;
    }
  | { kind: "closed" };
