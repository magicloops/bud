import "dotenv/config";

export const PROTO_VERSION = "0.1";
export const TERMINAL_PROTO_VERSION = "0.2";

const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value: string | undefined) => ["1", "true", "yes"].includes((value ?? "").toLowerCase());

const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
export type ReasoningEffortSetting = (typeof REASONING_EFFORTS)[number];

const toReasoningEffort = (value: string | undefined, fallback: ReasoningEffortSetting): ReasoningEffortSetting => {
  if (!value) {
    return fallback;
  }
  const normalized = value.toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(normalized as (typeof REASONING_EFFORTS)[number])
    ? (normalized as ReasoningEffortSetting)
    : fallback;
};

export const config = {
  port: toNumber(process.env.PORT, 3000),
  host: process.env.HOST ?? "0.0.0.0",
  logLevel: process.env.LOG_LEVEL ?? "info",
  heartbeatSec: toNumber(process.env.WS_HEARTBEAT_SEC, 30),
  offlineGraceSec: toNumber(process.env.WS_OFFLINE_GRACE_SEC, 90),
  enrollmentHashSecret: process.env.ENROLLMENT_HASH_SECRET ?? "dev-secret",
  devTokenBypass: process.env.DEV_BUD_TOKEN_BYPASS ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  agentMaxSteps: toNumber(process.env.AGENT_MAX_STEPS, 5),
  agentMaxOutputTokens: toNumber(process.env.AGENT_MAX_OUTPUT_TOKENS, 128000),
  agentReasoningEffortDefault: toReasoningEffort(process.env.AGENT_REASONING_EFFORT, "none"),
  runLogMaxBytes: toNumber(process.env.RUN_LOG_MAX_BYTES, 100 * 1024 * 1024),
  agentDebug: toBool(process.env.AGENT_DEBUG),
  agentOpenaiDebug: toBool(process.env.AGENT_DEBUG_OPENAI),
  terminalEnabled: true,
  terminalOutputSoftCapBytes: toNumber(
    process.env.TERMINAL_OUTPUT_SOFT_CAP_BYTES,
    100 * 1024 * 1024
  ),
  terminalOutputBackfillBytes: toNumber(process.env.TERMINAL_OUTPUT_BACKFILL_BYTES, 4096),
  terminalOutputInflightMax: toNumber(process.env.TERMINAL_OUTPUT_INFLIGHT_MAX, 128),
  terminalOutputRetentionDays: toNumber(process.env.TERMINAL_OUTPUT_RETENTION_DAYS, 7),
  // Idle management: mark idle after 30 min, cleanup after 24 hours idle
  terminalIdleTimeoutMinutes: toNumber(process.env.TERMINAL_IDLE_TIMEOUT_MINUTES, 30),
  terminalIdleCleanupHours: toNumber(process.env.TERMINAL_IDLE_CLEANUP_HOURS, 24),
  // How often to run idle checks (default: every 5 minutes)
  terminalIdleCheckIntervalMinutes: toNumber(process.env.TERMINAL_IDLE_CHECK_INTERVAL_MINUTES, 5)
};
