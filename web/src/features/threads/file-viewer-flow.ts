import type { ApiOpenThreadFileResponse } from '../../lib/api-types.ts'
import type { OpenFileCandidate } from '../../lib/file-paths.ts'
import {
  chooseFileViewerKind,
  createOpenThreadFileRequestBody,
  createPendingFileEntry,
  decodeFileText,
  fileViewerKey,
  formatFileViewerBytes,
  isLikelyBinaryText,
  languageForFilePath,
  metadataFromFileHead,
  reusedFileViewerEntry,
  sessionFileViewerEntry,
  shouldReuseFileViewerEntry,
  statusForFileResponseCode,
  type FileViewerEntry,
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
  if (!args.threadId) {
    args.onError('No thread selected')
    return
  }

  const key = fileViewerKey(args.candidate.relative_path)
  const existing = args.stateAccess.getState().entries_by_key[key]
  if (!args.forceNewSession && shouldReuseFileViewerEntry(existing)) {
    args.stateAccess.setState((current) => ({
      ...current,
      active_key: key,
      entries_by_key: {
        ...current.entries_by_key,
        [key]: reusedFileViewerEntry(existing, args.candidate),
      },
    }))
    return
  }

  const pendingEntry = createPendingFileEntry(args.candidate)
  args.stateAccess.updateEntry(key, () => pendingEntry)

  try {
    const response = await args.transport.openThreadFile(
      args.threadId,
      createOpenThreadFileRequestBody(args.candidate),
    )
    const sessionEntry = sessionFileViewerEntry(
      pendingEntry,
      response,
      args.candidate.raw_path,
    )
    args.stateAccess.updateEntry(key, () => sessionEntry)
    await loadFileViewerSessionContent({
      key,
      response,
      baseEntry: sessionEntry,
      stateAccess: args.stateAccess,
      transport: args.transport,
    })
  } catch (error) {
    if (isResponseLikeApiError(error) && error.status === 401) {
      return
    }
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

export async function loadFileViewerSessionContent(args: {
  key: string
  response: ApiOpenThreadFileResponse
  baseEntry: FileViewerEntry
  stateAccess: Pick<FileViewerFlowStateAccess, 'updateEntry'>
  transport: Pick<
    FileViewerFlowTransport,
    'fetchFile' | 'shouldAbortForUnauthorized' | 'readResponseErrorMessage'
  >
}): Promise<void> {
  const session = args.response.file_session
  const viewer = args.response.viewer

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
    return
  }
  if (!headResponse.ok) {
    await applyFileViewerResponseError(args.key, headResponse, args.stateAccess, args.transport)
    return
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
    return
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
    return
  }
  if (!getResponse.ok) {
    await applyFileViewerResponseError(args.key, getResponse, args.stateAccess, args.transport)
    return
  }

  const bytes = await getResponse.arrayBuffer()
  if (bytes.byteLength > maxDisplayBytes) {
    args.stateAccess.updateEntry(args.key, (entry) => ({
      ...(entry ?? args.baseEntry),
      status: 'too_large',
      error_message: `File is larger than ${formatFileViewerBytes(maxDisplayBytes)}.`,
    }))
    return
  }

  const content = decodeFileText(bytes)
  if (content === null || isLikelyBinaryText(content)) {
    args.stateAccess.updateEntry(args.key, (entry) => ({
      ...(entry ?? args.baseEntry),
      status: 'unsupported_binary',
      error_message: 'This file is not text-readable in the first viewer pass.',
    }))
    return
  }

  const viewerKind = chooseFileViewerKind(
    args.baseEntry.relative_path,
    viewer.suggested_kind,
    content,
  )
  args.stateAccess.updateEntry(args.key, (entry) => ({
    ...(entry ?? args.baseEntry),
    metadata,
    status: 'ready',
    content,
    viewer_kind: viewerKind,
    language: viewer.language ?? languageForFilePath(args.baseEntry.relative_path),
    display_name: viewer.display_name,
    error_message: undefined,
  }))
}

async function applyFileViewerResponseError(
  key: string,
  response: Response,
  stateAccess: Pick<FileViewerFlowStateAccess, 'updateEntry'>,
  transport: Pick<FileViewerFlowTransport, 'readResponseErrorMessage'>,
) {
  const message = await transport.readResponseErrorMessage(response, `HTTP ${response.status}`)
  stateAccess.updateEntry(key, (entry) => ({
    ...(entry ?? {
      key,
      raw_path: key,
      relative_path: key,
      status: 'error',
    }),
    status: statusForFileResponseCode(response.status),
    error_message: message,
  }))
}

function isResponseLikeApiError(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
  )
}
