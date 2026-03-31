The clean approach is:

**Do not use the DB row ID as the frontend message identity.**
Use a **stable public/correlation ID** that exists *before* streaming starts, and keep it fixed for the life of that message.

### What usually works best

Give each message two IDs with different jobs:

* **`client_id` / `public_id` / `message_key`**
  Created immediately, before first token. Used for:

  * React keys
  * stream routing
  * optimistic UI
  * dedupe / retries / reconciliation

* **`db_id`**
  Internal persistence identifier. Used for:

  * joins
  * internal storage
  * admin/debugging

The frontend should key/render by the stable ID, not the DB ID.

So instead of:

* render temp message with `tmp_123`
* later replace with `db_987`

do this:

* render message with `message_key = msg_abc`
* later attach `db_id = 987` to that same object

No swap. No identity mutation.

---

## Best architecture

### Option A: best overall

**Generate the canonical public message ID before streaming.**

Use a UUIDv7 / ULID / Snowflake-style ID. It can be generated:

* on the **server** immediately when the request starts, or
* on the **client** before the request is sent

Then stream and persist using that same ID.

Example:

```ts
type Message = {
  messageKey: string;   // stable, public, used in UI and API
  dbId?: number;        // optional/internal
  role: "assistant" | "user";
  status: "streaming" | "complete" | "failed";
  content: string;
}
```

Flow:

1. Client creates `messageKey = "msg_01J..."`.
2. UI renders assistant placeholder keyed by `messageKey`.
3. Request includes `messageKey`.
4. Server streams chunks tagged with `messageKey`.
5. When persistence finishes, server stores the row with the same `messageKey` and maybe also assigns `dbId`.
6. Frontend updates metadata, but the rendered message identity stays the same.

This is the cleanest solution because it removes the whole “temp vs real ID” distinction.

---

## Why this is better

Because in a streamed UI, “message identity” and “database identity” are not the same concern.

A DB auto-increment ID answers:
“Which row is this?”

A stable message key answers:
“Which thing on screen is receiving these deltas?”

Those should not be coupled.

---

## If you want a single canonical ID

Then stop using DB-generated IDs as your public IDs.

Use a generated ID as the message’s actual primary external identity:

* `id = UUIDv7` generated before streaming
* persist later using the same `id`

Your DB can still keep an internal integer PK if you want:

```sql
messages (
  pk bigint primary key,
  public_id uuid unique not null,
  ...
)
```

Expose `public_id` to the frontend, never `pk`.

This is a very common pattern because DB PKs are a bad fit for optimistic/distributed/streaming systems.

---

## If you cannot change the backend right now

Then keep the temp ID, but make it **permanent in the client**.

In other words:

* `local_id` is created immediately and never changes
* `server_id` is added later
* React keys and local state stay on `local_id`

So the anti-pattern is:

```ts
key={message.id} // where id changes from temp to real
```

The better pattern is:

```ts
key={message.localId} // never changes
```

with state like:

```ts
{
  localId: "tmp_123",
  serverId: "db_987",
  content: "...",
  status: "complete"
}
```

That alone removes most of the weirdness.

---

## Practical event model

For SSE/WebSocket streaming, I’d usually structure events like this:

```json
{ "type": "message.started", "message_key": "msg_abc" }
{ "type": "message.delta", "message_key": "msg_abc", "delta": "Hel" }
{ "type": "message.delta", "message_key": "msg_abc", "delta": "lo" }
{ "type": "message.completed", "message_key": "msg_abc", "db_id": 987 }
```

The frontend always merges by `message_key`.

---

## A subtle but important improvement

Use a separate **`stream_id` / `attempt_id`** when retries or regenerations are possible.

That gives you:

* `message_key`: logical message on screen
* `attempt_id`: this particular generation attempt
* `db_id`: persistence row if needed

That avoids pain when:

* user hits “regenerate”
* network reconnects mid-stream
* two streams overlap
* partial output is discarded and replaced

Example:

```ts
{
  messageKey: "msg_abc",
  attemptId: "att_002",
  dbId: 987
}
```

---

## Should you create the DB row before streaming?

Sometimes yes, sometimes no.

### Create row before streaming if you need:

* resumability
* live sync across devices
* auditability
* partial output recovery
* token/accounting tied to a row immediately

### Don’t block on it if you only want fast UX

You can still generate the public ID first and persist later.

Important distinction:
**Generating an ID is cheap. Waiting for DB insertion is what hurts TTFB.**

So you usually do **not** need to wait for persistence just to get a stable ID.

---

## My recommendation

If you’re designing this fresh:

1. **Introduce a stable message public ID available before first token**

   * UUIDv7 or ULID is great

2. **Use that ID everywhere in the stream protocol and frontend**

   * never swap it

3. **Treat DB IDs as internal implementation details**

   * expose them only if truly needed

4. **Optionally add `attempt_id` for retries/regenerations**

That gives you the fastest streaming UX and the cleanest state model.

---

## The short version of the design principle

**Optimistic UI objects need stable identity before the backend has finished persisting them.**
So give them one.

The smell is not “temporary IDs.”
The smell is “we used the wrong kind of ID as the UI identity.”

If you want, I can sketch a minimal React + SSE state shape for this pattern.

