import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "../db/client.js";
import {
  auditEventTable,
  budOperationTable,
  budStreamTable,
  deviceSessionTable,
  operationStateValues,
  streamStateValues,
  transportSessionTable,
} from "../db/schema.js";

export type OperationState = (typeof operationStateValues)[number];
export type StreamState = (typeof streamStateValues)[number];
type DeviceSessionRow = typeof deviceSessionTable.$inferSelect;
type TransportSessionRow = typeof transportSessionTable.$inferSelect;
type BudOperationRow = typeof budOperationTable.$inferSelect;
type BudStreamRow = typeof budStreamTable.$inferSelect;
type AuditEventRow = typeof auditEventTable.$inferSelect;

export type ReconnectOperationReport = {
  operation_id: string;
  state: string;
  operation_type?: string | null;
  updated_at?: string | null;
};

export type ReconnectStreamReport = {
  stream_id: string;
  operation_id?: string | null;
  stream_type: string;
  state: string;
  send_offset?: number;
  receive_offset?: number;
  updated_at?: string | null;
};

export type ReconciliationOperationDecision = {
  operation_id: string;
  state: OperationState;
  operation_type?: string | null;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  } | null;
};

export type ReconciliationStreamDecision = {
  stream_id: string;
  operation_id?: string | null;
  stream_type: string;
  state: StreamState;
  send_offset: number;
  receive_offset: number;
  reset_reason?: string | null;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  } | null;
};

export type ReconciliationDecision = {
  operations: ReconciliationOperationDecision[];
  streams: ReconciliationStreamDecision[];
};

export const OPERATION_TERMINAL_STATES = ["succeeded", "failed", "canceled", "unknown", "expired"] as const;
export const STREAM_TERMINAL_STATES = ["closed", "reset", "unknown", "expired"] as const;

const ALLOWED_OPERATION_TRANSITIONS: Record<OperationState, readonly OperationState[]> = {
  offered: ["accepted", "rejected", "canceled", "expired", "unknown"],
  accepted: ["running", "succeeded", "failed", "canceled", "unknown", "expired"],
  rejected: [],
  running: ["succeeded", "failed", "canceled", "unknown", "expired"],
  succeeded: [],
  failed: [],
  canceled: [],
  unknown: ["offered", "accepted", "running", "failed", "canceled", "expired"],
  expired: [],
};

const ALLOWED_STREAM_TRANSITIONS: Record<StreamState, readonly StreamState[]> = {
  opening: ["open", "reset", "unknown", "expired"],
  open: ["half_closed_local", "half_closed_remote", "closed", "reset", "unknown", "expired"],
  half_closed_local: ["closed", "reset", "unknown", "expired"],
  half_closed_remote: ["closed", "reset", "unknown", "expired"],
  closed: [],
  reset: [],
  unknown: ["opening", "open", "reset", "expired"],
  expired: [],
};

export function isAllowedOperationTransition(from: OperationState, to: OperationState): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_OPERATION_TRANSITIONS[from].includes(to);
}

export function isAllowedStreamTransition(from: StreamState, to: StreamState): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_STREAM_TRANSITIONS[from].includes(to);
}

export class DaemonStateStore {
  async registerDeviceSession(args: {
    deviceSessionId?: string;
    budId: string;
    capabilities?: Record<string, unknown>;
    gatewayInstanceId?: string | null;
    createdByUserId?: string | null;
    tenantId?: string | null;
  }): Promise<DeviceSessionRow> {
    const deviceSessionId = args.deviceSessionId ?? `ds_${ulid()}`;
    const now = new Date();
    const [row] = await db
      .insert(deviceSessionTable)
      .values({
        deviceSessionId,
        budId: args.budId,
        status: "active",
        gatewayInstanceId: args.gatewayInstanceId ?? undefined,
        capabilities: args.capabilities ?? {},
        connectedAt: now,
        lastHeartbeatAt: now,
        createdByUserId: args.createdByUserId ?? undefined,
        tenantId: args.tenantId ?? undefined,
      })
      .onConflictDoUpdate({
        target: deviceSessionTable.deviceSessionId,
        set: {
          status: "active",
          capabilities: args.capabilities ?? {},
          gatewayInstanceId: args.gatewayInstanceId ?? undefined,
          lastHeartbeatAt: now,
          closedAt: null,
          closeReason: null,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  async registerTransportSession(args: {
    transportSessionId?: string;
    budId: string;
    deviceSessionId?: string | null;
    transportKind: string;
    remoteAddr?: string | null;
    userAgent?: string | null;
    createdByUserId?: string | null;
    tenantId?: string | null;
  }): Promise<TransportSessionRow> {
    const transportSessionId = args.transportSessionId ?? `ts_${ulid()}`;
    const now = new Date();
    const [row] = await db
      .insert(transportSessionTable)
      .values({
        transportSessionId,
        budId: args.budId,
        deviceSessionId: args.deviceSessionId ?? undefined,
        transportKind: args.transportKind,
        status: "active",
        remoteAddr: args.remoteAddr ?? undefined,
        userAgent: args.userAgent ?? undefined,
        connectedAt: now,
        lastSeenAt: now,
        createdByUserId: args.createdByUserId ?? undefined,
        tenantId: args.tenantId ?? undefined,
      })
      .onConflictDoUpdate({
        target: transportSessionTable.transportSessionId,
        set: {
          status: "active",
          lastSeenAt: now,
          closedAt: null,
          closeReason: null,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  async recordHeartbeat(args: {
    deviceSessionId?: string | null;
    transportSessionId?: string | null;
  }): Promise<void> {
    const now = new Date();
    if (args.deviceSessionId) {
      await db
        .update(deviceSessionTable)
        .set({ lastHeartbeatAt: now, updatedAt: now })
        .where(eq(deviceSessionTable.deviceSessionId, args.deviceSessionId));
    }
    if (args.transportSessionId) {
      await db
        .update(transportSessionTable)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(eq(transportSessionTable.transportSessionId, args.transportSessionId));
    }
  }

  async closeDeviceSession(args: {
    deviceSessionId: string;
    reason: string;
    markDraining?: boolean;
  }): Promise<void> {
    const now = new Date();
    await db
      .update(deviceSessionTable)
      .set({
        status: "closed",
        closedAt: now,
        closeReason: args.reason,
        drainStartedAt: args.markDraining ? now : undefined,
        updatedAt: now,
      })
      .where(eq(deviceSessionTable.deviceSessionId, args.deviceSessionId));
  }

  async closeTransportSession(args: {
    transportSessionId: string;
    reason: string;
    markDraining?: boolean;
    markUnknown?: boolean;
  }): Promise<void> {
    const now = new Date();
    await db
      .update(transportSessionTable)
      .set({
        status: "closed",
        closedAt: now,
        closeReason: args.reason,
        drainStartedAt: args.markDraining ? now : undefined,
        updatedAt: now,
      })
      .where(eq(transportSessionTable.transportSessionId, args.transportSessionId));
    if (args.markUnknown ?? true) {
      await this.markUnknownForTransportSession(args.transportSessionId);
    }
  }

  async createOperation(args: {
    operationId?: string;
    budId: string;
    operationType: string;
    trafficClass?: string;
    state?: OperationState;
    threadId?: string | null;
    terminalSessionId?: string | null;
    deviceSessionId?: string | null;
    transportSessionId?: string | null;
    idempotencyKey?: string | null;
    request?: Record<string, unknown>;
    createdByUserId?: string | null;
    tenantId?: string | null;
  }): Promise<BudOperationRow> {
    const operationId = args.operationId ?? `op_${ulid()}`;
    const [row] = await db
      .insert(budOperationTable)
      .values({
        operationId,
        budId: args.budId,
        operationType: args.operationType,
        trafficClass: args.trafficClass ?? "control",
        state: args.state ?? "offered",
        threadId: args.threadId ?? undefined,
        terminalSessionId: args.terminalSessionId ?? undefined,
        deviceSessionId: args.deviceSessionId ?? undefined,
        transportSessionId: args.transportSessionId ?? undefined,
        idempotencyKey: args.idempotencyKey ?? undefined,
        request: args.request ?? {},
        createdByUserId: args.createdByUserId ?? undefined,
        tenantId: args.tenantId ?? undefined,
      })
      .returning();
    return row;
  }

  async transitionOperation(args: {
    operationId: string;
    from: readonly OperationState[];
    to: OperationState;
    result?: Record<string, unknown> | null;
    error?: {
      code: string;
      message: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
    } | null;
  }): Promise<BudOperationRow | null> {
    for (const from of args.from) {
      if (!isAllowedOperationTransition(from, args.to)) {
        throw new Error(`invalid_operation_transition:${from}->${args.to}`);
      }
    }
    const now = new Date();
    const [row] = await db
      .update(budOperationTable)
      .set({
        state: args.to,
        result: args.result ?? undefined,
        errorCode: args.error?.code ?? undefined,
        errorMessage: args.error?.message ?? undefined,
        errorRetryable: args.error?.retryable ?? undefined,
        errorDetails: args.error?.details ?? undefined,
        acceptedAt: args.to === "accepted" ? now : undefined,
        startedAt: args.to === "running" ? now : undefined,
        finishedAt: isTerminalOperationState(args.to) ? now : undefined,
        updatedAt: now,
      })
      .where(and(eq(budOperationTable.operationId, args.operationId), inArray(budOperationTable.state, args.from)))
      .returning();
    return row ?? null;
  }

  async createStream(args: {
    streamId?: string;
    operationId?: string | null;
    budId: string;
    streamType: string;
    trafficClass?: string;
    state?: StreamState;
    deviceSessionId?: string | null;
    transportSessionId?: string | null;
    createdByUserId?: string | null;
    tenantId?: string | null;
  }): Promise<BudStreamRow> {
    const streamId = args.streamId ?? `st_${ulid()}`;
    const [row] = await db
      .insert(budStreamTable)
      .values({
        streamId,
        operationId: args.operationId ?? undefined,
        budId: args.budId,
        streamType: args.streamType,
        trafficClass: args.trafficClass ?? "interactive",
        state: args.state ?? "opening",
        deviceSessionId: args.deviceSessionId ?? undefined,
        transportSessionId: args.transportSessionId ?? undefined,
        createdByUserId: args.createdByUserId ?? undefined,
        tenantId: args.tenantId ?? undefined,
      })
      .returning();
    return row;
  }

  async transitionStream(args: {
    streamId: string;
    from: readonly StreamState[];
    to: StreamState;
    sendOffset?: number;
    receiveOffset?: number;
    resetReason?: string | null;
    error?: {
      code: string;
      message: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
    } | null;
  }): Promise<BudStreamRow | null> {
    for (const from of args.from) {
      if (!isAllowedStreamTransition(from, args.to)) {
        throw new Error(`invalid_stream_transition:${from}->${args.to}`);
      }
    }
    const now = new Date();
    const [row] = await db
      .update(budStreamTable)
      .set({
        state: args.to,
        sendOffset: args.sendOffset ?? undefined,
        receiveOffset: args.receiveOffset ?? undefined,
        resetReason: args.resetReason ?? undefined,
        errorCode: args.error?.code ?? undefined,
        errorMessage: args.error?.message ?? undefined,
        errorRetryable: args.error?.retryable ?? undefined,
        errorDetails: args.error?.details ?? undefined,
        openedAt: args.to === "open" ? now : undefined,
        closedAt: isTerminalStreamState(args.to) ? now : undefined,
        updatedAt: now,
      })
      .where(and(eq(budStreamTable.streamId, args.streamId), inArray(budStreamTable.state, args.from)))
      .returning();
    return row ?? null;
  }

  async markUnknownForTransportSession(transportSessionId: string): Promise<void> {
    const now = new Date();
    await db
      .update(budOperationTable)
      .set({ state: "unknown", finishedAt: now, updatedAt: now })
      .where(
        and(
          eq(budOperationTable.transportSessionId, transportSessionId),
          inArray(budOperationTable.state, ["offered", "accepted", "running"]),
        ),
      );
    await db
      .update(budStreamTable)
      .set({ state: "unknown", closedAt: now, updatedAt: now })
      .where(
        and(
          eq(budStreamTable.transportSessionId, transportSessionId),
          inArray(budStreamTable.state, ["opening", "open", "half_closed_local", "half_closed_remote"]),
        ),
      );
  }

  async reconcileReconnectReport(args: {
    budId: string;
    deviceSessionId?: string | null;
    transportSessionId?: string | null;
    operations: ReconnectOperationReport[];
    streams: ReconnectStreamReport[];
    terminalSessions?: string[];
    localPolicyVersion?: string | null;
  }): Promise<ReconciliationDecision> {
    const operationIds = args.operations.map((operation) => operation.operation_id).filter(Boolean);
    const streamIds = args.streams.map((stream) => stream.stream_id).filter(Boolean);

    const operationRows = operationIds.length
      ? await db
          .select()
          .from(budOperationTable)
          .where(and(eq(budOperationTable.budId, args.budId), inArray(budOperationTable.operationId, operationIds)))
      : [];
    const streamRows = streamIds.length
      ? await db
          .select()
          .from(budStreamTable)
          .where(and(eq(budStreamTable.budId, args.budId), inArray(budStreamTable.streamId, streamIds)))
      : [];

    const operationRowsById = new Map(operationRows.map((row) => [row.operationId, row]));
    const streamRowsById = new Map(streamRows.map((row) => [row.streamId, row]));

    await this.appendAuditEvent({
      eventType: "daemon.reconnect_report",
      budId: args.budId,
      eventData: {
        device_session_id: args.deviceSessionId ?? null,
        transport_session_id: args.transportSessionId ?? null,
        operation_count: args.operations.length,
        stream_count: args.streams.length,
        terminal_session_count: args.terminalSessions?.length ?? 0,
        local_policy_version: args.localPolicyVersion ?? null,
      },
    });

    return {
      operations: args.operations.map((operation) => {
        const row = operationRowsById.get(operation.operation_id);
        if (!row) {
          return {
            operation_id: operation.operation_id,
            state: "unknown",
            operation_type: operation.operation_type ?? null,
            error: {
              code: "UNKNOWN_OPERATION",
              message: "daemon reported an operation not known to this service",
              retryable: true,
            },
          };
        }
        return {
          operation_id: row.operationId,
          state: row.state,
          operation_type: row.operationType,
          error: row.errorCode
            ? {
                code: row.errorCode,
                message: row.errorMessage ?? row.errorCode,
                retryable: row.errorRetryable ?? undefined,
                details: row.errorDetails ?? undefined,
              }
            : null,
        };
      }),
      streams: args.streams.map((stream) => {
        const row = streamRowsById.get(stream.stream_id);
        if (!row) {
          return {
            stream_id: stream.stream_id,
            operation_id: stream.operation_id ?? null,
            stream_type: stream.stream_type,
            state: "unknown",
            send_offset: stream.send_offset ?? 0,
            receive_offset: stream.receive_offset ?? 0,
            error: {
              code: "UNKNOWN_STREAM",
              message: "daemon reported a stream not known to this service",
              retryable: true,
            },
          };
        }
        return {
          stream_id: row.streamId,
          operation_id: row.operationId ?? null,
          stream_type: row.streamType,
          state: row.state,
          send_offset: row.sendOffset,
          receive_offset: row.receiveOffset,
          reset_reason: row.resetReason ?? null,
          error: row.errorCode
            ? {
                code: row.errorCode,
                message: row.errorMessage ?? row.errorCode,
                retryable: row.errorRetryable ?? undefined,
                details: row.errorDetails ?? undefined,
              }
            : null,
        };
      }),
    };
  }

  async appendAuditEvent(args: {
    auditEventId?: string;
    eventType: string;
    eventData?: Record<string, unknown>;
    budId?: string | null;
    userId?: string | null;
    operationId?: string | null;
    streamId?: string | null;
    createdByUserId?: string | null;
    tenantId?: string | null;
  }): Promise<AuditEventRow> {
    const [row] = await db
      .insert(auditEventTable)
      .values({
        auditEventId: args.auditEventId ?? `aud_${ulid()}`,
        eventType: args.eventType,
        eventData: args.eventData ?? {},
        budId: args.budId ?? undefined,
        userId: args.userId ?? undefined,
        operationId: args.operationId ?? undefined,
        streamId: args.streamId ?? undefined,
        createdByUserId: args.createdByUserId ?? undefined,
        tenantId: args.tenantId ?? undefined,
      })
      .returning();
    return row;
  }
}

function isTerminalOperationState(state: OperationState): state is (typeof OPERATION_TERMINAL_STATES)[number] {
  return OPERATION_TERMINAL_STATES.includes(state as (typeof OPERATION_TERMINAL_STATES)[number]);
}

function isTerminalStreamState(state: StreamState): state is (typeof STREAM_TERMINAL_STATES)[number] {
  return STREAM_TERMINAL_STATES.includes(state as (typeof STREAM_TERMINAL_STATES)[number]);
}
