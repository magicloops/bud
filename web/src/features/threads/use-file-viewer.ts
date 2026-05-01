import { useCallback, useEffect, useRef, useState } from 'react'
import {
  apiFetch,
  apiFetchJson,
  isApiError,
  readResponseErrorMessage,
} from '@/lib/transport'
import type { ApiFileSession, ApiOpenThreadFileResponse } from '@/lib/api-types'
import type { OpenFileCandidate } from '@/lib/file-paths'

export type FileViewerStatus =
  | 'idle'
  | 'creating_session'
  | 'loading_metadata'
  | 'loading_content'
  | 'ready'
  | 'invalid_path'
  | 'not_found'
  | 'denied'
  | 'too_large'
  | 'expired'
  | 'offline'
  | 'content_changed'
  | 'unsupported_binary'
  | 'error'

export type FileViewerKind = 'markdown' | 'code' | 'text'

export type FileViewerEntry = {
  key: string
  raw_path: string
  relative_path: string
  line?: number
  column?: number
  source?: OpenFileCandidate['source']
  file_session_id?: string
  file_url?: string
  expires_at?: string
  status: FileViewerStatus
  metadata?: {
    size?: number
    content_type?: string | null
    etag?: string | null
    last_modified?: string | null
  }
  content?: string
  viewer_kind?: FileViewerKind
  language?: string
  display_name?: string
  error_message?: string
}

type FileViewerState = {
  active_key: string | null
  entries_by_key: Record<string, FileViewerEntry>
}

type UseFileViewerArgs = {
  threadId: string | null
  onError: (message: string) => void
  shouldAbortForUnauthorized: (response?: Response | null) => boolean
}

const EMPTY_STATE: FileViewerState = {
  active_key: null,
  entries_by_key: {},
}

const extensionLanguageMap = new Map<string, string>([
  ['.c', 'c'],
  ['.cc', 'cpp'],
  ['.cpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.css', 'css'],
  ['.go', 'go'],
  ['.html', 'html'],
  ['.java', 'java'],
  ['.js', 'javascript'],
  ['.json', 'json'],
  ['.jsx', 'jsx'],
  ['.kt', 'kotlin'],
  ['.mjs', 'javascript'],
  ['.py', 'python'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.sh', 'bash'],
  ['.sql', 'sql'],
  ['.swift', 'swift'],
  ['.toml', 'toml'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
])

export function useFileViewer({
  threadId,
  onError,
  shouldAbortForUnauthorized,
}: UseFileViewerArgs) {
  const [state, setState] = useState<FileViewerState>(EMPTY_STATE)
  const stateRef = useRef<FileViewerState>(EMPTY_STATE)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    setState(EMPTY_STATE)
  }, [threadId])

  const updateEntry = useCallback((key: string, updater: (entry: FileViewerEntry | null) => FileViewerEntry) => {
    setState((current) => {
      const nextEntry = updater(current.entries_by_key[key] ?? null)
      return {
        active_key: key,
        entries_by_key: {
          ...current.entries_by_key,
          [key]: nextEntry,
        },
      }
    })
  }, [])

  const loadSessionContent = useCallback(async (
    key: string,
    session: ApiFileSession,
    viewer: ApiOpenThreadFileResponse['viewer'],
    baseEntry: FileViewerEntry,
  ) => {
    updateEntry(key, (entry) => ({
      ...(entry ?? baseEntry),
      status: 'loading_metadata',
      error_message: undefined,
    }))

    const headResponse = await apiFetch(session.file_url, {
      method: 'HEAD',
      redirectOnUnauthorized: false,
    })
    if (shouldAbortForUnauthorized(headResponse)) {
      return
    }
    if (!headResponse.ok) {
      await applyResponseError(key, headResponse, updateEntry)
      return
    }

    const metadata = metadataFromHead(headResponse)
    const maxDisplayBytes = viewer.max_display_bytes ?? session.max_bytes
    if (metadata.size !== undefined && metadata.size > maxDisplayBytes) {
      updateEntry(key, (entry) => ({
        ...(entry ?? baseEntry),
        metadata,
        status: 'too_large',
        error_message: `File is larger than ${formatBytes(maxDisplayBytes)}.`,
      }))
      return
    }

    updateEntry(key, (entry) => ({
      ...(entry ?? baseEntry),
      metadata,
      status: 'loading_content',
      error_message: undefined,
    }))

    const getResponse = await apiFetch(session.file_url, {
      method: 'GET',
      redirectOnUnauthorized: false,
    })
    if (shouldAbortForUnauthorized(getResponse)) {
      return
    }
    if (!getResponse.ok) {
      await applyResponseError(key, getResponse, updateEntry)
      return
    }

    const bytes = await getResponse.arrayBuffer()
    if (bytes.byteLength > maxDisplayBytes) {
      updateEntry(key, (entry) => ({
        ...(entry ?? baseEntry),
        status: 'too_large',
        error_message: `File is larger than ${formatBytes(maxDisplayBytes)}.`,
      }))
      return
    }

    const content = decodeText(bytes)
    if (content === null || isLikelyBinary(content)) {
      updateEntry(key, (entry) => ({
        ...(entry ?? baseEntry),
        status: 'unsupported_binary',
        error_message: 'This file is not text-readable in the first viewer pass.',
      }))
      return
    }

    const viewerKind = chooseViewerKind(baseEntry.relative_path, viewer.suggested_kind, content)
    updateEntry(key, (entry) => ({
      ...(entry ?? baseEntry),
      metadata,
      status: 'ready',
      content,
      viewer_kind: viewerKind,
      language: viewer.language ?? languageForPath(baseEntry.relative_path),
      display_name: viewer.display_name,
      error_message: undefined,
    }))
  }, [shouldAbortForUnauthorized, updateEntry])

  const openFileCandidate = useCallback(async (
    candidate: OpenFileCandidate,
    options: { forceNewSession?: boolean } = {},
  ) => {
    if (!threadId) {
      onError('No thread selected')
      return
    }

    const key = `workspace:${candidate.relative_path}`
    const existing = stateRef.current.entries_by_key[key]
    if (
      !options.forceNewSession &&
      existing &&
      existing.file_session_id &&
      !isExpired(existing.expires_at) &&
      existing.status === 'ready'
    ) {
      setState((current) => ({
        ...current,
        active_key: key,
        entries_by_key: {
          ...current.entries_by_key,
          [key]: {
            ...existing,
            raw_path: candidate.raw_path,
            ...(candidate.line ? { line: candidate.line } : { line: undefined }),
            ...(candidate.column ? { column: candidate.column } : { column: undefined }),
            source: candidate.source,
          },
        },
      }))
      return
    }

    const pendingEntry: FileViewerEntry = {
      key,
      raw_path: candidate.raw_path,
      relative_path: candidate.relative_path,
      ...(candidate.line ? { line: candidate.line } : {}),
      ...(candidate.column ? { column: candidate.column } : {}),
      source: candidate.source,
      status: 'creating_session',
      display_name: candidate.relative_path.split('/').at(-1) ?? candidate.relative_path,
    }
    updateEntry(key, () => pendingEntry)

    try {
      const response = await apiFetchJson<ApiOpenThreadFileResponse>(
        `/api/threads/${threadId}/files/open`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: candidate.raw_path,
            source: candidate.source,
            ...(candidate.line ? { line: candidate.line } : {}),
            ...(candidate.column ? { column: candidate.column } : {}),
            viewer_intent: 'preview',
          }),
          redirectOnUnauthorized: false,
        },
      )

      const session = response.file_session
      const sessionEntry: FileViewerEntry = {
        ...pendingEntry,
        raw_path: session.path.raw_path ?? candidate.raw_path,
        relative_path: session.path.relative_path,
        file_session_id: session.file_session_id,
        file_url: session.file_url,
        expires_at: session.expires_at,
        display_name: response.viewer.display_name,
        ...(response.viewer.line ? { line: response.viewer.line } : {}),
        ...(response.viewer.column ? { column: response.viewer.column } : {}),
      }
      updateEntry(key, () => sessionEntry)
      await loadSessionContent(key, session, response.viewer, sessionEntry)
    } catch (error) {
      if (isApiError(error, 401)) {
        return
      }
      const status = isApiError(error) ? statusForCode(error.status) : 'error'
      const message = error instanceof Error ? error.message : 'Failed to open file'
      updateEntry(key, (entry) => ({
        ...(entry ?? pendingEntry),
        status,
        error_message: message,
      }))
      if (status === 'error') {
        onError(message)
      }
    }
  }, [loadSessionContent, onError, threadId, updateEntry])

  const reloadActiveFile = useCallback(() => {
    const activeKey = stateRef.current.active_key
    const activeEntry = activeKey ? stateRef.current.entries_by_key[activeKey] : null
    if (!activeEntry) {
      return
    }
    void openFileCandidate(
      {
        raw_path: activeEntry.raw_path,
        relative_path: activeEntry.relative_path,
        ...(activeEntry.line ? { line: activeEntry.line } : {}),
        ...(activeEntry.column ? { column: activeEntry.column } : {}),
        source: activeEntry.source ?? { kind: 'unknown' },
      },
      { forceNewSession: true },
    )
  }, [openFileCandidate])

  const closeFileViewer = useCallback(() => {
    setState((current) => ({
      ...current,
      active_key: null,
    }))
  }, [])

  const activeEntry = state.active_key ? state.entries_by_key[state.active_key] ?? null : null

  return {
    activeEntry,
    openFileCandidate,
    reloadActiveFile,
    closeFileViewer,
  }
}

async function applyResponseError(
  key: string,
  response: Response,
  updateEntry: (key: string, updater: (entry: FileViewerEntry | null) => FileViewerEntry) => void,
) {
  const message = await readResponseErrorMessage(response, `HTTP ${response.status}`)
  updateEntry(key, (entry) => ({
    ...(entry ?? {
      key,
      raw_path: key,
      relative_path: key,
      status: 'error',
    }),
    status: statusForCode(response.status),
    error_message: message,
  }))
}

function statusForCode(status: number): FileViewerStatus {
  switch (status) {
    case 400:
      return 'invalid_path'
    case 403:
      return 'denied'
    case 404:
      return 'not_found'
    case 409:
    case 416:
      return 'content_changed'
    case 410:
      return 'expired'
    case 413:
      return 'too_large'
    case 424:
    case 503:
      return 'offline'
    default:
      return 'error'
  }
}

function metadataFromHead(response: Response): NonNullable<FileViewerEntry['metadata']> {
  const contentLength = response.headers.get('content-length')
  const size = contentLength ? Number(contentLength) : undefined
  return {
    ...(Number.isFinite(size) && size !== undefined ? { size } : {}),
    content_type: response.headers.get('content-type'),
    etag: response.headers.get('etag'),
    last_modified: response.headers.get('last-modified'),
  }
}

function decodeText(bytes: ArrayBuffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function isLikelyBinary(content: string): boolean {
  if (content.length === 0) {
    return false
  }
  const nulCount = [...content.slice(0, 4096)].filter((char) => char === '\0').length
  return nulCount > 0
}

function chooseViewerKind(
  relativePath: string,
  suggestedKind: ApiOpenThreadFileResponse['viewer']['suggested_kind'],
  content: string,
): FileViewerKind {
  const extension = extensionForPath(relativePath)
  if (extension === '.md' || extension === '.markdown' || extension === '.mdx') {
    return 'markdown'
  }
  if (suggestedKind === 'markdown' || suggestedKind === 'code' || suggestedKind === 'text') {
    return suggestedKind
  }
  if (languageForPath(relativePath)) {
    return 'code'
  }
  return content.trimStart().startsWith('#') && extension === '' ? 'markdown' : 'text'
}

function languageForPath(relativePath: string): string | undefined {
  return extensionLanguageMap.get(extensionForPath(relativePath))
}

function extensionForPath(relativePath: string): string {
  const basename = relativePath.split('/').at(-1) ?? relativePath
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === basename.length - 1) {
    return ''
  }
  return basename.slice(dotIndex).toLowerCase()
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return true
  }
  return new Date(expiresAt).getTime() <= Date.now() + 5000
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KiB`
  }
  return `${bytes} bytes`
}
