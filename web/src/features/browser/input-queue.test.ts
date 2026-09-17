import assert from "node:assert/strict";
import test from "node:test";
import { enqueueInput, inputMatchesFrame, type QueuedInput } from "./input-queue.ts";

const frame = { target_id: "tab", document_id: "doc", frame_token: "a", width: 600, height: 400, targets: [] };
const wheel = (delta_y = 10): QueuedInput => ({ frame, action: { kind: "scroll", x: 10, y: 20, delta_y } });

test("coalesces a wheel burst while preserving distance and wire bounds", () => {
  const queue: QueuedInput[] = [];
  for (let i = 0; i < 300; i++) assert(enqueueInput(queue, wheel()));
  assert.equal(queue.length, 2);
  assert.equal(queue.reduce((sum, item) => sum + Number(item.action.delta_y), 0), 3000);
  assert(queue.every(item => Number(item.action.delta_y) <= 2000));
});

test("ordering, direction, pointer and document changes are barriers; queue remains bounded", () => {
  const queue: QueuedInput[] = [];
  for (const item of [
    wheel(), { frame, action: { kind: "click" } }, wheel(), wheel(-10),
    { ...wheel(-10), action: { ...wheel(-10).action, x: 11 } },
    { ...wheel(), frame: { ...frame, document_id: "new" } },
  ]) assert(enqueueInput(queue, item));
  assert.equal(queue.length, 6);
  while (queue.length < 16) enqueueInput(queue, { frame, action: { kind: "text" } });
  assert.equal(enqueueInput(queue, wheel()), false);
});

test("only scroll can rebase to fresh pixels of the same document and viewport", () => {
  const fresh = { ...frame, frame_token: "b" };
  assert(inputMatchesFrame(wheel(), fresh));
  assert(!inputMatchesFrame({ frame, action: { kind: "click" } }, fresh));
  for (const changed of [
    { ...fresh, document_id: "new" }, { ...fresh, target_id: "other" },
    { ...fresh, width: 800 }, { ...fresh, viewport_id: "resized" },
  ]) assert(!inputMatchesFrame(wheel(), changed));
});
