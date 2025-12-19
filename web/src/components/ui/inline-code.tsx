import { memo, useRef, useState, useCallback, type ReactNode } from "react"
import { cn } from "@/lib/utils"

type InlineCodeProps = {
  children: ReactNode
  className?: string
}

/**
 * Inline code component with click-to-copy functionality.
 * Uses simple inline display for proper baseline alignment with surrounding text.
 * Long code wraps instead of truncating to avoid overflow.
 */
export const InlineCode = memo(function InlineCode({ children, className }: InlineCodeProps) {
  const codeRef = useRef<HTMLElement>(null)
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    const text = codeRef.current?.textContent
    if (!text) return

    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [])

  return (
    <code
      ref={codeRef}
      onClick={handleCopy}
      className={cn(
        // Base styling - simple inline element (NO inline-block for proper baseline alignment)
        "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] before:content-none after:content-none",
        // Allow long code to wrap instead of overflow
        "[overflow-wrap:break-word]",
        // Click-to-copy styling
        "cursor-pointer hover:bg-muted/80 active:scale-[0.98] transition-all",
        // Copied feedback
        copied && "ring-2 ring-green-500/50 bg-green-500/10",
        className
      )}
      title="Click to copy"
    >
      {children}
    </code>
  )
})
