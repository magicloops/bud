import {
  pgSchema,
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  integer,
  bigint,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
  customType
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const authSchema = pgSchema("auth");

const messageRoleValues = ["user", "assistant", "tool", "system"] as const;
export const operationStateValues = [
  "offered",
  "accepted",
  "rejected",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
  "expired",
] as const;
export const streamStateValues = [
  "opening",
  "open",
  "half_closed_local",
  "half_closed_remote",
  "closed",
  "reset",
  "unknown",
  "expired",
] as const;
export const proxySessionStateValues = [
  "ready",
  "unavailable",
  "revoked",
  "expired",
] as const;
export const fileSessionStateValues = [
  "ready",
  "unavailable",
  "revoked",
  "expired",
] as const;

const byteaColumn = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  }
});

export const budTable = pgTable(
  "bud",
  {
    budId: text("bud_id").primaryKey(),
    installationId: text("installation_id"),
    name: text("name").notNull(),
    displayName: text("display_name"),
    os: text("os").notNull(),
    arch: text("arch").notNull(),
    version: text("version"),
    accentColor: text("accent_color"),
    tags: jsonb("tags")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    capabilities: jsonb("capabilities")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    deviceSecret: text("device_secret"),
    devicePubkey: text("device_pubkey"),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    installationIdx: uniqueIndex("bud_installation_id_idx").on(table.installationId),
  }),
);

export const enrollmentTokenTable = pgTable("enrollment_token", {
  tokenHash: text("token_hash").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true })
});

export const authUserTable = authSchema.table(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("emailVerified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("createdAt", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    emailIdx: uniqueIndex("auth_user_email_idx").on(table.email),
  }),
);

export const authSessionTable = authSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).default(sql`now()`).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => authUserTable.id, { onDelete: "cascade" }),
  },
  (table) => ({
    tokenIdx: uniqueIndex("auth_session_token_idx").on(table.token),
    userIdx: index("auth_session_user_idx").on(table.userId),
  }),
);

export const authAccountTable = authSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => authUserTable.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    userIdx: index("auth_account_user_idx").on(table.userId),
    providerAccountIdx: index("auth_account_provider_account_idx").on(table.providerId, table.accountId),
  }),
);

export const authVerificationTable = authSchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    identifierIdx: index("auth_verification_identifier_idx").on(table.identifier),
  }),
);

export const authJwksTable = authSchema.table("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }),
});

export const authOAuthClientTable = authSchema.table(
  "oauthClient",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId").notNull().unique(),
    clientSecret: text("clientSecret"),
    disabled: boolean("disabled"),
    skipConsent: boolean("skipConsent"),
    enableEndSession: boolean("enableEndSession"),
    subjectType: text("subjectType"),
    scopes: jsonb("scopes").$type<string[]>(),
    userId: text("userId").references(() => authUserTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt", { withTimezone: true }),
    updatedAt: timestamp("updatedAt", { withTimezone: true }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: jsonb("contacts").$type<string[]>(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("softwareId"),
    softwareVersion: text("softwareVersion"),
    softwareStatement: text("softwareStatement"),
    redirectUris: jsonb("redirectUris").$type<string[]>().notNull(),
    postLogoutRedirectUris: jsonb("postLogoutRedirectUris").$type<string[]>(),
    tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
    grantTypes: jsonb("grantTypes").$type<string[]>(),
    responseTypes: jsonb("responseTypes").$type<string[]>(),
    public: boolean("public"),
    type: text("type"),
    requirePKCE: boolean("requirePKCE"),
    referenceId: text("referenceId"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
);

export const authOAuthRefreshTokenTable = authSchema.table("oauthRefreshToken", {
  id: text("id").primaryKey(),
  token: text("token").notNull(),
  clientId: text("clientId")
    .notNull()
    .references(() => authOAuthClientTable.clientId, { onDelete: "cascade" }),
  sessionId: text("sessionId").references(() => authSessionTable.id, { onDelete: "set null" }),
  userId: text("userId")
    .notNull()
    .references(() => authUserTable.id, { onDelete: "cascade" }),
  referenceId: text("referenceId"),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  revoked: timestamp("revoked", { withTimezone: true }),
  authTime: timestamp("authTime", { withTimezone: true }),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
});

export const authOAuthAccessTokenTable = authSchema.table(
  "oauthAccessToken",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("clientId")
      .notNull()
      .references(() => authOAuthClientTable.clientId, { onDelete: "cascade" }),
    sessionId: text("sessionId").references(() => authSessionTable.id, { onDelete: "set null" }),
    userId: text("userId").references(() => authUserTable.id, { onDelete: "cascade" }),
    referenceId: text("referenceId"),
    refreshId: text("refreshId").references(() => authOAuthRefreshTokenTable.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
  },
);

export const authOAuthConsentTable = authSchema.table("oauthConsent", {
  id: text("id").primaryKey(),
  clientId: text("clientId")
    .notNull()
    .references(() => authOAuthClientTable.clientId, { onDelete: "cascade" }),
  userId: text("userId").references(() => authUserTable.id, { onDelete: "cascade" }),
  referenceId: text("referenceId"),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

export const userProfileTable = pgTable(
  "user_profile",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => authUserTable.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    usernameIdx: uniqueIndex("user_profile_username_idx").on(table.username),
  }),
);

export const deviceAuthFlowTable = pgTable(
  "device_auth_flow",
  {
    flowId: text("flow_id").primaryKey(),
    installationId: text("installation_id").notNull(),
    pollSecretHash: text("poll_secret_hash").notNull(),
    requestedName: text("requested_name").notNull(),
    requestedOs: text("requested_os").notNull(),
    requestedArch: text("requested_arch").notNull(),
    requestedVersion: text("requested_version"),
    requestedCapabilities: jsonb("requested_capabilities")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"),
    approvedByUserId: text("approved_by_user_id").references(() => authUserTable.id, {
      onDelete: "set null",
    }),
    budId: text("bud_id").references(() => budTable.budId, { onDelete: "set null" }),
    issuedDeviceSecret: text("issued_device_secret"),
    errorCode: text("error_code"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    installationIdx: index("device_auth_flow_installation_idx").on(table.installationId, table.createdAt),
    statusIdx: index("device_auth_flow_status_idx").on(table.status, table.expiresAt),
    pollSecretIdx: index("device_auth_flow_poll_secret_idx").on(table.pollSecretHash),
  }),
);

export const threadTable = pgTable(
  "thread",
  {
    threadId: uuid("thread_id").primaryKey().defaultRandom(),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    title: text("title"),
    lastMessagePreview: text("last_message_preview"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).default(sql`now()`).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    pinned: boolean("pinned").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastAttentionMessageId: uuid("last_attention_message_id"),
    lastAttentionMessageCreatedAt: timestamp("last_attention_message_created_at", {
      withTimezone: true,
    }),
    lastAttentionKind: text("last_attention_kind"),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    budIdx: index("thread_bud_idx").on(table.budId),
    deletedIdx: index("thread_deleted_idx").on(table.deletedAt)
  })
);

export const threadReadStateTable = pgTable(
  "thread_read_state",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threadTable.threadId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUserTable.id, { onDelete: "cascade" }),
    lastSeenMessageId: uuid("last_seen_message_id"),
    lastSeenMessageCreatedAt: timestamp("last_seen_message_created_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).default(sql`now()`).notNull(),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.threadId, table.userId], name: "thread_read_state_pkey" }),
    userIdx: index("thread_read_state_user_idx").on(table.userId, table.lastSeenAt),
  }),
);

export const pushEndpointTable = pgTable(
  "push_endpoint",
  {
    endpointId: uuid("endpoint_id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUserTable.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    platform: text("platform").notNull(),
    provider: text("provider").notNull(),
    providerEnvironment: text("provider_environment"),
    appId: text("app_id").notNull(),
    token: text("token").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    alertsAgentCompleted: boolean("alerts_agent_completed").notNull().default(true),
    alertsHumanInputRequested: boolean("alerts_human_input_requested").notNull().default(true),
    includeMessagePreview: boolean("include_message_preview").notNull().default(true),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    lastRegisteredAt: timestamp("last_registered_at", { withTimezone: true }).default(sql`now()`).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).default(sql`now()`).notNull(),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    userInstallationIdx: uniqueIndex("push_endpoint_user_installation_idx").on(
      table.userId,
      table.installationId,
    ),
    userIdx: index("push_endpoint_user_idx").on(table.userId, table.updatedAt),
    providerTokenIdx: uniqueIndex("push_endpoint_provider_token_idx").on(table.provider, table.token),
  }),
);

export const messageTable = pgTable(
  "message",
  {
    messageId: uuid("message_id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threadTable.threadId, { onDelete: "cascade" }),
    role: text("role", { enum: messageRoleValues }).notNull(),
    displayRole: text("display_role"),
    content: text("content").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    threadIdx: index("message_thread_idx").on(table.threadId),
    clientIdUniqueIdx: uniqueIndex("message_client_id_idx").on(table.clientId)
  })
);

export const pushNotificationOutboxTable = pgTable(
  "push_notification_outbox",
  {
    notificationId: text("notification_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUserTable.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threadTable.threadId, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messageTable.messageId, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    dedupeKey: text("dedupe_key").notNull(),
    collapseKey: text("collapse_key").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).default(sql`now()`).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    suppressedReason: text("suppressed_reason"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    dedupeIdx: uniqueIndex("push_notification_outbox_dedupe_idx").on(table.dedupeKey),
    statusIdx: index("push_notification_outbox_status_idx").on(table.status, table.nextAttemptAt),
    userIdx: index("push_notification_outbox_user_idx").on(table.userId, table.createdAt),
    threadIdx: index("push_notification_outbox_thread_idx").on(table.threadId, table.createdAt),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Terminal Sessions (thread-scoped)
// ─────────────────────────────────────────────────────────────────────────────

export const terminalSessionTable = pgTable(
  "terminal_session",
  {
    sessionId: text("session_id").primaryKey(),
    threadId: uuid("thread_id")
      .references(() => threadTable.threadId, { onDelete: "set null" }),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    instanceId: text("instance_id"),
    state: text("state").notNull().default("pending"),
    shell: text("shell"),
    cwd: text("cwd"),
    cols: integer("cols").notNull().default(200),
    rows: integer("rows").notNull().default(50),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastInputAt: timestamp("last_input_at", { withTimezone: true }),
    lastOutputAt: timestamp("last_output_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    totalInputBytes: bigint("total_input_bytes", { mode: "number" }).notNull().default(0),
    totalOutputBytes: bigint("total_output_bytes", { mode: "number" }).notNull().default(0),
    outputLogBytes: bigint("output_log_bytes", { mode: "number" }).notNull().default(0),
    // State snapshot for context sync - tracks terminal state changes
    stateSnapshot: jsonb("state_snapshot").$type<{
      screenHash: string;
      lastLine: string;
      detectedMode: "shell" | "repl" | "tui" | "unknown";
      detectedProgram: string | null;
      capturedAt: string;  // ISO timestamp
    } | null>(),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id")
  },
  (table) => ({
    budStateIdx: index("terminal_session_bud_state_idx").on(table.budId, table.state),
    instanceIdx: index("terminal_session_instance_idx").on(table.instanceId),
    threadIdx: index("terminal_session_thread_idx").on(table.threadId),
    // A thread may have many historical sessions, but only one active (non-closed) session.
    activeThreadUniqueIdx: uniqueIndex("terminal_session_thread_active_unique_idx")
      .on(table.threadId)
      .where(sql`${table.threadId} is not null and ${table.closedAt} is null`),
  })
);

export const terminalSessionOutputTable = pgTable(
  "terminal_session_output",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => terminalSessionTable.sessionId, { onDelete: "cascade" }),
    byteOffset: bigint("byte_offset", { mode: "number" }).notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    data: byteaColumn("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.byteOffset], name: "terminal_session_output_pkey" }),
    seqIdx: index("terminal_session_output_seq_idx").on(table.sessionId, table.seq)
  })
);

export const terminalSessionInputLogTable = pgTable(
  "terminal_session_input_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id")
      .notNull()
      .references(() => terminalSessionTable.sessionId, { onDelete: "cascade" }),
    data: byteaColumn("data").notNull(),
    source: text("source").notNull(),
    userId: text("user_id"),
    tenantId: text("tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    sessionIdx: index("terminal_session_input_log_idx").on(table.sessionId, table.createdAt)
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Daemon transport durability (network-upgrade Phase 1)
// ─────────────────────────────────────────────────────────────────────────────

export const deviceSessionTable = pgTable(
  "device_session",
  {
    deviceSessionId: text("device_session_id").primaryKey(),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    gatewayInstanceId: text("gateway_instance_id"),
    capabilities: jsonb("capabilities")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    connectedAt: timestamp("connected_at", { withTimezone: true }).default(sql`now()`).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    drainStartedAt: timestamp("drain_started_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    budStatusIdx: index("device_session_bud_status_idx").on(table.budId, table.status),
    heartbeatIdx: index("device_session_heartbeat_idx").on(table.lastHeartbeatAt),
  }),
);

export const transportSessionTable = pgTable(
  "transport_session",
  {
    transportSessionId: text("transport_session_id").primaryKey(),
    deviceSessionId: text("device_session_id").references(() => deviceSessionTable.deviceSessionId, {
      onDelete: "set null",
    }),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    transportKind: text("transport_kind").notNull(),
    status: text("status").notNull().default("active"),
    remoteAddr: text("remote_addr"),
    userAgent: text("user_agent"),
    connectedAt: timestamp("connected_at", { withTimezone: true }).default(sql`now()`).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    drainStartedAt: timestamp("drain_started_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    deviceIdx: index("transport_session_device_idx").on(table.deviceSessionId),
    budKindStatusIdx: index("transport_session_bud_kind_status_idx").on(
      table.budId,
      table.transportKind,
      table.status,
    ),
  }),
);

export const budOperationTable = pgTable(
  "bud_operation",
  {
    operationId: text("operation_id").primaryKey(),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => threadTable.threadId, { onDelete: "set null" }),
    terminalSessionId: text("terminal_session_id").references(() => terminalSessionTable.sessionId, {
      onDelete: "set null",
    }),
    deviceSessionId: text("device_session_id").references(() => deviceSessionTable.deviceSessionId, {
      onDelete: "set null",
    }),
    transportSessionId: text("transport_session_id").references(() => transportSessionTable.transportSessionId, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key"),
    operationType: text("operation_type").notNull(),
    trafficClass: text("traffic_class").notNull().default("control"),
    state: text("state", { enum: operationStateValues }).notNull().default("offered"),
    request: jsonb("request")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorRetryable: boolean("error_retryable"),
    errorDetails: jsonb("error_details").$type<Record<string, unknown>>(),
    offeredAt: timestamp("offered_at", { withTimezone: true }).default(sql`now()`).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    budStateIdx: index("bud_operation_bud_state_idx").on(table.budId, table.state),
    threadIdx: index("bud_operation_thread_idx").on(table.threadId, table.createdAt),
    idempotencyIdx: uniqueIndex("bud_operation_idempotency_idx").on(table.budId, table.idempotencyKey),
  }),
);

export const budStreamTable = pgTable(
  "bud_stream",
  {
    streamId: text("stream_id").primaryKey(),
    operationId: text("operation_id").references(() => budOperationTable.operationId, {
      onDelete: "cascade",
    }),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    deviceSessionId: text("device_session_id").references(() => deviceSessionTable.deviceSessionId, {
      onDelete: "set null",
    }),
    transportSessionId: text("transport_session_id").references(() => transportSessionTable.transportSessionId, {
      onDelete: "set null",
    }),
    streamType: text("stream_type").notNull(),
    trafficClass: text("traffic_class").notNull().default("interactive"),
    state: text("state", { enum: streamStateValues }).notNull().default("opening"),
    sendOffset: bigint("send_offset", { mode: "number" }).notNull().default(0),
    receiveOffset: bigint("receive_offset", { mode: "number" }).notNull().default(0),
    creditWindowBytes: bigint("credit_window_bytes", { mode: "number" }),
    resetReason: text("reset_reason"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorRetryable: boolean("error_retryable"),
    errorDetails: jsonb("error_details").$type<Record<string, unknown>>(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    operationIdx: index("bud_stream_operation_idx").on(table.operationId),
    budStateIdx: index("bud_stream_bud_state_idx").on(table.budId, table.state),
    transportIdx: index("bud_stream_transport_idx").on(table.transportSessionId, table.state),
  }),
);

export const proxySessionTable = pgTable(
  "proxy_session",
  {
    proxySessionId: text("proxy_session_id").primaryKey(),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => threadTable.threadId, { onDelete: "set null" }),
    operationId: text("operation_id").references(() => budOperationTable.operationId, {
      onDelete: "set null",
    }),
    activeStreamId: text("active_stream_id").references(() => budStreamTable.streamId, {
      onDelete: "set null",
    }),
    targetHost: text("target_host").notNull(),
    targetPort: integer("target_port").notNull(),
    allowedMethods: jsonb("allowed_methods")
      .$type<string[]>()
      .notNull()
      .default(sql`'["GET","HEAD"]'::jsonb`),
    state: text("state", { enum: proxySessionStateValues }).notNull().default("ready"),
    displayMetadata: jsonb("display_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    auditCorrelationId: text("audit_correlation_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id").references(() => authUserTable.id, {
      onDelete: "set null",
    }),
    revokeReason: text("revoke_reason"),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    ownerStateIdx: index("proxy_session_owner_state_idx").on(
      table.createdByUserId,
      table.state,
      table.expiresAt,
    ),
    budStateIdx: index("proxy_session_bud_state_idx").on(table.budId, table.state, table.expiresAt),
    threadIdx: index("proxy_session_thread_idx").on(table.threadId, table.createdAt),
    auditCorrelationIdx: index("proxy_session_audit_correlation_idx").on(table.auditCorrelationId),
  }),
);

export const fileSessionTable = pgTable(
  "file_session",
  {
    fileSessionId: text("file_session_id").primaryKey(),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => threadTable.threadId, { onDelete: "set null" }),
    operationId: text("operation_id").references(() => budOperationTable.operationId, {
      onDelete: "set null",
    }),
    activeStreamId: text("active_stream_id").references(() => budStreamTable.streamId, {
      onDelete: "set null",
    }),
    rootKey: text("root_key").notNull(),
    relativePath: text("relative_path").notNull(),
    permissions: jsonb("permissions")
      .$type<string[]>()
      .notNull()
      .default(sql`'["stat","read","range"]'::jsonb`),
    maxBytes: bigint("max_bytes", { mode: "number" }).notNull(),
    state: text("state", { enum: fileSessionStateValues }).notNull().default("ready"),
    contentIdentity: jsonb("content_identity").$type<Record<string, unknown>>(),
    displayMetadata: jsonb("display_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    auditCorrelationId: text("audit_correlation_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id").references(() => authUserTable.id, {
      onDelete: "set null",
    }),
    revokeReason: text("revoke_reason"),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    ownerStateIdx: index("file_session_owner_state_idx").on(
      table.createdByUserId,
      table.state,
      table.expiresAt,
    ),
    budStateIdx: index("file_session_bud_state_idx").on(table.budId, table.state, table.expiresAt),
    threadIdx: index("file_session_thread_idx").on(table.threadId, table.createdAt),
    auditCorrelationIdx: index("file_session_audit_correlation_idx").on(table.auditCorrelationId),
  }),
);

export const auditEventTable = pgTable(
  "audit_event",
  {
    auditEventId: text("audit_event_id").primaryKey(),
    budId: text("bud_id").references(() => budTable.budId, { onDelete: "set null" }),
    userId: text("user_id").references(() => authUserTable.id, { onDelete: "set null" }),
    operationId: text("operation_id").references(() => budOperationTable.operationId, {
      onDelete: "set null",
    }),
    streamId: text("stream_id").references(() => budStreamTable.streamId, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    eventData: jsonb("event_data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    budIdx: index("audit_event_bud_idx").on(table.budId, table.createdAt),
    userIdx: index("audit_event_user_idx").on(table.userId, table.createdAt),
    operationIdx: index("audit_event_operation_idx").on(table.operationId),
    streamIdx: index("audit_event_stream_idx").on(table.streamId),
  }),
);
