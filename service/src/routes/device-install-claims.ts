import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { requireViewer } from "../auth/session.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { deviceInstallClaimTable } from "../db/schema.js";

const DEVICE_INSTALL_CLAIM_TTL_MS = 10 * 60 * 1000;

const CreateDeviceInstallClaimSchema = z.object({
  device_name_hint: z.string().trim().min(1).max(120).optional(),
  install_scope: z.literal("machine").default("machine"),
});

const DeviceInstallClaimParamsSchema = z.object({
  installClaimId: z.string().trim().min(1),
});

type DeviceInstallClaimRow = typeof deviceInstallClaimTable.$inferSelect;

export function hashDeviceInstallClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateDeviceInstallClaimToken(): string {
  return `bic_${randomBytes(32).toString("base64url")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function installScriptUrl(): string {
  return new URL("/install.sh", `${config.daemonInstallerBaseUrl}/`).toString();
}

export function buildInstallCommand(claimToken?: string): string {
  const baseCommand = `curl -fsSL ${installScriptUrl()}`;
  if (!claimToken) {
    return `${baseCommand} | sh`;
  }
  return `${baseCommand} | env BUD_CLAIM_ID=${shellQuote(claimToken)} sh`;
}

function installClaimStatus(row: DeviceInstallClaimRow, now = new Date()) {
  if (row.redeemedAt) {
    return "redeemed";
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "pending";
}

function serializeInstallClaim(row: DeviceInstallClaimRow) {
  return {
    install_claim_id: row.installClaimId,
    status: installClaimStatus(row),
    install_scope: row.installScope,
    device_name_hint: row.deviceNameHint,
    expires_at: row.expiresAt.toISOString(),
    redeemed_at: row.redeemedAt?.toISOString() ?? null,
    redeemed_bud_id: row.redeemedBudId ?? null,
    redeemed_installation_id: row.redeemedInstallationId ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function registerDeviceInstallClaimRoutes(server: FastifyInstance): Promise<void> {
  server.post("/api/device-install-claims", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const body = CreateDeviceInstallClaimSchema.parse(request.body ?? {});
    const claimToken = generateDeviceInstallClaimToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DEVICE_INSTALL_CLAIM_TTL_MS);
    const installClaimId = `dic_${ulid()}`;

    await db.insert(deviceInstallClaimTable).values({
      installClaimId,
      claimTokenHash: hashDeviceInstallClaimToken(claimToken),
      createdByUserId: viewer.userId,
      deviceNameHint: body.device_name_hint,
      installScope: body.install_scope,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    return reply.status(201).send({
      install_claim_id: installClaimId,
      claim_id: claimToken,
      expires_at: expiresAt.toISOString(),
      install_command: buildInstallCommand(claimToken),
      public_install_command: buildInstallCommand(),
    });
  });

  server.get("/api/device-install-claims/:installClaimId", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = DeviceInstallClaimParamsSchema.parse(request.params);
    const row = await db.query.deviceInstallClaimTable.findFirst({
      where: and(
        eq(deviceInstallClaimTable.installClaimId, params.installClaimId),
        eq(deviceInstallClaimTable.createdByUserId, viewer.userId),
      ),
    });

    if (!row) {
      return reply.status(404).send({ error: "device_install_claim_not_found" });
    }

    return serializeInstallClaim(row);
  });
}
