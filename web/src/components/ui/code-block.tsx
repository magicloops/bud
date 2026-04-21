import { memo, useState, useCallback, useEffect, type CSSProperties } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

type CodeBlockProps = {
  code: string
  language: string
  className?: string
}

type SyntaxTheme = {
  [key: string]: CSSProperties
}

type SyntaxRendererState = {
  SyntaxHighlighter: typeof import('react-syntax-highlighter').Prism
  style: SyntaxTheme
} | null

/**
 * Code block component with syntax highlighting and click-to-copy.
 * Shows a copy button on hover.
 */
export const CodeBlock = memo(function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const [renderer, setRenderer] = useState<SyntaxRendererState>(null)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [code])

  useEffect(() => {
    let cancelled = false

    void Promise.all([
      import('react-syntax-highlighter'),
      import('react-syntax-highlighter/dist/esm/styles/prism'),
    ]).then(([syntaxModule, styleModule]) => {
      if (cancelled) {
        return
      }

      setRenderer({
        SyntaxHighlighter: syntaxModule.Prism,
        style: styleModule.oneDark,
      })
    }).catch((error) => {
      if (cancelled) {
        return
      }
      console.error('Failed to load syntax highlighter', error)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const codePre = renderer ? (
    <renderer.SyntaxHighlighter
      language={language}
      style={renderer.style}
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
    </renderer.SyntaxHighlighter>
  ) : (
    <pre className="overflow-x-auto rounded-lg bg-[#282c34] p-4 text-[0.85em] text-white">
      <code>{code}</code>
    </pre>
  )

  return (
    <div className={cn('group/code relative', className)}>
      {/* Copy button */}
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          'absolute right-2 top-2 z-10 rounded-md p-1.5 transition-all',
          'opacity-0 group-hover/code:opacity-100',
          'bg-white/10 text-white/70 hover:bg-white/20 hover:text-white',
          copied && 'bg-green-500/20 text-green-400 opacity-100'
        )}
        title="Copy code"
      >
        {copied ? (
          <Check className="h-4 w-4" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>

      {codePre}
    </div>
  )
})
