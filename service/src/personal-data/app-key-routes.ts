import type { FastifyInstance, FastifyRequest } from "fastify";
import { getOptionalBearerViewer, getOptionalViewer } from "../auth/session.js";
import { AppKeys } from "./app-keys.js";
import { AppDataQueries } from "./app-queries.js";
import { appKeyDecisionSchema, parseAppKeyInput } from "./app-key-contracts.js";
import { AppKeyMaintenance } from "./app-key-maintenance.js";
import { DataRequestError } from "./contracts.js";
import { readFile } from "node:fs/promises";

type Dependencies = {
  keys?: Pick<AppKeys, "get" | "list" | "decide" | "revoke" | "handoff" | "expireNext">;
  queries?: Pick<AppDataQueries, "execute">;
  authenticate?: (request: FastifyRequest) => Promise<{ userId: string } | null>;
  issuanceEnabled?: boolean;
  startMaintenance?: boolean;
};

/** Human routes use owner SQL; app routes have a separate narrow auth boundary. */
export async function registerAppKeyRoutes(server: FastifyInstance, dependencies: Dependencies = {}) {
  const keys = dependencies.keys ?? new AppKeys();
  const queries = dependencies.queries ?? new AppDataQueries();
  const authenticate = dependencies.authenticate ?? ((request: FastifyRequest) => request.headers.authorization
    ? getOptionalBearerViewer(request) : getOptionalViewer(request));
  const maintenance = dependencies.startMaintenance ? new AppKeyMaintenance(keys,
    () => server.log.warn("App data expiry failed; durable work retained")) : undefined;
  if (maintenance) {
    server.addHook("onReady", async () => { maintenance.start(); });
    server.addHook("preClose", async () => { await maintenance.stop(); });
  }
  await server.register(async app => {
    app.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DataRequestError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
      // Do not pass request bodies, credentials, signatures or database errors to logs.
      request.log.warn({ request_id: request.id, status_code: status }, "App data request failed");
      return reply.code(status).send({ error: status === 413 ? "payload_too_large" : "app_data_unavailable" });
    });
    // Public source code only; the standalone helper has no service secrets or
    // dependencies. The same file is copied unchanged into the deployed build.
    app.get("/api/app-data/backend-helper.mjs", async (_request, reply) => reply
      .type("text/javascript; charset=utf-8")
      .send(await readFile(new URL("./app-key-backend.mjs", import.meta.url), "utf8")));
    await app.register(async human => {
      const viewers = new WeakMap<FastifyRequest, string>();
      human.addHook("onRequest", async (request, reply) => {
        const viewer = await authenticate(request);
        if (!viewer) return reply.code(401).send({ error: "unauthorized" });
        viewers.set(request, viewer.userId);
      });
      human.get<{ Querystring: Record<string, unknown> }>("/api/data/access-requests", async request => {
        const q = request.query;
        if (Object.keys(q).some(key => !["limit", "cursor", "pending_only"].includes(key)) ||
          (q.pending_only !== undefined && q.pending_only !== "true" && q.pending_only !== "false") ||
          (q.cursor !== undefined && typeof q.cursor !== "string"))
          throw new DataRequestError(400, "invalid_app_data_query", "Invalid app data page");
        return keys.list(viewers.get(request)!, { limit: q.limit === undefined ? undefined : Number(q.limit),
          cursor: q.cursor as string | undefined, pending_only: q.pending_only === "true" });
      });
      human.get<{ Params: { id: string } }>("/api/data/access-requests/:id", async request =>
        keys.get(viewers.get(request)!, request.params.id));
      human.post<{ Params: { id: string } }>("/api/data/access-requests/:id/decision", { bodyLimit: 4096 }, async request => {
        const owner = viewers.get(request)!;
        await keys.get(owner, request.params.id);
        const input = parseAppKeyInput(appKeyDecisionSchema, request.body);
        if (input.decision === "approve" && !dependencies.issuanceEnabled)
          throw new DataRequestError(503, "app_data_approval_unavailable", "App data approval is not available yet");
        return keys.decide(owner, request.params.id, input);
      });
      human.post<{ Params: { id: string } }>("/api/data/app-keys/:id/revoke", { bodyLimit: 4096 }, async request =>
        keys.revoke(viewers.get(request)!, request.params.id, request.body));
    });
    await app.register(async backend => {
      // Cookies/OAuth never substitute for this app's own scoped query credential.
      const credentials = new WeakMap<FastifyRequest, string>();
      backend.addHook("onRequest", async (request, reply) => {
        const value = request.headers.authorization;
        if (typeof value !== "string" || !/^Bearer dak_[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{43}$/.test(value))
          return reply.code(403).send({ error: "app_data_key_invalid" });
        credentials.set(request, value.slice(7));
      });
      const query = (request: FastifyRequest) => {
        const value = request.query as Record<string, unknown>;
        return { ...value, ...(value.limit === undefined ? {} : { limit: Number(value.limit) }) };
      };
      backend.get("/api/app-data/contacts", async request => queries.execute(credentials.get(request), "contacts_search", query(request)));
      backend.get<{ Params: { id: string } }>("/api/app-data/contacts/:id", async request =>
        queries.execute(credentials.get(request), "contacts_get", { ...query(request), contact_id: request.params.id }));
      backend.get<{ Params: { id: string } }>("/api/app-data/contacts/:id/history", async request =>
        queries.execute(credentials.get(request), "contacts_history", { ...query(request), contact_id: request.params.id }));
      backend.get("/api/app-data/location", async request => queries.execute(credentials.get(request), "timeline_query", query(request)));
      backend.get<{ Params: { id: string } }>("/api/app-data/contacts/:id/location-context", async request =>
        queries.execute(credentials.get(request), "location_context", { ...query(request), contact_id: request.params.id }));
    });
    // Possession proof only retrieves ciphertext or acknowledges that same key.
    // These endpoints cannot create requests, make human decisions or read data.
    for (const action of ["retrieve", "installed"] as const)
      app.post<{ Params: { id: string } }>(`/api/app-data/setup/:id/${action}`, { bodyLimit: 2048 }, async request =>
        keys.handoff(request.params.id, action, request.body));
  });
  return { stop: async () => { await maintenance?.stop(); } };
}
