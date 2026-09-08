import { randomUUID } from "node:crypto";
import { InvocationError, InvocationRepository, type Invocation } from "./invocation-repository.js";
import type { AgentExecutionHooks, AgentTurnOutcome } from "./execution-lifecycle.js";
import { AutomationManagement } from "../personal-data/automation-management.js";
import { DataRequestError } from "../personal-data/contracts.js";

type Repository = Pick<InvocationRepository, "claim" | "recoverExpired" | "expireQueued" | "heartbeat" | "start" | "defer" | "recordAction" | "completeAction" | "parkQuestion" | "parkAppDataRequest" | "parkAutomationProposal" | "parkBootstrapProposal" | "prepareQuestionContinuation" | "finish">;
export type InvocationPreflight = "ready" | "waiting_for_bud" | "waiting_for_model" | "retry_wait";
export interface InvocationExecutor {
  preflight(invocation: Invocation): Promise<InvocationPreflight>;
  execute(invocation: Invocation, signal: AbortSignal, hooks: AgentExecutionHooks): Promise<AgentTurnOutcome>;
}

// Explicitly started by the composition root only after shared admission is
// enabled. Constructing this worker neither polls nor starts an agent.
export class InvocationWorker {
  private readonly workerId = randomUUID();
  private readonly controllers = new Set<AbortController>();
  private readonly active = new Set<Promise<boolean>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private generation = 0;

  constructor(
    private readonly executor: InvocationExecutor,
    private readonly repository: Repository = new InvocationRepository(),
    private readonly reportError: (code: string) => void = () => {},
    private readonly concurrency = 4,
    private readonly automationManagement: Pick<AutomationManagement, "read" | "mutate"> = new AutomationManagement(),
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("invalid_worker_concurrency");
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.active.size < this.concurrency) {
        const task = this.runOnce().catch(() => { this.reportError("invocation_worker_failed"); return false; });
        this.active.add(task);
        void task.finally(() => { this.active.delete(task); });
      }
      this.schedule(1000);
    }, delay);
    this.timer.unref();
  }

  async stop() {
    this.generation++;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers) controller.abort(new Error("worker_stopping"));
    await Promise.allSettled([...this.active]);
  }

  async runOnce(): Promise<boolean> {
    const generation = this.generation;
    await this.repository.recoverExpired();
    await this.repository.expireQueued();
    const invocation = await this.repository.claim(this.workerId);
    if (!invocation) return false;
    // Stop may have raced with DB claim. Leave unstarted work for preflight
    // lease recovery instead of launching it after shutdown began.
    if (generation !== this.generation) return true;
    const controller = new AbortController();
    this.controllers.add(controller);
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let renewal: Promise<void> = Promise.resolve();
    let ended = false;
    let parked = false;
    const renew = () => {
      // Serialize renewals from timer and dispatch checkpoints. Failed renewal
      // stays rejected so a later checkpoint cannot revive a stale executor.
      renewal = renewal.then(async () => {
        controller.signal.throwIfAborted();
        await this.repository.heartbeat(invocation);
      }).catch(error => { controller.abort(error); throw error; });
      return renewal;
    };
    const scheduleHeartbeat = () => {
      heartbeat = setTimeout(() => {
        void renew().catch(() => {}).finally(() => { if (!ended) scheduleHeartbeat(); });
      }, 15_000);
      heartbeat.unref();
    };
    scheduleHeartbeat();
    try {
      const availability = await this.executor.preflight(invocation);
      await renew();
      if (availability !== "ready") {
        await this.repository.defer(invocation, availability);
        return true;
      }
      await this.repository.start(invocation);
      await this.repository.prepareQuestionContinuation(invocation);
      const hooks: AgentExecutionHooks = {
        checkpoint: renew,
        beforeTool: async directive => {
          await renew();
          await this.repository.recordAction(invocation, directive.callId, directive.tool);
        },
        parkQuestion: async (directive, questionRequestId) => {
          await renew();
          // Stop renewal before releasing the lease. The question/answer rows
          // and reserved invocation, not a live promise, now own continuation.
          ended = true;
          if (heartbeat) clearTimeout(heartbeat);
          await this.repository.parkQuestion(invocation, directive.callId, questionRequestId);
          parked = true;
        },
        parkAppDataRequest: async (callId, clientId, input) => {
          await renew();
          ended = true;
          if (heartbeat) clearTimeout(heartbeat);
          const request = await this.repository.parkAppDataRequest(invocation, callId, clientId, input);
          parked = true;
          return request;
        },
        parkAutomationProposal: async (callId, clientId, input) => {
          await renew();
          ended = true;
          if (heartbeat) clearTimeout(heartbeat);
          try {
            const proposal = await this.repository.parkAutomationProposal(invocation, callId, clientId, input);
            parked = true;
            return proposal;
          } catch (error) {
            // Validation rejects before the atomic park commits. The original
            // lease still owns the invocation and can record a tool error.
            if (error instanceof DataRequestError && !controller.signal.aborted) {
              ended = false;
              scheduleHeartbeat();
            }
            throw error;
          }
        },
        parkBootstrapProposal: async (callId, clientId, input) => {
          await renew();
          ended = true;
          if (heartbeat) clearTimeout(heartbeat);
          try {
            const result = await this.repository.parkBootstrapProposal(invocation, callId, clientId, input);
            if (result.kind === "proposal") {
              parked = true;
            } else {
              // Nothing was parked or released. Continue through the ordinary
              // result/checkpoint path, retaining heartbeat renewal.
              ended = false;
              scheduleHeartbeat();
            }
            return result;
          } catch (error) {
            if (error instanceof DataRequestError && !controller.signal.aborted) {
              ended = false;
              scheduleHeartbeat();
            }
            throw error;
          }
        },
        executeAutomationTool: async (name, callId, input) => {
          await renew();
          const context = { owner: invocation.createdByUserId, invocationId: invocation.id,
            workerId: invocation.workerId ?? "", fence: invocation.fence, callId };
          return name === "automations_list" || name === "automations_get" || name === "automations_history"
            ? this.automationManagement.read(context, name, input)
            : this.automationManagement.mutate(context, name, input);
        },
        afterTool: async (directive, execution, messageId) => {
          await renew();
          // Store references and compact facts, not contacts/credentials or
          // arbitrary terminal output. The canonical transcript holds payloads.
          await this.repository.completeAction(invocation, directive.callId, {
            message_id: messageId, tool: directive.tool, result_kind: execution.result.kind,
          });
        },
      };
      const outcome = await this.executor.execute(invocation, controller.signal, hooks);
      if (outcome.status === "waiting_for_user") {
        if (!parked) throw new Error("user_wait_not_durably_parked");
        return true;
      }
      await renew();
      await this.repository.finish(invocation,
        outcome.status === "canceled" ? "needs_review" : outcome.status,
        outcome.status === "canceled" ? "execution_canceled" : outcome.reason ?? outcome.status);
      return true;
    } catch (error) {
      if (error instanceof InvocationError && error.code === "automation_paused") {
        try { await this.repository.defer(invocation, "retry_wait"); }
        catch { this.reportError("invocation_outcome_not_committed"); }
        return true;
      }
      // Expired leases cannot write outcomes. Recovery will reserve ambiguous
      // execution; a currently-owned invocation records failure conservatively.
      try {
        await this.repository.finish(invocation, controller.signal.aborted ? "needs_review" : "failed",
          controller.signal.aborted ? "execution_interrupted" : "execution_failed");
      } catch { this.reportError("invocation_outcome_not_committed"); }
      return true;
    } finally {
      ended = true;
      if (heartbeat) clearTimeout(heartbeat);
      await renewal.catch(() => {});
      this.controllers.delete(controller);
    }
  }
}
