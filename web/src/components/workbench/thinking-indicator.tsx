import { useState, useEffect } from 'react'
import { LoaderCircle } from 'lucide-react'

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
  label?: string
  workStarted?: boolean
}

export function ThinkingIndicator({ isVisible, label, workStarted = false }: ThinkingIndicatorProps) {
  const [wordIndex, setWordIndex] = useState(() =>
    Math.floor(Math.random() * THINKING_WORDS.length)
  )
  const [graceElapsed, setGraceElapsed] = useState(false)
  const visible = isVisible && (workStarted || Boolean(label) || graceElapsed)

  useEffect(() => {
    setGraceElapsed(false)
    if (!isVisible) return
    const timer = window.setTimeout(() => setGraceElapsed(true), 500)
    return () => window.clearTimeout(timer)
  }, [isVisible])

  // Word cycling - only while visible and not showing a specific activity label
  useEffect(() => {
    if (!visible || label) return
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % THINKING_WORDS.length)
    }, 2000)
    return () => clearInterval(interval)
  }, [visible, label])

  // Reset to random word when becoming visible
  useEffect(() => {
    if (visible && !label) {
      setWordIndex(Math.floor(Math.random() * THINKING_WORDS.length))
    }
  }, [visible, label])

  if (!isVisible) return null

  return (
    <div className="border-l-[3px] border-transparent px-4 py-2.5 text-sm leading-relaxed" data-response-slot>
      <div className="relative min-h-[1lh]">
        {visible && <div role="status" className="absolute inset-0 flex items-center gap-2 text-muted-foreground">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          <span>{label ?? `${THINKING_WORDS[wordIndex]}...`}</span>
        </div>}
      </div>
    </div>
  )
}
