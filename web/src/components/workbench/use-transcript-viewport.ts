import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'

/** Measurements stay outside React; only the jump affordance publishes. */
export function useTranscriptViewport(scrollRef: MutableRefObject<HTMLDivElement | null>, sendKey: string | null) {
  const follow = useRef(true)
  const gesture = useRef(false)
  const frame = useRef<number | null>(null)
  const [showJump, setShowJump] = useState(false)
  const jumpVisible = useRef(false)
  const publishJump = useCallback((visible: boolean) => {
    if (jumpVisible.current === visible) return
    jumpVisible.current = visible
    setShowJump(visible)
  }, [])
  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])
  const inspect = useCallback(() => {
    follow.current = false
    gesture.current = false
    cancel()
  }, [cancel])
  const schedule = useCallback(() => {
    if (!follow.current || frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const node = scrollRef.current
      if (!node || !follow.current || gesture.current || !node.clientHeight || !window.getSelection()?.isCollapsed) return
      node.scrollTop = node.scrollHeight
    })
  }, [scrollRef])
  const jump = useCallback(() => {
    follow.current = true
    gesture.current = false
    publishJump(false)
    schedule()
  }, [schedule, publishJump])
  useEffect(() => {
    if (sendKey) jump()
  }, [sendKey, jump])
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    let prepend: { element: Element; top: number } | null = null
    const beforePrepend = () => {
      cancel()
      const top = node.getBoundingClientRect().top
      const element = Array.from(node.firstElementChild?.children ?? []).find(child => child.getBoundingClientRect().bottom > top)
      prepend = element ? { element, top: element.getBoundingClientRect().top } : null
    }
    const measure = () => {
      if (!node.clientHeight) return
      const near = node.scrollHeight - node.scrollTop - node.clientHeight < 48
      publishJump(!near)
    }
    const begin = (event: Event) => {
      if ((event.type === 'pointerdown' || event instanceof KeyboardEvent) &&
          (event.target as Element).closest('button, input, textarea, select, summary')) return
      if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
      prepend = null
      gesture.current = true
      follow.current = false
      cancel()
    }
    const end = () => {
      if (!gesture.current || !node.clientHeight) return
      gesture.current = false
      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
      measure()
    }
    let previousWidth = node.clientWidth
    const resize = () => {
      if (!node.clientHeight) return
      if (previousWidth !== node.clientWidth) {
        previousWidth = node.clientWidth
        const content = node.firstElementChild as HTMLElement | null
        if (content) content.style.minHeight = ''
      }
      if (prepend) {
        const saved = prepend
        prepend = null
        if (saved.element.isConnected) node.scrollTop += saved.element.getBoundingClientRect().top - saved.top
        measure()
        return
      }
      measure(); schedule()
    }
    node.addEventListener('bud:before-history-prepend', beforePrepend)
    node.addEventListener('scroll', measure, { passive: true })
    node.addEventListener('scrollend', end)
    node.addEventListener('wheel', begin, { passive: true })
    node.addEventListener('touchstart', begin, { passive: true })
    node.addEventListener('pointerdown', begin, { passive: true })
    node.addEventListener('keydown', begin)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(node)
    if (node.firstElementChild) observer?.observe(node.firstElementChild)
    schedule()
    return () => {
      cancel(); observer?.disconnect()
      node.removeEventListener('bud:before-history-prepend', beforePrepend)
      node.removeEventListener('scroll', measure)
      node.removeEventListener('scrollend', end)
      node.removeEventListener('wheel', begin)
      node.removeEventListener('touchstart', begin)
      node.removeEventListener('pointerdown', begin)
      node.removeEventListener('keydown', begin)
    }
  }, [cancel, schedule, scrollRef, publishJump])
  return { inspect, showJump, jump }
}
