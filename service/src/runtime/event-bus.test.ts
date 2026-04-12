import assert from "node:assert/strict";
import test from "node:test";
import { AgentEventBus, type SseEvent } from "./event-bus.js";

function makeEvent(id: string, event: string): SseEvent {
  return {
    id,
    event,
    data: { id, event },
  };
}

test("attachCallback replays the full buffer when no cursor is provided", () => {
  const bus = new AgentEventBus();
  const events = [makeEvent("evt_1", "agent.tool_call"), makeEvent("evt_2", "agent.message")];

  for (const event of events) {
    bus.emit("thread-1", event);
  }

  const replayed: SseEvent[] = [];
  const detach = bus.attachCallback("thread-1", (event) => {
    replayed.push(event);
  });

  assert.deepEqual(replayed, events);
  detach();
});

test("attachCallback can opt into live-only mode even without a resume cursor", () => {
  const bus = new AgentEventBus();
  const bufferedEvents = [makeEvent("evt_1", "agent.tool_call"), makeEvent("evt_2", "agent.message")];

  for (const event of bufferedEvents) {
    bus.emit("thread-1", event);
  }

  const replayed: SseEvent[] = [];
  const detach = bus.attachCallback(
    "thread-1",
    (event) => {
      replayed.push(event);
    },
    { replayBuffered: false },
  );

  assert.deepEqual(replayed, []);

  const liveEvent = makeEvent("evt_3", "final");
  bus.emit("thread-1", liveEvent);

  assert.deepEqual(replayed, [liveEvent]);
  detach();
});

test("attachCallback replays only buffered events after the provided last event id", () => {
  const bus = new AgentEventBus();
  const events = [
    makeEvent("evt_1", "agent.tool_call"),
    makeEvent("evt_2", "agent.tool_result"),
    makeEvent("evt_3", "agent.message"),
  ];

  for (const event of events) {
    bus.emit("thread-1", event);
  }

  const replayed: SseEvent[] = [];
  const detach = bus.attachCallback(
    "thread-1",
    (event) => {
      replayed.push(event);
    },
    { lastEventId: "evt_2" },
  );

  assert.deepEqual(replayed, [events[2]]);
  detach();
});

test("attachCallback falls back to live-only attachment when the resume cursor is missing", () => {
  const bus = new AgentEventBus();
  bus.emit("thread-1", makeEvent("evt_1", "agent.tool_call"));
  bus.emit("thread-1", makeEvent("evt_2", "agent.message"));

  const replayed: SseEvent[] = [];
  const detach = bus.attachCallback(
    "thread-1",
    (event) => {
      replayed.push(event);
    },
    { lastEventId: "evt_missing" },
  );

  assert.deepEqual(replayed, []);

  const liveEvent = makeEvent("evt_3", "final");
  bus.emit("thread-1", liveEvent);

  assert.deepEqual(replayed, [liveEvent]);
  detach();
});
