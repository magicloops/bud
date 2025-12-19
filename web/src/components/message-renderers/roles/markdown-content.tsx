import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { InlineCode } from '@/components/ui/inline-code'
import { CodeBlock } from '@/components/ui/code-block'
import type { MessageContentRendererProps } from '../types'

/**
 * Shared markdown renderer for assistant and user messages.
 * Includes GFM (tables, task lists), syntax highlighting, and prose styling.
 */
export const MarkdownContent = memo(function MarkdownContent({
  content,
}: MessageContentRendererProps) {
  if (!content) return null

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-p:leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          code: ({ className, children }) => {
            const match = className?.match(/language-(\w+)/)
            if (match) {
              const code = String(children).replace(/\n$/, '')
              return <CodeBlock code={code} language={match[1]} />
            }
            // Inline code - click to copy
            return <InlineCode>{children}</InlineCode>
          },
          pre: ({ children }) => (
            <div className="my-4">{children}</div>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 hover:text-accent/80"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  )
})
