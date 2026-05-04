import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { cn } from '@/lib/utils'
import type { FileViewerEntry } from '@/features/threads/use-file-viewer'

type FileViewerPaneProps = {
  entry: FileViewerEntry | null
  onClose: () => void
  onReload: () => void
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
    message: 'This first pass only opens workspace-relative file paths.',
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

export function FileViewerPane({ entry, onClose, onReload }: FileViewerPaneProps) {
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
  const title = entry?.display_name ?? entry?.relative_path ?? 'File viewer'

  const metaDetails = useMemo(() => {
    if (!entry) {
      return ''
    }
    const pieces = [
      entry.metadata?.size !== undefined ? formatBytes(entry.metadata.size) : null,
      entry.line ? `L${entry.line}${entry.column ? `:${entry.column}` : ''}` : null,
    ].filter(Boolean)
    return pieces.join('  /  ')
  }, [entry])

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
    <div className="relative flex flex-1 flex-col overflow-hidden border-l-2 border-black bg-background">
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!entry ? (
          <StateMessage status="idle" />
        ) : entry.status === 'ready' ? (
          <ReadyContent entry={entry} />
        ) : (
          <StateMessage
            status={entry.status}
            message={entry.error_message}
            loading={isLoading}
          />
        )}
      </div>

      <div className="flex min-h-16 items-center justify-between border-t-4 border-black bg-card px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="truncate font-mono text-sm font-semibold">{title}</p>
          </div>
          {entry && (
            <div className="flex min-w-0 items-center gap-1 text-[11px] font-mono text-muted-foreground">
              <button
                type="button"
                onClick={() => copyValue('path', entry.relative_path)}
                title={copied === 'path' ? 'Copied path' : 'Copy path'}
                aria-label="Copy file path"
                className={cn(
                  'min-w-0 cursor-pointer truncate text-left underline-offset-2 transition hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  copied === 'path' &&
                    'text-green-600 hover:text-green-600 dark:text-green-400 dark:hover:text-green-400',
                )}
              >
                {entry.relative_path}
              </button>
              {copied === 'path' && (
                <span className="shrink-0 text-green-600 dark:text-green-400">Copied</span>
              )}
              {metaDetails && (
                <span className="shrink-0">/ {metaDetails}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={() => copyValue('content', entry?.content)}
            disabled={!canCopyContent}
            title="Copy content"
            className="rounded-lg border-2 border-black"
          >
            {copied === 'content' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={onReload}
            disabled={!entry || isLoading}
            title="Reload"
            className="rounded-lg border-2 border-black"
          >
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={onClose}
            title="Close file viewer"
            className="rounded-lg border-2 border-black"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function ReadyContent({ entry }: { entry: FileViewerEntry }) {
  if (!entry.content) {
    return <StateMessage status="error" message="File content is empty or unavailable." />
  }

  if (entry.viewer_kind === 'markdown') {
    return (
      <div className="mx-auto max-w-4xl">
        <MarkdownContent content={entry.content} />
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

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`
  }
  return `${bytes} B`
}
