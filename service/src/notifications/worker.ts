import { setTimeout as delay } from "node:timers/promises";
import { and, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { pushEndpointTable, pushNotificationOutboxTable, threadReadStateTable, threadTable } from "../db/schema.js";
import { isMessageNewerThanWatermark } from "./attention.js";
import { ApnsPushProvider, resolveApnsAuthority, type PushProviderSendResult } from "./apns.js";
import { buildGenericNotificationBody } from "./payload.js";

type OutboxRow = typeof pushNotificationOutboxTable.$inferSelect;

const MAX_RETRY_ATTEMPTS = 5;

function addBackoff(base: number): Date {
  return new Date(Date.now() + base);
}

function getRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(attemptCount, 5);
  return 1000 * 2 ** exponent;
}

export class PushNotificationWorker {
  private readonly logger: FastifyBaseLogger;
  private readonly apnsProvider: ApnsPushProvider | null;
  private running = false;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger;
    this.apnsProvider = ApnsPushProvider.isConfigured() ? new ApnsPushProvider() : null;
  }

  start(): void {
    if (this.running || !this.apnsProvider) {
      if (!this.apnsProvider) {
        this.logger.info({ component: "push_worker" }, "Push worker disabled: APNs not configured");
      }
      return;
    }
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.processBatch();
      } catch (err) {
        this.logger.error({ err, component: "push_worker" }, "Push worker batch failed");
      }
      await delay(config.pushWorkerPollMs);
    }
  }

  private async processBatch(): Promise<void> {
    const rows = await this.claimPendingRows(config.pushWorkerBatchSize);
    for (const row of rows) {
      await this.processRow(row);
    }
  }

  private async claimPendingRows(limit: number): Promise<OutboxRow[]> {
    const result = await db.execute(sql`
      WITH candidates AS (
        SELECT notification_id
        FROM push_notification_outbox
        WHERE status = 'pending'
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE push_notification_outbox AS outbox
      SET
        status = 'sending',
        claimed_at = now(),
        updated_at = now()
      FROM candidates
      WHERE outbox.notification_id = candidates.notification_id
      RETURNING
        outbox.notification_id AS "notificationId",
        outbox.user_id AS "userId",
        outbox.thread_id AS "threadId",
        outbox.message_id AS "messageId",
        outbox.kind AS "kind",
        outbox.status AS "status",
        outbox.dedupe_key AS "dedupeKey",
        outbox.collapse_key AS "collapseKey",
        outbox.title AS "title",
        outbox.body AS "body",
        outbox.payload AS "payload",
        outbox.attempt_count AS "attemptCount",
        outbox.next_attempt_at AS "nextAttemptAt",
        outbox.claimed_at AS "claimedAt",
        outbox.sent_at AS "sentAt",
        outbox.suppressed_reason AS "suppressedReason",
        outbox.last_error_code AS "lastErrorCode",
        outbox.last_error_message AS "lastErrorMessage",
        outbox.tenant_id AS "tenantId",
        outbox.created_by_user_id AS "createdByUserId",
        outbox.created_at AS "createdAt",
        outbox.updated_at AS "updatedAt"
    `);

    return result.rows as OutboxRow[];
  }

  private async processRow(row: OutboxRow): Promise<void> {
    const [threadState] = await db
      .select({
        lastAttentionMessageId: threadTable.lastAttentionMessageId,
        lastAttentionMessageCreatedAt: threadTable.lastAttentionMessageCreatedAt,
        lastSeenMessageId: threadReadStateTable.lastSeenMessageId,
        lastSeenMessageCreatedAt: threadReadStateTable.lastSeenMessageCreatedAt,
      })
      .from(threadTable)
      .leftJoin(
        threadReadStateTable,
        and(
          eq(threadReadStateTable.threadId, threadTable.threadId),
          eq(threadReadStateTable.userId, row.userId),
        ),
      )
      .where(eq(threadTable.threadId, row.threadId))
      .limit(1);

    if (!threadState) {
      await this.markSuppressed(row.notificationId, "thread_missing");
      return;
    }

    if (
      threadState.lastAttentionMessageId &&
      row.messageId &&
      threadState.lastAttentionMessageId !== row.messageId
    ) {
      await this.markSuppressed(row.notificationId, "superseded_by_newer_attention");
      return;
    }

    if (
      !isMessageNewerThanWatermark(
        threadState.lastAttentionMessageCreatedAt,
        threadState.lastAttentionMessageId,
        {
          createdAt: threadState.lastSeenMessageCreatedAt,
          messageId: threadState.lastSeenMessageId,
        },
      )
    ) {
      await this.markSuppressed(row.notificationId, "already_seen");
      return;
    }

    const endpoints = await db.query.pushEndpointTable.findMany({
      where: and(
        eq(pushEndpointTable.userId, row.userId),
        eq(pushEndpointTable.enabled, true),
        isNull(pushEndpointTable.invalidatedAt),
      ),
    });

    const eligibleEndpoints = endpoints.filter((endpoint) =>
      endpoint.provider === "apns" &&
      (row.kind === "human_input_requested"
        ? endpoint.alertsHumanInputRequested
        : endpoint.alertsAgentCompleted),
    );

    if (eligibleEndpoints.length === 0) {
      await this.markSuppressed(row.notificationId, "no_enabled_endpoints");
      return;
    }

    let sent = false;
    for (const endpoint of eligibleEndpoints) {
      const providerResult = await this.sendToEndpoint(row, endpoint);
      if (providerResult.status === "sent") {
        this.logger.info(
          {
            component: "push_worker",
            notificationId: row.notificationId,
            userId: row.userId,
            threadId: row.threadId,
            messageId: row.messageId,
            kind: row.kind,
            endpointId: endpoint.endpointId,
            provider: endpoint.provider,
            appId: endpoint.appId,
            providerEnvironment: endpoint.providerEnvironment,
            apnsTopic: endpoint.appId,
            apnsAuthority: resolveApnsAuthority(endpoint.providerEnvironment),
          },
          "Push notification sent",
        );
        sent = true;
        continue;
      }
      if (providerResult.status === "invalid_endpoint") {
        this.logger.warn(
          {
            component: "push_worker",
            notificationId: row.notificationId,
            userId: row.userId,
            threadId: row.threadId,
            messageId: row.messageId,
            kind: row.kind,
            endpointId: endpoint.endpointId,
            provider: endpoint.provider,
            appId: endpoint.appId,
            providerEnvironment: endpoint.providerEnvironment,
            apnsTopic: endpoint.appId,
            apnsAuthority: resolveApnsAuthority(endpoint.providerEnvironment),
            code: providerResult.code,
            message: providerResult.message,
          },
          "Push endpoint invalidated by provider",
        );
        await db
          .update(pushEndpointTable)
          .set({
            invalidatedAt: new Date(),
            lastErrorAt: new Date(),
            lastErrorCode: providerResult.code,
            lastErrorMessage: providerResult.message,
            updatedAt: new Date(),
          })
          .where(eq(pushEndpointTable.endpointId, endpoint.endpointId));
      }
      if (providerResult.status === "retryable") {
        this.logger.warn(
          {
            component: "push_worker",
            notificationId: row.notificationId,
            userId: row.userId,
            threadId: row.threadId,
            messageId: row.messageId,
            kind: row.kind,
            endpointId: endpoint.endpointId,
            provider: endpoint.provider,
            appId: endpoint.appId,
            providerEnvironment: endpoint.providerEnvironment,
            apnsTopic: endpoint.appId,
            apnsAuthority: resolveApnsAuthority(endpoint.providerEnvironment),
            code: providerResult.code,
            message: providerResult.message,
            attemptCount: row.attemptCount,
          },
          "Push notification delivery will retry",
        );
        await this.markRetry(row, providerResult);
        return;
      }
      if (providerResult.status === "failed") {
        this.logger.error(
          {
            component: "push_worker",
            notificationId: row.notificationId,
            userId: row.userId,
            threadId: row.threadId,
            messageId: row.messageId,
            kind: row.kind,
            endpointId: endpoint.endpointId,
            provider: endpoint.provider,
            appId: endpoint.appId,
            providerEnvironment: endpoint.providerEnvironment,
            apnsTopic: endpoint.appId,
            apnsAuthority: resolveApnsAuthority(endpoint.providerEnvironment),
            code: providerResult.code,
            message: providerResult.message,
          },
          "Push notification delivery failed permanently",
        );
        await this.markDead(row, providerResult);
        return;
      }
    }

    if (!sent) {
      await this.markSuppressed(row.notificationId, "no_deliverable_endpoints");
      return;
    }

    await db
      .update(pushNotificationOutboxTable)
      .set({
        status: "sent",
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(pushNotificationOutboxTable.notificationId, row.notificationId));
  }

  private async sendToEndpoint(
    row: OutboxRow,
    endpoint: typeof pushEndpointTable.$inferSelect,
  ): Promise<PushProviderSendResult> {
    if (endpoint.provider !== "apns" || !this.apnsProvider) {
      return { status: "failed", code: "provider_unavailable", message: "provider_unavailable" };
    }

    return this.apnsProvider.send(
      {
        title: row.title,
        body: row.body,
        genericBody: buildGenericNotificationBody(row.kind),
        collapseKey: row.collapseKey,
        payload: row.payload,
      },
      {
        token: endpoint.token,
        appId: endpoint.appId,
        providerEnvironment: endpoint.providerEnvironment,
        includeMessagePreview: endpoint.includeMessagePreview,
      },
    );
  }

  private async markSuppressed(notificationId: string, reason: string): Promise<void> {
    await db
      .update(pushNotificationOutboxTable)
      .set({
        status: "suppressed",
        suppressedReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(pushNotificationOutboxTable.notificationId, notificationId));
  }

  private async markRetry(
    row: OutboxRow,
    result: Extract<PushProviderSendResult, { status: "retryable" }>,
  ): Promise<void> {
    const nextAttemptCount = row.attemptCount + 1;
    if (nextAttemptCount >= MAX_RETRY_ATTEMPTS) {
      await this.markDead(row, { status: "failed", code: result.code, message: result.message });
      return;
    }

    await db
      .update(pushNotificationOutboxTable)
      .set({
        status: "pending",
        attemptCount: nextAttemptCount,
        nextAttemptAt: addBackoff(getRetryDelayMs(nextAttemptCount)),
        lastErrorCode: result.code,
        lastErrorMessage: result.message,
        updatedAt: new Date(),
      })
      .where(eq(pushNotificationOutboxTable.notificationId, row.notificationId));
  }

  private async markDead(
    row: OutboxRow,
    result: Extract<PushProviderSendResult, { status: "failed" }>,
  ): Promise<void> {
    await db
      .update(pushNotificationOutboxTable)
      .set({
        status: "dead",
        attemptCount: row.attemptCount + 1,
        lastErrorCode: result.code,
        lastErrorMessage: result.message,
        updatedAt: new Date(),
      })
      .where(eq(pushNotificationOutboxTable.notificationId, row.notificationId));
  }
}
