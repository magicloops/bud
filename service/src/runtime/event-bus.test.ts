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

test("emit with buffer:false delivers live but never enters the replay buffer", () => {
  const bus = new AgentEventBus();
  bus.emit("thread-1", makeEvent("evt_1", "terminal.output"));

  const live: SseEvent[] = [];
  const detachLive = bus.attachCallback("thread-1", (event) => {
    live.push(event);
  }, { replay: false });

  bus.emit("thread-1", makeEvent("evt_grid", "terminal.grid"), { buffer: false });
  assert.deepEqual(
    live.map((event) => event.event),
    ["terminal.grid"],
    "unbuffered events still reach live listeners",
  );
  detachLive();

  // A fresh attach replays only the buffered event — the grid frame is gone.
  const replayed: SseEvent[] = [];
  const detach = bus.attachCallback("thread-1", (event) => {
    replayed.push(event);
  });
  assert.deepEqual(replayed.map((event) => event.event), ["terminal.output"]);
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
