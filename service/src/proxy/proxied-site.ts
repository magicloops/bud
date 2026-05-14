import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import {
  auditEventTable,
  authSessionTable,
  proxiedSiteTable,
  proxiedSiteViewerGrantTable,
  proxiedSiteViewerSessionTable,
  threadTable,
  threadWebViewTable,
} from "../db/schema.js";
import type { Viewer } from "../auth/session.js";
import {
  resolveProxyTransportStatus,
  resolveWebSocketProxyTransportStatus,
  serializeProxyTransportStatus,
  type ProxyTransportStatus,
} from "./proxy-session.js";
import { closeProxyWebSocketRuntimeSessionsForSite } from "./proxy-ws-runtime.js";

export const PROXIED_SITE_PRIVATE_OWNER = "private_owner";
export const PROXIED_SITE_TARGET_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;
export const DEFAULT_PROXIED_SITE_TARGET_HOST: (typeof PROXIED_SITE_TARGET_HOSTS)[number] = "localhost";

const proxiedSiteTargetHostSet = new Set<string>(PROXIED_SITE_TARGET_HOSTS);

export const CreateProxiedSiteBodySchema = z.object({
  target_host: z.string().optional().default(DEFAULT_PROXIED_SITE_TARGET_HOST),
  target_port: z.number().int().min(1).max(65535),
  path: z.string().optional().default("/"),
  title: z.string().trim().min(1).max(120).optional(),
  reuse_existing: z.boolean().optional().default(true),
  source: z.enum(["manual", "agent", "system"]).optional().default("manual"),
  access_policy: z.literal(PROXIED_SITE_PRIVATE_OWNER).optional().default(PROXIED_SITE_PRIVATE_OWNER),
  display_metadata: z.record(z.unknown()).optional().default({}),
});

export const UpdateProxiedSiteBodySchema = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  path: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const AttachThreadWebViewBodySchema = z.object({
  proxied_site_id: z.string().min(1),
  path: z.string().optional(),
});

export const CreateViewerGrantBodySchema = z.object({
  path: z.string().optional(),
});

export type CreateProxiedSiteBody = z.infer<typeof CreateProxiedSiteBodySchema>;
export type ProxiedSiteRow = typeof proxiedSiteTable.$inferSelect;
export type ThreadWebViewRow = typeof threadWebViewTable.$inferSelect;

export class ProxiedSiteValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProxiedSiteValidationError";
  }
}

export function normalizeProxiedSiteTargetHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!proxiedSiteTargetHostSet.has(normalized)) {
    throw new ProxiedSiteValidationError(
      "unsupported_proxy_target",
      "Only localhost loopback proxy targets are allowed",
    );
  }
  return normalized;
}

export function normalizeProxiedSitePath(path: string | undefined): string {
  const value = (path ?? "/").trim() || "/";
  if (!value.startsWith("/")) {
    throw new ProxiedSiteValidationError(
      "invalid_proxy_path",
      "Proxy path must start with /",
    );
  }
  if (value.includes("\0")) {
    throw new ProxiedSiteValidationError(
      "invalid_proxy_path",
      "Proxy path cannot contain NUL bytes",
    );
  }
  return value;
}

function slugify(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return normalized || "local-app";
}

function defaultDisplayName(targetPort: number): string {
  return `Local app ${targetPort}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function renewExpiry(now = new Date()): Date {
  return new Date(now.getTime() + config.proxiedSiteTtlSeconds * 1000);
}

function viewerSessionExpiry(now = new Date()): Date {
  return new Date(now.getTime() + config.proxyViewerCookieMaxAgeSeconds * 1000);
}

function gatewayOrigin(endpointHost: string): string {
  const port = config.proxyPublicPort ? `:${config.proxyPublicPort}` : "";
  return `${config.proxyPublicScheme}://${endpointHost}${port}`;
}

export function endpointHostForSlug(slug: string): string {
  return `${slug}.${config.proxyBaseDomain}`;
}

export function isProxyGatewayHost(host: string | undefined): boolean {
  const normalized = normalizeHostHeader(host);
  return Boolean(normalized && normalized.endsWith(`.${config.proxyBaseDomain}`));
}

export function normalizeHostHeader(host: string | undefined): string | null {
  if (!host) {
    return null;
  }
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    return trimmed.slice(1, trimmed.indexOf("]"));
  }
  return trimmed.split(":")[0] ?? null;
}

async function allocateEndpointHost(title: string): Promise<{ slug: string; endpointHost: string }> {
  const base = slugify(title);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = ulid().slice(-6).toLowerCase();
    const slug = `${base}-${suffix}`;
    const endpointHost = endpointHostForSlug(slug);
    const existing = await db.query.proxiedSiteTable.findFirst({
      where: eq(proxiedSiteTable.endpointHost, endpointHost),
    });
    if (!existing) {
      return { slug, endpointHost };
    }
  }
  throw new ProxiedSiteValidationError(
    "endpoint_host_allocation_failed",
    "Failed to allocate a unique proxy endpoint host",
  );
}

export async function createOrReuseProxiedSite(args: {
  viewer: Viewer;
  budId: string;
  body: CreateProxiedSiteBody;
  transportStatus?: ProxyTransportStatus;
}): Promise<{ site: ProxiedSiteRow; transportStatus: ProxyTransportStatus; reused: boolean }> {
  const targetHost = normalizeProxiedSiteTargetHost(args.body.target_host);
  const defaultPath = normalizeProxiedSitePath(args.body.path);
  const displayName = args.body.title?.trim() || defaultDisplayName(args.body.target_port);
  const transportStatus = args.transportStatus ?? resolveProxyTransportStatus(args.budId);
  const now = new Date();

  if (args.body.reuse_existing) {
    const [existing] = await db
      .select()
      .from(proxiedSiteTable)
      .where(
        and(
          eq(proxiedSiteTable.budId, args.budId),
          eq(proxiedSiteTable.createdByUserId, args.viewer.userId),
          eq(proxiedSiteTable.targetHost, targetHost),
          eq(proxiedSiteTable.targetPort, args.body.target_port),
          eq(proxiedSiteTable.defaultPath, defaultPath),
          eq(proxiedSiteTable.accessPolicy, PROXIED_SITE_PRIVATE_OWNER),
          eq(proxiedSiteTable.enabled, true),
        ),
      )
      .limit(1);

    if (existing) {
      const [renewed] = await db
        .update(proxiedSiteTable)
        .set({
          expiresAt: renewExpiry(now),
          lastRenewedAt: now,
          updatedAt: now,
        })
        .where(eq(proxiedSiteTable.proxiedSiteId, existing.proxiedSiteId))
        .returning();
      return { site: renewed ?? existing, transportStatus, reused: true };
    }
  }

  const proxiedSiteId = `site_${ulid()}`;
  const auditCorrelationId = `psc_${ulid()}`;
  const endpoint = await allocateEndpointHost(displayName);

  const site = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(proxiedSiteTable)
      .values({
        proxiedSiteId,
        budId: args.budId,
        displayName,
        slug: endpoint.slug,
        endpointHost: endpoint.endpointHost,
        targetScheme: "http",
        targetHost,
        targetPort: args.body.target_port,
        defaultPath,
        accessPolicy: PROXIED_SITE_PRIVATE_OWNER,
        displayMetadata: {
          ...args.body.display_metadata,
          source: args.body.source,
        },
        auditCorrelationId,
        expiresAt: renewExpiry(now),
        lastRenewedAt: now,
        createdByUserId: args.viewer.userId,
      })
      .returning();

    await tx.insert(auditEventTable).values({
      auditEventId: `aud_${ulid()}`,
      eventType: "proxied_site.create",
      budId: args.budId,
      userId: args.viewer.userId,
      createdByUserId: args.viewer.userId,
      eventData: {
        proxied_site_id: proxiedSiteId,
        audit_correlation_id: auditCorrelationId,
        endpoint_host: endpoint.endpointHost,
        target_host: targetHost,
        target_port: args.body.target_port,
        default_path: defaultPath,
        access_policy: PROXIED_SITE_PRIVATE_OWNER,
        transport: serializeProxyTransportStatus(transportStatus),
      },
    });

    return row;
  });

  return { site, transportStatus, reused: false };
}

export async function getAuthorizedProxiedSite(
  viewer: Viewer,
  proxiedSiteId: string,
): Promise<ProxiedSiteRow | null> {
  const [row] = await db
    .select()
    .from(proxiedSiteTable)
    .where(
      and(
        eq(proxiedSiteTable.proxiedSiteId, proxiedSiteId),
        eq(proxiedSiteTable.createdByUserId, viewer.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getProxiedSiteByEndpointHost(endpointHost: string): Promise<ProxiedSiteRow | null> {
  const [row] = await db
    .select()
    .from(proxiedSiteTable)
    .where(eq(proxiedSiteTable.endpointHost, endpointHost))
    .limit(1);
  return row ?? null;
}

export async function listAuthorizedProxiedSitesForBud(args: {
  viewer: Viewer;
  budId: string;
  limit?: number;
}): Promise<ProxiedSiteRow[]> {
  return db
    .select()
    .from(proxiedSiteTable)
    .where(
      and(
        eq(proxiedSiteTable.budId, args.budId),
        eq(proxiedSiteTable.createdByUserId, args.viewer.userId),
      ),
    )
    .orderBy(desc(proxiedSiteTable.updatedAt))
    .limit(args.limit ?? 50);
}

export async function updateAuthorizedProxiedSite(args: {
  viewer: Viewer;
  proxiedSiteId: string;
  body: z.infer<typeof UpdateProxiedSiteBodySchema>;
}): Promise<ProxiedSiteRow | null> {
  const existing = await getAuthorizedProxiedSite(args.viewer, args.proxiedSiteId);
  if (!existing) {
    return null;
  }
  const now = new Date();
  const update: Partial<typeof proxiedSiteTable.$inferInsert> = {
    updatedAt: now,
  };
  if (args.body.display_name !== undefined) {
    update.displayName = args.body.display_name;
  }
  if (args.body.path !== undefined) {
    update.defaultPath = normalizeProxiedSitePath(args.body.path);
  }
  if (args.body.enabled !== undefined) {
    update.enabled = args.body.enabled;
    update.disabledAt = args.body.enabled ? null : now;
    update.disabledByUserId = args.body.enabled ? null : args.viewer.userId;
    update.disableReason = args.body.enabled ? null : "user_requested";
    if (args.body.enabled) {
      update.expiresAt = renewExpiry(now);
      update.lastRenewedAt = now;
    }
  }

  const [row] = await db
    .update(proxiedSiteTable)
    .set(update)
    .where(
      and(
        eq(proxiedSiteTable.proxiedSiteId, args.proxiedSiteId),
        eq(proxiedSiteTable.createdByUserId, args.viewer.userId),
      ),
    )
    .returning();

  if (args.body.enabled === false) {
    closeDisabledSiteWebSockets(args.proxiedSiteId);
  }

  return row ?? existing;
}

export async function disableAuthorizedProxiedSite(args: {
  viewer: Viewer;
  proxiedSiteId: string;
  reason?: string;
}): Promise<ProxiedSiteRow | null> {
  const existing = await getAuthorizedProxiedSite(args.viewer, args.proxiedSiteId);
  if (!existing) {
    return null;
  }
  if (!existing.enabled) {
    closeDisabledSiteWebSockets(args.proxiedSiteId);
    return existing;
  }

  const now = new Date();
  const [row] = await db
    .update(proxiedSiteTable)
    .set({
      enabled: false,
      disabledAt: now,
      disabledByUserId: args.viewer.userId,
      disableReason: args.reason ?? "user_requested",
      updatedAt: now,
    })
    .where(
      and(
        eq(proxiedSiteTable.proxiedSiteId, args.proxiedSiteId),
        eq(proxiedSiteTable.createdByUserId, args.viewer.userId),
      ),
    )
    .returning();

  await db.insert(auditEventTable).values({
    auditEventId: `aud_${ulid()}`,
    eventType: "proxied_site.disable",
    budId: existing.budId,
    userId: args.viewer.userId,
    createdByUserId: args.viewer.userId,
    eventData: {
      proxied_site_id: args.proxiedSiteId,
      audit_correlation_id: existing.auditCorrelationId,
      reason: args.reason ?? "user_requested",
    },
  });

  closeDisabledSiteWebSockets(args.proxiedSiteId);

  return row ?? existing;
}

function closeDisabledSiteWebSockets(proxiedSiteId: string): number {
  return closeProxyWebSocketRuntimeSessionsForSite(proxiedSiteId, {
    reason: "site_disabled",
    closeCode: 1008,
    error: {
      code: "PROXIED_SITE_DISABLED",
      message: "proxied site was disabled",
      retryable: false,
    },
  });
}

export async function attachThreadWebView(args: {
  viewer: Viewer;
  thread: typeof threadTable.$inferSelect;
  proxiedSiteId: string;
  selectedPath?: string;
}): Promise<ThreadWebViewRow | null> {
  const site = await getAuthorizedProxiedSite(args.viewer, args.proxiedSiteId);
  if (!site || site.budId !== args.thread.budId || !isProxiedSiteOpenable(site)) {
    return null;
  }

  const now = new Date();
  const selectedPath =
    args.selectedPath === undefined ? null : normalizeProxiedSitePath(args.selectedPath);
  const [row] = await db
    .insert(threadWebViewTable)
    .values({
      threadId: args.thread.threadId,
      budId: args.thread.budId,
      proxiedSiteId: site.proxiedSiteId,
      selectedPath,
      attachedByUserId: args.viewer.userId,
      createdByUserId: args.viewer.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: threadWebViewTable.threadId,
      set: {
        budId: args.thread.budId,
        proxiedSiteId: site.proxiedSiteId,
        selectedPath,
        attachedByUserId: args.viewer.userId,
        updatedAt: now,
      },
    })
    .returning();

  return row ?? null;
}

export async function getThreadWebViewForThread(args: {
  viewer: Viewer;
  threadId: string;
}): Promise<{ attachment: ThreadWebViewRow; site: ProxiedSiteRow } | null> {
  const [attachment] = await db
    .select()
    .from(threadWebViewTable)
    .where(
      and(
        eq(threadWebViewTable.threadId, args.threadId),
        eq(threadWebViewTable.createdByUserId, args.viewer.userId),
      ),
    )
    .limit(1);
  if (!attachment) {
    return null;
  }

  const site = await getAuthorizedProxiedSite(args.viewer, attachment.proxiedSiteId);
  if (!site) {
    return null;
  }

  return { attachment, site };
}

export async function detachThreadWebView(args: {
  viewer: Viewer;
  threadId: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(threadWebViewTable)
    .where(
      and(
        eq(threadWebViewTable.threadId, args.threadId),
        eq(threadWebViewTable.createdByUserId, args.viewer.userId),
      ),
    )
    .returning({ threadId: threadWebViewTable.threadId });

  return deleted.length > 0;
}

export function isProxiedSiteOpenable(site: ProxiedSiteRow): boolean {
  return site.enabled && site.expiresAt.getTime() > Date.now();
}

export function effectiveProxiedSiteState(site: ProxiedSiteRow): "ready" | "disabled" | "expired" {
  if (!site.enabled) {
    return "disabled";
  }
  if (site.expiresAt.getTime() <= Date.now()) {
    return "expired";
  }
  return "ready";
}

export function proxiedSiteViewUrl(site: ProxiedSiteRow, path = site.defaultPath): string {
  return new URL(normalizeProxiedSitePath(path), gatewayOrigin(site.endpointHost)).toString();
}

export function serializeProxiedSite(
  site: ProxiedSiteRow,
  transportStatus?: ProxyTransportStatus,
  websocketTransportStatus?: ProxyTransportStatus,
): Record<string, unknown> {
  const resolvedWebSocketTransportStatus =
    websocketTransportStatus ?? (transportStatus ? resolveWebSocketProxyTransportStatus(site.budId) : null);
  return {
    proxied_site_id: site.proxiedSiteId,
    bud_id: site.budId,
    display_name: site.displayName,
    slug: site.slug,
    endpoint_host: site.endpointHost,
    view_url: proxiedSiteViewUrl(site),
    target_host: site.targetHost,
    target_port: site.targetPort,
    path: site.defaultPath,
    access_policy: site.accessPolicy,
    enabled: site.enabled,
    state: effectiveProxiedSiteState(site),
    expires_at: site.expiresAt.toISOString(),
    disabled_at: site.disabledAt?.toISOString() ?? null,
    last_accessed_at: site.lastAccessedAt?.toISOString() ?? null,
    transport: transportStatus ? serializeProxyTransportStatus(transportStatus) : null,
    websocket_transport: resolvedWebSocketTransportStatus
      ? serializeProxyTransportStatus(resolvedWebSocketTransportStatus)
      : null,
    capabilities: {
      websocket: resolvedWebSocketTransportStatus?.available === true,
    },
    created_at: site.createdAt.toISOString(),
    updated_at: site.updatedAt.toISOString(),
  };
}

export async function createViewerGrant(args: {
  viewer: Viewer;
  site: ProxiedSiteRow;
  path?: string;
}): Promise<{ bootstrapUrl: string; viewUrl: string; expiresAt: Date }> {
  if (!isProxiedSiteOpenable(args.site)) {
    throw new ProxiedSiteValidationError(
      effectiveProxiedSiteState(args.site) === "expired" ? "proxied_site_expired" : "proxied_site_disabled",
      "Proxied site is not openable",
    );
  }
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.proxyBootstrapGrantTtlSeconds * 1000);
  const redirectPath = normalizeProxiedSitePath(args.path ?? args.site.defaultPath);
  await db.insert(proxiedSiteViewerGrantTable).values({
    viewerGrantId: `pvg_${ulid()}`,
    proxiedSiteId: args.site.proxiedSiteId,
    budId: args.site.budId,
    userId: args.viewer.userId,
    authSessionId: args.viewer.sessionId ?? undefined,
    grantHash: hashToken(token),
    redirectPath,
    expiresAt,
    createdByUserId: args.viewer.userId,
  });

  const bootstrap = new URL("/__bud/bootstrap", gatewayOrigin(args.site.endpointHost));
  bootstrap.searchParams.set("grant", token);
  bootstrap.searchParams.set("to", redirectPath);

  return {
    bootstrapUrl: bootstrap.toString(),
    viewUrl: proxiedSiteViewUrl(args.site, redirectPath),
    expiresAt,
  };
}

export async function consumeViewerGrant(args: {
  endpointHost: string;
  grantToken: string;
}): Promise<
  | {
      ok: true;
      site: ProxiedSiteRow;
      sessionToken: string;
      redirectPath: string;
      expiresAt: Date;
    }
  | { ok: false; code: string }
> {
  const now = new Date();
  const grantHash = hashToken(args.grantToken);
  const [grant] = await db
    .select()
    .from(proxiedSiteViewerGrantTable)
    .where(
      and(
        eq(proxiedSiteViewerGrantTable.grantHash, grantHash),
        gt(proxiedSiteViewerGrantTable.expiresAt, now),
        isNull(proxiedSiteViewerGrantTable.consumedAt),
      ),
    )
    .limit(1);
  if (!grant) {
    return { ok: false, code: "invalid_viewer_grant" };
  }

  const [site] = await db
    .select()
    .from(proxiedSiteTable)
    .where(
      and(
        eq(proxiedSiteTable.proxiedSiteId, grant.proxiedSiteId),
        eq(proxiedSiteTable.endpointHost, args.endpointHost),
      ),
    )
    .limit(1);
  if (!site || site.createdByUserId !== grant.userId || !isProxiedSiteOpenable(site)) {
    return { ok: false, code: "proxied_site_not_found" };
  }

  const sessionToken = randomToken();
  const expiresAt = viewerSessionExpiry(now);
  await db.transaction(async (tx) => {
    await tx
      .update(proxiedSiteViewerGrantTable)
      .set({ consumedAt: now })
      .where(eq(proxiedSiteViewerGrantTable.viewerGrantId, grant.viewerGrantId));
    await tx.insert(proxiedSiteViewerSessionTable).values({
      viewerSessionId: `pvs_${ulid()}`,
      proxiedSiteId: site.proxiedSiteId,
      budId: site.budId,
      userId: grant.userId,
      authSessionId: grant.authSessionId ?? undefined,
      tokenHash: hashToken(sessionToken),
      expiresAt,
      lastSeenAt: now,
      lastRefreshedAt: now,
      createdByUserId: grant.userId,
    });
  });

  return {
    ok: true,
    site,
    sessionToken,
    redirectPath: grant.redirectPath,
    expiresAt,
  };
}

export async function resolveViewerSession(args: {
  site: ProxiedSiteRow;
  sessionToken: string | null;
}): Promise<{ viewer: Viewer; refreshed: boolean; sessionToken: string | null } | null> {
  if (!args.sessionToken) {
    return null;
  }
  const now = new Date();
  const [session] = await db
    .select()
    .from(proxiedSiteViewerSessionTable)
    .where(
      and(
        eq(proxiedSiteViewerSessionTable.tokenHash, hashToken(args.sessionToken)),
        eq(proxiedSiteViewerSessionTable.proxiedSiteId, args.site.proxiedSiteId),
        gt(proxiedSiteViewerSessionTable.expiresAt, now),
        isNull(proxiedSiteViewerSessionTable.revokedAt),
      ),
    )
    .limit(1);
  if (!session || session.userId !== args.site.createdByUserId) {
    return null;
  }

  let refreshed = false;
  let nextToken: string | null = null;
  const authSessionId = session.authSessionId;
  const shouldRefresh =
    authSessionId &&
    (!session.lastRefreshedAt ||
      now.getTime() - session.lastRefreshedAt.getTime() >
        config.proxyViewerCookieRefreshSeconds * 1000);

  if (shouldRefresh) {
    const [authSession] = await db
      .select({ id: authSessionTable.id })
      .from(authSessionTable)
      .where(
        and(
          eq(authSessionTable.id, authSessionId),
          eq(authSessionTable.userId, session.userId),
          gt(authSessionTable.expiresAt, now),
        ),
      )
      .limit(1);
    if (authSession) {
      nextToken = randomToken();
      await db
        .update(proxiedSiteViewerSessionTable)
        .set({
          tokenHash: hashToken(nextToken),
          expiresAt: viewerSessionExpiry(now),
          lastSeenAt: now,
          lastRefreshedAt: now,
          updatedAt: now,
        })
        .where(eq(proxiedSiteViewerSessionTable.viewerSessionId, session.viewerSessionId));
      refreshed = true;
    }
  } else {
    await db
      .update(proxiedSiteViewerSessionTable)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(eq(proxiedSiteViewerSessionTable.viewerSessionId, session.viewerSessionId));
  }

  return {
    viewer: {
      userId: session.userId,
      sessionId: session.authSessionId,
      email: null,
      authType: "cookie",
    },
    refreshed,
    sessionToken: nextToken,
  };
}

export function readCookie(header: string | string[] | undefined, name: string): string | null {
  const cookieHeader = Array.isArray(header) ? header.join("; ") : header;
  if (!cookieHeader) {
    return null;
  }
  for (const pair of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = pair.trim().split("=");
    if (rawName === name) {
      return rawValue.join("=") || null;
    }
  }
  return null;
}

export function buildViewerCookie(token: string): string {
  const parts = [
    `${config.proxyViewerCookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${config.proxyViewerCookieMaxAgeSeconds}`,
    config.proxyPublicScheme === "https" ? "SameSite=None" : "SameSite=Lax",
  ];
  if (config.proxyPublicScheme === "https") {
    parts.push("Secure");
  }
  return parts.join("; ");
}
