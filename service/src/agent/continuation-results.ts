import type { CanonicalContentBlock } from "../llm/types.js";

// A provider may batch a question with subsequent actions. Those actions were
// never dispatched before parking. Return that fact so the model can reconsider
// them using the user's answer, rather than silently executing stale arguments.
export function deferredToolResult(block: Extract<CanonicalContentBlock, { type: "tool_use" }>, waitingFor: "question" | "permission" | "automation" = "question") {
  const names: Record<string, string> = {
    terminal_send: "terminal.send", terminal_observe: "terminal.observe", terminal_wait: "terminal.wait",
    web_view_open: "web_view.open", web_view_close: "web_view.close", web_view_list: "web_view.list",
  };
  return {
    ...block.input, args: block.input, tool: names[block.name] ?? block.name, call_id: block.id,
    ok: false, error: waitingFor === "automation" ? "not_executed_due_to_automation_review" : waitingFor === "permission" ? "not_executed_due_to_permission" : "not_executed_due_to_question", retryable: true,
    summary: waitingFor === "automation" ? "Not executed: reconsider this action using the automation review decision." : waitingFor === "permission" ? "Not executed: reconsider this action using the user's permission decision."
      : "Not executed: reconsider this action using the user's answer.",
  };
}
