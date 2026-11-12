import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { ApiMessage } from '@/lib/api-types'

const EMPTY_HISTORY: ApiMessage[] = []

export type ComposerHistoryProps = {
  messageHistory?: ApiMessage[]
  hasOlderMessages?: boolean
  isLoadingOlderMessages?: boolean
  olderMessagesError?: boolean
  onLoadOlderMessages?: () => Promise<void>
}

type Draft = { value: string; start: number; end: number }
type Navigation = { id: string | null; draft: Draft; edits: Map<string, string> }

/** Visit-local recall over the route's authorized transcript, never browser storage. */
export function useComposerHistory({
  messageHistory = EMPTY_HISTORY,
  hasOlderMessages = false,
  isLoadingOlderMessages = false,
  olderMessagesError = false,
  onLoadOlderMessages,
  messageText,
  onMessageChange,
  textareaRef,
}: ComposerHistoryProps & {
  messageText: string
  onMessageChange: (value: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
}) {
  const entries = useMemo(() => messageHistory.filter((message) =>
    message.role === 'user' && message.content.trim() && message.metadata?.optimistic !== true,
  ), [messageHistory])
  const navigationRef = useRef<Navigation | null>(null)
  const recalledRef = useRef<Draft | null>(null)
  const [pendingOlder, setPendingOlder] = useState(false)
  const [selection, setSelection] = useState<Draft | null>(null)

  const apply = useCallback((draft: Draft, recalled = true) => {
    recalledRef.current = recalled ? draft : null
    onMessageChange(draft.value)
    // The controlled value must commit before the browser can place the caret.
    // Separate state also handles consecutive messages with identical text.
    setSelection(draft)
  }, [onMessageChange])

  useLayoutEffect(() => {
    if (selection && messageText === selection.value) {
      textareaRef.current?.setSelectionRange(selection.start, selection.end)
      setSelection(null)
    }
  }, [messageText, selection, textareaRef])

  const move = useCallback((direction: 'older' | 'newer'): boolean => {
    const navigation = navigationRef.current
    if (!navigation) return false
    const index = navigation.id === null ? entries.length : entries.findIndex(
      (entry) => (entry.client_id || entry.message_id) === navigation.id,
    )
    const nextIndex = direction === 'older'
      ? (index < 0 ? entries.length : index) - 1
      : index + 1
    const entry = entries[nextIndex]
    if (!entry) return false
    if (navigation.id !== null) navigation.edits.set(navigation.id, messageText)
    navigation.id = entry.client_id || entry.message_id
    const value = navigation.edits.get(navigation.id) ?? entry.content
    apply({ value, start: value.length, end: value.length })
    return true
  }, [entries, messageText, apply])

  useEffect(() => {
    if (!pendingOlder) return
    if (move('older') || olderMessagesError || !hasOlderMessages || !onLoadOlderMessages) {
      setPendingOlder(false)
      return
    }
    if (!isLoadingOlderMessages) {
      // A page may contain only tool/assistant rows. Continue through the
      // existing serialized loader until a user message or the end is found.
      void onLoadOlderMessages()
    }
  }, [pendingOlder, move, olderMessagesError, hasOlderMessages, isLoadingOlderMessages, onLoadOlderMessages])

  const cancelPending = () => {
    recalledRef.current = null
    if (navigationRef.current?.id === null) navigationRef.current = null
    setPendingOlder(false)
    setSelection(null)
  }

  const reset = () => {
    cancelPending()
    navigationRef.current = null
  }

  const restoreDraft = () => {
    const draft = navigationRef.current?.draft
    reset()
    if (draft) apply(draft, false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const { key, currentTarget: input } = event
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      cancelPending()
      return false
    }
    if (key === 'Escape' && navigationRef.current) {
      event.preventDefault()
      restoreDraft()
      return true
    }
    if (key !== 'ArrowUp' && key !== 'ArrowDown') {
      cancelPending()
      return false
    }
    if (key === 'ArrowDown') setPendingOlder(false)
    const recalled = recalledRef.current
    const browsing = recalled?.value === input.value &&
      recalled.start === input.selectionStart && recalled.end === input.selectionEnd
    // Uninterrupted Up/Down cycles messages, including multiline recalls.
    // After editing or moving the caret, use exact text boundaries so native
    // movement within both explicit and soft-wrapped lines stays available.
    if (input.selectionStart !== input.selectionEnd ||
        (!browsing && key === 'ArrowUp' && input.selectionStart !== 0) ||
        (!browsing && key === 'ArrowDown' && input.selectionEnd !== input.value.length)) {
      cancelPending()
      return false
    }
    if (key === 'ArrowDown') {
      if (!navigationRef.current) return false
      event.preventDefault()
      if (!move('newer')) restoreDraft()
      return true
    }
    if (entries.length === 0 && !hasOlderMessages) return false
    event.preventDefault()
    navigationRef.current ??= {
      id: null,
      draft: { value: input.value, start: input.selectionStart, end: input.selectionEnd },
      edits: new Map(),
    }
    if (!move('older') && hasOlderMessages && onLoadOlderMessages) {
      if (!isLoadingOlderMessages && !pendingOlder) void onLoadOlderMessages()
      setPendingOlder(true)
    }
    return true
  }

  return { onKeyDown, cancelPending, reset, isLoadingHistory: pendingOlder }
}
