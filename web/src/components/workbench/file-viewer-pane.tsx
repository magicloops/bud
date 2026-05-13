import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  Copy,
  FileText,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownContent } from '@/components/message-renderers/roles/markdown-content'
import { CodeBlock } from '@/components/ui/code-block'
import { toOpenFileCandidate, type OpenFileCandidate } from '@/lib/file-paths'
import { cn } from '@/lib/utils'
import type { FileViewerEntry } from '@/features/threads/use-file-viewer'

type FileViewerPaneProps = {
  entry: FileViewerEntry | null
  onClose: () => void
  onReload: () => void
  onOpenMarkdownPreviewFile?: (candidate: OpenFileCandidate) => void
}

const statusCopy: Record<string, { title: string; message: string }> = {
  idle: {
    title: 'No file selected',
    message: 'Click a file path in the thread to preview it here.',
  },
  creating_session: {
    title: 'Opening file',
    message: 'Creating a short-lived file session.',
  },
  loading_metadata: {
    title: 'Reading metadata',
    message: 'Checking size and availability.',
  },
  loading_content: {
    title: 'Loading file',
    message: 'Fetching content from the Bud host.',
  },
  invalid_path: {
    title: 'Unsupported path',
    message: 'This path format is not supported by the file viewer.',
  },
  not_found: {
    title: 'File not found',
    message: 'The Bud host could not find this file.',
  },
  denied: {
    title: 'Access denied',
    message: 'The Bud daemon denied this file request.',
  },
  too_large: {
    title: 'File too large',
    message: 'This file is larger than the first-pass viewer limit.',
  },
  expired: {
    title: 'Session expired',
    message: 'Reload to create a new file session.',
  },
  offline: {
    title: 'Bud unavailable',
    message: 'The Bud host is offline or file transport is unavailable.',
  },
  content_changed: {
    title: 'File changed',
    message: 'The file changed while Bud was reading it. Reload to try again.',
  },
  unsupported_binary: {
    title: 'Unsupported file',
    message: 'Binary files are not supported in the first viewer pass.',
  },
  error: {
    title: 'Unable to open file',
    message: 'The file viewer hit an unexpected error.',
  },
}

export function FileViewerPane({
  entry,
  onClose,
  onReload,
  onOpenMarkdownPreviewFile,
}: FileViewerPaneProps) {
  const [copied, setCopied] = useState<'path' | 'content' | null>(null)
  const copyResetRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current)
      }
    }
  }, [])

  const isLoading =
    entry?.status === 'creating_session' ||
    entry?.status === 'loading_metadata' ||
    entry?.status === 'loading_content'
  const canCopyContent = entry?.status === 'ready' && typeof entry.content === 'string'
  const displayName = entry
    ? entry.display_name ?? getFilename(entry.relative_path ?? entry.display_path)
    : 'File viewer'
  const copyPath = entry ? entry.relative_path ?? entry.raw_path : undefined

  const copyValue = useCallback(async (kind: 'path' | 'content', value: string | undefined) => {
    if (!value) {
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current)
      }
      copyResetRef.current = window.setTimeout(() => setCopied(null), 1500)
    } catch (error) {
      console.error('Failed to copy file viewer value', error)
    }
  }, [])

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-background">
      <div className="flex h-10 items-center justify-between gap-3 border-b-2 border-black bg-background px-3">
        <div className="flex min-w-0 items-center gap-2 font-mono">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          {entry ? (
            <button
              type="button"
              onClick={() => copyValue('path', copyPath)}
              title={copied === 'path' ? 'Copied path' : `Copy ${copyPath}`}
              aria-label="Copy file path"
              className={cn(
                'min-w-0 cursor-pointer truncate text-left text-sm font-semibold underline-offset-2 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                copied === 'path' &&
                  'text-green-600 hover:text-green-600 dark:text-green-400 dark:hover:text-green-400',
              )}
            >
              {displayName}
            </button>
          ) : (
            <p className="truncate text-sm font-semibold">{displayName}</p>
          )}
          {copied === 'path' && (
            <span className="shrink-0 text-xs text-green-600 dark:text-green-400">Copied</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => copyValue('content', entry?.content)}
            disabled={!canCopyContent}
            title="Copy content"
            className="h-7 w-7 cursor-pointer rounded-md bg-transparent text-foreground hover:bg-black/10 dark:hover:bg-white/10"
          >
            {copied === 'content' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onReload}
            disabled={!entry || isLoading}
            title="Reload"
            className="h-7 w-7 cursor-pointer rounded-md bg-transparent text-foreground hover:bg-black/10 dark:hover:bg-white/10"
          >
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onClose}
            title="Close file viewer"
            className="h-7 w-7 cursor-pointer rounded-md bg-transparent text-foreground hover:bg-black/10 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!entry ? (
          <StateMessage status="idle" />
        ) : entry.status === 'ready' ? (
          <ReadyContent
            entry={entry}
            onOpenMarkdownPreviewFile={onOpenMarkdownPreviewFile}
          />
        ) : (
          <StateMessage
            status={entry.status}
            message={entry.error_message}
            loading={isLoading}
          />
        )}
      </div>
    </div>
  )
}

function ReadyContent({
  entry,
  onOpenMarkdownPreviewFile,
}: {
  entry: FileViewerEntry
  onOpenMarkdownPreviewFile?: (candidate: OpenFileCandidate) => void
}) {
  if (!entry.content) {
    return <StateMessage status="error" message="File content is empty or unavailable." />
  }

  if (entry.viewer_kind === 'markdown') {
    const previewSource = {
      kind: 'markdown_preview' as const,
      ...(entry.source?.message_id ? { message_id: entry.source.message_id } : {}),
      ...(entry.source?.client_id ? { client_id: entry.source.client_id } : {}),
    }
    return (
      <div className="mx-auto max-w-4xl">
        <MarkdownContent
          content={entry.content}
          inertLocalLinks
          allowedFilePathKinds={['absolute_posix']}
          fileActions={onOpenMarkdownPreviewFile
            ? {
                source: previewSource,
                onOpenFileCandidate: (candidate) => {
                  onOpenMarkdownPreviewFile(toOpenFileCandidate(candidate, previewSource))
                },
              }
            : undefined}
        />
      </div>
    )
  }

  if (entry.viewer_kind === 'code') {
    return (
      <CodeBlock
        code={entry.content}
        language={entry.language ?? 'text'}
        className="text-sm"
      />
    )
  }

  return (
    <pre className="whitespace-pre-wrap break-words rounded-lg border-2 border-black bg-card p-4 font-mono text-xs leading-relaxed text-card-foreground">
      {entry.content}
    </pre>
  )
}

function StateMessage({
  status,
  message,
  loading = false,
}: {
  status: string
  message?: string
  loading?: boolean
}) {
  const copy = statusCopy[status] ?? statusCopy.error
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center">
      <div className="max-w-sm rounded-lg border-3 border-black bg-card p-5 text-center shadow-[4px_4px_0px_rgba(0,0,0,1)]">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border-2 border-black bg-background">
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <AlertCircle className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <p className="font-mono text-sm font-semibold">{copy.title}</p>
        <p className="mt-2 text-sm text-muted-foreground">{message || copy.message}</p>
      </div>
    </div>
  )
}

function getFilename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
