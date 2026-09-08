type ToolMessage = { content: string; metadata?: Record<string, unknown> | null }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function resolveToolPayload(message: ToolMessage): Record<string, unknown> | null {
  const metadata = isRecord(message.metadata) ? message.metadata : null
  // Pending forms are synthesized in metadata before a canonical result exists.
  if (metadata?.pending === true) return metadata
  try {
    const content: unknown = JSON.parse(message.content)
    // Continuation receipts can have timing-only metadata. Their content is the
    // canonical tool result; metadata supplements it without replacing fields.
    if (isRecord(content)) return { ...metadata, ...content }
  } catch {
    // Historical metadata-only tools may have a plain-text content summary.
  }
  return metadata
}
