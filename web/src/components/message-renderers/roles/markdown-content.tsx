import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
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
          code: ({ className, children, ...props }) => {
            const match = className?.match(/language-(\w+)/)
            if (match) {
              const code = String(children).replace(/\n$/, '')
              return (
                <SyntaxHighlighter
                  language={match[1]}
                  style={oneDark}
                  PreTag={({ children: preChildren, style }) => (
                    <pre
                      style={{
                        ...style,
                        margin: 0,
                        borderRadius: '0.5rem',
                        fontSize: '0.85em',
                        background: '#282c34',
                      }}
                    >
                      {preChildren}
                    </pre>
                  )}
                >
                  {code}
                </SyntaxHighlighter>
              )
            }
            return (
              <code
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]"
                {...props}
              >
                {children}
              </code>
            )
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
