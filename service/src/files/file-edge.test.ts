import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFileOpenControlFrame,
  buildFileOpenOperationRequest,
} from "./file-edge.js";
import type { FileSessionRow } from "./file-session.js";

test("file open request and frame include terminal context when available", () => {
  const session = createFileSessionRow({
    threadId: "11111111-1111-4111-8111-111111111111",
    contentIdentity: { size: 100, modified_ms: 1777132800000 },
    displayMetadata: {
      source: {
        kind: "assistant_message",
        message_id: "22222222-2222-4222-8222-222222222222",
      },
      path_context: {
        schema: "terminal_cwd_v1",
        source: "terminal_runtime_cache",
        reported_by: "tmux_pane_current_path",
        terminal_session_id: "bud-bud-1-thread-11111111-1111-4111-8111-111111111111",
        host_cwd: "/Users/adam/bud/service",
        captured_at: "2026-05-05T19:30:00.000Z",
      },
    },
  });

  assert.deepEqual(
    buildFileOpenOperationRequest({
      session,
      terminalSessionId: "bud-bud-1-thread-11111111-1111-4111-8111-111111111111",
      mode: "range",
      range: { ok: true, rangeStart: 10, rangeEnd: 20 },
    }),
    {
      file_session_id: "fs_test",
      root_key: "workspace",
      relative_path: "service/src/file.ts",
      terminal_session_id: "bud-bud-1-thread-11111111-1111-4111-8111-111111111111",
      resolution_hint: {
        kind: "host_cwd",
        host_cwd: "/Users/adam/bud/service",
        source_message_id: "22222222-2222-4222-8222-222222222222",
      },
      mode: "range",
      range_start: 10,
      range_end: 20,
    },
  );

  assert.deepEqual(
    buildFileOpenControlFrame({
      session,
      terminalSessionId: "bud-bud-1-thread-11111111-1111-4111-8111-111111111111",
      mode: "range",
      range: { ok: true, rangeStart: 10, rangeEnd: 20 },
      operationId: "op_test",
      streamId: "st_test",
      messageId: "msg_test",
      sentAt: 1777132800000,
      initialCreditBytes: 65536,
      maxChunkBytes: 16384,
    }),
    {
      proto: "0.1",
      type: "file_open",
      id: "msg_test",
      ts: 1777132800000,
      ext: {},
      operation_id: "op_test",
      stream_id: "st_test",
      file_session_id: "fs_test",
      terminal_session_id: "bud-bud-1-thread-11111111-1111-4111-8111-111111111111",
      stream_type: "file_read",
      root_key: "workspace",
      relative_path: "service/src/file.ts",
      resolution_hint: {
        kind: "host_cwd",
        host_cwd: "/Users/adam/bud/service",
        source_message_id: "22222222-2222-4222-8222-222222222222",
      },
      mode: "range",
      range_start: 10,
      range_end: 20,
      expected_content_identity: { size: 100, modified_ms: 1777132800000 },
      max_bytes: 1048576,
      initial_credit_bytes: 65536,
      max_chunk_bytes: 16384,
    },
  );
});

test("file open request and frame omit terminal context when unavailable", () => {
  const session = createFileSessionRow({ threadId: null, contentIdentity: null });

  const request = buildFileOpenOperationRequest({
    session,
    terminalSessionId: null,
    mode: "stat",
    range: { ok: true },
  });
  assert.equal("terminal_session_id" in request, false);
  assert.deepEqual(request, {
    file_session_id: "fs_test",
    root_key: "workspace",
    relative_path: "service/src/file.ts",
    mode: "stat",
  });

  const frame = buildFileOpenControlFrame({
    session,
    terminalSessionId: null,
    mode: "stat",
    range: { ok: true },
    operationId: "op_test",
    streamId: "st_test",
    messageId: "msg_test",
    sentAt: 1777132800000,
    initialCreditBytes: 65536,
    maxChunkBytes: 16384,
  });
  assert.equal("terminal_session_id" in frame, false);
  assert.equal("expected_content_identity" in frame, false);
  assert.equal(frame.mode, "stat");
});

function createFileSessionRow(overrides: {
  threadId: string | null;
  contentIdentity: Record<string, unknown> | null;
  displayMetadata?: Record<string, unknown>;
}): FileSessionRow {
  return {
    fileSessionId: "fs_test",
    budId: "bud-1",
    threadId: overrides.threadId,
    operationId: null,
    activeStreamId: null,
    rootKey: "workspace",
    relativePath: "service/src/file.ts",
    permissions: ["stat", "read", "range"],
    maxBytes: 1024 * 1024,
    state: "ready",
    contentIdentity: overrides.contentIdentity,
    displayMetadata: overrides.displayMetadata ?? {},
    auditCorrelationId: "fc_test",
    expiresAt: new Date("2026-05-05T20:00:00.000Z"),
    revokedAt: null,
    revokedByUserId: null,
    revokeReason: null,
    tenantId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-05-05T19:00:00.000Z"),
    updatedAt: new Date("2026-05-05T19:00:00.000Z"),
  };
}
