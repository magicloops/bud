import { invocationTimingTransaction, recordInvocationChange } from "./invocation-timing.js";
import { and, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { agentQuestionRequestTable, placeTable } from "../db/schema.js";
import { DataRequestError } from "../personal-data/contracts.js";
import { Places } from "../personal-data/places.js";
import {
  ASK_USER_QUESTIONS_TOOL,
  ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
  attachRequestIdToAskUserQuestionsRequest,
  buildAskUserQuestionsToolResult,
  parseStoredAskUserQuestionsRequest,
  validateAskUserQuestionsResponse,
  type AskUserQuestionResponseAnswer,
  type AskUserQuestionsRequest,
  type AskUserQuestionsResponse,
  type AskUserQuestionsToolResult,
} from "./user-question-contracts.js";
import type { ExecutedUserQuestionTool, UserQuestionToolCallDirective } from "./contracts.js";

export type AgentQuestionRequestRow = typeof agentQuestionRequestTable.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type AcceptedQuestionResponse = {
  questionRequest: AgentQuestionRequestRow;
  request: AskUserQuestionsRequest;
  response: AskUserQuestionsResponse;
  toolResult: AskUserQuestionsToolResult;
  alreadyAnswered: boolean;
};

export class AgentQuestionRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message = code) {
    super(message);
    this.name = "AgentQuestionRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createQuestionRequestId(): string {
  return `qr_${ulid()}`;
}

export async function createAgentQuestionRequest(args: {
  questionRequestId?: string;
  threadId: string;
  turnId: string;
  callId: string;
  clientId: string;
  request: AskUserQuestionsRequest;
  ownerUserId?: string | null;
}): Promise<{
  row: AgentQuestionRequestRow;
  request: AskUserQuestionsRequest;
}> {
  const questionRequestId = args.questionRequestId ?? createQuestionRequestId();
  const request = attachRequestIdToAskUserQuestionsRequest(args.request, questionRequestId);
  const [row] = await db
    .insert(agentQuestionRequestTable)
    .values({
      questionRequestId,
      threadId: args.threadId,
      turnId: args.turnId,
      callId: args.callId,
      clientId: args.clientId,
      status: "pending",
      request: request as unknown as Record<string, unknown>,
      createdByUserId: args.ownerUserId ?? undefined,
    })
    .returning();

  return { row, request };
}

export async function getAgentQuestionRequestForThread(
  threadId: string,
  questionRequestId: string,
): Promise<AgentQuestionRequestRow | null> {
  const [row] = await db
    .select()
    .from(agentQuestionRequestTable)
    .where(
      and(
        eq(agentQuestionRequestTable.threadId, threadId),
        eq(agentQuestionRequestTable.questionRequestId, questionRequestId),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function acceptAgentQuestionResponse(args: {
  threadId: string;
  questionRequestId: string;
  response: unknown;
  answeredByUserId: string;
}): Promise<AcceptedQuestionResponse> {
  return invocationTimingTransaction(db, async (tx) => {
    const [row] = await tx
      .select()
      .from(agentQuestionRequestTable)
      .where(
        and(
          eq(agentQuestionRequestTable.threadId, args.threadId),
          eq(agentQuestionRequestTable.questionRequestId, args.questionRequestId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AgentQuestionRequestError("question_request_not_found", 404);
    }

    const request = parseStoredAskUserQuestionsRequest(row.request);
    if (row.status === "answered") {
      const existingResponse = parseStoredResponse(row.clientResponse);
      const existingToolResult = parseStoredToolResult(row.toolResult);
      const attempted = validateAskUserQuestionsResponse(args.response, request);
      if (existingResponse.client_response_id === attempted.client_response_id) {
        return {
          questionRequest: row,
          request,
          response: existingResponse,
          toolResult: existingToolResult,
          alreadyAnswered: true,
        };
      }
      throw new AgentQuestionRequestError("question_request_already_answered", 409);
    }

    if (row.status !== "pending") {
      throw new AgentQuestionRequestError("question_request_not_pending", 409);
    }

    const response = await savePlaceAnswers(tx, row.createdByUserId ?? args.answeredByUserId, request,
      validateAskUserQuestionsResponse(args.response, request));
    const toolResult = buildAskUserQuestionsToolResult(
      request,
      response,
      row.questionRequestId,
    );
    const [updated] = await tx
      .update(agentQuestionRequestTable)
      .set({
        status: "answered",
        clientResponse: response as unknown as Record<string, unknown>,
        toolResult: toolResult as unknown as Record<string, unknown>,
        clientResponseId: response.client_response_id,
        answeredByUserId: args.answeredByUserId,
        answeredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentQuestionRequestTable.threadId, args.threadId),
          eq(agentQuestionRequestTable.questionRequestId, args.questionRequestId),
          eq(agentQuestionRequestTable.status, "pending"),
        ),
      )
      .returning();

    if (!updated) {
      throw new AgentQuestionRequestError("question_request_not_pending", 409);
    }

    recordInvocationChange(tx);
    return {
      questionRequest: updated,
      request,
      response,
      toolResult,
      alreadyAnswered: false,
    };
  });
}

/**
 * Saves each answered place question as the user's own place, in the answer's transaction
 * (Phase 9): a new place, or the asked-about place updated. A save that fails (the place was
 * deleted, or the limit is reached) refuses the whole answer, so the prompt stays. Moving or
 * resizing restarts the place's presence (`Places.update`); an unchanged pin changes nothing.
 */
async function savePlaceAnswers(tx: Transaction, owner: string, request: AskUserQuestionsRequest,
  response: AskUserQuestionsResponse): Promise<AskUserQuestionsResponse> {
  const places = new Places(tx as unknown as Database);
  const answers: AskUserQuestionResponseAnswer[] = [];
  for (const answer of response.answers) {
    const asked = request.questions.find(question => question.question_id === answer.question_id)?.place;
    if (answer.status !== "answered" || answer.answer?.kind !== "place" || !asked) { answers.push(answer); continue; }
    const pin = answer.answer;
    try {
      let id: string;
      if (asked.place_id) {
        const [current] = await tx.select().from(placeTable).where(and(eq(placeTable.id, asked.place_id),
          eq(placeTable.createdByUserId, owner), isNull(placeTable.deletedAt))).limit(1);
        if (!current) throw new DataRequestError(404, "place_not_found", "That place no longer exists");
        const moved = current.latitude !== pin.latitude || current.longitude !== pin.longitude;
        // The answer's address is the one the user accepted, so it's always sent with a move (an
        // absent one clears it); an address change alone keeps presence.
        const address = pin.address ?? null;
        const changes = { ...(current.name !== pin.name ? { name: pin.name } : {}),
          ...(moved ? { latitude: pin.latitude, longitude: pin.longitude } : {}),
          ...(current.radiusM !== pin.radius_m ? { radius_m: pin.radius_m } : {}),
          ...(moved || current.address !== address ? { address } : {}) };
        if (Object.keys(changes).length) await places.update(owner, current.id, changes);
        id = current.id;
      } else {
        id = (await places.create(owner, { name: pin.name, latitude: pin.latitude, longitude: pin.longitude, radius_m: pin.radius_m,
          address: pin.address ?? null }, "user")).id;
      }
      answers.push({ ...answer, answer: { ...pin, place_id: id, operation: asked.place_id ? "updated" : "created" } });
    } catch (error) {
      if (error instanceof DataRequestError) throw new AgentQuestionRequestError(error.code, 409, error.message);
      throw error;
    }
  }
  return { ...response, answers };
}

export async function acceptPendingAgentQuestionRequestsAsSkipped(args: {
  threadId: string;
  answeredByUserId: string;
}): Promise<AcceptedQuestionResponse[]> {
  return invocationTimingTransaction(db, async (tx) => {
    const rows = await tx
      .select()
      .from(agentQuestionRequestTable)
      .where(
        and(
          eq(agentQuestionRequestTable.threadId, args.threadId),
          eq(agentQuestionRequestTable.status, "pending"),
        ),
      );

    const accepted: AcceptedQuestionResponse[] = [];
    for (const row of rows) {
      const request = parseStoredAskUserQuestionsRequest(row.request);
      const response = validateAskUserQuestionsResponse(
        {
          schema: ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
          client_response_id: generateMessageClientId(),
          answers: request.questions.map((question) => ({
            question_id: question.question_id,
            status: "skipped",
            skip_reason: "user_skipped",
          })),
        },
        request,
      );
      const toolResult = buildAskUserQuestionsToolResult(
        request,
        response,
        row.questionRequestId,
      );
      const [updated] = await tx
        .update(agentQuestionRequestTable)
        .set({
          status: "answered",
          clientResponse: response as unknown as Record<string, unknown>,
          toolResult: toolResult as unknown as Record<string, unknown>,
          clientResponseId: response.client_response_id,
          answeredByUserId: args.answeredByUserId,
          answeredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentQuestionRequestTable.threadId, args.threadId),
            eq(agentQuestionRequestTable.questionRequestId, row.questionRequestId),
            eq(agentQuestionRequestTable.status, "pending"),
          ),
        )
        .returning();

      if (!updated) {
        continue;
      }

      recordInvocationChange(tx);
      accepted.push({
        questionRequest: updated,
        request,
        response,
        toolResult,
        alreadyAnswered: false,
      });
    }

    return accepted;
  });
}

export async function markPendingAgentQuestionRequestsCanceled(args: {
  threadId: string;
  turnId?: string | null;
}): Promise<void> {
  await db
    .update(agentQuestionRequestTable)
    .set({
      status: "canceled",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentQuestionRequestTable.threadId, args.threadId),
        args.turnId ? eq(agentQuestionRequestTable.turnId, args.turnId) : undefined,
        eq(agentQuestionRequestTable.status, "pending"),
      ),
    );
}

export function buildExecutedUserQuestionTool(args: {
  directive: UserQuestionToolCallDirective;
  toolResult: AskUserQuestionsToolResult;
}): ExecutedUserQuestionTool {
  const summary = args.toolResult.title
    ? `Answered questions: ${args.toolResult.title}`
    : "Answered user questions";
  return {
    directive: args.directive,
    args: args.directive.request as unknown as Record<string, unknown>,
    summary,
    outputTruncationReason: null,
    result: {
      kind: "user_questions" as const,
      requestId: args.toolResult.request_id,
      responses: args.toolResult.responses,
    },
    payload: {
      tool: ASK_USER_QUESTIONS_TOOL,
      call_id: args.directive.callId,
      ...args.directive.request,
      summary,
      kind: "user_questions",
      result: args.toolResult,
    },
  };
}

function parseStoredResponse(input: unknown): AskUserQuestionsResponse {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentQuestionRequestError("stored_question_response_missing", 500);
  }
  return input as AskUserQuestionsResponse;
}

function parseStoredToolResult(input: unknown): AskUserQuestionsToolResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentQuestionRequestError("stored_question_tool_result_missing", 500);
  }
  return input as AskUserQuestionsToolResult;
}
