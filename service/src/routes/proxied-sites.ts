import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket from "ws";
import { z } from "zod";
import { config } from "../config.js";
import { getAuthorizedBud, requireViewer } from "../auth/session.js";
import {
  resolveProxyTransportStatus,
  resolveWebSocketProxyTransportStatus,
  serializeProxyTransportStatus,
} from "../proxy/proxy-session.js";
import { openProxiedSiteEdgeStream } from "../proxy/proxy-edge.js";
import { openProxiedSiteWebSocketEdge } from "../proxy/proxy-ws-edge.js";
import {
  AttachThreadWebViewBodySchema,
  CreateProxiedSiteBodySchema,
  CreateViewerGrantBodySchema,
  ProxiedSiteValidationError,
  UpdateProxiedSiteBodySchema,
  attachThreadWebView,
  buildViewerCookie,
  consumeViewerGrant,
  createOrReuseProxiedSite,
  createViewerGrant,
  detachThreadWebView,
  effectiveProxiedSiteState,
  getAuthorizedProxiedSite,
  getProxiedSiteByEndpointHost,
  getThreadWebViewForThread,
  isProxiedSiteOpenable,
  listAuthorizedProxiedSitesForBud,
  proxiedSiteViewUrl,
  readCookie,
  resolveProxyGatewayHost,
  resolveViewerSession,
  serializeProxiedSite,
  updateAuthorizedProxiedSite,
  disableAuthorizedProxiedSite,
} from "../proxy/proxied-site.js";
import { ThreadParamsSchema, requireAuthorizedThreadAccess } from "./threads/shared.js";

const BudProxiedSitesParamsSchema = z.object({
  budId: z.string().min(1),
});

const ProxiedSiteParamsSchema = z.object({
  proxiedSiteId: z.string().min(1),
});

const BootstrapQuerySchema = z.object({
  grant: z.string().min(1),
  to: z.string().optional(),
});

export async function registerProxiedSiteRoutes(server: FastifyInstance): Promise<void> {
  server.post("/api/buds/:budId/proxied-sites", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = BudProxiedSitesParamsSchema.parse(request.params);
    if (!(await getAuthorizedBud(viewer, params.budId))) {
      return reply.status(404).send({ error: "bud_not_found" });
    }

    const bodyResult = CreateProxiedSiteBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "invalid_proxied_site_request",
        message: bodyResult.error.issues[0]?.message ?? "Invalid proxied site request",
      });
    }

    try {
      const result = await createOrReuseProxiedSite({
        viewer,
        budId: params.budId,
        body: bodyResult.data,
      });
      const websocketTransportStatus = resolveWebSocketProxyTransportStatus(result.site.budId);
      return reply
        .status(result.reused ? 200 : 201)
        .send(serializeProxiedSite(result.site, result.transportStatus, websocketTransportStatus));
    } catch (err) {
      if (err instanceof ProxiedSiteValidationError) {
        return reply.status(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  server.get("/api/buds/:budId/proxied-sites", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = BudProxiedSitesParamsSchema.parse(request.params);
    if (!(await getAuthorizedBud(viewer, params.budId))) {
      return reply.status(404).send({ error: "bud_not_found" });
    }

    const transportStatus = resolveProxyTransportStatus(params.budId);
    const websocketTransportStatus = resolveWebSocketProxyTransportStatus(params.budId);
    const sites = await listAuthorizedProxiedSitesForBud({
      viewer,
      budId: params.budId,
    });

    return {
      proxied_sites: sites.map((site) => serializeProxiedSite(site, transportStatus, websocketTransportStatus)),
      transport: serializeProxyTransportStatus(transportStatus),
      websocket_transport: serializeProxyTransportStatus(websocketTransportStatus),
    };
  });

  server.get("/api/proxied-sites/:proxiedSiteId", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = ProxiedSiteParamsSchema.parse(request.params);
    const site = await getAuthorizedProxiedSite(viewer, params.proxiedSiteId);
    if (!site) {
      return reply.status(404).send({ error: "proxied_site_not_found" });
    }

    const transportStatus = resolveProxyTransportStatus(site.budId);
    const websocketTransportStatus = resolveWebSocketProxyTransportStatus(site.budId);
    return serializeProxiedSite(site, transportStatus, websocketTransportStatus);
  });

  server.patch("/api/proxied-sites/:proxiedSiteId", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = ProxiedSiteParamsSchema.parse(request.params);
    const bodyResult = UpdateProxiedSiteBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.status(400).send({ error: "invalid_proxied_site_update" });
    }

    try {
      const site = await updateAuthorizedProxiedSite({
        viewer,
        proxiedSiteId: params.proxiedSiteId,
        body: bodyResult.data,
      });
      if (!site) {
        return reply.status(404).send({ error: "proxied_site_not_found" });
      }
      const transportStatus = resolveProxyTransportStatus(site.budId);
      const websocketTransportStatus = resolveWebSocketProxyTransportStatus(site.budId);
      return serializeProxiedSite(site, transportStatus, websocketTransportStatus);
    } catch (err) {
      if (err instanceof ProxiedSiteValidationError) {
        return reply.status(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  server.delete("/api/proxied-sites/:proxiedSiteId", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = ProxiedSiteParamsSchema.parse(request.params);
    const site = await disableAuthorizedProxiedSite({
      viewer,
      proxiedSiteId: params.proxiedSiteId,
    });
    if (!site) {
      return reply.status(404).send({ error: "proxied_site_not_found" });
    }

    const transportStatus = resolveProxyTransportStatus(site.budId);
    const websocketTransportStatus = resolveWebSocketProxyTransportStatus(site.budId);
    return serializeProxiedSite(site, transportStatus, websocketTransportStatus);
  });

  server.post("/api/threads/:threadId/web-view/attach", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const bodyResult = AttachThreadWebViewBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.status(400).send({ error: "invalid_web_view_attach" });
    }

    try {
      const attachment = await attachThreadWebView({
        viewer: access.viewer,
        thread: access.thread,
        proxiedSiteId: bodyResult.data.proxied_site_id,
        selectedPath: bodyResult.data.path,
      });
      if (!attachment) {
        return reply.status(404).send({ error: "proxied_site_not_found" });
      }
      return {
        thread_id: attachment.threadId,
        bud_id: attachment.budId,
        proxied_site_id: attachment.proxiedSiteId,
        selected_path: attachment.selectedPath,
        created_at: attachment.createdAt.toISOString(),
        updated_at: attachment.updatedAt.toISOString(),
      };
    } catch (err) {
      if (err instanceof ProxiedSiteValidationError) {
        return reply.status(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  server.delete("/api/threads/:threadId/web-view", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const detached = await detachThreadWebView({
      viewer: access.viewer,
      threadId: params.threadId,
    });
    return { ok: true, detached };
  });

  server.get("/api/threads/:threadId/web-view", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const webView = await getThreadWebViewForThread({
      viewer: access.viewer,
      threadId: params.threadId,
    });
    if (!webView) {
      return { web_view: null };
    }

    const transportStatus = resolveProxyTransportStatus(webView.site.budId);
    const websocketTransportStatus = resolveWebSocketProxyTransportStatus(webView.site.budId);
    return {
      web_view: {
        thread_id: webView.attachment.threadId,
        bud_id: webView.attachment.budId,
        proxied_site_id: webView.attachment.proxiedSiteId,
        selected_path: webView.attachment.selectedPath,
        created_at: webView.attachment.createdAt.toISOString(),
        updated_at: webView.attachment.updatedAt.toISOString(),
        proxied_site: serializeProxiedSite(webView.site, transportStatus, websocketTransportStatus),
      },
    };
  });

  server.post("/api/proxied-sites/:proxiedSiteId/viewer-grants", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const params = ProxiedSiteParamsSchema.parse(request.params);
    const bodyResult = CreateViewerGrantBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.status(400).send({ error: "invalid_viewer_grant_request" });
    }

    const site = await getAuthorizedProxiedSite(viewer, params.proxiedSiteId);
    if (!site) {
      return reply.status(404).send({ error: "proxied_site_not_found" });
    }

    try {
      const grant = await createViewerGrant({
        viewer,
        site,
        path: bodyResult.data.path,
      });
      return {
        bootstrap_url: grant.bootstrapUrl,
        view_url: grant.viewUrl,
        expires_at: grant.expiresAt.toISOString(),
      };
    } catch (err) {
      if (err instanceof ProxiedSiteValidationError) {
        return reply.status(410).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  server.route({
    method: "GET",
    url: "/*",
    async handler(request, reply) {
      return handleProxyGatewayHttpRoute(request, reply);
    },
    async wsHandler(socket: WebSocket, request: FastifyRequest) {
      await handleProxiedSiteGatewayWebSocketRequest({ socket, request });
    },
  });

  server.route({
    method: "HEAD",
    url: "/*",
    async handler(request, reply) {
      return handleProxyGatewayHttpRoute(request, reply);
    },
  });
  server.route({
    method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/*",
    async handler(request, reply) {
      return handleProxyGatewayHttpRoute(request, reply);
    },
  });
}

async function handleProxyGatewayHttpRoute(request: FastifyRequest, reply: FastifyReply) {
  const endpointHost = resolveProxyGatewayHost(request.headers);
  if (!config.proxyGatewayEnabled || !endpointHost) {
    return reply.status(404).send(request.method === "HEAD" ? undefined : { error: "not_found" });
  }

  const url = new URL(request.url, `http://${endpointHost}`);
  if (request.method === "HEAD" && url.pathname === "/__bud/bootstrap") {
    return reply.status(405).send();
  }
  if (url.pathname === "/__bud/bootstrap") {
    const queryResult = BootstrapQuerySchema.safeParse(request.query ?? {});
    if (!queryResult.success) {
      return reply.status(400).send({ error: "invalid_viewer_grant" });
    }
    const consumed = await consumeViewerGrant({
      endpointHost,
      grantToken: queryResult.data.grant,
    });
    if (!consumed.ok) {
      return reply.status(401).send({ error: consumed.code });
    }
    reply.header("Set-Cookie", buildViewerCookie(consumed.sessionToken));
    return reply.redirect(proxiedSiteViewUrl(consumed.site, consumed.redirectPath));
  }

  return handleProxiedSiteGatewayRequest({ endpointHost, request, reply });
}

async function handleProxiedSiteGatewayRequest(args: {
  endpointHost: string;
  request: FastifyRequest;
  reply: FastifyReply;
}) {
  const site = await getProxiedSiteByEndpointHost(args.endpointHost);
  if (!site) {
    return args.reply.status(404).send({ error: "proxied_site_not_found" });
  }
  const state = effectiveProxiedSiteState(site);
  if (state !== "ready") {
    return args.reply.status(state === "expired" ? 410 : 403).send({
      error: state === "expired" ? "proxied_site_expired" : "proxied_site_disabled",
    });
  }
  if (!isProxiedSiteOpenable(site)) {
    return args.reply.status(410).send({ error: "proxied_site_expired" });
  }

  const viewerSession = await resolveViewerSession({
    site,
    sessionToken: readCookie(args.request.headers.cookie, config.proxyViewerCookieName),
  });
  if (!viewerSession) {
    return args.reply.status(401).send({ error: "proxy_viewer_unauthorized" });
  }
  if (viewerSession.refreshed && viewerSession.sessionToken) {
    args.reply.header("Set-Cookie", buildViewerCookie(viewerSession.sessionToken));
  }

  const transportStatus = resolveProxyTransportStatus(site.budId);
  if (!transportStatus.available) {
    return args.reply.status(424).send({
      error: transportStatus.code ?? "PROXY_TRANSPORT_UNAVAILABLE",
      message: transportStatus.message ?? "Proxied site is not currently usable",
      transport: serializeProxyTransportStatus(transportStatus),
    });
  }

  return openProxiedSiteEdgeStream({
    viewer: viewerSession.viewer,
    site,
    transportStatus,
    request: args.request,
    reply: args.reply,
  });
}

async function handleProxiedSiteGatewayWebSocketRequest(args: {
  endpointHost?: string;
  request: FastifyRequest;
  socket: WebSocket;
}) {
  const endpointHost = args.endpointHost ?? resolveProxyGatewayHost(args.request.headers);
  if (!config.proxyGatewayEnabled || !endpointHost) {
    closeSocket(args.socket, 1008, "proxy host not found");
    return;
  }

  const url = new URL(args.request.url, `http://${endpointHost}`);
  if (url.pathname === "/__bud/bootstrap") {
    closeSocket(args.socket, 1008, "bootstrap is not a WebSocket endpoint");
    return;
  }

  const site = await getProxiedSiteByEndpointHost(endpointHost);
  if (!site) {
    closeSocket(args.socket, 1008, "proxied site not found");
    return;
  }
  const state = effectiveProxiedSiteState(site);
  if (state !== "ready" || !isProxiedSiteOpenable(site)) {
    closeSocket(args.socket, 1008, state === "expired" ? "proxied site expired" : "proxied site disabled");
    return;
  }

  const viewerSession = await resolveViewerSession({
    site,
    sessionToken: readCookie(args.request.headers.cookie, config.proxyViewerCookieName),
  });
  if (!viewerSession) {
    closeSocket(args.socket, 1008, "proxy viewer unauthorized");
    return;
  }

  const transportStatus = resolveWebSocketProxyTransportStatus(site.budId);
  if (!transportStatus.available) {
    closeSocket(args.socket, 1013, transportStatus.code ?? "proxy WebSocket unavailable");
    return;
  }

  await openProxiedSiteWebSocketEdge({
    viewer: viewerSession.viewer,
    site,
    transportStatus,
    request: args.request,
    socket: args.socket,
  });
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason.slice(0, 120));
  }
}
