import type { CanonicalContentBlock } from "../llm/types.js";

// A provider may batch a question with subsequent actions. Those actions were
// never dispatched before parking. Return that fact so the model can reconsider
// them using the user's answer, rather than silently executing stale arguments.
export function deferredToolResult(block: Extract<CanonicalContentBlock, { type: "tool_use" }>, waitingFor: "question" | "permission" | "automation" | "browser" = "question", browserRestarted = false) {
  const names: Record<string, string> = {
    terminal_send: "terminal.send", terminal_observe: "terminal.observe", terminal_wait: "terminal.wait",
    web_view_open: "web_view.open", web_view_close: "web_view.close", web_view_list: "web_view.list",
  };
  return {
    ...block.input, args: block.input, tool: names[block.name] ?? block.name, call_id: block.id,
    ok: false,
    error: waitingFor === "browser" ? "not_executed_due_to_browser_handoff"
      : waitingFor === "automation" ? "not_executed_due_to_automation_review"
      : waitingFor === "permission" ? "not_executed_due_to_permission"
      : "not_executed_due_to_question",
    retryable: true,
    ...(waitingFor === "browser" ? {
      executed: false,
      ...(block.name === "browser_exec" ? { execution_state: "not_executed" } : {}),
      handoff: { status: browserRestarted ? "interrupted" : "returned", control_state: "agent", private_content: false },
    } : {}),
    summary: waitingFor === "browser" && block.name === "browser_exec"
      ? `Browser control is back with the agent. This queued cell was not executed. ${browserRestarted ? "The browser runtime was replaced; old JavaScript bindings and handles cannot be assumed to survive." : "A normal takeover preserves JavaScript bindings, but cached page data is historical."} Observe the current owned page before reconsidering the task; do not replay the queued cell or reuse stale action references. New calls still check live authority.`
      : waitingFor === "browser" && browserRestarted ? "The browser runtime was lost and replaced. This queued action was not executed. Private work was interrupted, not completed by the user. Observe the recovered shared page without old target IDs, then reconsider the task. Do not replay stale actions or ask for an extinct controller to return." : waitingFor === "browser" ? "The user has returned browser control to the agent. This queued action was not executed; the handoff is complete, not still waiting. Continue through browser_exec: use await browser.tabs.list() to discover owned pages and await browser.tabs.current() to bind the current page. If no task page exists, use await browser.tabs.open(exactUrl) with the requested URL. Obtain fresh observations before page interactions; do not replay stale actions. Do not ask the user to return control again based on this result. New browser calls still check live authority." : waitingFor === "automation" ? "Not executed: reconsider this action using the automation review decision." : waitingFor === "permission" ? "Not executed: reconsider this action using the user's permission decision."
      : "Not executed: reconsider this action using the user's answer.",
  };
}
