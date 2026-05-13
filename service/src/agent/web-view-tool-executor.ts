import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { threadTable } from "../db/schema.js";
import type { Viewer } from "../auth/session.js";
import {
  DEFAULT_PROXIED_SITE_TARGET_HOST,
  ProxiedSiteValidationError,
  attachThreadWebView,
  createOrReuseProxiedSite,
  detachThreadWebView,
  disableAuthorizedProxiedSite,
  getAuthorizedProxiedSite,
  getThreadWebViewForThread,
  listAuthorizedProxiedSitesForBud,
  normalizeProxiedSitePath,
  proxiedSiteViewUrl,
  serializeProxiedSite,
  type ProxiedSiteRow,
  type ThreadWebViewRow,
} from "../proxy/proxied-site.js";
import {
  resolveProxyTransportStatus,
  serializeProxyTransportStatus,
} from "../proxy/proxy-session.js";
import {
  buildToolArgs,
  type ExecutedWebViewTool,
  type WebViewCallResult,
  type WebViewToolCallDirective,
} from "./contracts.js";

export class WebViewToolExecutor {
  private readonly logger: FastifyBaseLogger;
  private readonly debugEnabled: boolean;

  constructor(logger: FastifyBaseLogger, debugEnabled: boolean) {
    this.logger = logger;
    this.debugEnabled = debugEnabled;
  }

  async execute(
    threadId: string,
    directive: WebViewToolCallDirective,
    ownerUserId?: string | null,
  ): Promise<ExecutedWebViewTool> {
    const args = buildToolArgs(directive);
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, threadId),
    });
    if (!thread) {
      return this.buildExecution(
        directive,
        args,
        {
          kind: "web_view",
          action: actionForDirective(directive),
          error: "thread_not_found",
        },
        "Thread was not found",
      );
    }

    const userId = ownerUserId ?? thread.createdByUserId;
    if (!userId) {
      return this.buildExecution(
        directive,
        args,
        {
          kind: "web_view",
          action: actionForDirective(directive),
          error: "thread_owner_required",
        },
        "Thread owner is required before web views can be changed",
      );
    }

    const viewer = {
      userId,
      sessionId: null,
      email: null,
      authType: "cookie",
    } satisfies Viewer;

    try {
      switch (directive.tool) {
        case "web_view.open":
          return await this.openWebView({ directive, args, thread, viewer });
        case "web_view.close":
          return await this.closeWebView({ directive, args, threadId, viewer });
        case "web_view.list":
          return await this.listWebViews({ directive, args, thread, viewer });
      }
    } catch (err) {
      if (err instanceof ProxiedSiteValidationError) {
        return this.buildExecution(
          directive,
          args,
          {
            kind: "web_view",
            action: actionForDirective(directive),
            error: err.code,
          },
          err.message,
        );
      }
      throw err;
    }
  }

  private async openWebView(args: {
    directive: Extract<WebViewToolCallDirective, { tool: "web_view.open" }>;
    args: Record<string, unknown>;
    thread: typeof threadTable.$inferSelect;
    viewer: Viewer;
  }): Promise<ExecutedWebViewTool> {
    const targetPort = args.directive.targetPort;
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return this.buildExecution(
        args.directive,
        args.args,
        {
          kind: "web_view",
          action: "open",
          error: "invalid_proxy_port",
        },
        "Web view target port must be between 1 and 65535",
      );
    }

    const path = normalizeProxiedSitePath(args.directive.path);
    const result = await createOrReuseProxiedSite({
      viewer: args.viewer,
      budId: args.thread.budId,
      body: {
        target_host: args.directive.targetHost ?? DEFAULT_PROXIED_SITE_TARGET_HOST,
        target_port: targetPort,
        path,
        title: args.directive.title,
        reuse_existing: true,
        source: "agent",
        access_policy: "private_owner",
        display_metadata: {},
      },
    });
    const attachment = await attachThreadWebView({
      viewer: args.viewer,
      thread: args.thread,
      proxiedSiteId: result.site.proxiedSiteId,
      selectedPath: path,
    });
    if (!attachment) {
      return this.buildExecution(
        args.directive,
        args.args,
        {
          kind: "web_view",
          action: "open",
          proxiedSite: serializeProxiedSite(result.site, result.transportStatus),
          transport: serializeProxyTransportStatus(result.transportStatus),
          error: "web_view_attach_failed",
        },
        "Created proxied site, but failed to attach it to the thread",
      );
    }

    const serializedSite = serializeProxiedSite(result.site, result.transportStatus);
    const summary = `${result.reused ? "Reused" : "Opened"} web view for ${result.site.targetHost}:${result.site.targetPort}${path}`;
    this.debug(summary, {
      threadId: args.thread.threadId,
      proxiedSiteId: result.site.proxiedSiteId,
      endpointHost: result.site.endpointHost,
    });

    return this.buildExecution(
      args.directive,
      args.args,
      {
        kind: "web_view",
        action: "open",
        proxiedSite: serializedSite,
        webView: serializeThreadWebView(attachment, result.site),
        transport: serializeProxyTransportStatus(result.transportStatus),
      },
      summary,
    );
  }

  private async closeWebView(args: {
    directive: Extract<WebViewToolCallDirective, { tool: "web_view.close" }>;
    args: Record<string, unknown>;
    threadId: string;
    viewer: Viewer;
  }): Promise<ExecutedWebViewTool> {
    const current = await getThreadWebViewForThread({
      viewer: args.viewer,
      threadId: args.threadId,
    });
    const targetProxiedSiteId = args.directive.proxiedSiteId ?? current?.site.proxiedSiteId ?? null;
    let detached = false;
    if (!args.directive.proxiedSiteId || current?.site.proxiedSiteId === args.directive.proxiedSiteId) {
      detached = await detachThreadWebView({
        viewer: args.viewer,
        threadId: args.threadId,
      });
    }

    let disabledSite: ProxiedSiteRow | null = null;
    if (args.directive.disable === true && targetProxiedSiteId) {
      disabledSite = await disableAuthorizedProxiedSite({
        viewer: args.viewer,
        proxiedSiteId: targetProxiedSiteId,
        reason: "agent_requested",
      });
    }

    const site = disabledSite ?? current?.site ?? (
      targetProxiedSiteId ? await getAuthorizedProxiedSite(args.viewer, targetProxiedSiteId) : null
    );
    const transportStatus = site ? resolveProxyTransportStatus(site.budId) : null;
    const result: WebViewCallResult = {
      kind: "web_view",
      action: "close",
      detached,
      disabled: Boolean(disabledSite),
      proxiedSite: site && transportStatus ? serializeProxiedSite(site, transportStatus) : null,
      transport: transportStatus ? serializeProxyTransportStatus(transportStatus) : null,
      ...(!targetProxiedSiteId
        ? { error: "web_view_not_attached" }
        : !site
          ? { error: "proxied_site_not_found" }
          : {}),
    };
    const summary = targetProxiedSiteId
      ? `${detached ? "Detached" : "No matching thread attachment for"} web view${disabledSite ? " and disabled proxied site" : ""}`
      : "No web view is attached to this thread";

    return this.buildExecution(args.directive, args.args, result, summary);
  }

  private async listWebViews(args: {
    directive: Extract<WebViewToolCallDirective, { tool: "web_view.list" }>;
    args: Record<string, unknown>;
    thread: typeof threadTable.$inferSelect;
    viewer: Viewer;
  }): Promise<ExecutedWebViewTool> {
    const transportStatus = resolveProxyTransportStatus(args.thread.budId);
    const sites = await listAuthorizedProxiedSitesForBud({
      viewer: args.viewer,
      budId: args.thread.budId,
    });
    const current = await getThreadWebViewForThread({
      viewer: args.viewer,
      threadId: args.thread.threadId,
    });

    return this.buildExecution(
      args.directive,
      args.args,
      {
        kind: "web_view",
        action: "list",
        proxiedSites: sites.map((site) => serializeProxiedSite(site, transportStatus)),
        webView: current ? serializeThreadWebView(current.attachment, current.site) : null,
        transport: serializeProxyTransportStatus(transportStatus),
      },
      `Listed ${sites.length} web view${sites.length === 1 ? "" : "s"}`,
    );
  }

  private buildExecution(
    directive: WebViewToolCallDirective,
    args: Record<string, unknown>,
    result: WebViewCallResult,
    summary: string,
  ): ExecutedWebViewTool {
    return {
      directive,
      args,
      summary,
      outputTruncationReason: null,
      result,
      payload: {
        tool: directive.tool,
        call_id: directive.callId,
        ...args,
        summary,
        kind: result.kind,
        action: result.action,
        proxied_site: result.proxiedSite,
        proxied_sites: result.proxiedSites,
        web_view: result.webView,
        transport: result.transport,
        detached: result.detached,
        disabled: result.disabled,
        error: result.error,
      },
    };
  }

  private debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }
    this.logger.info({ ...meta, component: "agent_web_view" }, message);
  }
}

function actionForDirective(directive: WebViewToolCallDirective): WebViewCallResult["action"] {
  switch (directive.tool) {
    case "web_view.open":
      return "open";
    case "web_view.close":
      return "close";
    case "web_view.list":
      return "list";
  }
}

function serializeThreadWebView(
  attachment: ThreadWebViewRow,
  site: ProxiedSiteRow,
): Record<string, unknown> {
  return {
    thread_id: attachment.threadId,
    bud_id: attachment.budId,
    proxied_site_id: attachment.proxiedSiteId,
    selected_path: attachment.selectedPath,
    view_url: proxiedSiteViewUrl(site, attachment.selectedPath ?? site.defaultPath),
    created_at: attachment.createdAt.toISOString(),
    updated_at: attachment.updatedAt.toISOString(),
  };
}
