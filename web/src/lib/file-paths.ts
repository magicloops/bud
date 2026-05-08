export type FilePathSourceSurface = 'markdown_link' | 'inline_code' | 'plain_text'

export type FilePathCandidate = {
  raw_path: string
  relative_path: string
  line?: number
  column?: number
  source_surface: FilePathSourceSurface
}

export type OpenFileSource = {
  kind: 'assistant_message' | 'markdown_preview' | 'unknown'
  message_id?: string
  client_id?: string
  text_range?: {
    start: number
    end: number
  }
}

export type OpenFileCandidate = {
  raw_path: string
  relative_path: string
  line?: number
  column?: number
  source: OpenFileSource
}

const knownFileNames = new Set([
  'dockerfile',
  'makefile',
  'readme',
  'license',
  'gemfile',
  'rakefile',
])

const knownExtensions = new Set([
  '.c',
  '.cc',
  '.cfg',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.lock',
  '.log',
  '.md',
  '.mdx',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
])

export function parseFilePathCandidate(
  input: string | null | undefined,
  sourceSurface: FilePathSourceSurface,
): FilePathCandidate | null {
  const rawInput = trimCandidate(input ?? '')
  if (!rawInput || rawInput.includes('\0')) {
    return null
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawInput) || /^mailto:/i.test(rawInput)) {
    return null
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawInput)) {
    return null
  }
  if (/^[a-zA-Z]:([/\\]|$)/.test(rawInput) || rawInput.includes('\\')) {
    return null
  }

  let rawPath = rawInput
  let line: number | undefined
  let column: number | undefined

  const hashLineMatch = /^(?<path>.+?)#L(?<line>\d+)(?:-L?\d+)?$/i.exec(rawPath)
  if (hashLineMatch?.groups) {
    rawPath = hashLineMatch.groups.path
    const parsedLine = parsePositiveInteger(hashLineMatch.groups.line)
    if (parsedLine === null) {
      return null
    }
    line = parsedLine
  } else {
    const colonLineColumnMatch = /^(?<path>.+):(?<line>\d+):(?<column>\d+)$/.exec(rawPath)
    const colonLineMatch = /^(?<path>.+):(?<line>\d+)$/.exec(rawPath)
    const match = colonLineColumnMatch ?? colonLineMatch
    if (match?.groups) {
      rawPath = match.groups.path
      const parsedLine = parsePositiveInteger(match.groups.line)
      if (parsedLine === null) {
        return null
      }
      line = parsedLine

      if (match.groups.column) {
        const parsedColumn = parsePositiveInteger(match.groups.column)
        if (parsedColumn === null) {
          return null
        }
        column = parsedColumn
      }
    }
  }

  if (rawPath.endsWith('/')) {
    return null
  }

  const relativePath = normalizeRelativeFilePath(rawPath)
  if (!relativePath || !looksLikeFilePath(relativePath, Boolean(line))) {
    return null
  }

  return {
    raw_path: rawInput,
    relative_path: relativePath,
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
    source_surface: sourceSurface,
  }
}

function normalizeRelativeFilePath(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('~')) {
    return null
  }

  const parts: string[] = []
  for (const part of trimmed.split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      return null
    }
    parts.push(part)
  }

  return parts.length > 0 ? parts.join('/') : null
}

function looksLikeFilePath(relativePath: string, hasLineSuffix: boolean): boolean {
  const basename = relativePath.split('/').at(-1)?.toLowerCase() ?? ''
  if (!basename) {
    return false
  }
  if (knownFileNames.has(basename)) {
    return true
  }

  const extension = extensionForPath(basename)
  if (extension && knownExtensions.has(extension)) {
    return true
  }

  return hasLineSuffix && relativePath.includes('/')
}

function extensionForPath(path: string): string {
  const dotIndex = path.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === path.length - 1) {
    return ''
  }
  return path.slice(dotIndex).toLowerCase()
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function trimCandidate(input: string): string {
  return input
    .trim()
    .replace(/^[`"'([{<]+/, '')
    .replace(/[`"',.;:!?)}\]>]+$/, '')
}
