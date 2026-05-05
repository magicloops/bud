import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { FileText } from 'lucide-react'
import { InlineCode } from '@/components/ui/inline-code'
import { CodeBlock } from '@/components/ui/code-block'
import type { MessageContentRendererProps } from '../types'
import {
  createFileOpenClickHandler,
  getInlineCodeFileCandidate,
  getMarkdownLinkFileCandidate,
} from './markdown-file-actions'

/**
 * Shared markdown renderer for assistant and user messages.
 * Includes GFM (tables, task lists), syntax highlighting, and prose styling.
 */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  fileActions,
}: MessageContentRendererProps) {
  if (!content) return null

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none [overflow-wrap:break-word] prose-a:[overflow-wrap:anywhere] prose-headings:font-semibold prose-headings:tracking-tight prose-p:leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          code: ({ className, children }) => {
            const match = className?.match(/language-(\w+)/)
            if (match) {
              const code = String(children).replace(/\n$/, '')
              return <CodeBlock code={code} language={match[1]} />
            }
            const inlineText = String(children)
            const fileCandidate = getInlineCodeFileCandidate(inlineText, fileActions)
            if (fileActions && fileCandidate) {
              return (
                <span className="align-baseline [overflow-wrap:anywhere]">
                  <InlineCode className="max-w-full [overflow-wrap:anywhere]">{children}</InlineCode>
                  <button
                    type="button"
                    onClick={createFileOpenClickHandler(fileActions, fileCandidate)}
                    className="ml-1 inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-border bg-background align-text-bottom text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    title={`Open ${fileCandidate.relative_path}`}
                    aria-label={`Open ${fileCandidate.relative_path}`}
                  >
                    <FileText className="h-3 w-3" />
                  </button>
                </span>
              )
            }
            return <InlineCode>{children}</InlineCode>
          },
          pre: ({ children }) => (
            <div className="my-4">{children}</div>
          ),
          a: ({ href, children }) => {
            const fileCandidate = getMarkdownLinkFileCandidate(href, fileActions)
            if (fileActions && fileCandidate) {
              return (
                <button
                  type="button"
                  onClick={createFileOpenClickHandler(fileActions, fileCandidate)}
                  className="inline-flex max-w-full cursor-pointer flex-wrap items-baseline gap-x-1 text-left align-baseline text-accent underline underline-offset-2 transition hover:text-accent/80"
                  title={`Open ${fileCandidate.relative_path}`}
                  aria-label={`Open ${fileCandidate.relative_path}`}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 max-w-full [overflow-wrap:anywhere]">{children}</span>
                </button>
              )
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline underline-offset-2 hover:text-accent/80"
              >
                {children}
              </a>
            )
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  )
})
