import type { ApiOpenThreadFileResponse } from '../../lib/api-types.ts'
import {
  filePathCandidateDisplayPath,
  type OpenFileCandidate,
} from '../../lib/file-paths.ts'

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
  path_kind: OpenFileCandidate['path_kind']
  raw_path: string
  display_path: string
  relative_path?: string
  requested_path?: string
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

export type FileViewerState = {
  active_key: string | null
  entries_by_key: Record<string, FileViewerEntry>
}

export const EMPTY_FILE_VIEWER_STATE: FileViewerState = {
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

export function fileViewerKey(
  relativePath: string,
  source?: OpenFileCandidate['source'],
): string {
  const baseKey = `workspace:${relativePath}`
  if (source?.kind === 'assistant_message' && source.message_id) {
    return `${baseKey}:source_message:${source.message_id}`
  }
  return baseKey
}

export function fileViewerCandidateKey(candidate: OpenFileCandidate): string {
  if (candidate.path_kind === 'absolute_posix') {
    return `absolute_posix:${candidate.requested_path}`
  }
  return fileViewerKey(candidate.relative_path, candidate.source)
}

export function fileViewerResolvedKey(
  relativePath: string,
  candidate: OpenFileCandidate,
): string {
  return fileViewerKey(
    relativePath,
    candidate.path_kind === 'relative' ? candidate.source : undefined,
  )
}

export function createPendingFileEntry(candidate: OpenFileCandidate): FileViewerEntry {
  const displayPath = filePathCandidateDisplayPath(candidate)
  return {
    key: fileViewerCandidateKey(candidate),
    path_kind: candidate.path_kind,
    raw_path: candidate.raw_path,
    display_path: displayPath,
    ...(candidate.path_kind === 'relative' ? { relative_path: candidate.relative_path } : {}),
    ...(candidate.path_kind === 'absolute_posix' ? { requested_path: candidate.requested_path } : {}),
    ...(candidate.line ? { line: candidate.line } : {}),
    ...(candidate.column ? { column: candidate.column } : {}),
    source: candidate.source,
    status: 'creating_session',
    display_name: displayPath.split('/').at(-1) ?? displayPath,
  }
}

export function shouldReuseFileViewerEntry(
  entry: FileViewerEntry | null | undefined,
  now: number = Date.now(),
): entry is FileViewerEntry {
  return Boolean(
    entry &&
      entry.file_session_id &&
      !isFileSessionExpired(entry.expires_at, now) &&
      entry.status === 'ready',
  )
}

export function reusedFileViewerEntry(
  existing: FileViewerEntry,
  candidate: OpenFileCandidate,
): FileViewerEntry {
  const displayPath = filePathCandidateDisplayPath(candidate)
  return {
    ...existing,
    raw_path: candidate.raw_path,
    path_kind: candidate.path_kind,
    display_path: existing.relative_path ?? displayPath,
    ...(candidate.path_kind === 'absolute_posix' ? { requested_path: candidate.requested_path } : {}),
    ...(candidate.line ? { line: candidate.line } : { line: undefined }),
    ...(candidate.column ? { column: candidate.column } : { column: undefined }),
    source: candidate.source,
  }
}

export function createOpenThreadFileRequestBody(candidate: OpenFileCandidate): Record<string, unknown> {
  return {
    path: candidate.raw_path,
    source: candidate.source,
    ...(candidate.line ? { line: candidate.line } : {}),
    ...(candidate.column ? { column: candidate.column } : {}),
    viewer_intent: 'preview',
  }
}

export function sessionFileViewerEntry(
  pendingEntry: FileViewerEntry,
  response: ApiOpenThreadFileResponse,
  fallbackRawPath: string,
): FileViewerEntry {
  const session = response.file_session
  return {
    ...pendingEntry,
    path_kind: pendingEntry.path_kind,
    raw_path: session.path.raw_path ?? fallbackRawPath,
    relative_path: session.path.relative_path,
    display_path: session.path.relative_path,
    file_session_id: session.file_session_id,
    file_url: session.file_url,
    expires_at: session.expires_at,
    display_name: response.viewer.display_name,
    ...(response.viewer.line ? { line: response.viewer.line } : {}),
    ...(response.viewer.column ? { column: response.viewer.column } : {}),
  }
}

export function statusForFileResponseCode(status: number): FileViewerStatus {
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

export function metadataFromFileHead(
  response: Pick<Response, 'headers'>,
): NonNullable<FileViewerEntry['metadata']> {
  const contentLength = response.headers.get('content-length')
  const size = contentLength ? Number(contentLength) : undefined
  return {
    ...(Number.isFinite(size) && size !== undefined ? { size } : {}),
    content_type: response.headers.get('content-type'),
    etag: response.headers.get('etag'),
    last_modified: response.headers.get('last-modified'),
  }
}

export function decodeFileText(bytes: ArrayBuffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function isLikelyBinaryText(content: string): boolean {
  if (content.length === 0) {
    return false
  }
  const nulCount = [...content.slice(0, 4096)].filter((char) => char === '\0').length
  return nulCount > 0
}

export function chooseFileViewerKind(
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
  if (languageForFilePath(relativePath)) {
    return 'code'
  }
  return content.trimStart().startsWith('#') && extension === '' ? 'markdown' : 'text'
}

export function languageForFilePath(relativePath: string): string | undefined {
  return extensionLanguageMap.get(extensionForPath(relativePath))
}

export function isFileSessionExpired(expiresAt: string | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) {
    return true
  }
  return new Date(expiresAt).getTime() <= now + 5000
}

export function formatFileViewerBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KiB`
  }
  return `${bytes} bytes`
}

function extensionForPath(path: string): string {
  const basename = path.split('/').at(-1) ?? path
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === basename.length - 1) {
    return ''
  }
  return basename.slice(dotIndex).toLowerCase()
}
