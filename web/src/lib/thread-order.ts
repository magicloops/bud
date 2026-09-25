type OrderedThread = { thread_id: string; created_at: string; last_conversation_at?: string | null }

export function compareThreads(a: OrderedThread, b: OrderedThread): number {
  return Date.parse(b.last_conversation_at ?? b.created_at) - Date.parse(a.last_conversation_at ?? a.created_at)
    || Date.parse(b.created_at) - Date.parse(a.created_at)
    || (a.thread_id < b.thread_id ? 1 : a.thread_id > b.thread_id ? -1 : 0)
}

export function latestConversationAt(a?: string | null, b?: string | null): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}
