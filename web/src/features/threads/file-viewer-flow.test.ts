import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadFileViewerSessionContent,
  openFileViewerCandidateFlow,
  type FileViewerFlowStateAccess,
  type FileViewerFlowTransport,
} from './file-viewer-flow.ts'
import {
  EMPTY_FILE_VIEWER_STATE,
  createPendingFileEntry,
  fileViewerKey,
  statusForFileResponseCode,
  type FileViewerState,
} from './file-viewer-state.ts'
import type { ApiOpenThreadFileResponse } from '../../lib/api-types.ts'
import type { OpenFileCandidate } from '../../lib/file-paths.ts'

test('openFileViewerCandidateFlow creates a session then fetches HEAD before GET', async () => {
  const { stateAccess, getState } = createStateHarness()
  const calls: string[] = []
  const candidate = createCandidate()
  const response = createOpenResponse()
  const transport = createTransport({
    calls,
    open: async (_threadId, body) => {
      calls.push(`POST:${JSON.stringify(body)}`)
      return response
    },
    fetch: async (_url, init) => {
      calls.push(init.method ?? 'GET')
      if (init.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': '24', 'content-type': 'text/typescript' },
        })
      }
      return new Response('export const ok = true\n', { status: 200 })
    },
  })

  await openFileViewerCandidateFlow({
    threadId: 'thread-1',
    candidate,
    stateAccess,
    transport,
    onError: assert.fail,
  })

  assert.equal(calls[0]?.startsWith('POST:'), true)
  assert.equal(calls[1], 'HEAD')
  assert.equal(calls[2], 'GET')
  assert.match(calls[0] ?? '', /"path":"service\/src\/file-viewer.ts:12"/)

  const entry = getActiveEntry(getState())
  assert.equal(entry?.status, 'ready')
  assert.equal(entry?.content, 'export const ok = true\n')
  assert.equal(entry?.viewer_kind, 'code')
  assert.equal(entry?.language, 'typescript')
  assert.equal(entry?.metadata?.size, 24)
})

test('openFileViewerCandidateFlow reuses an unexpired ready session without network calls', async () => {
  const key = fileViewerKey('README.md')
  const { stateAccess, getState, setState } = createStateHarness()
  setState(() => ({
    active_key: null,
    entries_by_key: {
      [key]: {
        key,
        raw_path: 'README.md',
        relative_path: 'README.md',
        file_session_id: 'fs_existing',
        file_url: '/api/files/fs_existing',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        status: 'ready',
        content: '# Existing\n',
        viewer_kind: 'markdown',
      },
    },
  }))

  await openFileViewerCandidateFlow({
    threadId: 'thread-1',
    candidate: {
      raw_path: 'README.md:8',
      relative_path: 'README.md',
      line: 8,
      source: { kind: 'assistant_message' },
    },
    stateAccess,
    transport: createTransport({
      open: async () => assert.fail('open route should not be called for reusable entries'),
      fetch: async () => assert.fail('file edge should not be called for reusable entries'),
    }),
    onError: assert.fail,
  })

  const entry = getActiveEntry(getState())
  assert.equal(entry?.file_session_id, 'fs_existing')
  assert.equal(entry?.raw_path, 'README.md:8')
  assert.equal(entry?.line, 8)
})

test('openFileViewerCandidateFlow does not reuse a ready entry from a different source message', async () => {
  const firstSource = {
    kind: 'assistant_message' as const,
    message_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }
  const secondSource = {
    kind: 'assistant_message' as const,
    message_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }
  const relativePath = 'src/index.ts'
  const firstKey = fileViewerKey(relativePath, firstSource)
  const secondKey = fileViewerKey(relativePath, secondSource)
  const { stateAccess, getState, setState } = createStateHarness()
  setState(() => ({
    active_key: null,
    entries_by_key: {
      [firstKey]: {
        key: firstKey,
        raw_path: relativePath,
        relative_path: relativePath,
        source: firstSource,
        file_session_id: 'fs_existing',
        file_url: '/api/files/fs_existing',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        status: 'ready',
        content: 'from first message\n',
        viewer_kind: 'code',
      },
    },
  }))

  let openCalls = 0
  await openFileViewerCandidateFlow({
    threadId: 'thread-1',
    candidate: {
      raw_path: relativePath,
      relative_path: relativePath,
      source: secondSource,
    },
    stateAccess,
    transport: createTransport({
      open: async () => {
        openCalls += 1
        return createOpenResponse({
          rawPath: relativePath,
          relativePath,
        })
      },
      fetch: async (_url, init) => {
        if (init.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'content-length': '20', 'content-type': 'text/typescript' },
          })
        }
        return new Response('from second message\n', { status: 200 })
      },
    }),
    onError: assert.fail,
  })

  assert.equal(openCalls, 1)
  assert.equal(getState().entries_by_key[firstKey]?.file_session_id, 'fs_existing')
  const activeEntry = getActiveEntry(getState())
  assert.equal(activeEntry?.key, secondKey)
  assert.equal(activeEntry?.file_session_id, 'fs_test')
  assert.equal(activeEntry?.content, 'from second message\n')
})

test('loadFileViewerSessionContent stops after HEAD when metadata exceeds the display cap', async () => {
  const { stateAccess, getState } = createStateHarness()
  const response = createOpenResponse({ maxDisplayBytes: 16 })
  const baseEntry = createPendingFileEntry(createCandidate())
  const calls: string[] = []

  await loadFileViewerSessionContent({
    key: baseEntry.key,
    response,
    baseEntry,
    stateAccess,
    transport: createTransport({
      calls,
      fetch: async (_url, init) => {
        calls.push(init.method ?? 'GET')
        return new Response(null, {
          status: 200,
          headers: { 'content-length': '17' },
        })
      },
    }),
  })

  assert.deepEqual(calls, ['HEAD'])
  const entry = getActiveEntry(getState())
  assert.equal(entry?.status, 'too_large')
  assert.equal(entry?.error_message, 'File is larger than 16 bytes.')
})

test('loadFileViewerSessionContent detects binary content and maps response statuses', async () => {
  const { stateAccess, getState } = createStateHarness()
  const response = createOpenResponse()
  const baseEntry = createPendingFileEntry(createCandidate())

  await loadFileViewerSessionContent({
    key: baseEntry.key,
    response,
    baseEntry,
    stateAccess,
    transport: createTransport({
      fetch: async (_url, init) => {
        if (init.method === 'HEAD') {
          return new Response(null, { status: 200, headers: { 'content-length': '3' } })
        }
        return new Response(new Uint8Array([65, 0, 66]), { status: 200 })
      },
    }),
  })

  assert.equal(getActiveEntry(getState())?.status, 'unsupported_binary')
  assert.equal(statusForFileResponseCode(400), 'invalid_path')
  assert.equal(statusForFileResponseCode(403), 'denied')
  assert.equal(statusForFileResponseCode(404), 'not_found')
  assert.equal(statusForFileResponseCode(410), 'expired')
  assert.equal(statusForFileResponseCode(413), 'too_large')
  assert.equal(statusForFileResponseCode(424), 'offline')
  assert.equal(statusForFileResponseCode(503), 'offline')
})

function createStateHarness() {
  let state = EMPTY_FILE_VIEWER_STATE
  const setState = (updater: (current: FileViewerState) => FileViewerState) => {
    state = updater(state)
  }
  const stateAccess: FileViewerFlowStateAccess = {
    getState: () => state,
    setState,
    updateEntry: (key, updater) => {
      setState((current) => ({
        active_key: key,
        entries_by_key: {
          ...current.entries_by_key,
          [key]: updater(current.entries_by_key[key] ?? null),
        },
      }))
    },
  }
  return {
    stateAccess,
    getState: () => state,
    setState,
  }
}

function getActiveEntry(state: FileViewerState) {
  return state.active_key ? state.entries_by_key[state.active_key] : null
}

function createCandidate(): OpenFileCandidate {
  return {
    raw_path: 'service/src/file-viewer.ts:12',
    relative_path: 'service/src/file-viewer.ts',
    line: 12,
    source: {
      kind: 'assistant_message',
      message_id: '22222222-2222-4222-8222-222222222222',
      client_id: '33333333-3333-4333-8333-333333333333',
    },
  }
}

function createOpenResponse(
  options: { maxDisplayBytes?: number; rawPath?: string; relativePath?: string } = {},
): ApiOpenThreadFileResponse {
  const relativePath = options.relativePath ?? 'service/src/file-viewer.ts'
  return {
    file_session: {
      file_session_id: 'fs_test',
      bud_id: 'bud-1',
      thread_id: 'thread-1',
      root: { key: 'workspace' },
      path: {
        raw_path: options.rawPath ?? 'service/src/file-viewer.ts:12',
        relative_path: relativePath,
      },
      permissions: ['stat', 'read', 'range'],
      state: 'ready',
      file_url: '/api/files/fs_test',
      max_bytes: 1024 * 1024,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    viewer: {
      suggested_kind: 'code',
      language: 'typescript',
      display_name: relativePath.split('/').at(-1) ?? relativePath,
      line: 12,
      max_display_bytes: options.maxDisplayBytes ?? 1024 * 1024,
    },
  }
}

function createTransport(options: {
  calls?: string[]
  open?: FileViewerFlowTransport['openThreadFile']
  fetch?: FileViewerFlowTransport['fetchFile']
}): FileViewerFlowTransport {
  return {
    openThreadFile: options.open ?? (async () => createOpenResponse()),
    fetchFile:
      options.fetch ??
      (async (_url, init) => {
        options.calls?.push(init.method ?? 'GET')
        return new Response(null, { status: 200 })
      }),
    shouldAbortForUnauthorized: () => false,
    readResponseErrorMessage: async (response, fallback) => {
      if (response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.json().catch(() => null)
        if (body && typeof body === 'object' && 'error' in body) {
          return String(body.error)
        }
      }
      return fallback
    },
  }
}
