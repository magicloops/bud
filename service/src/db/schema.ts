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
  unique,
  foreignKey,
  customType,
  check,
  doublePrecision
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const authSchema = pgSchema("auth");

// "compaction": a browser-visible transcript row written when a context
// checkpoint completes (the summary the model now carries). Never replayed
// to the model, never previewed/counted — like "reasoning" rows.
const messageRoleValues = ["user", "assistant", "tool", "system", "reasoning", "compaction"] as const;
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
export const agentQuestionRequestStatusValues = [
  "pending",
  "answered",
  "expired",
  "canceled",
] as const;
export const agentContextCheckpointStatusValues = [
  "completed",
  "failed",
  "canceled",
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

export const deviceInstallClaimTable = pgTable(
  "device_install_claim",
  {
    installClaimId: text("install_claim_id").primaryKey(),
    claimTokenHash: text("claim_token_hash").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => authUserTable.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id"),
    deviceNameHint: text("device_name_hint"),
    installScope: text("install_scope").notNull().default("machine"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    redeemedBudId: text("redeemed_bud_id").references(() => budTable.budId, {
      onDelete: "set null",
    }),
    redeemedInstallationId: text("redeemed_installation_id"),
    redeemedUserAgent: text("redeemed_user_agent"),
    redeemedIp: text("redeemed_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("device_install_claim_token_hash_idx").on(table.claimTokenHash),
    ownerExpiresIdx: index("device_install_claim_owner_expires_idx").on(
      table.createdByUserId,
      table.expiresAt,
    ),
    redeemedBudIdx: index("device_install_claim_redeemed_bud_idx").on(table.redeemedBudId),
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
    modelId: text("model_id"),
    reasoningEffort: text("reasoning_effort"),
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
    invocationOwnerKey: unique("thread_invocation_owner_key").on(table.threadId, table.budId, table.createdByUserId),
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
    invocationOwnerKey: unique("message_invocation_owner_key").on(table.messageId, table.threadId, table.createdByUserId),
    clientIdUniqueIdx: uniqueIndex("message_client_id_idx").on(table.clientId)
  })
);

export const llmCallTable = pgTable(
  "llm_call",
  {
    llmCallId: text("llm_call_id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threadTable.threadId, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    requestMode: text("request_mode").notNull(),
    providerResponseId: text("provider_response_id"),
    status: text("status").notNull().default("completed"),
    inputFingerprint: text("input_fingerprint"),
    toolConfigFingerprint: text("tool_config_fingerprint"),
    promptCacheKey: text("prompt_cache_key"),
    usage: jsonb("usage").$type<Record<string, unknown>>(),
    cacheMetadata: jsonb("cache_metadata").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<Record<string, unknown>>(),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    threadStepIdx: index("llm_call_thread_step_idx").on(
      table.threadId,
      table.turnId,
      table.stepIndex,
    ),
    providerIdx: index("llm_call_provider_idx").on(table.provider, table.createdAt),
    statusIdx: index("llm_call_status_idx").on(table.status, table.createdAt),
  }),
);

export const llmCallItemTable = pgTable(
  "llm_call_item",
  {
    llmCallItemId: text("llm_call_item_id").primaryKey(),
    llmCallId: text("llm_call_id")
      .notNull()
      .references(() => llmCallTable.llmCallId, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threadTable.threadId, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    role: text("role"),
    kind: text("kind").notNull(),
    sequence: integer("sequence").notNull(),
    providerOutputIndex: integer("provider_output_index"),
    providerContentIndex: integer("provider_content_index"),
    providerItemId: text("provider_item_id"),
    toolCallId: text("tool_call_id"),
    text: text("text"),
    canonicalPayload: jsonb("canonical_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    providerPayload: jsonb("provider_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    visibility: text("visibility").notNull().default("provider_only"),
    messageId: uuid("message_id").references(() => messageTable.messageId, {
      onDelete: "set null",
    }),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    callSequenceIdx: uniqueIndex("llm_call_item_call_sequence_idx").on(
      table.llmCallId,
      table.direction,
      table.sequence,
    ),
    threadCreatedIdx: index("llm_call_item_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
    toolCallIdx: index("llm_call_item_tool_call_idx").on(table.toolCallId),
    messageIdx: index("llm_call_item_message_idx").on(table.messageId),
  }),
);

export const agentContextCheckpointTable = pgTable(
  "agent_context_checkpoint",
  {
    checkpointId: text("checkpoint_id").primaryKey(),
    threadId: uuid("thread_id").notNull(),
    trigger: text("trigger").notNull(),
    reason: text("reason").notNull(),
    phase: text("phase").notNull(),
    implementation: text("implementation").notNull().default("local_summary"),
    status: text("status", { enum: agentContextCheckpointStatusValues }).notNull(),
    sourceProvider: text("source_provider"),
    sourceModel: text("source_model"),
    sourceReasoningEffort: text("source_reasoning_effort"),
    summary: text("summary"),
    replacementHistory: jsonb("replacement_history")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    compactedThroughMessageCreatedAt: timestamp("compacted_through_message_created_at", {
      withTimezone: true,
    }),
    compactedThroughMessageId: uuid("compacted_through_message_id"),
    compactedThroughLlmCallCreatedAt: timestamp("compacted_through_llm_call_created_at", {
      withTimezone: true,
    }),
    compactedThroughLlmCallId: text("compacted_through_llm_call_id"),
    inputTokensBefore: integer("input_tokens_before"),
    estimatedTokensAfter: integer("estimated_tokens_after"),
    error: jsonb("error").$type<Record<string, unknown>>(),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    threadStatusCreatedIdx: index("agent_context_checkpoint_thread_status_created_idx").on(
      table.threadId,
      table.status,
      table.createdAt,
    ),
    messageBoundaryIdx: index("agent_context_checkpoint_message_boundary_idx").on(
      table.threadId,
      table.compactedThroughMessageCreatedAt,
      table.compactedThroughMessageId,
    ),
    llmBoundaryIdx: index("agent_context_checkpoint_llm_boundary_idx").on(
      table.threadId,
      table.compactedThroughLlmCallCreatedAt,
      table.compactedThroughLlmCallId,
    ),
    threadFk: foreignKey({
      columns: [table.threadId],
      foreignColumns: [threadTable.threadId],
      name: "agent_context_checkpoint_thread_fk",
    }).onDelete("cascade"),
  }),
);

export const agentQuestionRequestTable = pgTable(
  "agent_question_request",
  {
    questionRequestId: text("question_request_id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threadTable.threadId, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    callId: text("call_id").notNull(),
    clientId: uuid("client_id").notNull(),
    status: text("status", { enum: agentQuestionRequestStatusValues })
      .notNull()
      .default("pending"),
    request: jsonb("request")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    clientResponse: jsonb("client_response").$type<Record<string, unknown>>(),
    toolResult: jsonb("tool_result").$type<Record<string, unknown>>(),
    clientResponseId: uuid("client_response_id"),
    answeredByUserId: text("answered_by_user_id").references(() => authUserTable.id, {
      onDelete: "set null",
    }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    threadCallIdx: uniqueIndex("agent_question_request_thread_call_idx").on(
      table.threadId,
      table.callId,
    ),
    clientResponseIdx: uniqueIndex("agent_question_request_client_response_idx").on(
      table.clientResponseId,
    ),
    threadStatusIdx: index("agent_question_request_thread_status_idx").on(
      table.threadId,
      table.status,
      table.createdAt,
    ),
    ownerStatusIdx: index("agent_question_request_owner_status_idx").on(
      table.createdByUserId,
      table.status,
      table.createdAt,
    ),
  }),
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
    sessionId: text("session_id").notNull(),
    byteOffset: bigint("byte_offset", { mode: "number" }).notNull(),
    data: byteaColumn("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.byteOffset], name: "terminal_session_output_pkey" }),
    sessionFk: foreignKey({
      columns: [table.sessionId],
      foreignColumns: [terminalSessionTable.sessionId],
      name: "terminal_session_output_session_fk",
    }).onDelete("cascade"),
  })
);

// Command lifecycle rows minted from proto 0.3 terminal_event frames
// (command_started / command_finished). command_id is a daemon-minted ULID;
// output byte ranges slice transcript output from terminal_session_output.
// Owner stamping (created_by_user_id / tenant_id) inherits from the owning
// terminal session's thread per AGENTS.md §4.6.
export const terminalCommandTable = pgTable(
  "terminal_command",
  {
    commandId: text("command_id").primaryKey(),
    terminalSessionId: text("terminal_session_id").notNull(),
    threadId: uuid("thread_id"),
    budId: text("bud_id").notNull(),
    createdByUserId: text("created_by_user_id"),
    tenantId: text("tenant_id"),
    commandStartedAt: timestamp("command_started_at", { withTimezone: true }).notNull(),
    commandFinishedAt: timestamp("command_finished_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    outputByteStart: bigint("output_byte_start", { mode: "number" }).notNull().default(0),
    outputByteEnd: bigint("output_byte_end", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    sessionIdx: index("terminal_command_session_idx").on(table.terminalSessionId, table.commandStartedAt),
    threadIdx: index("terminal_command_thread_idx").on(table.threadId, table.commandStartedAt),
    budIdx: index("terminal_command_bud_idx").on(table.budId),
    sessionFk: foreignKey({
      columns: [table.terminalSessionId],
      foreignColumns: [terminalSessionTable.sessionId],
      name: "terminal_command_session_fk",
    }).onDelete("cascade"),
  })
);

export const terminalSessionInputLogTable = pgTable(
  "terminal_session_input_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    data: byteaColumn("data").notNull(),
    source: text("source").notNull(),
    userId: text("user_id"),
    tenantId: text("tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    sessionIdx: index("terminal_session_input_log_idx").on(table.sessionId, table.createdAt),
    sessionFk: foreignKey({
      columns: [table.sessionId],
      foreignColumns: [terminalSessionTable.sessionId],
      name: "terminal_session_input_log_session_fk",
    }).onDelete("cascade"),
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
    deviceSessionId: text("device_session_id"),
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
    deviceSessionFk: foreignKey({
      columns: [table.deviceSessionId],
      foreignColumns: [deviceSessionTable.deviceSessionId],
      name: "transport_session_device_session_fk",
    }).onDelete("set null"),
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
    terminalSessionId: text("terminal_session_id"),
    deviceSessionId: text("device_session_id"),
    transportSessionId: text("transport_session_id"),
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
    terminalSessionFk: foreignKey({
      columns: [table.terminalSessionId],
      foreignColumns: [terminalSessionTable.sessionId],
      name: "bud_operation_terminal_session_fk",
    }).onDelete("set null"),
    deviceSessionFk: foreignKey({
      columns: [table.deviceSessionId],
      foreignColumns: [deviceSessionTable.deviceSessionId],
      name: "bud_operation_device_session_fk",
    }).onDelete("set null"),
    transportSessionFk: foreignKey({
      columns: [table.transportSessionId],
      foreignColumns: [transportSessionTable.transportSessionId],
      name: "bud_operation_transport_session_fk",
    }).onDelete("set null"),
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
    deviceSessionId: text("device_session_id"),
    transportSessionId: text("transport_session_id"),
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
    deviceSessionFk: foreignKey({
      columns: [table.deviceSessionId],
      foreignColumns: [deviceSessionTable.deviceSessionId],
      name: "bud_stream_device_session_fk",
    }).onDelete("set null"),
    transportSessionFk: foreignKey({
      columns: [table.transportSessionId],
      foreignColumns: [transportSessionTable.transportSessionId],
      name: "bud_stream_transport_session_fk",
    }).onDelete("set null"),
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

export const proxiedSiteTable = pgTable(
  "proxied_site",
  {
    proxiedSiteId: text("proxied_site_id").primaryKey(),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    operationId: text("operation_id").references(() => budOperationTable.operationId, {
      onDelete: "set null",
    }),
    activeStreamId: text("active_stream_id").references(() => budStreamTable.streamId, {
      onDelete: "set null",
    }),
    displayName: text("display_name").notNull(),
    slug: text("slug").notNull(),
    endpointHost: text("endpoint_host").notNull(),
    targetScheme: text("target_scheme").notNull().default("http"),
    targetHost: text("target_host").notNull(),
    targetPort: integer("target_port").notNull(),
    defaultPath: text("default_path").notNull().default("/"),
    accessPolicy: text("access_policy").notNull().default("private_owner"),
    enabled: boolean("enabled").notNull().default(true),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledByUserId: text("disabled_by_user_id").references(() => authUserTable.id, {
      onDelete: "set null",
    }),
    disableReason: text("disable_reason"),
    displayMetadata: jsonb("display_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    auditCorrelationId: text("audit_correlation_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    lastRenewedAt: timestamp("last_renewed_at", { withTimezone: true }),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    endpointHostIdx: uniqueIndex("proxied_site_endpoint_host_idx").on(table.endpointHost),
    appDataOwnerKey: unique("proxied_site_app_data_owner_key").on(table.proxiedSiteId, table.budId, table.createdByUserId),
    ownerIdx: index("proxied_site_owner_idx").on(table.createdByUserId, table.budId),
    budEnabledIdx: index("proxied_site_bud_enabled_idx").on(
      table.budId,
      table.enabled,
      table.expiresAt,
    ),
    reuseIdx: index("proxied_site_reuse_idx").on(
      table.budId,
      table.createdByUserId,
      table.targetHost,
      table.targetPort,
      table.defaultPath,
    ),
    auditCorrelationIdx: index("proxied_site_audit_correlation_idx").on(table.auditCorrelationId),
  }),
);

export const threadWebViewTable = pgTable(
  "thread_web_view",
  {
    threadId: uuid("thread_id")
      .primaryKey()
      .references(() => threadTable.threadId, { onDelete: "cascade" }),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    proxiedSiteId: text("proxied_site_id")
      .notNull()
      .references(() => proxiedSiteTable.proxiedSiteId, { onDelete: "cascade" }),
    selectedPath: text("selected_path"),
    attachedByUserId: text("attached_by_user_id").references(() => authUserTable.id, {
      onDelete: "set null",
    }),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    siteIdx: index("thread_web_view_site_idx").on(table.proxiedSiteId, table.updatedAt),
    ownerIdx: index("thread_web_view_owner_idx").on(table.createdByUserId, table.updatedAt),
  }),
);

export const proxiedSiteViewerGrantTable = pgTable(
  "proxied_site_viewer_grant",
  {
    viewerGrantId: text("viewer_grant_id").primaryKey(),
    proxiedSiteId: text("proxied_site_id").notNull(),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUserTable.id, { onDelete: "cascade" }),
    authSessionId: text("auth_session_id").references(() => authSessionTable.id, {
      onDelete: "set null",
    }),
    grantHash: text("grant_hash").notNull(),
    redirectPath: text("redirect_path").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    hashIdx: uniqueIndex("proxied_site_viewer_grant_hash_idx").on(table.grantHash),
    siteIdx: index("proxied_site_viewer_grant_site_idx").on(
      table.proxiedSiteId,
      table.expiresAt,
    ),
    userIdx: index("proxied_site_viewer_grant_user_idx").on(table.userId, table.createdAt),
    proxiedSiteFk: foreignKey({
      columns: [table.proxiedSiteId],
      foreignColumns: [proxiedSiteTable.proxiedSiteId],
      name: "proxied_site_viewer_grant_site_fk",
    }).onDelete("cascade"),
  }),
);

export const proxiedSiteViewerSessionTable = pgTable(
  "proxied_site_viewer_session",
  {
    viewerSessionId: text("viewer_session_id").primaryKey(),
    proxiedSiteId: text("proxied_site_id").notNull(),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUserTable.id, { onDelete: "cascade" }),
    authSessionId: text("auth_session_id").references(() => authSessionTable.id, {
      onDelete: "set null",
    }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    tokenIdx: uniqueIndex("proxied_site_viewer_session_token_idx").on(table.tokenHash),
    siteUserIdx: index("proxied_site_viewer_session_site_user_idx").on(
      table.proxiedSiteId,
      table.userId,
      table.expiresAt,
    ),
    authSessionIdx: index("proxied_site_viewer_session_auth_session_idx").on(
      table.authSessionId,
    ),
    proxiedSiteFk: foreignKey({
      columns: [table.proxiedSiteId],
      foreignColumns: [proxiedSiteTable.proxiedSiteId],
      name: "proxied_site_viewer_session_site_fk",
    }).onDelete("cascade"),
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

// Personal data belongs to the authenticated user, not a Bud or thread.
export const dataOwnerStateTable = pgTable("data_owner_state", {
  createdByUserId: text("created_by_user_id").primaryKey().references(() => authUserTable.id),
  tenantId: text("tenant_id"),
  publicationSequence: bigint("publication_sequence", { mode: "number" }).notNull().default(0),
  storedBytes: bigint("stored_bytes", { mode: "number" }).notNull().default(0),
  requestWindowAt: timestamp("request_window_at", { withTimezone: true }).notNull().defaultNow(),
  requestCount: integer("request_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dataInstallationTable = pgTable("data_installation", {
  id: text("id").primaryKey(),
  installationId: text("installation_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull().references(() => authUserTable.id),
  tenantId: text("tenant_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerSourceIdx: uniqueIndex("data_installation_owner_source_idx").on(table.createdByUserId, table.installationId),
  idOwnerIdx: unique("data_installation_id_owner_key").on(table.id, table.createdByUserId),
}));

export const dataCollectionEpochTable = pgTable("data_collection_epoch", {
  id: text("id").primaryKey(),
  installationId: text("installation_id").notNull(),
  collectionEpoch: text("collection_epoch").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  tenantId: text("tenant_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sourceIdx: uniqueIndex("data_epoch_source_idx").on(table.installationId, table.collectionEpoch),
  idOwnerIdx: unique("data_epoch_id_owner_key").on(table.id, table.createdByUserId),
  installationFk: foreignKey({ name: "data_epoch_installation_owner_fk", columns: [table.installationId, table.createdByUserId], foreignColumns: [dataInstallationTable.id, dataInstallationTable.createdByUserId] }),
}));

export const dataEventTable = pgTable("data_event", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  epochId: text("epoch_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  tenantId: text("tenant_id"),
  eventType: text("event_type").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  batchId: text("batch_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  byteLength: integer("byte_length").notNull(),
  rawEnvelope: jsonb("raw_envelope").$type<Record<string, unknown>>().notNull(),
}, (table) => ({
  dedupeIdx: uniqueIndex("data_event_owner_event_idx").on(table.createdByUserId, table.eventId),
  idOwnerIdx: unique("data_event_id_owner_key").on(table.id, table.createdByUserId),
  occurrenceIdx: index("data_event_owner_type_time_idx").on(table.createdByUserId, table.eventType, table.occurredAt, table.id),
  receiptIdx: index("data_event_owner_receipt_idx").on(table.createdByUserId, table.receivedAt, table.id),
  epochFk: foreignKey({ name: "data_event_epoch_owner_fk", columns: [table.epochId, table.createdByUserId], foreignColumns: [dataCollectionEpochTable.id, dataCollectionEpochTable.createdByUserId] }),
}));

export const dataProcessingJobTable = pgTable("data_processing_job", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  tenantId: text("tenant_id"),
  processorVersion: integer("processor_version").notNull().default(1),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  leaseVersion: integer("lease_version").notNull().default(0),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  eventVersionIdx: uniqueIndex("data_job_event_version_idx").on(table.eventId, table.processorVersion),
  dueIdx: index("data_job_due_idx").on(table.status, table.nextAttemptAt),
  ownerIdx: index("data_job_owner_status_idx").on(table.createdByUserId, table.status),
  eventFk: foreignKey({ name: "data_job_event_owner_fk", columns: [table.eventId, table.createdByUserId], foreignColumns: [dataEventTable.id, dataEventTable.createdByUserId] }),
}));

// Projection source identity includes the owner-bound installation/epoch.
export const contactSourceTable = pgTable("contact_source", {
  id: text("id").primaryKey(),
  epochId: text("epoch_id").notNull(),
  storeId: text("store_id").notNull(),
  generation: integer("generation").notNull().default(0),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
}, (t) => ({
  sourceKey: unique("contact_source_identity_key").on(t.epochId, t.storeId),
  ownerKey: unique("contact_source_owner_key").on(t.id, t.createdByUserId),
  epochFk: foreignKey({ name: "contact_source_epoch_fk", columns: [t.epochId, t.createdByUserId], foreignColumns: [dataCollectionEpochTable.id, dataCollectionEpochTable.createdByUserId] }),
}));

export const contactScanTable = pgTable("contact_scan", {
  id: text("id").primaryKey(), sourceId: text("source_id").notNull(),
  scanId: text("scan_id").notNull(), generation: integer("generation").notNull(),
  manifest: jsonb("manifest").$type<Record<string, unknown>>(),
  status: text("status").notNull().default("pending"), errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
}, (t) => ({
  scanKey: unique("contact_scan_identity_key").on(t.sourceId, t.scanId),
  generationKey: unique("contact_scan_generation_key").on(t.sourceId, t.generation),
  ownerKey: unique("contact_scan_owner_key").on(t.id, t.createdByUserId),
  dueIdx: index("contact_scan_due_idx").on(t.status, t.createdAt),
  sourceFk: foreignKey({ name: "contact_scan_source_fk", columns: [t.sourceId, t.createdByUserId], foreignColumns: [contactSourceTable.id, contactSourceTable.createdByUserId] }),
}));

export const contactScanRecordTable = pgTable("contact_scan_record", {
  id: text("id").primaryKey(), scanId: text("scan_id").notNull(),
  rawEventId: text("raw_event_id").notNull(), clientEventId: text("client_event_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
}, (t) => ({
  eventKey: unique("contact_scan_record_event_key").on(t.rawEventId),
  scanIdx: index("contact_scan_record_scan_idx").on(t.scanId),
  scanFk: foreignKey({ name: "contact_record_scan_fk", columns: [t.scanId, t.createdByUserId], foreignColumns: [contactScanTable.id, contactScanTable.createdByUserId] }),
  eventFk: foreignKey({ name: "contact_record_event_fk", columns: [t.rawEventId, t.createdByUserId], foreignColumns: [dataEventTable.id, dataEventTable.createdByUserId] }),
}));

export const contactTable = pgTable("contact", {
  id: text("id").primaryKey(), sourceId: text("source_id").notNull(), sourceContactId: text("source_contact_id").notNull(),
  fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
  visible: boolean("visible").notNull().default(true), generation: integer("generation").notNull(),
  firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
}, (t) => ({
  sourceKey: unique("contact_identity_key").on(t.sourceId, t.sourceContactId),
  ownerKey: unique("contact_owner_key").on(t.id, t.createdByUserId),
  ownerIdx: index("contact_owner_list_idx").on(t.createdByUserId, t.id),
  sourceFk: foreignKey({ name: "contact_source_owner_fk", columns: [t.sourceId, t.createdByUserId], foreignColumns: [contactSourceTable.id, contactSourceTable.createdByUserId] }),
}));

export const contactRevisionTable = pgTable("contact_revision", {
  id: text("id").primaryKey(), contactId: text("contact_id").notNull(), scanId: text("scan_id").notNull(),
  fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
  visible: boolean("visible").notNull(), observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
}, (t) => ({
  revisionKey: unique("contact_revision_identity_key").on(t.contactId, t.scanId),
  ownerKey: unique("contact_revision_owner_key").on(t.id, t.createdByUserId),
  contactFk: foreignKey({ name: "contact_revision_contact_fk", columns: [t.contactId, t.createdByUserId], foreignColumns: [contactTable.id, contactTable.createdByUserId] }),
  scanFk: foreignKey({ name: "contact_revision_scan_fk", columns: [t.scanId, t.createdByUserId], foreignColumns: [contactScanTable.id, contactScanTable.createdByUserId] }),
}));

export const dataDomainEventTable = pgTable("data_domain_event", {
  id: text("id").primaryKey(), revisionId: text("revision_id").notNull(),
  eventType: text("event_type").notNull(), status: text("status").notNull().default("pending"),
  publicationSequence: bigint("publication_sequence", { mode: "number" }),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
}, (t) => ({
  ownerKey: unique("data_domain_owner_key").on(t.id, t.createdByUserId),
  sequenceKey: unique("data_domain_sequence_key").on(t.createdByUserId, t.publicationSequence),
  revisionKey: unique("data_domain_revision_key").on(t.revisionId, t.eventType),
  ownerIdx: index("data_domain_owner_idx").on(t.createdByUserId, t.status, t.id),
  revisionFk: foreignKey({ name: "data_domain_revision_fk", columns: [t.revisionId, t.createdByUserId], foreignColumns: [contactRevisionTable.id, contactRevisionTable.createdByUserId] }),
}));


export const locationObservationTable = pgTable("location_observation", {
  id: text("id").primaryKey(), rawEventId: text("raw_event_id").notNull(), epochId: text("epoch_id").notNull(),
  kind: text("kind").notNull(), latitude: doublePrecision("latitude").notNull(), longitude: doublePrecision("longitude").notNull(),
  horizontalAccuracyM: doublePrecision("horizontal_accuracy_m").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  arrivalAt: timestamp("arrival_at", { withTimezone: true }), departureAt: timestamp("departure_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
}, t => ({
  eventKey: unique("location_observation_event_key").on(t.rawEventId),
  ownerTimeIdx: index("location_observation_owner_time_idx").on(t.createdByUserId, t.occurredAt, t.id),
  eventFk: foreignKey({ name: "location_observation_event_fk", columns: [t.rawEventId, t.createdByUserId], foreignColumns: [dataEventTable.id, dataEventTable.createdByUserId] }),
  epochFk: foreignKey({ name: "location_observation_epoch_fk", columns: [t.epochId, t.createdByUserId], foreignColumns: [dataCollectionEpochTable.id, dataCollectionEpochTable.createdByUserId] }),
}));

// One explicit owner-wide agent grant. App grants remain separate consumers.
export const agentDataGrantTable = pgTable("agent_data_grant", {
  createdByUserId: text("created_by_user_id").primaryKey().references(() => authUserTable.id), tenantId: text("tenant_id"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  contactFields: jsonb("contact_fields").$type<string[]>().notNull().default(sql`'["names","organization","phones","emails"]'::jsonb`),
  version: integer("version").notNull().default(0), historyDays: integer("history_days").notNull().default(90),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: text("updated_by_user_id").notNull().references(() => authUserTable.id),
});

export const agentInvocationStatusValues = [
  "pending", "retry_wait", "leased", "waiting_for_bud", "waiting_for_model",
  "running", "waiting_for_user", "succeeded", "failed", "canceled", "expired", "needs_review",
] as const;

// Admission is staged separately from the existing detached agent runner.
export const agentInvocationTable = pgTable("agent_invocation", {
  id: text("id").primaryKey(), turnId: text("turn_id").notNull(),
  threadId: uuid("thread_id").notNull(), budId: text("bud_id").notNull(),
  inputMessageId: uuid("input_message_id").notNull(),
  origin: text("origin", { enum: ["human", "automation"] }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  model: text("model").notNull(), reasoningEffort: text("reasoning_effort").notNull(),
  status: text("status", { enum: agentInvocationStatusValues }).notNull().default("pending"),
  reservesThread: boolean("reserves_thread").notNull().default(false),
  attempt: integer("attempt").notNull().default(0), fence: integer("fence").notNull().default(0),
  workerId: text("worker_id"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  latestStartAt: timestamp("latest_start_at", { withTimezone: true }),
  outcomeCode: text("outcome_code"),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  canceledByUserId: text("canceled_by_user_id").references(() => authUserTable.id),
  createdByUserId: text("created_by_user_id").notNull().references(() => authUserTable.id),
  tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  ownerKey: unique("agent_invocation_owner_key").on(t.id, t.createdByUserId),
  appDataContextKey: unique("agent_invocation_app_data_context_key").on(t.id, t.threadId, t.budId, t.createdByUserId),
  dedupeKey: unique("agent_invocation_dedupe_key").on(t.createdByUserId, t.idempotencyKey),
  inputKey: unique("agent_invocation_input_key").on(t.inputMessageId),
  turnKey: unique("agent_invocation_turn_key").on(t.turnId),
  activeThread: uniqueIndex("agent_invocation_active_thread_idx").on(t.threadId)
    .where(sql`${t.reservesThread}`),
  dueIdx: index("agent_invocation_due_idx").on(t.status, t.nextAttemptAt),
  ownerIdx: index("agent_invocation_owner_idx").on(t.createdByUserId, t.createdAt),
  threadFk: foreignKey({ name: "agent_invocation_thread_owner_fk", columns: [t.threadId, t.budId, t.createdByUserId], foreignColumns: [threadTable.threadId, threadTable.budId, threadTable.createdByUserId] }).onDelete("cascade"),
  inputFk: foreignKey({ name: "agent_invocation_input_owner_fk", columns: [t.inputMessageId, t.threadId, t.createdByUserId], foreignColumns: [messageTable.messageId, messageTable.threadId, messageTable.createdByUserId] }),
  statusCheck: check("agent_invocation_status_check", sql`${t.status} in ('pending','retry_wait','leased','waiting_for_bud','waiting_for_model','running','waiting_for_user','succeeded','failed','canceled','expired','needs_review')`),
  originCheck: check("agent_invocation_origin_check", sql`${t.origin} in ('human','automation')`),
  leaseCheck: check("agent_invocation_lease_check", sql`(${t.status} in ('leased','running')) = (${t.workerId} is not null and ${t.leaseExpiresAt} is not null)`),
}));

export const agentInvocationActionTable = pgTable("agent_invocation_action", {
  id: text("id").primaryKey(), invocationId: text("invocation_id").notNull(),
  callId: text("call_id").notNull(), fence: integer("fence").notNull(),
  kind: text("kind").notNull(), status: text("status").notNull().default("intent"),
  evidence: jsonb("evidence").$type<Record<string, unknown>>(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => ({
  callKey: unique("agent_invocation_action_call_key").on(t.invocationId, t.callId),
  invocationFk: foreignKey({ name: "agent_action_invocation_owner_fk", columns: [t.invocationId, t.createdByUserId], foreignColumns: [agentInvocationTable.id, agentInvocationTable.createdByUserId] }).onDelete("cascade"),
}));

// Mutable draft/control state; published definitions live in immutable revisions.
export const automationTable = pgTable("automation", {
  id: text("id").primaryKey(),
  version: integer("version").notNull().default(0),
  draft: jsonb("draft").$type<Record<string, unknown>>().notNull(),
  state: text("state").notNull().default("draft"),
  activeRevision: integer("active_revision"),
  createdByUserId: text("created_by_user_id").notNull().references(() => authUserTable.id),
  updatedByUserId: text("updated_by_user_id").notNull().references(() => authUserTable.id),
  tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  ownerKey: unique("automation_owner_key").on(t.id, t.createdByUserId),
  ownerIdx: index("automation_owner_idx").on(t.createdByUserId, t.createdAt, t.id),
  stateCheck: check("automation_state_check", sql`${t.state} in ('draft','enabled','paused','deleted')`),
  versionCheck: check("automation_version_check", sql`${t.version} >= 0 and (${t.activeRevision} is null or ${t.activeRevision} > 0)`),
}));

export const automationRevisionTable = pgTable("automation_revision", {
  automationId: text("automation_id").notNull(), revision: integer("revision").notNull(),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  publicationBoundary: bigint("publication_boundary", { mode: "number" }).notNull(),
  grantVersion: integer("grant_version").notNull(),
  activatedByUserId: text("activated_by_user_id").notNull().references(() => authUserTable.id),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  pk: primaryKey({ columns: [t.automationId, t.revision] }),
  ownerKey: unique("automation_revision_owner_key").on(t.automationId, t.revision, t.createdByUserId),
  automationFk: foreignKey({ name: "automation_revision_owner_fk", columns: [t.automationId, t.createdByUserId], foreignColumns: [automationTable.id, automationTable.createdByUserId] }),
  revisionCheck: check("automation_revision_number_check", sql`${t.revision} > 0 and ${t.publicationBoundary} >= 0 and ${t.grantVersion} >= 0`),
}));

export const automationDeliveryTable = pgTable("automation_delivery", {
  id: text("id").primaryKey(), automationId: text("automation_id").notNull(), revision: integer("revision").notNull(),
  domainEventId: text("domain_event_id").notNull(), invocationId: text("invocation_id"),
  status: text("status").notNull().default("pending"), outcomeCode: text("outcome_code"),
  latestStartAt: timestamp("latest_start_at", { withTimezone: true }).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  eventKey: unique("automation_delivery_event_key").on(t.automationId, t.revision, t.domainEventId),
  invocationKey: unique("automation_delivery_invocation_key").on(t.invocationId),
  ownerIdx: index("automation_delivery_owner_idx").on(t.createdByUserId, t.createdAt, t.id),
  dueIdx: index("automation_delivery_due_idx").on(t.status, t.nextAttemptAt),
  revisionFk: foreignKey({ name: "automation_delivery_revision_fk", columns: [t.automationId, t.revision, t.createdByUserId], foreignColumns: [automationRevisionTable.automationId, automationRevisionTable.revision, automationRevisionTable.createdByUserId] }),
  eventFk: foreignKey({ name: "automation_delivery_event_fk", columns: [t.domainEventId, t.createdByUserId], foreignColumns: [dataDomainEventTable.id, dataDomainEventTable.createdByUserId] }),
  invocationFk: foreignKey({ name: "automation_delivery_invocation_fk", columns: [t.invocationId, t.createdByUserId], foreignColumns: [agentInvocationTable.id, agentInvocationTable.createdByUserId] }),
  stateCheck: check("automation_delivery_state_check", sql`${t.status} in ('pending','admitted','suppressed','expired','canceled','failed')`),
  admissionCheck: check("automation_delivery_admission_check", sql`(${t.status} = 'admitted') = (${t.invocationId} is not null)`),
}));

export const automationBootstrapTable = pgTable("automation_bootstrap", {
  id: text("id").primaryKey(), automationId: text("automation_id").notNull(), revision: integer("revision").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), request: jsonb("request").$type<Record<string, unknown>>().notNull(),
  publicationBoundary: bigint("publication_boundary", { mode: "number" }).notNull(),
  memberCount: integer("member_count").notNull(), groupSize: integer("group_size").notNull(),
  status: text("status").notNull().default("pending"),
  latestStartAt: timestamp("latest_start_at", { withTimezone: true }).notNull(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  ownerKey: unique("automation_bootstrap_owner_key").on(t.id, t.createdByUserId),
  retryKey: unique("automation_bootstrap_retry_key").on(t.createdByUserId, t.idempotencyKey),
  ownerIdx: index("automation_bootstrap_owner_idx").on(t.createdByUserId, t.automationId, t.id),
  revisionFk: foreignKey({ name: "automation_bootstrap_revision_fk", columns: [t.automationId, t.revision, t.createdByUserId], foreignColumns: [automationRevisionTable.automationId, automationRevisionTable.revision, automationRevisionTable.createdByUserId] }),
  boundsCheck: check("automation_bootstrap_bounds_check", sql`${t.memberCount} between 0 and 1000 and ${t.groupSize} between 1 and 25 and ${t.publicationBoundary} >= 0`),
  stateCheck: check("automation_bootstrap_state_check", sql`${t.status} in ('pending','completed','canceled','failed')`),
}));

export const automationBootstrapMemberTable = pgTable("automation_bootstrap_member", {
  bootstrapId: text("bootstrap_id").notNull(), ordinal: integer("ordinal").notNull(),
  contactRevisionId: text("contact_revision_id").notNull(), groupIndex: integer("group_index").notNull(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
}, t => ({
  pk: primaryKey({ columns: [t.bootstrapId, t.ordinal] }),
  revisionKey: unique("automation_bootstrap_member_revision_key").on(t.bootstrapId, t.contactRevisionId),
  groupIdx: index("automation_bootstrap_member_group_idx").on(t.bootstrapId, t.groupIndex, t.ordinal),
  bootstrapFk: foreignKey({ name: "automation_bootstrap_member_owner_fk", columns: [t.bootstrapId, t.createdByUserId], foreignColumns: [automationBootstrapTable.id, automationBootstrapTable.createdByUserId] }),
  revisionFk: foreignKey({ name: "automation_bootstrap_member_revision_fk", columns: [t.contactRevisionId, t.createdByUserId], foreignColumns: [contactRevisionTable.id, contactRevisionTable.createdByUserId] }),
  boundsCheck: check("automation_bootstrap_member_bounds_check", sql`${t.ordinal} between 0 and 999 and ${t.groupIndex} between 0 and 999`),
}));

export const automationBootstrapGroupTable = pgTable("automation_bootstrap_group", {
  bootstrapId: text("bootstrap_id").notNull(), groupIndex: integer("group_index").notNull(),
  invocationId: text("invocation_id"), status: text("status").notNull().default("pending"),
  outcomeCode: text("outcome_code"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  pk: primaryKey({ columns: [t.bootstrapId, t.groupIndex] }),
  invocationKey: unique("automation_bootstrap_group_invocation_key").on(t.invocationId),
  dueIdx: index("automation_bootstrap_group_due_idx").on(t.status, t.nextAttemptAt),
  ownerIdx: index("automation_bootstrap_group_owner_idx").on(t.createdByUserId, t.bootstrapId, t.groupIndex),
  bootstrapFk: foreignKey({ name: "automation_bootstrap_group_owner_fk", columns: [t.bootstrapId, t.createdByUserId], foreignColumns: [automationBootstrapTable.id, automationBootstrapTable.createdByUserId] }),
  invocationFk: foreignKey({ name: "automation_bootstrap_group_invocation_fk", columns: [t.invocationId, t.createdByUserId], foreignColumns: [agentInvocationTable.id, agentInvocationTable.createdByUserId] }),
  boundsCheck: check("automation_bootstrap_group_bounds_check", sql`${t.groupIndex} between 0 and 999`),
  stateCheck: check("automation_bootstrap_group_state_check", sql`${t.status} in ('pending','admitted','expired','canceled','failed')`),
  admissionCheck: check("automation_bootstrap_group_admission_check", sql`(${t.status} = 'admitted') = (${t.invocationId} is not null)`),
}));

// Immutable app permission proposal. Approval is a separate human decision;
// generic question answers and model output cannot create a query credential.
export const dataAccessRequestTable = pgTable("data_access_request", {
  id: text("id").primaryKey(), invocationId: text("invocation_id").notNull(),
  threadId: uuid("thread_id").notNull(), budId: text("bud_id").notNull(), callId: text("call_id").notNull(),
  proxiedSiteId: text("proxied_site_id").notNull(),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  definitionHash: text("definition_hash").notNull(),
  status: text("status", { enum: ["pending", "approved", "declined", "canceled", "expired"] }).notNull().default("pending"),
  version: integer("version").notNull().default(0),
  decisionRequest: jsonb("decision_request").$type<Record<string, unknown>>(),
  decisionIdempotencyKey: text("decision_idempotency_key"),
  decidedByUserId: text("decided_by_user_id").references(() => authUserTable.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdByUserId: text("created_by_user_id").notNull().references(() => authUserTable.id), tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  ownerKey: unique("data_access_request_owner_key").on(t.id, t.createdByUserId),
  callKey: unique("data_access_request_call_key").on(t.invocationId, t.callId),
  decisionKey: unique("data_access_request_decision_key").on(t.createdByUserId, t.decisionIdempotencyKey),
  ownerIdx: index("data_access_request_owner_idx").on(t.createdByUserId, t.status, t.id),
  expiryIdx: index("data_access_request_expiry_idx").on(t.status, t.expiresAt),
  invocationFk: foreignKey({ name: "data_access_request_invocation_fk", columns: [t.invocationId, t.threadId, t.budId, t.createdByUserId], foreignColumns: [agentInvocationTable.id, agentInvocationTable.threadId, agentInvocationTable.budId, agentInvocationTable.createdByUserId] }),
  actionFk: foreignKey({ name: "data_access_request_action_fk", columns: [t.invocationId, t.callId], foreignColumns: [agentInvocationActionTable.invocationId, agentInvocationActionTable.callId] }),
  siteFk: foreignKey({ name: "data_access_request_site_fk", columns: [t.proxiedSiteId, t.budId, t.createdByUserId], foreignColumns: [proxiedSiteTable.proxiedSiteId, proxiedSiteTable.budId, proxiedSiteTable.createdByUserId] }),
  stateCheck: check("data_access_request_state_check", sql`${t.status} in ('pending','approved','declined','canceled','expired') and ${t.version} >= 0`),
  decisionCheck: check("data_access_request_decision_check", sql`(${t.status} in ('approved','declined')) = (${t.decisionRequest} is not null and ${t.decisionIdempotencyKey} is not null and ${t.decidedByUserId} is not null and ${t.decidedAt} is not null)`),
  actorCheck: check("data_access_request_actor_check", sql`${t.decidedByUserId} is null or ${t.decidedByUserId} = ${t.createdByUserId}`),
}));

// Frozen automation review, bound to the originating durable tool action.
// Only an explicit owner decision may publish the captured draft revision.
export const automationProposalTable = pgTable("automation_proposal", {
  id: text("id").primaryKey(), automationId: text("automation_id").notNull(),
  invocationId: text("invocation_id").notNull(), threadId: uuid("thread_id").notNull(),
  budId: text("bud_id").notNull(), callId: text("call_id").notNull(),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  draftVersion: integer("draft_version").notNull(), grantVersion: integer("grant_version").notNull(),
  version: integer("version").notNull().default(0),
  status: text("status", { enum: ["pending", "approved", "declined", "canceled", "expired", "stale"] }).notNull().default("pending"),
  activatedRevision: integer("activated_revision"),
  decisionRequest: jsonb("decision_request").$type<Record<string, unknown>>(),
  decisionIdempotencyKey: text("decision_idempotency_key"),
  decidedByUserId: text("decided_by_user_id").references(() => authUserTable.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdByUserId: text("created_by_user_id").notNull().references(() => authUserTable.id),
  tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  ownerKey: unique("automation_proposal_owner_key").on(t.id, t.createdByUserId),
  callKey: unique("automation_proposal_call_key").on(t.invocationId, t.callId),
  decisionKey: unique("automation_proposal_decision_key").on(t.createdByUserId, t.decisionIdempotencyKey),
  ownerIdx: index("automation_proposal_owner_idx").on(t.createdByUserId, t.status, t.id),
  expiryIdx: index("automation_proposal_expiry_idx").on(t.status, t.expiresAt),
  automationFk: foreignKey({ name: "automation_proposal_automation_fk", columns: [t.automationId, t.createdByUserId], foreignColumns: [automationTable.id, automationTable.createdByUserId] }),
  invocationFk: foreignKey({ name: "automation_proposal_invocation_fk", columns: [t.invocationId, t.threadId, t.budId, t.createdByUserId], foreignColumns: [agentInvocationTable.id, agentInvocationTable.threadId, agentInvocationTable.budId, agentInvocationTable.createdByUserId] }),
  actionFk: foreignKey({ name: "automation_proposal_action_fk", columns: [t.invocationId, t.callId], foreignColumns: [agentInvocationActionTable.invocationId, agentInvocationActionTable.callId] }),
  revisionFk: foreignKey({ name: "automation_proposal_revision_fk", columns: [t.automationId, t.activatedRevision, t.createdByUserId], foreignColumns: [automationRevisionTable.automationId, automationRevisionTable.revision, automationRevisionTable.createdByUserId] }),
  stateCheck: check("automation_proposal_state_check", sql`${t.status} in ('pending','approved','declined','canceled','expired','stale')`),
  versionCheck: check("automation_proposal_version_check", sql`${t.version} >= 0 and ${t.draftVersion} >= 0 and ${t.grantVersion} >= 0`),
  revisionCheck: check("automation_proposal_revision_check", sql`(${t.status} = 'approved') = (${t.activatedRevision} is not null) and (${t.activatedRevision} is null or ${t.activatedRevision} > 0)`),
  decisionCheck: check("automation_proposal_decision_check", sql`(${t.decisionRequest} is null and ${t.decisionIdempotencyKey} is null and ${t.decidedByUserId} is null and ${t.decidedAt} is null and ${t.status} not in ('approved','declined')) or (${t.decisionRequest} is not null and ${t.decisionIdempotencyKey} is not null and ${t.decidedByUserId} is not null and ${t.decidedAt} is not null and ${t.status} in ('approved','declined','canceled'))`),
  actorCheck: check("automation_proposal_actor_check", sql`${t.decidedByUserId} is null or ${t.decidedByUserId} = ${t.createdByUserId}`),
  expiryCheck: check("automation_proposal_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
}));

// Separate storage prevents older activation-only code from approving bootstrap work.
export const automationBootstrapProposalTable = pgTable("automation_bootstrap_proposal", {
  id: text("id").primaryKey(), automationId: text("automation_id").notNull(),
  revision: integer("revision").notNull(),
  invocationId: text("invocation_id").notNull(), threadId: uuid("thread_id").notNull(),
  budId: text("bud_id").notNull(), callId: text("call_id").notNull(),
  frozen: jsonb("frozen").$type<Record<string, unknown>>().notNull(),
  fingerprint: text("fingerprint").notNull(), memberCount: integer("member_count").notNull(),
  version: integer("version").notNull().default(0),
  status: text("status", { enum: ["pending", "approved", "declined", "canceled", "expired", "stale"] }).notNull().default("pending"),
  bootstrapId: text("bootstrap_id"),
  decisionRequest: jsonb("decision_request").$type<Record<string, unknown>>(),
  decisionIdempotencyKey: text("decision_idempotency_key"),
  decidedByUserId: text("decided_by_user_id").references(() => authUserTable.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdByUserId: text("created_by_user_id").notNull().references(() => authUserTable.id), tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  ownerKey: unique("bootstrap_proposal_owner_key").on(t.id, t.createdByUserId),
  callKey: unique("bootstrap_proposal_call_key").on(t.invocationId, t.callId),
  decisionKey: unique("bootstrap_proposal_decision_key").on(t.createdByUserId, t.decisionIdempotencyKey),
  ownerIdx: index("bootstrap_proposal_owner_idx").on(t.createdByUserId, t.status, t.id),
  expiryIdx: index("bootstrap_proposal_expiry_idx").on(t.status, t.expiresAt),
  revisionFk: foreignKey({ name: "bootstrap_proposal_revision_fk", columns: [t.automationId, t.revision, t.createdByUserId], foreignColumns: [automationRevisionTable.automationId, automationRevisionTable.revision, automationRevisionTable.createdByUserId] }),
  invocationFk: foreignKey({ name: "bootstrap_proposal_invocation_fk", columns: [t.invocationId, t.threadId, t.budId, t.createdByUserId], foreignColumns: [agentInvocationTable.id, agentInvocationTable.threadId, agentInvocationTable.budId, agentInvocationTable.createdByUserId] }),
  actionFk: foreignKey({ name: "bootstrap_proposal_action_fk", columns: [t.invocationId, t.callId], foreignColumns: [agentInvocationActionTable.invocationId, agentInvocationActionTable.callId] }),
  bootstrapFk: foreignKey({ name: "bootstrap_proposal_receipt_fk", columns: [t.bootstrapId, t.createdByUserId], foreignColumns: [automationBootstrapTable.id, automationBootstrapTable.createdByUserId] }),
  stateCheck: check("bootstrap_proposal_state_check", sql`${t.status} in ('pending','approved','declined','canceled','expired','stale') and ${t.version} >= 0 and ${t.revision} > 0`),
  memberCheck: check("bootstrap_proposal_member_check", sql`${t.memberCount} between 1 and 1000 and ${t.fingerprint} ~ '^[a-f0-9]{64}$'`),
  receiptCheck: check("bootstrap_proposal_receipt_check", sql`(${t.status} = 'approved') = (${t.bootstrapId} is not null)`),
  decisionCheck: check("bootstrap_proposal_decision_check", sql`(${t.decisionRequest} is null and ${t.decisionIdempotencyKey} is null and ${t.decidedByUserId} is null and ${t.decidedAt} is null and ${t.status} not in ('approved','declined')) or (${t.decisionRequest} is not null and ${t.decisionIdempotencyKey} is not null and ${t.decidedByUserId} is not null and ${t.decidedAt} is not null and ${t.status} in ('approved','declined','canceled'))`),
  actorCheck: check("bootstrap_proposal_actor_check", sql`${t.decidedByUserId} is null or ${t.decidedByUserId} = ${t.createdByUserId}`),
  expiryCheck: check("bootstrap_proposal_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
}));

export const automationBootstrapProposalMemberTable = pgTable("automation_bootstrap_proposal_member", {
  proposalId: text("proposal_id").notNull(), ordinal: integer("ordinal").notNull(),
  contactRevisionId: text("contact_revision_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
}, t => ({
  pk: primaryKey({ columns: [t.proposalId, t.ordinal] }),
  revisionKey: unique("bootstrap_proposal_member_revision_key").on(t.proposalId, t.contactRevisionId),
  proposalFk: foreignKey({ name: "bootstrap_proposal_member_proposal_fk", columns: [t.proposalId, t.createdByUserId], foreignColumns: [automationBootstrapProposalTable.id, automationBootstrapProposalTable.createdByUserId] }),
  revisionFk: foreignKey({ name: "bootstrap_proposal_member_contact_fk", columns: [t.contactRevisionId, t.createdByUserId], foreignColumns: [contactRevisionTable.id, contactRevisionTable.createdByUserId] }),
  ordinalCheck: check("bootstrap_proposal_member_ordinal_check", sql`${t.ordinal} between 0 and 999`),
}));

// One app grant/credential per approved request. No plaintext secret column.
export const dataAppKeyTable = pgTable("data_app_key", {
  id: text("id").primaryKey(), requestId: text("request_id").notNull(),
  verificationHash: text("verification_hash").notNull(),
  status: text("status", { enum: ["handoff_pending", "installed", "revoked", "setup_failed"] }).notNull().default("handoff_pending"),
  version: integer("version").notNull().default(0),
  encryptedEnvelope: jsonb("encrypted_envelope").$type<Record<string, unknown>>(),
  ciphertextDigest: text("ciphertext_digest").notNull(),
  setupExpiresAt: timestamp("setup_expires_at", { withTimezone: true }).notNull(),
  installedAt: timestamp("installed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: text("revoked_by_user_id").references(() => authUserTable.id),
  revokeRequest: jsonb("revoke_request").$type<Record<string, unknown>>(),
  outcomeCode: text("outcome_code"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  requestKey: unique("data_app_key_request_key").on(t.requestId),
  ownerIdx: index("data_app_key_owner_idx").on(t.createdByUserId, t.status, t.id),
  expiryIdx: index("data_app_key_expiry_idx").on(t.status, t.setupExpiresAt),
  requestFk: foreignKey({ name: "data_app_key_request_owner_fk", columns: [t.requestId, t.createdByUserId], foreignColumns: [dataAccessRequestTable.id, dataAccessRequestTable.createdByUserId] }),
  stateCheck: check("data_app_key_state_check", sql`${t.status} in ('handoff_pending','installed','revoked','setup_failed') and ${t.version} >= 0`),
  envelopeCheck: check("data_app_key_envelope_check", sql`(${t.status} = 'handoff_pending') = (${t.encryptedEnvelope} is not null)`),
  installedCheck: check("data_app_key_installed_check", sql`${t.status} <> 'installed' or ${t.installedAt} is not null`),
  revokedCheck: check("data_app_key_revoked_check", sql`(${t.status} in ('revoked','setup_failed')) = (${t.revokedAt} is not null)`),
  actorCheck: check("data_app_key_actor_check", sql`${t.revokedByUserId} is null or ${t.revokedByUserId} = ${t.createdByUserId}`),
}));

// Request receipts outlive expiring content so TTL cannot reset a turn's budget.
export const webRetrievalRequestTable = pgTable("web_retrieval_request", {
  id: text("id").primaryKey(), threadId: uuid("thread_id").notNull(), budId: text("bud_id").notNull(),
  turnId: text("turn_id").notNull(), callId: text("call_id").notNull(),
  fingerprint: text("fingerprint").notNull(), backend: text("backend").notNull(),
  status: text("status").notNull().default("started"),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  callKey: unique("web_retrieval_request_call_key").on(t.threadId, t.turnId, t.callId),
  budgetIdx: index("web_retrieval_request_budget_idx").on(t.createdByUserId, t.threadId, t.turnId),
  threadFk: foreignKey({ name: "web_retrieval_request_thread_fk", columns: [t.threadId, t.budId, t.createdByUserId], foreignColumns: [threadTable.threadId, threadTable.budId, threadTable.createdByUserId] }).onDelete("cascade"),
  stateCheck: check("web_retrieval_request_state_check", sql`${t.status} in ('started','completed','failed')`),
}));

export const webRetrievalArtifactTable = pgTable("web_retrieval_artifact", {
  id: text("id").primaryKey(), threadId: uuid("thread_id").notNull(), budId: text("bud_id").notNull(),
  requestId: text("request_id").notNull().references(() => webRetrievalRequestTable.id, { onDelete: "cascade" }),
  operation: text("operation").notNull(), backend: text("backend").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), byteLength: integer("byte_length").notNull(),
  createdByUserId: text("created_by_user_id").notNull(), tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, t => ({
  requestKey: unique("web_retrieval_artifact_request_key").on(t.requestId),
  ownerIdx: index("web_retrieval_artifact_owner_idx").on(t.createdByUserId, t.threadId),
  expiryIdx: index("web_retrieval_artifact_expiry_idx").on(t.expiresAt),
  threadFk: foreignKey({ name: "web_retrieval_artifact_thread_fk", columns: [t.threadId, t.budId, t.createdByUserId], foreignColumns: [threadTable.threadId, threadTable.budId, threadTable.createdByUserId] }).onDelete("cascade"),
  sizeCheck: check("web_retrieval_artifact_size_check", sql`${t.byteLength} between 0 and 524288`),
}));
