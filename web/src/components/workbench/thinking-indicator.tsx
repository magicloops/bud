import { useState, useEffect } from 'react'
import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

const THINKING_WORDS = [
  'Thinking',
  'Working',
  'Pondering',
  'Processing',
  'Computing',
  'Analyzing',
  'Exploring',
  'Reasoning',
  'Contemplating',
  'Cogitating',
  'Deliberating',
  'Combobulating'
]

export const THINKING_INDICATOR_ENTER_DURATION_MS = 200

type ThinkingIndicatorProps = {
  isVisible: boolean
  label?: string
}

export function ThinkingIndicator({ isVisible, label }: ThinkingIndicatorProps) {
  const [wordIndex, setWordIndex] = useState(() =>
    Math.floor(Math.random() * THINKING_WORDS.length)
  )
  const [isExpanded, setIsExpanded] = useState(false)

  // Enter-only height animation. Hidden state still unmounts immediately.
  useEffect(() => {
    if (!isVisible) {
      setIsExpanded(false)
      return
    }

    setIsExpanded(false)
    const frame = window.requestAnimationFrame(() => setIsExpanded(true))
    return () => window.cancelAnimationFrame(frame)
  }, [isVisible])

  // Word cycling - only while visible and not showing a specific activity label
  useEffect(() => {
    if (!isVisible || label) return
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % THINKING_WORDS.length)
    }, 2000)
    return () => clearInterval(interval)
  }, [isVisible, label])

  // Reset to random word when becoming visible
  useEffect(() => {
    if (isVisible && !label) {
      setWordIndex(Math.floor(Math.random() * THINKING_WORDS.length))
    }
  }, [isVisible, label])

  if (!isVisible) return null

  return (
    <div
      className={cn(
        'overflow-hidden transition-[max-height] duration-200 ease-out',
        isExpanded ? 'max-h-10' : 'max-h-0'
      )}
      style={{ backgroundColor: 'var(--chat-bg)' }}
    >
      <div className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm text-muted-foreground">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin flex-shrink-0" />
        <span className="animate-pulse">{label ?? `${THINKING_WORDS[wordIndex]}...`}</span>
      </div>
    </div>
  )
}
