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

type ThinkingIndicatorProps = {
  isVisible: boolean
}

export function ThinkingIndicator({ isVisible }: ThinkingIndicatorProps) {
  const [wordIndex, setWordIndex] = useState(() =>
    Math.floor(Math.random() * THINKING_WORDS.length)
  )
  const [shouldRender, setShouldRender] = useState(isVisible)

  // Delayed unmount for exit animation
  useEffect(() => {
    if (isVisible) {
      setShouldRender(true)
    } else {
      const timer = setTimeout(() => setShouldRender(false), 200)
      return () => clearTimeout(timer)
    }
  }, [isVisible])

  // Word cycling - only while visible
  useEffect(() => {
    if (!isVisible) return
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % THINKING_WORDS.length)
    }, 2000)
    return () => clearInterval(interval)
  }, [isVisible])

  // Reset to random word when becoming visible
  useEffect(() => {
    if (isVisible) {
      setWordIndex(Math.floor(Math.random() * THINKING_WORDS.length))
    }
  }, [isVisible])

  if (!shouldRender) return null

  return (
    <div
      className={cn(
        'flex items-center justify-center gap-2 px-4 py-3 text-sm text-muted-foreground',
        'transition-all duration-200 ease-out overflow-hidden',
        isVisible
          ? 'opacity-100 max-h-12 translate-y-0'
          : 'opacity-0 max-h-0 translate-y-1'
      )}
      style={{ backgroundColor: 'var(--chat-bg)' }}
    >
      <LoaderCircle className="h-4 w-4 animate-spin flex-shrink-0" />
      <span className="animate-pulse">{THINKING_WORDS[wordIndex]}...</span>
    </div>
  )
}
