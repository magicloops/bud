import { retrievalAvailable } from "./web-retrieval/config.js";
import { RetrievalRepository } from "./web-retrieval/repository.js";
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import websocketPlugin from "@fastify/websocket";
import fastifySseV2 from "fastify-sse-v2";
import { authPool, registerAuthRoutes } from "./auth/auth.js";
import { registerBudRoutes } from "./routes/buds.js";
import { pool } from "./db/client.js";
import { config } from "./config.js";
import { registerWsGateway } from "./ws/gateway.js";
import { TerminalEventBus } from "./runtime/event-bus.js";
import { registerThreadRoutes, registerThreadTerminalRoutes } from "./routes/threads.js";
import { registerModelsRoutes } from "./routes/models.js";
import { AgentService, ThreadTitleService } from "./agent/index.js";
import { repairDanglingToolCalls } from "./agent/restart-repair.js";
import { InvocationRepository } from "./agent/invocation-repository.js";
import { InvocationWorker } from "./agent/invocation-worker.js";
import { ServiceInvocationExecutor } from "./agent/invocation-executor.js";
import { acquireInvocationMode, readInvocationSettings, verifyAutomationProposalSchema, verifyBootstrapProposalSchema } from "./invocation-startup.js";
import { initializeProviders } from "./llm/index.js";
import { TerminalSessionManager } from "./runtime/terminal-session-manager.js";
import { registerDeviceAuthRoutes } from "./routes/device-auth.js";
import { registerDeviceInstallClaimRoutes } from "./routes/device-install-claims.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerProxyRoutes } from "./routes/proxy.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerProxiedSiteRoutes } from "./routes/proxied-sites.js";
import { isProxyGatewayRequest, type ProxyGatewayRequestHeaders } from "./proxy/proxied-site.js";
import { AgentRuntimeStateManager } from "./runtime/agent-runtime-state.js";
import { PushNotificationWorker } from "./notifications/index.js";
import { startGrpcControlGateway } from "./grpc/control-gateway.js";
import { startGrpcDataGateway } from "./grpc/data-gateway.js";

import { AutomationWorker } from "./personal-data/automation-worker.js";
import { registerPersonalDataRoutes } from "./personal-data/routes.js";

const SERVICE_VERSION = "0.0.1";
const CORS_METHODS = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const DEFAULT_CORS_HEADERS = "Authorization, Content-Type, Last-Event-ID";
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
const WEBSOCKET_SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function applyCorsHeaders(request: FastifyRequest, reply: FastifyReply): boolean {
  const origin = request.headers.origin;
  if (!origin || !config.betterAuthTrustedOrigins.includes(origin)) {
    return false;
  }

  const requestedHeaders = request.headers["access-control-request-headers"];
  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Access-Control-Allow-Credentials", "true");
  reply.header("Access-Control-Allow-Methods", CORS_METHODS);
  reply.header(
    "Access-Control-Allow-Headers",
    typeof requestedHeaders === "string" && requestedHeaders.trim().length > 0
      ? requestedHeaders
      : DEFAULT_CORS_HEADERS,
  );
  reply.header("Vary", "Origin, Access-Control-Request-Headers");
  return true;
}

function selectProxyWebSocketSubprotocol(
  protocols: Set<string>,
  request: { headers?: ProxyGatewayRequestHeaders },
): string | false {
  if (!request.headers || !isProxyGatewayRequest(request.headers)) {
    return protocols.values().next().value ?? false;
  }
  for (const protocol of protocols) {
    const value = protocol.trim();
    if (value.length > 0 && value.length <= 128 && WEBSOCKET_SUBPROTOCOL_TOKEN.test(value)) {
      return value;
    }
  }
  return false;
}

export async function buildServer(): Promise<FastifyInstance> {
  const invocationSettings = readInvocationSettings();
  const server = Fastify({
    bodyLimit: config.proxySessionMaxRequestBodyBytes,
    logger: {
      level: config.logLevel,
      transport:
        process.env.NODE_ENV !== "production"
          ? {
              target: "pino-pretty",
              options: {
                colorize: true,
                singleLine: false
              }
            }
          : undefined
    }
  });

  // OAuth token and revoke requests arrive as form-encoded bodies.
  server.addContentTypeParser(
    /^application\/x-www-form-urlencoded(?:;.*)?$/i,
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );
  server.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  server.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const isPreflight =
      request.method === "OPTIONS" &&
      (typeof origin === "string" || typeof request.headers["access-control-request-method"] === "string");

    const corsAllowed = applyCorsHeaders(request, reply);
    if (!isPreflight) {
      return;
    }

    if (typeof origin === "string" && !corsAllowed) {
      reply.code(403).send({
        error: "CORS_ORIGIN_DENIED",
        message: `Origin ${origin} is not allowed`,
      });
      return;
    }

    reply.code(204).send();
  });

  const terminalEvents = new TerminalEventBus();
  const agentRuntime = new AgentRuntimeStateManager();
  const terminalSessionLogger = server.log.child({ component: "terminal_session_manager" });
  const terminalSessionManager = new TerminalSessionManager(terminalSessionLogger, terminalEvents);
  terminalSessionManager.startIdleChecks();

  // Initialize LLM providers
  initializeProviders();

  const agentLogger = server.log.child({ component: "agent" });
  const invocations = invocationSettings.mode === "durable"
    ? new InvocationRepository(undefined, invocationSettings.automationConcurrencyPerBud)
    : undefined;
  const agentService = new AgentService(
    terminalSessionManager,
    agentRuntime,
    agentLogger,
    config.agentDebug,
    config.agentOpenaiDebug,
    invocations,
    invocationSettings.appKeysEnabled,
    invocationSettings.automationProposalsEnabled,
    invocationSettings.bootstrapProposalsEnabled,
  );
  const invocationWorker = invocations ? new InvocationWorker(
    new ServiceInvocationExecutor(agentService, undefined, undefined, undefined,
      threadId => terminalSessionManager.rejectPendingRequestsForThread(threadId, "invocation_interrupted")), invocations,
    code => server.log.error({ code, component: "invocation_worker" }, "Invocation worker error"),
  ) : undefined;
  const automationWorker = invocationSettings.automationsEnabled ? new AutomationWorker(undefined,
    code => server.log.error({ code, component: "automation_worker" }, "Automation worker error")) : undefined;
  let retrievalCleanupTimer: NodeJS.Timeout | undefined;
  let retrievalCleanup: Promise<void> | undefined;
  const cleanRetrieval = () => {
    if (retrievalCleanup) return;
    retrievalCleanup = new RetrievalRepository().cleanup()
      .catch(() => server.log.warn({ component: "web_retrieval", code: "cleanup_failed" }, "Web retrieval cleanup failed"))
      .finally(() => { retrievalCleanup = undefined; });
  };
  let releaseInvocationMode: (() => Promise<void>) | undefined;
  server.addHook("onReady", async () => {
    releaseInvocationMode = await acquireInvocationMode(pool, invocationSettings.mode, () => {
      server.log.error("Invocation mode database session lost; stopping service");
      void server.close().catch(err => server.log.error({ err }, "Service shutdown failed"));
    });
    if (invocationSettings.appKeysEnabled) {
      await pool.query("select id, invocation_id, status, version from data_access_request limit 0");
      await pool.query("select id, verification_hash, encrypted_envelope from data_app_key limit 0");
    }
    if (invocations) {
      // Recovery reads these tables regardless of new-proposal issuance flags.
      await verifyAutomationProposalSchema(pool);
      await verifyBootstrapProposalSchema(pool);
    }
    if (automationWorker) {
      // Fail readiness before publishing capability if required schema is absent.
      await pool.query("select bootstrap_id, group_index from automation_bootstrap_group limit 0");
      automationWorker.start();
    }
    if (retrievalAvailable()) {
      await pool.query("select id, status from web_retrieval_request limit 0");
      await pool.query("select id, payload, expires_at from web_retrieval_artifact limit 0");
      cleanRetrieval();
      retrievalCleanupTimer = setInterval(cleanRetrieval, 60000);
      retrievalCleanupTimer.unref();
    }
    invocationWorker?.start();
    server.log.info({ admission_mode: invocationSettings.mode,
      automation_concurrency_per_bud: invocationSettings.automationConcurrencyPerBud,
      automations_enabled: invocationSettings.automationsEnabled,
      automation_proposals_enabled: invocationSettings.automationProposalsEnabled,
      existing_contact_reviews_enabled: invocationSettings.bootstrapProposalsEnabled,
      app_data_keys_enabled: invocationSettings.appKeysEnabled }, "Agent admission ready");
  });
  const threadTitleService = new ThreadTitleService(
    agentRuntime,
    server.log.child({ component: "thread_title" }),
  );
  const pushNotificationWorker = new PushNotificationWorker(
    server.log.child({ component: "push_worker" }),
  );
  pushNotificationWorker.start();

  // Register finalizers before plugin boot. Late onClose registration can run
  // before Fastify's internal preClose runner after an awaited register().
  let grpcControlGateway: Awaited<ReturnType<typeof startGrpcControlGateway>>;
  let grpcDataGateway: Awaited<ReturnType<typeof startGrpcDataGateway>>;
  let stopPersonalData = async () => {};
  server.addHook("preClose", async () => {
    await automationWorker?.stop();
    await invocationWorker?.stop();
  });
  server.addHook("onClose", async () => {
    await automationWorker?.stop();
    await invocationWorker?.stop();
    clearInterval(retrievalCleanupTimer);
    await retrievalCleanup;
    await stopPersonalData();
    await grpcDataGateway?.close();
    await grpcControlGateway?.close();
    pushNotificationWorker.stop();
    terminalSessionManager.stopIdleChecks();
    await releaseInvocationMode?.();
    await authPool.end();
    await pool.end();
  });

  await server.register(websocketPlugin, {
    options: {
      handleProtocols: selectProxyWebSocketSubprotocol,
      perMessageDeflate: {
        threshold: 1024,
        serverNoContextTakeover: true,
        clientNoContextTakeover: true
      }
    }
  });
  await server.register(fastifySseV2);
  await registerAuthRoutes(server);
  await registerDeviceInstallClaimRoutes(server);
  await registerDeviceAuthRoutes(server);
  await registerMeRoutes(server);
  ({ stop: stopPersonalData } = await registerPersonalDataRoutes(server, {
    automationActivationEnabled: invocationSettings.automationsEnabled,
    appKeysEnabled: invocationSettings.appKeysEnabled,
    automationProposalsEnabled: invocationSettings.automationProposalsEnabled,
    bootstrapProposalsEnabled: invocationSettings.bootstrapProposalsEnabled,
  }));
  await registerBudRoutes(server, terminalSessionManager);
  await registerProxyRoutes(server);
  await registerFileRoutes(server);
  await registerProxiedSiteRoutes(server);
  await registerThreadRoutes(
    server,
    agentService,
    agentRuntime,
    threadTitleService,
    terminalSessionManager,
  );
  await registerThreadTerminalRoutes(server, terminalSessionManager, terminalEvents);
  await registerModelsRoutes(server);
  await registerWsGateway(server, terminalSessionManager);
  grpcControlGateway = await startGrpcControlGateway(
    terminalSessionManager,
    server.log.child({ component: "grpc_control_gateway" }),
  );
  grpcDataGateway = await startGrpcDataGateway(
    terminalSessionManager,
    server.log.child({ component: "grpc_data_gateway" }),
  );


  server.get("/healthz", async () => ({
    ok: true,
    version: SERVICE_VERSION,
    time: new Date().toISOString()
  }));

  server.get("/readyz", async (_request, reply) => {
    const checks: Record<string, "ok" | "error"> = {
      database: "ok",
      auth_schema: "ok",
    };

    try {
      await pool.query("select 1 from bud limit 1");
    } catch (err) {
      checks.database = "error";
      server.log.error({ err, component: "readyz", check: "database" }, "Readiness check failed");
    }

    try {
      await authPool.query('select 1 from "user" limit 1');
    } catch (err) {
      checks.auth_schema = "error";
      server.log.error({ err, component: "readyz", check: "auth_schema" }, "Readiness check failed");
    }

    const ok = Object.values(checks).every((status) => status === "ok");
    reply.code(ok ? 200 : 503).send({
      ok,
      version: SERVICE_VERSION,
      time: new Date().toISOString(),
      checks,
    });
  });

  return server;
}

async function start() {
  const server = await buildServer();
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.log.info({ signal }, "service shutdown requested");
    try {
      await server.close();
      server.log.info({ signal }, "service shutdown complete");
    } catch (err) {
      server.log.error({ err, signal }, "service shutdown failed");
      process.exitCode = 1;
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  // A prior process may have died mid-tool (deploy/crash — most visibly
  // mid-terminal.wait). Close those holes durably before accepting traffic;
  // failures must never block boot (replay-time repair remains the net).
  try {
    const repairResult = await repairDanglingToolCalls(
      server.log.child({ component: "restart_repair" }),
    );
    if (repairResult.found > 0) {
      server.log.info(repairResult, "Dangling tool call repair completed");
    }
  } catch (err) {
    server.log.error({ err }, "Dangling tool call repair failed (continuing boot)");
  }

  try {
    await server.listen({ port: config.port, host: config.host });
    server.log.info({ port: config.port }, "service listening");
  } catch (err) {
    server.log.error({ err }, "Failed to start service");
    await server.close();
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
