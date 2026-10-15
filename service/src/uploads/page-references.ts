import type { CanonicalContentBlock, CanonicalMessage } from '../llm/types.js';

/** Shared by hydration and context budgeting; no I/O or document bytes. */
export function documentPageReferences(messages: CanonicalMessage[]) {
  const references = new Map<CanonicalContentBlock, { file_id: string; page: number }>();
  for (const message of messages) if (message.role === 'user' && Array.isArray(message.content)) for (const block of message.content) {
    if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
    try {
      const payload = JSON.parse(block.content), ref = payload.document_page;
      if (payload.tool === 'files_read' && payload.ok === true && ref &&
        /^file_[0-9A-HJKMNP-TV-Z]{26}$/.test(ref.file_id) && Number.isInteger(ref.page) && ref.page >= 1 && ref.page <= 200)
        references.set(block, { file_id: ref.file_id, page: ref.page });
    } catch { /* Ordinary tool result. */ }
  }
  return references;
}
export function selectedDocumentPages(messages: CanonicalMessage[]) {
  return new Map([...documentPageReferences(messages)].slice(-2));
}
