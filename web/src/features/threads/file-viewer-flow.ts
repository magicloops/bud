import type { ApiOpenThreadFileResponse } from '../../lib/api-types.ts'
import type { OpenFileCandidate } from '../../lib/file-paths.ts'
import {
  chooseFileViewerKind,
  createOpenThreadFileRequestBody,
  createPendingFileEntry,
  decodeFileText,
  fileViewerCandidateKey,
  fileViewerResolvedKey,
  formatFileViewerBytes,
  isLikelyBinaryText,
  languageForFilePath,
  metadataFromFileHead,
  reusedFileViewerEntry,
  sessionFileViewerEntry,
  shouldReuseFileViewerEntry,
  statusForFileResponseCode,
  type FileViewerEntry,
  type FileViewerStatus,
  type FileViewerState,
} from './file-viewer-state.ts'

export type FileViewerFlowTransport = {
  openThreadFile: (
    threadId: string,
    body: Record<string, unknown>,
  ) => Promise<ApiOpenThreadFileResponse>
  fetchFile: (url: string, init: RequestInit & { redirectOnUnauthorized?: boolean }) => Promise<Response>
  shouldAbortForUnauthorized: (response?: Response | null) => boolean
  readResponseErrorMessage: (response: Response, fallback: string) => Promise<string>
}

export type FileViewerFlowStateAccess = {
  getState: () => FileViewerState
  setState: (updater: (current: FileViewerState) => FileViewerState) => void
  updateEntry: (
    key: string,
    updater: (entry: FileViewerEntry | null) => FileViewerEntry,
  ) => void
}

export async function openFileViewerCandidateFlow(args: {
  threadId: string | null
  candidate: OpenFileCandidate
  forceNewSession?: boolean
  stateAccess: FileViewerFlowStateAccess
  transport: FileViewerFlowTransport
  onError: (message: string) => void
}): Promise<void> {
  const threadId = args.threadId
  if (!threadId) {
    args.onError('No thread selected')
    return
  }

  const key = fileViewerCandidateKey(args.candidate)
  const reusableEntry = !args.forceNewSession
    ? findReusableFileViewerEntry(args.stateAccess.getState(), args.candidate, key)
    : null
  if (reusableEntry) {
    args.stateAccess.setState((current) => ({
      ...current,
      active_key: reusableEntry.key,
      entries_by_key: {
        ...current.entries_by_key,
        [reusableEntry.key]: reusedFileViewerEntry(reusableEntry.entry, args.candidate),
      },
    }))
    return
  }

  try {
    await openAndLoadFileViewerCandidate(
      {
        threadId,
        candidate: args.candidate,
        stateAccess: args.stateAccess,
        transport: args.transport,
      },
      key,
    )
  } catch (error) {
    if (isResponseLikeApiError(error) && error.status === 401) {
      return
    }
    const pendingEntry = createPendingFileEntry(args.candidate)
    const status = isResponseLikeApiError(error)
      ? statusForFileResponseCode(error.status)
      : 'error'
    const message = error instanceof Error ? error.message : 'Failed to open file'
    args.stateAccess.updateEntry(key, (entry) => ({
      ...(entry ?? pendingEntry),
      status,
      error_message: message,
    }))
    if (status === 'error') {
      args.onError(message)
    }
  }
}

async function openAndLoadFileViewerCandidate(
  args: {
    threadId: string
    candidate: OpenFileCandidate
    stateAccess: FileViewerFlowStateAccess
    transport: FileViewerFlowTransport
  },
  key: string,
): Promise<void> {
  let attempt = 0
  while (attempt < 2) {
    const pendingEntry = createPendingFileEntry(args.candidate)
    args.stateAccess.updateEntry(key, () => pendingEntry)
    const response = await args.transport.openThreadFile(
      args.threadId,
      createOpenThreadFileRequestBody(args.candidate),
    )
    const sessionEntry = sessionFileViewerEntry(
      pendingEntry,
      response,
      args.candidate.raw_path,
    )
    const resolvedKey = fileViewerResolvedKey(
      response.file_session.path.relative_path,
      args.candidate,
    )
    args.stateAccess.setState((current) => {
      const nextEntries = { ...current.entries_by_key }
      if (resolvedKey !== key) {
        delete nextEntries[key]
      }
      nextEntries[resolvedKey] = { ...sessionEntry, key: resolvedKey }
      return {
        active_key: resolvedKey,
        entries_by_key: nextEntries,
      }
    })
    const status = await loadFileViewerSessionContent({
      key: resolvedKey,
      response,
      baseEntry: { ...sessionEntry, key: resolvedKey },
      stateAccess: args.stateAccess,
      transport: args.transport,
    })
    if (status !== 'content_changed') {
      return
    }
    attempt += 1
  }
}

export async function loadFileViewerSessionContent(args: {
  key: string
  response: ApiOpenThreadFileResponse
  baseEntry: FileViewerEntry
  stateAccess: Pick<FileViewerFlowStateAccess, 'updateEntry'>
  transport: Pick<
    FileViewerFlowTransport,
    'fetchFile' | 'shouldAbortForUnauthorized' | 'readResponseErrorMessage'
  >
}): Promise<FileViewerStatus> {
  const session = args.response.file_session
  const viewer = args.response.viewer
  const relativePath = args.baseEntry.relative_path ?? session.path.relative_path

  args.stateAccess.updateEntry(args.key, (entry) => ({
    ...(entry ?? args.baseEntry),
    status: 'loading_metadata',
    error_message: undefined,
  }))

  const headResponse = await args.transport.fetchFile(session.file_url, {
    method: 'HEAD',
    redirectOnUnauthorized: false,
  })
  if (args.transport.shouldAbortForUnauthorized(headResponse)) {
    return args.baseEntry.status
  }
  if (!headResponse.ok) {
    return applyFileViewerResponseError(args.key, headResponse, args.stateAccess, args.transport)
  }

  const metadata = metadataFromFileHead(headResponse)
  const maxDisplayBytes = viewer.max_display_bytes ?? session.max_bytes
  if (metadata.size !== undefined && metadata.size > maxDisplayBytes) {
    args.stateAccess.updateEntry(args.key, (entry) => ({
      ...(entry ?? args.baseEntry),
      metadata,
      status: 'too_large',
      error_message: `File is larger than ${formatFileViewerBytes(maxDisplayBytes)}.`,
    }))
    return 'too_large'
  }

  args.stateAccess.updateEntry(args.key, (entry) => ({
    ...(entry ?? args.baseEntry),
    metadata,
    status: 'loading_content',
    error_message: undefined,
  }))

  const getResponse = await args.transport.fetchFile(session.file_url, {
    method: 'GET',
    redirectOnUnauthorized: false,
  })
  if (args.transport.shouldAbortForUnauthorized(getResponse)) {
    return args.baseEntry.status
  }
  if (!getResponse.ok) {
    return applyFileViewerResponseError(args.key, getResponse, args.stateAccess, args.transport)
  }

  const bytes = await getResponse.arrayBuffer()
  if (bytes.byteLength > maxDisplayBytes) {
    args.stateAccess.updateEntry(args.key, (entry) => ({
      ...(entry ?? args.baseEntry),
      status: 'too_large',
      error_message: `File is larger than ${formatFileViewerBytes(maxDisplayBytes)}.`,
    }))
    return 'too_large'
  }

  const content = decodeFileText(bytes)
  if (content === null || isLikelyBinaryText(content)) {
    args.stateAccess.updateEntry(args.key, (entry) => ({
      ...(entry ?? args.baseEntry),
      status: 'unsupported_binary',
      error_message: 'This file is not text-readable in the first viewer pass.',
    }))
    return 'unsupported_binary'
  }

  const viewerKind = chooseFileViewerKind(
    relativePath,
    viewer.suggested_kind,
    content,
  )
  args.stateAccess.updateEntry(args.key, (entry) => ({
    ...(entry ?? args.baseEntry),
    metadata,
    status: 'ready',
    content,
    viewer_kind: viewerKind,
    language: viewer.language ?? languageForFilePath(relativePath),
    display_name: viewer.display_name,
    error_message: undefined,
  }))
  return 'ready'
}

function findReusableFileViewerEntry(
  state: FileViewerState,
  candidate: OpenFileCandidate,
  key: string,
): { key: string; entry: FileViewerEntry } | null {
  const preferred = state.entries_by_key[key]
  if (shouldReuseFileViewerEntry(preferred)) {
    return { key, entry: preferred }
  }
  if (candidate.path_kind !== 'absolute_posix') {
    return null
  }
  for (const [entryKey, entry] of Object.entries(state.entries_by_key)) {
    if (entry.raw_path === candidate.raw_path && shouldReuseFileViewerEntry(entry)) {
      return { key: entryKey, entry }
    }
  }
  return null
}

async function applyFileViewerResponseError(
  key: string,
  response: Response,
  stateAccess: Pick<FileViewerFlowStateAccess, 'updateEntry'>,
  transport: Pick<FileViewerFlowTransport, 'readResponseErrorMessage'>,
): Promise<FileViewerStatus> {
  const message = await transport.readResponseErrorMessage(response, `HTTP ${response.status}`)
  const status = statusForFileResponseCode(response.status)
  stateAccess.updateEntry(key, (entry) => ({
    ...(entry ?? {
      key,
      raw_path: key,
      path_kind: 'relative',
      display_path: key,
      relative_path: key,
      status: 'error',
    }),
    status,
    error_message: message,
  }))
  return status
}

function isResponseLikeApiError(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
  )
}
