import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { budTable, threadTable } from "../db/schema.js";
import { AccessLog, GEOAPIFY, countRecords, queryWindow, type AccessActor } from "../personal-data/access-log.js";
import { AgentDataQueries, scopesOfTool } from "../personal-data/agent-queries.js";
import { sourcesOfScopes } from "../personal-data/sources.js";
import { DataRequestError } from "../personal-data/contracts.js";
import { loadAutomationDataCeiling } from "../personal-data/automation-policy.js";
import type { ExecutedPersonalDataTool, PersonalDataToolCallDirective } from "./contracts.js";

async function ownsThread(threadId: string, owner: string): Promise<boolean> {
  const [row] = await db.select({ id: threadTable.threadId }).from(threadTable)
    .innerJoin(budTable, eq(threadTable.budId, budTable.budId))
    .where(and(eq(threadTable.threadId, threadId), eq(threadTable.createdByUserId, owner),
      eq(budTable.createdByUserId, owner), isNull(threadTable.deletedAt))).limit(1);
  return Boolean(row);
}

export class PersonalDataToolExecutor {
  constructor(private readonly queries: Pick<AgentDataQueries, "execute"> = new AgentDataQueries(),
    private readonly authorize: typeof ownsThread = ownsThread,
    private readonly ceiling = loadAutomationDataCeiling,
    private readonly log: Pick<AccessLog, "record" | "recordQuietly"> = new AccessLog()) {}

  async execute(threadId: string, directive: PersonalDataToolCallDirective, owner?: string | null, signal?: AbortSignal, turnId?: string): Promise<ExecutedPersonalDataTool> {
    let response: Record<string, unknown>;
    let summary: string;
    let errorCode: string | undefined;
    let retryable = false;
    // The access log (bud-mobile `plan/data-sources-ux`, Phase 3): every call for an owned thread
    // is recorded, refused or not, against the conversation or the automation it ran for.
    let actor: AccessActor | undefined;
    const entry = () => ({ owner: owner!, actor: actor!, sources: sourcesOfScopes(scopesOfTool(directive.tool)),
      operation: directive.tool, window: queryWindow(directive.args) });
    try {
      signal?.throwIfAborted();
      if (!owner || !await this.authorize(threadId, owner)) throw new DataRequestError(404, "not_found", "Owned thread not found");
      actor = { kind: "agent", ref: threadId, threadId, turnId };
      const ceiling = await this.ceiling(threadId, owner, turnId);
      if (ceiling?.automationId) actor = { kind: "automation", ref: ceiling.automationId, threadId, turnId };
      response = await this.queries.execute(owner, directive.tool, directive.args, ceiling);
      const current = await this.ceiling(threadId, owner, turnId);
      if (current?.binding !== ceiling?.binding) throw new DataRequestError(409, "automation_changed", "Automation execution changed during the query");
      if (!await this.authorize(threadId, owner)) throw new DataRequestError(404, "not_found", "Owned thread not found");
      signal?.throwIfAborted();
      // Written before the result is handed over: a read that can't be logged isn't delivered.
      const permission = (response as { permission?: { version?: number } }).permission;
      await this.log.record({ ...entry(), recordCount: countRecords((response as { data?: unknown }).data), policyVersion: permission?.version });
      // These two send a location (or a place the owner asked about) to Geoapify.
      if (directive.tool === "places_nearby" || directive.tool === "place_details")
        await this.log.recordQuietly({ owner, actor: { kind: "processor", ref: GEOAPIFY, threadId, turnId }, sources: ["location"],
          operation: directive.tool === "places_nearby" ? "nearby_search" : "place_details", recordCount: 1 });
      summary = "Queried approved personal data";
    } catch (error) {
      if (signal?.aborted) throw error;
      if (actor) await this.log.recordQuietly({ ...entry(), outcome: error instanceof DataRequestError ? error.code : "failed" });
      errorCode = error instanceof DataRequestError ? error.code : "data_query_failed";
      retryable = error instanceof DataRequestError ? error.retryable || error.statusCode === 409 : true;
      summary = error instanceof DataRequestError ? error.message : "Personal data is temporarily unavailable";
      // `reason` says who can fix it (bud-mobile `plan/data-sources-ux`): the user, never the agent.
      response = { error: errorCode, message: summary, retryable,
        ...(errorCode === "data_permission_required" ? { reason: "agent_not_allowed", permission_settings_path: "/data", approval_required: true } : {}),
        ...(errorCode === "source_off" ? { reason: "source_off", ...(error as DataRequestError).details, permission_settings_path: "/data" } : {}) };
    }
    return { directive, args: directive.args, summary, outputTruncationReason: null,
      result: { kind: "personal_data", ok: !errorCode, error: errorCode, retryable },
      payload: { tool: directive.tool, call_id: directive.callId, args: directive.args, kind: "personal_data",
        ok: !errorCode, summary, ...response } };
  }
}
