/** Browser/mobile projection only. Stored content and model replay are unchanged. */
type StoredMessage = {
  messageId: string; clientId: string | null; role: string; displayRole: string | null;
  content: string; metadata: Record<string, unknown>; createdAt: Date;
};
export type ToolPresentation = {
  kind: "questions" | "app_permission" | "automation_activation" | "bootstrap" | "browser_handoff" | "terminal" | "generic";
  id: string | null;
  status: string | null;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

export function toolPresentation(name: string, payload: Record<string, unknown>, pending = false): ToolPresentation {
  const result = record(payload.result) ? payload.result : payload;
  const proposal = record(payload.proposal) ? payload.proposal : result;
  const request = record(payload.request) ? payload.request : result;
  const kind: ToolPresentation["kind"] = name === "ask_user_questions" ? "questions"
    : name === "data_request_api_key" ? "app_permission"
    : name === "automations_request_activation" ? "automation_activation"
    : name === "automations_request_existing_contacts" ? "bootstrap"
    : name === "browser_request_handoff" || payload.wait_kind === "return_control" ? "browser_handoff"
    : name.startsWith("terminal.") ? "terminal" : "generic";
  const id = kind === "questions" || kind === "app_permission" ? text(request.request_id)
    : kind === "automation_activation" || kind === "bootstrap" ? text(proposal.proposal_id)
    : kind === "browser_handoff" ? text(payload.handoff_id) ?? text(result.handoff_id) : null;
  // Unknown historical state stays unknown; result presence does not imply approval.
  const status = pending ? "pending" : text(proposal.status) ?? text(request.status) ?? text(payload.status);
  return { kind, id, status };
}

const metadataKeys = new Set(["turn_id", "started_at", "finished_at", "duration_ms", "duration_source",
  "model", "reasoning_effort", "model_selection_source", "llm_call_id", "path_context", "path_context_before",
  "path_context_after", "terminal_visibility", "continuation", "model_visible"]);

export type MessageView = {
  message_id: string; client_id: string | null; role: string; display_role: string;
  content: string; metadata: Record<string, unknown>; created_at: string;
  tool_payload?: Record<string, unknown> | null; presentation?: ToolPresentation;
};
export function serializeMessageView(row: StoredMessage): MessageView {
  const base = { message_id: row.messageId, client_id: row.clientId, role: row.role,
    display_role: row.displayRole ?? row.role, content: row.content,
    metadata: row.metadata ?? {}, created_at: row.createdAt.toISOString() };
  if (row.role !== "tool") return base;
  let payload: Record<string, unknown> | null = null;
  let parsedContent = false;
  try {
    const parsed: unknown = JSON.parse(row.content);
    if (record(parsed)) { payload = parsed; parsedContent = true; }
  } catch { /* Historical plain text is retained verbatim. */ }
  if (!payload && typeof base.metadata.tool === "string") {
    payload = Object.fromEntries(Object.entries(base.metadata).filter(([key]) => !metadataKeys.has(key)));
  }
  if (!payload) return { ...base, tool_payload: null,
    presentation: { kind: "generic", id: null, status: null } satisfies ToolPresentation };
  const metadata = Object.fromEntries(Object.entries(base.metadata).filter(([key]) => metadataKeys.has(key) || !(key in payload!)));
  const name = text(payload.tool) ?? text(base.metadata.tool) ?? "";
  return { ...base, content: parsedContent ? text(payload.summary) ?? name : row.content,
    metadata, tool_payload: payload, presentation: toolPresentation(name, payload) };
}
