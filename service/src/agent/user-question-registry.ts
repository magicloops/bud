import type {
  AskUserQuestionsResponse,
  AskUserQuestionsToolResult,
} from "./user-question-contracts.js";

export type ResolvedUserQuestionResponse = {
  response: AskUserQuestionsResponse;
  toolResult: AskUserQuestionsToolResult;
  continuation?: "continue" | "supersede";
  reason?: "superseded_by_user_message";
  onFinalized?: () => void;
  onFailed?: (error: unknown) => void;
};

type PendingUserQuestion = {
  threadId: string;
  resolve: (response: ResolvedUserQuestionResponse) => void;
  reject: (error: Error) => void;
};

export class AgentUserQuestionRegistry {
  private readonly pending = new Map<string, PendingUserQuestion>();

  register(
    threadId: string,
    questionRequestId: string,
  ): Promise<ResolvedUserQuestionResponse> {
    this.reject(questionRequestId, new Error("question_request_replaced"));

    return new Promise<ResolvedUserQuestionResponse>((resolve, reject) => {
      this.pending.set(questionRequestId, {
        threadId,
        resolve,
        reject,
      });
    });
  }

  has(questionRequestId: string): boolean {
    return this.pending.has(questionRequestId);
  }

  resolve(questionRequestId: string, response: ResolvedUserQuestionResponse): boolean {
    const pending = this.pending.get(questionRequestId);
    if (!pending) {
      return false;
    }
    this.pending.delete(questionRequestId);
    pending.resolve(response);
    return true;
  }

  reject(questionRequestId: string, error: Error): boolean {
    const pending = this.pending.get(questionRequestId);
    if (!pending) {
      return false;
    }
    this.pending.delete(questionRequestId);
    pending.reject(error);
    return true;
  }

  rejectThread(threadId: string, error: Error): number {
    let rejected = 0;
    for (const [questionRequestId, pending] of this.pending.entries()) {
      if (pending.threadId !== threadId) {
        continue;
      }
      this.pending.delete(questionRequestId);
      pending.reject(error);
      rejected += 1;
    }
    return rejected;
  }
}
