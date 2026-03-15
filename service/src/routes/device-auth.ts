import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { requireViewer } from "../auth/session.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { budTable, deviceAuthFlowTable } from "../db/schema.js";

const DEVICE_AUTH_FLOW_TTL_MS = 15 * 60 * 1000;
const DEVICE_AUTH_POST_APPROVAL_TTL_MS = 30 * 60 * 1000;
const DEVICE_AUTH_POLL_INTERVAL_MS = 2_000;

const DeviceMetadataSchema = z.object({
  installation_id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  os: z.string().trim().min(1).max(64),
  arch: z.string().trim().min(1).max(64),
  version: z.string().trim().min(1).max(120).optional(),
  capabilities: z.record(z.unknown()).default({})
});

const DeviceAuthPollSchema = z.object({
  flow_id: z.string().trim().min(1),
  poll_secret: z.string().trim().min(1)
});

const DeviceAuthFlowParamsSchema = z.object({
  flowId: z.string().trim().min(1)
});

type DeviceAuthFlowRow = typeof deviceAuthFlowTable.$inferSelect;
type PublicFlowStatus = "pending" | "approved" | "completed" | "rejected" | "expired";

function hashPollSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function isExpired(flow: DeviceAuthFlowRow, now = new Date()) {
  return flow.expiresAt.getTime() <= now.getTime();
}

function getFlowStatus(flow: DeviceAuthFlowRow, now = new Date()): PublicFlowStatus {
  if (flow.status === "pending" && isExpired(flow, now)) {
    return "expired";
  }
  if (flow.status === "approved" || flow.status === "completed" || flow.status === "rejected") {
    return flow.status;
  }
  return "pending";
}

function buildClaimUrl(flowId: string) {
  return new URL(`/devices/claim/${flowId}`, config.appBaseUrl).toString();
}

function serializePublicFlow(flow: DeviceAuthFlowRow) {
  return {
    flow_id: flow.flowId,
    status: getFlowStatus(flow),
    expires_at: flow.expiresAt.toISOString(),
    approved_at: flow.approvedAt?.toISOString() ?? null,
    completed_at: flow.completedAt?.toISOString() ?? null,
    approved_bud_id: flow.budId ?? null,
    error_code: flow.errorCode ?? null,
    device: {
      name: flow.requestedName,
      os: flow.requestedOs,
      arch: flow.requestedArch,
      version: flow.requestedVersion ?? null
    }
  };
}

export async function registerDeviceAuthRoutes(server: FastifyInstance): Promise<void> {
  server.post("/api/device-auth/start", async (request, reply) => {
    const body = DeviceMetadataSchema.parse(request.body ?? {});
    const flowId = `daf_${ulid()}`;
    const pollSecret = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + DEVICE_AUTH_FLOW_TTL_MS);
    const claimUrl = buildClaimUrl(flowId);

    await db.insert(deviceAuthFlowTable).values({
      flowId,
      installationId: body.installation_id,
      pollSecretHash: hashPollSecret(pollSecret),
      requestedName: body.name,
      requestedOs: body.os,
      requestedArch: body.arch,
      requestedVersion: body.version,
      requestedCapabilities: body.capabilities,
      expiresAt
    });

    return reply.status(201).send({
      flow_id: flowId,
      claim_url: claimUrl,
      qr_payload: claimUrl,
      poll_secret: pollSecret,
      expires_at: expiresAt.toISOString(),
      poll_interval_ms: DEVICE_AUTH_POLL_INTERVAL_MS
    });
  });

  server.post("/api/device-auth/poll", async (request, reply) => {
    const body = DeviceAuthPollSchema.parse(request.body ?? {});
    const flow = await db.query.deviceAuthFlowTable.findFirst({
      where: eq(deviceAuthFlowTable.flowId, body.flow_id)
    });

    if (!flow || flow.pollSecretHash !== hashPollSecret(body.poll_secret)) {
      return reply.status(404).send({ error: "device_auth_flow_not_found" });
    }

    await db
      .update(deviceAuthFlowTable)
      .set({ lastPolledAt: new Date() })
      .where(eq(deviceAuthFlowTable.flowId, flow.flowId));

    const status = getFlowStatus(flow);
    if (status === "expired") {
      return {
        status,
        expires_at: flow.expiresAt.toISOString()
      };
    }

    if ((status === "approved" || status === "completed") && flow.budId && flow.issuedDeviceSecret) {
      return {
        status: "approved",
        bud_id: flow.budId,
        device_secret: flow.issuedDeviceSecret,
        expires_at: flow.expiresAt.toISOString()
      };
    }

    if (status === "completed") {
      return {
        status,
        bud_id: flow.budId ?? null,
        expires_at: flow.expiresAt.toISOString()
      };
    }

    if (status === "rejected") {
      return {
        status,
        error_code: flow.errorCode ?? "device_claim_rejected"
      };
    }

    return {
      status: "pending",
      expires_at: flow.expiresAt.toISOString(),
      poll_interval_ms: DEVICE_AUTH_POLL_INTERVAL_MS
    };
  });

  server.get("/api/device-auth/flows/:flowId", async (request, reply) => {
    const params = DeviceAuthFlowParamsSchema.parse(request.params);
    const flow = await db.query.deviceAuthFlowTable.findFirst({
      where: eq(deviceAuthFlowTable.flowId, params.flowId)
    });

    if (!flow) {
      return reply.status(404).send({ error: "device_auth_flow_not_found" });
    }

    return serializePublicFlow(flow);
  });

  server.post("/api/device-auth/flows/:flowId/approve", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = DeviceAuthFlowParamsSchema.parse(request.params);

    const result = await db.transaction(async (tx) => {
      const flow = await tx.query.deviceAuthFlowTable.findFirst({
        where: eq(deviceAuthFlowTable.flowId, params.flowId)
      });

      if (!flow) {
        return { kind: "not_found" as const };
      }

      const status = getFlowStatus(flow);
      if (status === "expired") {
        return { kind: "expired" as const };
      }
      if (status === "rejected") {
        return {
          kind: "rejected" as const,
          errorCode: flow.errorCode ?? "device_claim_rejected"
        };
      }
      if ((status === "approved" || status === "completed") && flow.budId) {
        if (flow.approvedByUserId && flow.approvedByUserId !== viewer.userId) {
          return {
            kind: "conflict" as const,
            errorCode: flow.errorCode ?? "device_claim_conflict"
          };
        }
        return {
          kind: "approved" as const,
          budId: flow.budId
        };
      }

      const existingBud = await tx.query.budTable.findFirst({
        where: eq(budTable.installationId, flow.installationId)
      });

      if (existingBud?.createdByUserId && existingBud.createdByUserId !== viewer.userId) {
        await tx
          .update(deviceAuthFlowTable)
          .set({
            status: "rejected",
            errorCode: "installation_claim_conflict"
          })
          .where(eq(deviceAuthFlowTable.flowId, flow.flowId));

        return {
          kind: "conflict" as const,
          errorCode: "installation_claim_conflict"
        };
      }

      const budId = existingBud?.budId ?? `b_${ulid()}`;
      const deviceSecret = randomBytes(32).toString("base64url");
      const now = new Date();
      const nextExpiry = new Date(now.getTime() + DEVICE_AUTH_POST_APPROVAL_TTL_MS);

      if (existingBud) {
        await tx
          .update(budTable)
          .set({
            installationId: flow.installationId,
            name: flow.requestedName,
            os: flow.requestedOs,
            arch: flow.requestedArch,
            version: flow.requestedVersion,
            capabilities: flow.requestedCapabilities,
            deviceSecret,
            createdByUserId: existingBud.createdByUserId ?? viewer.userId
          })
          .where(eq(budTable.budId, budId));
      } else {
        await tx.insert(budTable).values({
          budId,
          installationId: flow.installationId,
          name: flow.requestedName,
          os: flow.requestedOs,
          arch: flow.requestedArch,
          version: flow.requestedVersion,
          capabilities: flow.requestedCapabilities,
          status: "offline",
          deviceSecret,
          createdByUserId: viewer.userId
        });
      }

      await tx
        .update(deviceAuthFlowTable)
        .set({
          status: "approved",
          approvedByUserId: viewer.userId,
          budId,
          issuedDeviceSecret: deviceSecret,
          approvedAt: now,
          expiresAt: nextExpiry,
          errorCode: null
        })
        .where(eq(deviceAuthFlowTable.flowId, flow.flowId));

      return {
        kind: "approved" as const,
        budId
      };
    });

    if (result.kind === "not_found") {
      return reply.status(404).send({ error: "device_auth_flow_not_found" });
    }
    if (result.kind === "expired") {
      return reply.status(410).send({ error: "device_auth_flow_expired" });
    }
    if (result.kind === "rejected" || result.kind === "conflict") {
      return reply.status(409).send({ error: result.errorCode });
    }

    return {
      status: "approved",
      bud_id: result.budId
    };
  });
}
