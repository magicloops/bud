import { memo, useState, useCallback } from "react"
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Check, Copy } from "lucide-react"
import { cn } from "@/lib/utils"

type CodeBlockProps = {
  code: string
  language: string
  className?: string
}

/**
 * Code block component with syntax highlighting and click-to-copy.
 * Shows a copy button on hover.
 */
export const CodeBlock = memo(function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [code])

  return (
    <div className={cn("group/code relative", className)}>
      {/* Copy button */}
      <button
        onClick={handleCopy}
        className={cn(
          "absolute right-2 top-2 z-10 p-1.5 rounded-md transition-all",
          "opacity-0 group-hover/code:opacity-100",
          "bg-white/10 hover:bg-white/20 text-white/70 hover:text-white",
          copied && "opacity-100 bg-green-500/20 text-green-400"
        )}
        title="Copy code"
      >
        {copied ? (
          <Check className="h-4 w-4" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>

      <SyntaxHighlighter
        language={language}
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
    </div>
  )
})
