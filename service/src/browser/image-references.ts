// Pure selection of browser screenshot references (no I/O), shared by image
// hydration and context accounting so both agree on which images the provider
// receives (Phase 3s D4).
import type { CanonicalContentBlock, CanonicalMessage } from '../llm/types.js';

/** Provider payloads carry at most this many of the newest screenshots. */
export const HYDRATED_IMAGE_LIMIT = 8;

/**
 * Conservative per-image token cost used before hydration. Roughly the upper
 * range of OpenAI high-detail tiles and Anthropic's pixel-area formula for a
 * ~1.2 MP screenshot, plus the caption line hydration inserts. Over-estimating
 * moves the compaction trigger earlier, never later.
 */
export const IMAGE_TOKEN_ESTIMATE = 1_600;

export function imageArtifactIds(block: CanonicalContentBlock): string[] {
  if (block.type !== 'tool_result' || typeof block.content !== 'string') return [];
  try {
    const payload = JSON.parse(block.content);
    if (payload?.data?.output_withheld) return [];
    if (payload?.tool === 'browser_exec') return (Array.isArray(payload?.data?.images) ? payload.data.images.slice(0,2) : [])
      .map((image: {id?: unknown}) => image?.id).filter((id: unknown): id is string => typeof id === 'string');
    const id = payload?.tool === 'browser_observe' && payload?.ok === true && payload?.data?.image_artifact?.id;
    return typeof id === 'string' ? [id] : [];
  } catch { return []; }
}

/** Newest image emissions, capped by images rather than tool-result blocks. */
export function selectHydratedImageReferences(messages: CanonicalMessage[]): Map<CanonicalContentBlock, string[]> {
  const selected = new Map<CanonicalContentBlock, string[]>();
  let remaining = HYDRATED_IMAGE_LIMIT;
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of [...message.content].reverse()) {
      if (!remaining) break;
      const ids = imageArtifactIds(block).slice(-remaining);
      if (remaining && ids.length) { selected.set(block, ids); remaining -= ids.length; }
    }
  }
  return selected;
}

/**
 * Artifact ids that would be hydrated, restricted to the first `count`
 * messages (conversation order). Used to fence a measured request baseline.
 */
export function hydratedImageIds(messages: CanonicalMessage[], count = messages.length): string[] {
  const selected = selectHydratedImageReferences(messages);
  const ids: string[] = [];
  for (const message of messages.slice(0, count)) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (selected.has(block)) ids.push(...selected.get(block)!);
    }
  }
  return ids;
}
