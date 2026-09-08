import type { AgentToolCallDirective, ExecutedAgentTool } from "./contracts.js";
import type { InvocationRepository } from "./invocation-repository.js";
import type { AutomationToolName } from "../personal-data/automation-tool-contracts.js";

export type AgentTurnOutcome = {
  status: "succeeded" | "failed" | "canceled" | "waiting_for_user";
  reason?: string;
};

// Internal worker hooks. None of these callbacks or identities come from model
// arguments or browser request bodies. Rejection must prevent the next dispatch.
export interface AgentExecutionHooks {
  checkpoint(): Promise<void>;
  beforeTool(directive: AgentToolCallDirective): Promise<void>;
  parkQuestion?(directive: AgentToolCallDirective, questionRequestId: string): Promise<void>;
  parkAppDataRequest?(callId: string, clientId: string, input: unknown): ReturnType<InvocationRepository["parkAppDataRequest"]>;
  parkAutomationProposal?(callId: string, clientId: string, input: unknown): ReturnType<InvocationRepository["parkAutomationProposal"]>;
  parkBootstrapProposal?(callId: string, clientId: string, input: unknown): ReturnType<InvocationRepository["parkBootstrapProposal"]>;
  executeAutomationTool?(name: Exclude<AutomationToolName, "automations_request_activation" | "automations_request_existing_contacts">, callId: string, input: unknown): Promise<Record<string, unknown>>;
  afterTool(directive: AgentToolCallDirective, execution: ExecutedAgentTool, messageId: string): Promise<void>;
}
