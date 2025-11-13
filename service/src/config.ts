import "dotenv/config";

export const PROTO_VERSION = "0.1";

const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  runLogMaxBytes: toNumber(process.env.RUN_LOG_MAX_BYTES, 100 * 1024 * 1024)
};
