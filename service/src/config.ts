import "dotenv/config";
import { readFileSync } from "node:fs";

export const PROTO_VERSION = "0.1";
export const TERMINAL_PROTO_VERSION = "0.2";

const defaultDatabaseUrl = "postgres://postgres:postgres@localhost:5432/bud";
const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value: string | undefined) => ["1", "true", "yes"].includes((value ?? "").toLowerCase());
const toNullable = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};
const normalizeMultiline = (value: string | undefined) =>
  value ? value.replace(/\\n/g, "\n") : null;
export function resolveApnsPrivateKey(
  keyFile: string | undefined,
  inlineKey: string | undefined,
  shouldResolveFile = true,
): string | null {
  const trimmedKeyFile = keyFile?.trim();
  if (trimmedKeyFile && !shouldResolveFile) {
    return normalizeMultiline(inlineKey);
  }

  if (trimmedKeyFile) {
    try {
      return readFileSync(trimmedKeyFile, "utf8");
    } catch (err) {
      throw new Error(`Failed to read APNS_KEY_FILE at ${trimmedKeyFile}`, { cause: err });
    }
  }

  return normalizeMultiline(inlineKey);
}
const defaultPort = toNumber(process.env.PORT, 3000);
const defaultServiceUrl = `http://localhost:${defaultPort}`;

const trimTrailingSlash = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value);
const toUrlString = (value: string) => {
  try {
    return trimTrailingSlash(new URL(value).toString());
  } catch {
    return trimTrailingSlash(value);
  }
};
const joinUrl = (base: string, path: string) => {
  try {
    return trimTrailingSlash(new URL(path, base).toString());
  } catch {
    return `${trimTrailingSlash(base)}${path}`;
  }
};
const toList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
const DEFAULT_APNS_ALLOWED_TOPICS = "chat.bud.app,chat.bud.app.staging";
const toOrigin = (value: string) => {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
};

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

const apnsKeyId = toNullable(process.env.APNS_KEY_ID);
const apnsTeamId = toNullable(process.env.APNS_TEAM_ID);
const apnsKeyFile = toNullable(process.env.APNS_KEY_FILE);

export const config = {
  port: defaultPort,
  host: process.env.HOST ?? "0.0.0.0",
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl: process.env.DATABASE_URL ?? defaultDatabaseUrl,
  pgPoolMax: toNumber(process.env.PG_POOL_MAX, 10),
  betterAuthUrl: toUrlString(process.env.BETTER_AUTH_URL ?? defaultServiceUrl),
  appBaseUrl:
    toUrlString(process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? defaultServiceUrl),
  betterAuthSecret:
    process.env.BETTER_AUTH_SECRET ?? "bud-dev-better-auth-secret-change-me-please",
  betterAuthBasePath: "/api/auth",
  oauthLoginPagePath: "/auth/mobile",
  oauthConsentPagePath: "/auth/mobile/consent",
  apiAudience: toUrlString(
    process.env.API_AUDIENCE ??
      joinUrl(process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? defaultServiceUrl, "/api"),
  ),
  oauthTrustedClientIds: toList(process.env.OAUTH_TRUSTED_CLIENT_IDS),
  betterAuthTrustedOrigins: Array.from(
    new Set([
      toOrigin(process.env.BETTER_AUTH_URL ?? defaultServiceUrl),
      ...toList(process.env.BETTER_AUTH_TRUSTED_ORIGINS).map(toOrigin),
    ]),
  ),
  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  heartbeatSec: toNumber(process.env.WS_HEARTBEAT_SEC, 30),
  offlineGraceSec: toNumber(process.env.WS_OFFLINE_GRACE_SEC, 90),
  enrollmentHashSecret: process.env.ENROLLMENT_HASH_SECRET ?? "dev-secret",
  devTokenBypass: process.env.DEV_BUD_TOKEN_BYPASS ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  // Default model for agent (can be OpenAI or Anthropic)
  defaultModel: process.env.DEFAULT_MODEL ?? process.env.OPENAI_MODEL ?? "claude-opus-4-5",
  // Anthropic
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicTimeout: toNumber(process.env.ANTHROPIC_TIMEOUT_MS, 120000),
  agentMaxSteps: toNumber(process.env.AGENT_MAX_STEPS, 30),
  agentMaxOutputTokens: toNumber(process.env.AGENT_MAX_OUTPUT_TOKENS, 128000),
  agentReasoningEffortDefault: toReasoningEffort(process.env.AGENT_REASONING_EFFORT, "none"),
  runLogMaxBytes: toNumber(process.env.RUN_LOG_MAX_BYTES, 100 * 1024 * 1024),
  agentDebug: toBool(process.env.AGENT_DEBUG),
  agentOpenaiDebug: toBool(process.env.AGENT_DEBUG_OPENAI),
  // OpenAI request timeout in milliseconds (default: 2 minutes)
  openaiTimeout: toNumber(process.env.OPENAI_TIMEOUT_MS, 120000),
  terminalEnabled: true,
  terminalOutputSoftCapBytes: toNumber(
    process.env.TERMINAL_OUTPUT_SOFT_CAP_BYTES,
    100 * 1024 * 1024
  ),
  terminalOutputBackfillBytes: toNumber(process.env.TERMINAL_OUTPUT_BACKFILL_BYTES, 4096),
  terminalOutputInflightMax: toNumber(process.env.TERMINAL_OUTPUT_INFLIGHT_MAX, 128),
  terminalOutputRetentionDays: toNumber(process.env.TERMINAL_OUTPUT_RETENTION_DAYS, 7),
  // Idle management: mark idle after 30 min; destructive cleanup is disabled by default.
  terminalIdleTimeoutMinutes: toNumber(process.env.TERMINAL_IDLE_TIMEOUT_MINUTES, 30),
  terminalIdleCleanupHours: toNumber(process.env.TERMINAL_IDLE_CLEANUP_HOURS, 0),
  // How often to run idle checks (default: every 5 minutes)
  terminalIdleCheckIntervalMinutes: toNumber(process.env.TERMINAL_IDLE_CHECK_INTERVAL_MINUTES, 5),
  pushWorkerPollMs: toNumber(process.env.PUSH_WORKER_POLL_MS, 5000),
  pushWorkerBatchSize: toNumber(process.env.PUSH_WORKER_BATCH_SIZE, 10),
  apnsKeyId,
  apnsTeamId,
  apnsKeyFile,
  apnsPrivateKey: resolveApnsPrivateKey(
    process.env.APNS_KEY_FILE,
    process.env.APNS_PRIVATE_KEY,
    Boolean(apnsKeyId && apnsTeamId),
  ),
  apnsDefaultTopic: toNullable(process.env.APNS_DEFAULT_TOPIC),
  apnsAllowedTopics: toList(process.env.APNS_ALLOWED_TOPICS ?? DEFAULT_APNS_ALLOWED_TOPICS),
};
