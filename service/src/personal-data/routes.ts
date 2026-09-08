import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getOptionalBearerViewer, getOptionalViewer } from "../auth/session.js";
import { DataRequestError, INGEST_LIMITS, validIdentifier, type IngestContext } from "./contracts.js";
import { ContactProcessor } from "./contact-processor.js";
import { ContactQueries } from "./contact-queries.js";
import { LocationQueries, type LocationQuery } from "./location.js";
import { DataGrants } from "./grants.js";
import { Automations } from "./automations.js";
import { AutomationBootstrap } from "./automation-bootstrap.js";
import { automationCreateSchema, automationActivateBootstrapSchema, parseAutomationInput } from "./automation-contracts.js";
import { parseBatch } from "./parser.js";
import { PostgresIngestRepository, type IngestRepository } from "./repository.js";
import { registerAppKeyRoutes } from "./app-key-routes.js";
import { AutomationProposals } from "./automation-proposals.js";
import { registerAutomationProposalRoutes } from "./automation-proposal-routes.js";
import { AutomationProposalMaintenance } from "./automation-proposal-maintenance.js";
import { AutomationBootstrapProposals } from "./automation-bootstrap-proposals.js";
import { registerAutomationBootstrapProposalRoutes } from "./automation-bootstrap-proposal-routes.js";

type Dependencies = {
  repository?: IngestRepository;
  verifyExpandedContactsSchema?: () => Promise<void>;
  queries?: ContactQueries;
  locationQueries?: LocationQueries;
  grants?: DataGrants;
  automations?: Pick<Automations, "list" | "get" | "history" | "create" | "update" | "pause" | "activate" | "delete">;
  automationActivationEnabled?: boolean;
  appKeysEnabled?: boolean;
  automationProposalsEnabled?: boolean;
  bootstrapProposalsEnabled?: boolean;
  bootstrapProposals?: Pick<AutomationBootstrapProposals, "get" | "list" | "decide" | "cancel" | "expireNext">;
  automationProposals?: Pick<AutomationProposals, "get" | "list" | "decide" | "cancel" | "expireNext">;
  bootstrap?: Pick<AutomationBootstrap, "list" | "get" | "page" | "capture" | "activateAndCapture" | "cancel" | "progress" | "preview">;
  processor?: Pick<ContactProcessor, "requeueSupportedLocations" | "processNext" | "publishNext">;
  authenticate?: (request: FastifyRequest) => Promise<{ userId: string } | null>;
};

export async function registerPersonalDataRoutes(server: FastifyInstance, dependencies: Dependencies = {}) {
  const repository = dependencies.repository ?? new PostgresIngestRepository();
  const queries = dependencies.queries ?? new ContactQueries();
  const locationQueries = dependencies.locationQueries ?? new LocationQueries();
  const grants = dependencies.grants ?? new DataGrants();
  const automations = dependencies.automations ?? new Automations();
  const bootstrap = dependencies.bootstrap ?? new AutomationBootstrap();
  let contactsV2Ready = false;
  // Normal composition must verify migration 0035 before workers or HTTP readiness.
  // Injected repositories do not imply compatible capture; fixtures opt in explicitly.
  const verifyExpandedContactsSchema = dependencies.verifyExpandedContactsSchema
    ?? (!dependencies.repository ? () => grants.verifyFieldSchema() : undefined);
  if (verifyExpandedContactsSchema) {
    server.addHook("onReady", async () => {
      await verifyExpandedContactsSchema();
      contactsV2Ready = true;
    });
  }
  let stop = async () => {};
  // Injection tests do not start a background worker against a real database.
  if (!dependencies.repository || dependencies.processor) {
    const processor = dependencies.processor ?? new ContactProcessor();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let active: Promise<void> | undefined;
    const run = async () => {
      try {
        for (let count = 0; count < 100 && !stopped; count++) {
          const recovered = await processor.requeueSupportedLocations();
          const staged = await processor.processNext();
          const published = await processor.publishNext();
          if (!recovered && !staged && !published) break;
        }
      } catch { server.log.warn("Contact processing failed; durable work retained for retry"); }
      finally { if (!stopped) { timer = setTimeout(() => { active = run(); }, 1000); timer.unref(); } }
    };
    server.addHook("onReady", async () => { active = run(); });
    // onClose hooks run in reverse order; the later composition-root hook
    // closes the DB pool. Drain here before any resource finalizers run.
    stop = async () => { stopped = true; clearTimeout(timer); await active; };
    server.addHook("preClose", stop);
  }
  // If a bearer was supplied, it is authoritative; don't accidentally accept a
  // different account's cookie when that upload token is expired or invalid.
  const authenticate = dependencies.authenticate ?? ((request) => request.headers.authorization
    ? getOptionalBearerViewer(request) : getOptionalViewer(request));
  await server.register(async (app) => {
    const viewers = new WeakMap<FastifyRequest, { userId: string }>();
    let activeUploads = 0;
    const owners = new Set<string>();
    const admitted = new WeakSet<FastifyRequest>();
    const release = (request: FastifyRequest) => {
      if (!admitted.delete(request)) return;
      activeUploads--;
      owners.delete(viewers.get(request)!.userId);
    };
    app.addHook("onRequest", async (request, reply) => {
      const viewer = await authenticate(request);
      if (!viewer) return reply.code(401).send({ error: "unauthorized" });
      viewers.set(request, viewer);
      if (request.method === "POST" && request.routeOptions.url === "/v1/events/batches") {
        if (activeUploads >= 4 || owners.has(viewer.userId))
          return reply.code(429).header("Retry-After", "2").send({ error: "upload_busy", retryable: true, retry_after_s: 2 });
        activeUploads++;
        owners.add(viewer.userId);
        admitted.add(request);
      }
    });
    app.addHook("onResponse", async (request) => release(request));
    app.addHook("onRequestAbort", async (request) => release(request));
    app.addHook("onTimeout", async (request) => release(request));
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DataRequestError) {
        if (error.retryAfterSeconds) reply.header("Retry-After", String(error.retryAfterSeconds));
        return reply.code(error.statusCode).send({ error: error.code, message: error.message, retryable: error.retryable, retry_after_s: error.retryAfterSeconds });
      }
      // Do not log Drizzle/PG error objects: their query parameters may contain
      // raw personal-data payloads. The request ID is sufficient for correlation.
      const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
      request.log.warn({ request_id: request.id, status_code: status }, "Personal-data request failed");
      return reply.code(status).send({ error: status === 413 ? "payload_too_large" : "ingestion_failed", retryable: status >= 500 });
    });
    app.get("/api/automations", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const filter = parseAutomationInput(z.object({ bud_id: z.string().min(1).max(128).optional(),
        thread_id: z.string().min(1).max(128).optional(), state: z.enum(["enabled", "paused", "draft"]).optional() }).strict(), request.query);
      return automations.list(viewers.get(request)!.userId, filter);
    });
    app.post("/api/automations", async request => {
      const input = parseAutomationInput(automationCreateSchema, request.body);
      return automations.create(viewers.get(request)!.userId, input.definition, input.idempotency_key);
    });
    app.put<{ Params: { id: string } }>("/api/automations/:id", async request =>
      automations.update(viewers.get(request)!.userId, request.params.id, request.body));
    app.post<{ Params: { id: string } }>("/api/automations/:id/pause", async request =>
      automations.pause(viewers.get(request)!.userId, request.params.id, request.body));
    app.post<{ Params: { id: string } }>("/api/automations/:id/delete", { bodyLimit: 1024 }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return automations.delete(viewers.get(request)!.userId, request.params.id, request.body);
    });
    app.post<{ Params: { id: string } }>("/api/automations/:id/activate", async request => {
      const owner = viewers.get(request)!.userId;
      await automations.get(owner, request.params.id);
      if (!dependencies.automationActivationEnabled)
        throw new DataRequestError(503, "automation_activation_unavailable", "Automation activation is not available yet");
      return automations.activate(owner, request.params.id, request.body);
    });
    app.get<{ Params: { id: string } }>("/api/automations/:id", async request =>
      automations.get(viewers.get(request)!.userId, request.params.id));
    // Bootstrap resources belong to the authenticated account. Repositories
    // filter every lookup by owner and stamp new requests/members with that owner.
    app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>("/api/automations/:id/bootstrap", async request =>
      bootstrap.list(viewers.get(request)!.userId, request.params.id, {
        limit: request.query.limit === undefined ? undefined : Number(request.query.limit), cursor: request.query.cursor,
      }));
    app.post<{ Params: { id: string } }>("/api/automations/:id/bootstrap/preview", async request =>
      bootstrap.preview(viewers.get(request)!.userId, request.params.id, request.body));
    app.post<{ Params: { id: string } }>("/api/automations/:id/bootstrap", async request => {
      const owner = viewers.get(request)!.userId;
      await automations.get(owner, request.params.id);
      if (!dependencies.automationActivationEnabled)
        throw new DataRequestError(503, "automation_activation_unavailable", "Automation activation is not available yet");
      return bootstrap.capture(owner, request.params.id, request.body);
    });
    app.post<{ Params: { id: string } }>("/api/automations/:id/activate-and-bootstrap", async request => {
      const owner = viewers.get(request)!.userId;
      await automations.get(owner, request.params.id);
      if (!dependencies.automationActivationEnabled)
        throw new DataRequestError(503, "automation_activation_unavailable", "Automation activation is not available yet");
      const input = parseAutomationInput(automationActivateBootstrapSchema, request.body);
      return bootstrap.activateAndCapture(owner, request.params.id, input.activation, input.bootstrap);
    });
    app.get<{ Params: { id: string; bootstrapId: string }; Querystring: { limit?: string; after?: string } }>(
      "/api/automations/:id/bootstrap/:bootstrapId/progress", async request =>
        bootstrap.progress(viewers.get(request)!.userId, request.params.id, request.params.bootstrapId, {
          limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
          after: request.query.after === undefined ? undefined : Number(request.query.after),
        }));
    app.post<{ Params: { id: string; bootstrapId: string } }>("/api/automations/:id/bootstrap/:bootstrapId/cancel", async request =>
      bootstrap.cancel(viewers.get(request)!.userId, request.params.id, request.params.bootstrapId));
    app.get<{ Params: { id: string; bootstrapId: string } }>("/api/automations/:id/bootstrap/:bootstrapId", async request =>
      bootstrap.get(viewers.get(request)!.userId, request.params.id, request.params.bootstrapId));
    app.get<{ Params: { id: string; bootstrapId: string }; Querystring: { limit?: string; cursor?: string } }>(
      "/api/automations/:id/bootstrap/:bootstrapId/members", async request =>
        bootstrap.page(viewers.get(request)!.userId, request.params.id, request.params.bootstrapId,
          { limit: request.query.limit === undefined ? undefined : Number(request.query.limit), cursor: request.query.cursor }));
    app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>("/api/automations/:id/deliveries", async request =>
      automations.history(viewers.get(request)!.userId, request.params.id,
        { ...request.query, limit: request.query.limit === undefined ? undefined : Number(request.query.limit) }));
    app.get<{ Querystring: { search?: string; limit?: string; cursor?: string; visibility?: string } }>("/api/data/contacts", async request =>
      queries.list(viewers.get(request)!.userId, { ...request.query, limit: request.query.limit === undefined ? undefined : Number(request.query.limit) }));
    app.get<{ Params: { id: string } }>("/api/data/contacts/:id", async request => queries.get(viewers.get(request)!.userId, request.params.id));
    app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>("/api/data/contacts/:id/history", async request =>
      queries.history(viewers.get(request)!.userId, request.params.id, { ...request.query, limit: request.query.limit === undefined ? undefined : Number(request.query.limit) }));
    app.get<{ Querystring: Omit<LocationQuery, "limit"> & { limit?: string } }>("/api/data/location", async request =>
      locationQueries.list(viewers.get(request)!.userId, { ...request.query, limit: request.query.limit === undefined ? undefined : Number(request.query.limit) }));
    app.get<{ Params: { id: string }; Querystring: Pick<LocationQuery, "from" | "to"> }>("/api/data/contacts/:id/location-context", async request =>
      locationQueries.contactContext(viewers.get(request)!.userId, request.params.id, request.query));
    app.get("/api/data/agent-grant", async request => grants.get(viewers.get(request)!.userId));
    app.put("/api/data/agent-grant", async request => grants.update(viewers.get(request)!.userId, request.body));
    app.get("/api/data/status", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return {
      ingest: { envelope_versions: [1], unknown_envelopes_stored: true, limits: INGEST_LIMITS, collection_epochs: true },
      features: { contacts: true, contacts_payload_v2: contactsV2Ready, contact_source_repair: true, location_queries: true, health_queries: false, automations: dependencies.automationActivationEnabled ?? false,
        automation_activation: dependencies.automationActivationEnabled ?? false, app_keys: dependencies.appKeysEnabled ?? false,
        automation_proposals: Boolean(dependencies.automationActivationEnabled && dependencies.automationProposalsEnabled),
        existing_contact_reviews: Boolean(dependencies.automationActivationEnabled && dependencies.automationProposalsEnabled && dependencies.bootstrapProposalsEnabled) },
      ...await repository.status(viewers.get(request)!.userId) as object,
      };
    });
    // A child parser prevents the main server's JSON/proxy parsers from consuming
    // or interpreting upload data. All bodies are byte-bounded by Fastify first.
    await app.register(async (uploads) => {
      uploads.removeAllContentTypeParsers();
      uploads.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: INGEST_LIMITS.compressed_bytes }, (_request, body, done) => done(null, body));
      const handler = async (request: FastifyRequest, reply: FastifyReply) => {
        const installationId = request.headers["x-installation-id"];
        const batchId = request.headers["x-batch-id"];
        const collectionEpoch = request.headers["x-collection-epoch"] ?? "legacy";
        if (!validIdentifier(installationId) || !validIdentifier(batchId) || !validIdentifier(collectionEpoch))
          throw new DataRequestError(400, "invalid_headers", "Valid installation, batch and collection epoch identifiers are required");
        const context: IngestContext = { userId: viewers.get(request)!.userId, installationId, batchId, collectionEpoch };
        if (!Buffer.isBuffer(request.body)) throw new DataRequestError(400, "invalid_body", "NDJSON body is required");
        const batch = await parseBatch(request.body, String(request.headers["content-encoding"] ?? "").toLowerCase(), context);
        const result = await repository.persist(context, batch);
        return reply.code(200).send({ request_id: request.id, batch_id: batchId, server_time: new Date().toISOString(), ...result, rejected_count: result.rejected.length, retry_after_s: 0 });
      };
      uploads.post("/v1/events/batches", { bodyLimit: INGEST_LIMITS.compressed_bytes }, handler);
    });
  });
  const appKeys = await registerAppKeyRoutes(server, {
    authenticate, startMaintenance: !dependencies.repository, issuanceEnabled: dependencies.appKeysEnabled,
  });
  const proposals = dependencies.automationProposals ?? new AutomationProposals();
  await registerAutomationProposalRoutes(server, { authenticate, proposals,
    approvalEnabled: Boolean(dependencies.automationActivationEnabled && dependencies.automationProposalsEnabled) });
  const proposalMaintenance = !dependencies.repository ? new AutomationProposalMaintenance(proposals,
    () => server.log.warn("Automation review expiry failed; durable work retained")) : undefined;
  if (proposalMaintenance) {
    server.addHook("onReady", async () => { proposalMaintenance.start(); });
    server.addHook("preClose", async () => { await proposalMaintenance.stop(); });
  }
  const bootstrapProposals = dependencies.bootstrapProposals ?? new AutomationBootstrapProposals();
  await registerAutomationBootstrapProposalRoutes(server, { authenticate, proposals: bootstrapProposals,
    approvalEnabled: Boolean(dependencies.automationActivationEnabled && dependencies.automationProposalsEnabled && dependencies.bootstrapProposalsEnabled) });
  const bootstrapMaintenance = !dependencies.repository ? new AutomationProposalMaintenance(bootstrapProposals,
    () => server.log.warn("Existing-contact review expiry failed; durable work retained")) : undefined;
  if (bootstrapMaintenance) {
    server.addHook("onReady", async () => { bootstrapMaintenance.start(); });
    server.addHook("preClose", async () => { await bootstrapMaintenance.stop(); });
  }
  return { stop: async () => { await Promise.all([stop(), appKeys.stop(), proposalMaintenance?.stop(), bootstrapMaintenance?.stop()]); } };
}
