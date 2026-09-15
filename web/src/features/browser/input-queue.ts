import type { BrowserFrame } from "./media";

export type QueuedInput = { action: Record<string, unknown>; frame: BrowserFrame };

function sameViewport(a: BrowserFrame, b: BrowserFrame) {
  return a.target_id === b.target_id && a.document_id === b.document_id &&
    a.width === b.width && a.height === b.height && a.viewport_id === b.viewport_id;
}

export function inputMatchesFrame(input: QueuedInput, frame: BrowserFrame) {
  return sameViewport(input.frame, frame) &&
    (input.action.kind === "scroll" || input.frame.frame_token === frame.frame_token);
}

/** Merge only unsent adjacent wheels; clicks, typing and direction changes are barriers. */
export function enqueueInput(queue: QueuedInput[], input: QueuedInput): boolean {
  const tail = queue.at(-1);
  if (tail?.action.kind === "scroll" && input.action.kind === "scroll" &&
      sameViewport(tail.frame, input.frame) &&
      tail.action.x === input.action.x && tail.action.y === input.action.y) {
    const before = Number(tail.action.delta_y);
    const next = Number(input.action.delta_y);
    if (Math.sign(before) === Math.sign(next) && Math.abs(before + next) <= 2000) {
      tail.action = { ...tail.action, delta_y: before + next };
      tail.frame = input.frame;
      return true;
    }
  }
  if (queue.length >= 16) return false;
  queue.push(input);
  return true;
}
