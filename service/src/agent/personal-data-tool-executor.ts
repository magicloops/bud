import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { budTable, threadTable } from "../db/schema.js";
import { AgentDataQueries } from "../personal-data/agent-queries.js";
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
    private readonly ceiling = loadAutomationDataCeiling) {}

  async execute(threadId: string, directive: PersonalDataToolCallDirective, owner?: string | null, signal?: AbortSignal, turnId?: string): Promise<ExecutedPersonalDataTool> {
    let response: Record<string, unknown>;
    let summary: string;
    let errorCode: string | undefined;
    let retryable = false;
    try {
      signal?.throwIfAborted();
      if (!owner || !await this.authorize(threadId, owner)) throw new DataRequestError(404, "not_found", "Owned thread not found");
      const ceiling = await this.ceiling(threadId, owner, turnId);
      response = await this.queries.execute(owner, directive.tool, directive.args, ceiling);
      const current = await this.ceiling(threadId, owner, turnId);
      if (current?.binding !== ceiling?.binding) throw new DataRequestError(409, "automation_changed", "Automation execution changed during the query");
      if (!await this.authorize(threadId, owner)) throw new DataRequestError(404, "not_found", "Owned thread not found");
      signal?.throwIfAborted();
      summary = "Queried approved personal data";
    } catch (error) {
      if (signal?.aborted) throw error;
      errorCode = error instanceof DataRequestError ? error.code : "data_query_failed";
      retryable = error instanceof DataRequestError ? error.retryable || error.statusCode === 409 : true;
      summary = error instanceof DataRequestError ? error.message : "Personal data is temporarily unavailable";
      response = { error: errorCode, message: summary, retryable,
        ...(errorCode === "data_permission_required" ? { permission_settings_path: "/data", approval_required: true } : {}) };
    }
    return { directive, args: directive.args, summary, outputTruncationReason: null,
      result: { kind: "personal_data", ok: !errorCode, error: errorCode, retryable },
      payload: { tool: directive.tool, call_id: directive.callId, args: directive.args, kind: "personal_data",
        ok: !errorCode, summary, ...response } };
  }
}
