import "dotenv/config";
import { readFileSync } from "node:fs";
import type { ReasoningLevel } from "./llm/model-catalog.js";

export const PROTO_VERSION = "0.1";
export const TERMINAL_PROTO_VERSION = "0.2";

const defaultDatabaseUrl = "postgres://postgres:postgres@localhost:5432/bud";
const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const toPositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const toBool = (value: string | undefined) => ["1", "true", "yes"].includes((value ?? "").toLowerCase());
const toOptionalNumber = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const toClampedRatio = (value: string | undefined, fallback: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
};
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

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ReasoningLevel[];
export type ReasoningEffortSetting = ReasoningLevel;

const DAEMON_TRANSPORT_POLICIES = ["websocket_baseline", "h2_preferred", "quic_preferred"] as const;
export type DaemonTransportPolicy = (typeof DAEMON_TRANSPORT_POLICIES)[number];
const defaultProxyBaseDomain =
  process.env.NODE_ENV === "production" ? "bud.show" : "proxy.localhost";
const defaultProxyPublicScheme =
  process.env.NODE_ENV === "production" ? "https" : "http";
const proxyPublicScheme = process.env.PROXY_PUBLIC_SCHEME ?? defaultProxyPublicScheme;
const proxyBaseDomain = process.env.PROXY_BASE_DOMAIN ?? defaultProxyBaseDomain;
const proxyPublicPort = toOptionalNumber(
  process.env.PROXY_PUBLIC_PORT ??
    (proxyPublicScheme === "http" && proxyBaseDomain.includes("localhost")
      ? String(defaultPort)
      : undefined),
);
const proxyViewerCookieName =
  process.env.PROXY_VIEWER_COOKIE_NAME ??
  (proxyPublicScheme === "https" ? "__Host-bud_proxy_viewer" : "bud_proxy_viewer");
const proxyEdgeSecret = toNullable(process.env.PROXY_EDGE_SECRET);

const toReasoningEffort = (value: string | undefined, fallback: ReasoningEffortSetting): ReasoningEffortSetting => {
  if (!value) {
    return fallback;
  }
  const normalized = value.toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(normalized as (typeof REASONING_EFFORTS)[number])
    ? (normalized as ReasoningEffortSetting)
    : fallback;
};

const toDaemonTransportPolicy = (value: string | undefined): DaemonTransportPolicy => {
  const normalized = value?.toLowerCase();
  return normalized && (DAEMON_TRANSPORT_POLICIES as readonly string[]).includes(normalized)
    ? (normalized as DaemonTransportPolicy)
    : "websocket_baseline";
};

const apnsKeyId = toNullable(process.env.APNS_KEY_ID);
const apnsTeamId = toNullable(process.env.APNS_TEAM_ID);
const apnsKeyFile = toNullable(process.env.APNS_KEY_FILE);
const dataPlaneMaxChunkBytes = toPositiveInteger(
  process.env.DATA_PLANE_MAX_CHUNK_BYTES ?? process.env.GRPC_DATA_MAX_CHUNK_BYTES,
  16 * 1024,
);
const dataPlaneInitialCreditBytes = toPositiveInteger(
  process.env.DATA_PLANE_INITIAL_CREDIT_BYTES ?? process.env.GRPC_DATA_INITIAL_CREDIT_BYTES,
  1024 * 1024,
);
const dataPlaneMaxInFlightBytes = toPositiveInteger(
  process.env.DATA_PLANE_MAX_IN_FLIGHT_BYTES,
  dataPlaneInitialCreditBytes,
);

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
  grpcControlEnabled: toBool(process.env.GRPC_CONTROL_ENABLED),
  grpcControlHost: process.env.GRPC_CONTROL_HOST ?? "127.0.0.1",
  grpcControlPort: toNumber(process.env.GRPC_CONTROL_PORT, 50051),
  grpcControlMaxMessageBytes: toNumber(
    process.env.GRPC_CONTROL_MAX_MESSAGE_BYTES,
    4 * 1024 * 1024,
  ),
  grpcControlMaxConcurrentStreams: toOptionalNumber(process.env.GRPC_CONTROL_MAX_CONCURRENT_STREAMS),
  grpcControlMaxSessionMemory: toOptionalNumber(process.env.GRPC_CONTROL_MAX_SESSION_MEMORY),
  grpcControlEnableChannelz: toOptionalNumber(process.env.GRPC_CONTROL_ENABLE_CHANNELZ),
  grpcDataEnabled: toBool(process.env.GRPC_DATA_ENABLED),
  grpcDataHost: process.env.GRPC_DATA_HOST ?? "127.0.0.1",
  grpcDataPort: toNumber(process.env.GRPC_DATA_PORT, 50052),
  grpcDataMaxMessageBytes: toNumber(process.env.GRPC_DATA_MAX_MESSAGE_BYTES, 4 * 1024 * 1024),
  grpcDataMaxChunkBytes: toNumber(process.env.GRPC_DATA_MAX_CHUNK_BYTES, 16 * 1024),
  grpcDataInitialCreditBytes: toNumber(process.env.GRPC_DATA_INITIAL_CREDIT_BYTES, 1024 * 1024),
  grpcDataMaxConcurrentStreams: toOptionalNumber(process.env.GRPC_DATA_MAX_CONCURRENT_STREAMS),
  grpcDataMaxSessionMemory: toOptionalNumber(process.env.GRPC_DATA_MAX_SESSION_MEMORY),
  grpcDataEnableChannelz: toOptionalNumber(process.env.GRPC_DATA_ENABLE_CHANNELZ),
  daemonTransportPolicy: toDaemonTransportPolicy(process.env.DAEMON_TRANSPORT_POLICY),
  dataPlaneMaxChunkBytes,
  dataPlaneInitialCreditBytes,
  dataPlaneMaxInFlightBytes,
  dataPlaneMaxConcurrentFileStreamsPerBud: toPositiveInteger(
    process.env.DATA_PLANE_MAX_CONCURRENT_FILE_STREAMS_PER_BUD,
    8,
  ),
  dataPlaneMaxConcurrentProxyStreamsPerBud: toPositiveInteger(
    process.env.DATA_PLANE_MAX_CONCURRENT_PROXY_STREAMS_PER_BUD,
    16,
  ),
  dataPlaneStreamIdleTimeoutMs: toPositiveInteger(
    process.env.DATA_PLANE_STREAM_IDLE_TIMEOUT_MS,
    60_000,
  ),
  dataPlaneStreamTtlMs: toPositiveInteger(process.env.DATA_PLANE_STREAM_TTL_MS, 5 * 60_000),
  fileSessionDefaultMaxBytes: toPositiveInteger(
    process.env.FILE_SESSION_DEFAULT_MAX_BYTES,
    64 * 1024 * 1024,
  ),
  proxySessionMaxResponseBytes: toPositiveInteger(
    process.env.PROXY_SESSION_MAX_RESPONSE_BYTES,
    16 * 1024 * 1024,
  ),
  proxySessionMaxRequestBodyBytes: toPositiveInteger(
    process.env.PROXY_SESSION_MAX_REQUEST_BODY_BYTES,
    10 * 1024 * 1024,
  ),
  proxyLocalAppCookieMaxCount: toPositiveInteger(
    process.env.PROXY_LOCAL_APP_COOKIE_MAX_COUNT,
    50,
  ),
  proxyLocalAppCookieMaxBytes: toPositiveInteger(
    process.env.PROXY_LOCAL_APP_COOKIE_MAX_BYTES,
    16 * 1024,
  ),
  proxyWebSocketMaxMessageBytes: toPositiveInteger(
    process.env.PROXY_WEBSOCKET_MAX_MESSAGE_BYTES,
    1024 * 1024,
  ),
  proxyWebSocketOpenTimeoutMs: toPositiveInteger(
    process.env.PROXY_WEBSOCKET_OPEN_TIMEOUT_MS,
    10_000,
  ),
  proxyWebSocketIdleTimeoutMs: toPositiveInteger(
    process.env.PROXY_WEBSOCKET_IDLE_TIMEOUT_MS,
    10 * 60_000,
  ),
  proxyWebSocketMaxConnectionsPerSite: toPositiveInteger(
    process.env.PROXY_WEBSOCKET_MAX_CONNECTIONS_PER_SITE,
    16,
  ),
  proxyWebSocketMaxConnectionsPerBud: toPositiveInteger(
    process.env.PROXY_WEBSOCKET_MAX_CONNECTIONS_PER_BUD,
    64,
  ),
  proxyGatewayEnabled: process.env.PROXY_GATEWAY_ENABLED === undefined
    ? true
    : toBool(process.env.PROXY_GATEWAY_ENABLED),
  proxyBaseDomain,
  proxyPublicScheme,
  proxyPublicPort,
  proxyViewerCookieName,
  proxyEdgeSecret,
  proxyViewerCookieMaxAgeSeconds: toPositiveInteger(
    process.env.PROXY_VIEWER_COOKIE_MAX_AGE_SECONDS,
    7 * 24 * 60 * 60,
  ),
  proxyViewerCookieRefreshSeconds: toPositiveInteger(
    process.env.PROXY_VIEWER_COOKIE_REFRESH_SECONDS,
    24 * 60 * 60,
  ),
  proxyBootstrapGrantTtlSeconds: toPositiveInteger(
    process.env.PROXY_BOOTSTRAP_GRANT_TTL_SECONDS,
    5 * 60,
  ),
  proxiedSiteTtlSeconds: toPositiveInteger(
    process.env.PROXIED_SITE_TTL_SECONDS,
    90 * 24 * 60 * 60,
  ),
  enrollmentHashSecret: process.env.ENROLLMENT_HASH_SECRET ?? "dev-secret",
  devTokenBypass: process.env.DEV_BUD_TOKEN_BYPASS ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  // Default model for agent (can be OpenAI or Anthropic)
  defaultModel: process.env.DEFAULT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.5",
  // Anthropic
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicTimeout: toNumber(process.env.ANTHROPIC_TIMEOUT_MS, 120000),
  agentMaxSteps: toNumber(process.env.AGENT_MAX_STEPS, 1000),
  agentMaxOutputTokens: toNumber(process.env.AGENT_MAX_OUTPUT_TOKENS, 128000),
  agentReasoningEffortDefault: toReasoningEffort(process.env.AGENT_REASONING_EFFORT, "low"),
  agentAutoCompactionEnabled: process.env.AGENT_AUTO_COMPACTION_ENABLED === undefined
    ? true
    : toBool(process.env.AGENT_AUTO_COMPACTION_ENABLED),
  agentAutoCompactionRatio: toClampedRatio(
    process.env.AGENT_AUTO_COMPACTION_RATIO,
    0.95,
    0.95,
  ),
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
