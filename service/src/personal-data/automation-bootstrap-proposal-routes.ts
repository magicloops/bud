import type { FastifyInstance, FastifyRequest } from "fastify";
import { getOptionalBearerViewer, getOptionalViewer } from "../auth/session.js";
import { AutomationBootstrapProposals } from "./automation-bootstrap-proposals.js";
import { automationProposalDecisionSchema, parseAutomationProposalInput } from "./automation-proposal-contracts.js";
import { DataRequestError } from "./contracts.js";

type Dependencies = {
  proposals?: Pick<AutomationBootstrapProposals, "get" | "list" | "decide" | "cancel">;
  authenticate?: (request: FastifyRequest) => Promise<{ userId: string } | null>;
  approvalEnabled?: boolean;
};

/** Human-only owner boundary. An app query key is never a human credential. */
export async function registerAutomationBootstrapProposalRoutes(server: FastifyInstance, dependencies: Dependencies = {}) {
  const proposals = dependencies.proposals ?? new AutomationBootstrapProposals();
  const authenticate = dependencies.authenticate ?? ((request: FastifyRequest) => request.headers.authorization
    ? getOptionalBearerViewer(request) : getOptionalViewer(request));
  await server.register(async app => {
    const owners = new WeakMap<FastifyRequest, string>();
    app.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const viewer = await authenticate(request);
      if (!viewer) return reply.code(401).send({ error: "unauthorized" });
      owners.set(request, viewer.userId);
    });
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DataRequestError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
      request.log.warn({ request_id: request.id, status_code: status }, "Existing-contact review request failed");
      return reply.code(status).send({ error: status === 413 ? "payload_too_large" : "bootstrap_proposal_unavailable" });
    });
    app.get<{ Querystring: Record<string, unknown> }>("/api/automations/existing-contact-proposals", async request => {
      const q = request.query;
      if (Object.keys(q).some(key => !["limit", "cursor", "pending_only"].includes(key)) ||
        (q.pending_only !== undefined && q.pending_only !== "true" && q.pending_only !== "false") ||
        (q.cursor !== undefined && typeof q.cursor !== "string"))
        throw new DataRequestError(400, "invalid_bootstrap_proposal_query", "Invalid proposal page");
      return proposals.list(owners.get(request)!, { limit: q.limit === undefined ? undefined : Number(q.limit),
        cursor: q.cursor as string | undefined, pending_only: q.pending_only === "true" });
    });
    app.get<{ Params: { id: string } }>("/api/automations/existing-contact-proposals/:id", async request =>
      proposals.get(owners.get(request)!, request.params.id));
    app.post<{ Params: { id: string } }>("/api/automations/existing-contact-proposals/:id/decision", { bodyLimit: 4096 }, async request => {
      const owner = owners.get(request)!;
      await proposals.get(owner, request.params.id);
      const input = parseAutomationProposalInput(automationProposalDecisionSchema, request.body);
      if (input.decision === "approve" && !dependencies.approvalEnabled)
        throw new DataRequestError(503, "bootstrap_proposal_approval_unavailable", "Existing-contact review approval is not available yet");
      return proposals.decide(owner, request.params.id, input);
    });
    app.post<{ Params: { id: string } }>("/api/automations/existing-contact-proposals/:id/cancel", { bodyLimit: 4096 }, async request =>
      proposals.cancel(owners.get(request)!, request.params.id, request.body));
  });
}
