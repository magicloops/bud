/** Presentation only: never infer authority from contact or message text. */
export function automationAttribution(message: {
  role: string; content: string; metadata?: Record<string, unknown> | null
}) {
  const metadata = message.metadata
  if (message.role !== 'system' || metadata?.origin !== 'automation') return null
  const text = (key: string) => typeof metadata[key] === 'string' ? metadata[key] as string : null
  // Messages admitted before `automation_name` began with "Automation: <name>" and stay in conversations.
  const firstLine = message.content.split('\n', 1)[0]
  const name = text('automation_name')?.trim() || (firstLine.startsWith('Automation: ') ? firstLine.slice(12).trim() : '')
  return {
    label: `Triggered by ${name || 'automation'}`,
    automationId: text('automation_id'),
    revision: typeof metadata.automation_revision === 'number' ? metadata.automation_revision : null,
    invocationId: text('invocation_id'),
    eventId: text('domain_event_id'),
  }
}
