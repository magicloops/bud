import { memo, useMemo, type ReactNode } from 'react'
import {
  Streamdown,
  defaultRemarkPlugins,
  type Components,
  type ControlsConfig,
  type PluginConfig,
} from 'streamdown'
import { code } from '@streamdown/code'
import { mermaid } from '@streamdown/mermaid'
import { math } from '@streamdown/math'
import remarkBreaks from 'remark-breaks'
import { FileText } from 'lucide-react'
import { InlineCode } from '@/components/ui/inline-code'
import { filePathCandidateDisplayPath } from '@/lib/file-paths'
import type { MessageContentRendererProps } from '../types'
import {
  type AllowedFilePathKind,
  createFileOpenClickHandler,
  getMarkdownLinkAction,
  getInlineCodeFileCandidate,
} from './markdown-file-actions'

type MarkdownContentProps = MessageContentRendererProps & {
  inertLocalLinks?: boolean
  allowedFilePathKinds?: readonly AllowedFilePathKind[]
}

const streamdownPlugins: PluginConfig = { code, mermaid, math }
const streamdownControls: ControlsConfig = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: false },
}
const streamdownRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks]

/**
 * Shared markdown renderer for assistant and user messages.
 * Includes streaming-safe Markdown, GFM, code highlighting, Mermaid, math, and Bud file actions.
 */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  fileActions,
  isStreaming = false,
  inertLocalLinks = false,
  allowedFilePathKinds,
}: MarkdownContentProps) {
  const components = useMemo<Components>(() => ({
    inlineCode: ({ children }) => {
      const inlineText = reactNodeText(children)
      const fileCandidate = getInlineCodeFileCandidate(inlineText, fileActions, {
        allowedPathKinds: allowedFilePathKinds,
      })
      if (fileActions && fileCandidate) {
        const displayPath = filePathCandidateDisplayPath(fileCandidate)
        return (
          <span className="align-baseline [overflow-wrap:anywhere]">
            <InlineCode className="max-w-full [overflow-wrap:anywhere]">{children}</InlineCode>
            <button
              type="button"
              onClick={createFileOpenClickHandler(fileActions, fileCandidate)}
              className="ml-1 inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-border bg-background align-text-bottom text-muted-foreground transition hover:bg-muted hover:text-foreground"
              title={`Open ${displayPath}`}
              aria-label={`Open ${displayPath}`}
            >
              <FileText className="h-3 w-3" />
            </button>
          </span>
        )
      }
      return <InlineCode>{children}</InlineCode>
    },
    a: ({ href, children }) => {
      const linkAction = getMarkdownLinkAction(href, fileActions, {
        inertLocalLinks,
        allowedPathKinds: allowedFilePathKinds,
      })
      if (fileActions && linkAction.kind === 'file') {
        const displayPath = filePathCandidateDisplayPath(linkAction.candidate)
        const label = reactNodeText(children) || displayPath
        return (
          <button
            type="button"
            onClick={createFileOpenClickHandler(fileActions, linkAction.candidate)}
            className="inline-flex max-w-full cursor-pointer flex-wrap items-baseline gap-x-1 text-left align-baseline text-accent underline underline-offset-2 transition hover:text-accent/80"
            title={`Open ${displayPath}`}
            aria-label={`Open ${displayPath}`}
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 max-w-full [overflow-wrap:anywhere]">{label}</span>
          </button>
        )
      }
      if (linkAction.kind !== 'external') {
        return (
          <span className="text-muted-foreground underline decoration-dotted underline-offset-2">
            {children}
          </span>
        )
      }
      return (
        <a
          href={linkAction.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-2 hover:text-accent/80"
        >
          {children}
        </a>
      )
    },
  }), [allowedFilePathKinds, fileActions, inertLocalLinks])

  if (!content && !isStreaming) return null

  return (
    <Streamdown
      className="bud-markdown max-w-none text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_p]:leading-relaxed"
      components={components}
      controls={streamdownControls}
      isAnimating={isStreaming}
      mode={isStreaming ? 'streaming' : 'static'}
      plugins={streamdownPlugins}
      remarkPlugins={streamdownRemarkPlugins}
      skipHtml
    >
      {content}
    </Streamdown>
  )
})

function reactNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(reactNodeText).join('')
  }
  return ''
}
