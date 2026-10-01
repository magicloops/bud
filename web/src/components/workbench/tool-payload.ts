type ToolMessage = { tool_payload?: Record<string, unknown> | null; content: string; metadata?: Record<string, unknown> | null }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function resolveToolPayload(message: ToolMessage): Record<string, unknown> | null {
  const metadata = isRecord(message.metadata) ? message.metadata : null
  if (isRecord(message.tool_payload)) return { ...metadata, ...message.tool_payload }
  return null
}
