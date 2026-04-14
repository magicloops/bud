export type TerminalInputPlatform = 'mac' | 'non-mac'

export type TerminalInputIntent =
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'browser'; reason: string }
  | { kind: 'unsupported'; reason: string }

type TerminalKeydownOptions = {
  hasSelection: boolean
  platform: TerminalInputPlatform
}

const SIMPLE_KEY_MAP: Record<string, string> = {
  Enter: '\n',
  Tab: '\t',
  Backspace: '\x7f',
  Escape: '\x1b',
}

const NAVIGATION_KEY_MAP: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
}

const loggedUnsupportedKeyEvents = new Set<string>()
const loggedCompositionEvents = new Set<string>()
const MODIFIER_ONLY_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

const isMacPlatform = (value: string) => /mac|iphone|ipad|ipod/i.test(value)
const hasNoControlModifiers = (event: KeyboardEvent) =>
  !event.ctrlKey && !event.altKey && !event.metaKey
const hasNoModifiers = (event: KeyboardEvent) =>
  !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey

const isPrintableKey = (event: KeyboardEvent) =>
  event.key.length === 1 && hasNoControlModifiers(event)

const isPlatformCopyShortcut = (
  event: KeyboardEvent,
  platform: TerminalInputPlatform,
  hasSelection: boolean,
) => {
  const key = event.key.toLowerCase()
  if (platform === 'mac') {
    return key === 'c' && event.metaKey && !event.ctrlKey && !event.altKey
  }

  return key === 'c' && hasSelection && event.ctrlKey && !event.metaKey && !event.altKey
}

const isPlatformPasteShortcut = (event: KeyboardEvent, platform: TerminalInputPlatform) => {
  const key = event.key.toLowerCase()
  if (platform === 'mac') {
    return key === 'v' && event.metaKey && !event.ctrlKey && !event.altKey
  }

  return key === 'v' && event.ctrlKey && !event.metaKey && !event.altKey
}

const isSupportedControlLetter = (event: KeyboardEvent) =>
  /^[a-z]$/i.test(event.key) && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey

const summarizeKeyboardEvent = (event: KeyboardEvent) =>
  [
    event.type,
    `key=${event.key}`,
    event.ctrlKey ? 'ctrl' : '',
    event.metaKey ? 'meta' : '',
    event.altKey ? 'alt' : '',
    event.shiftKey ? 'shift' : '',
  ]
    .filter(Boolean)
    .join(':')

export const detectTerminalInputPlatform = (): TerminalInputPlatform => {
  if (typeof navigator === 'undefined') {
    return 'non-mac'
  }

  const platform = navigator.platform || navigator.userAgent || ''
  return isMacPlatform(platform) ? 'mac' : 'non-mac'
}

export const translateTerminalKeydown = (
  event: KeyboardEvent,
  options: TerminalKeydownOptions,
): TerminalInputIntent => {
  const { hasSelection, platform } = options

  if (event.isComposing || event.key === 'Process' || event.key === 'Dead') {
    return { kind: 'unsupported', reason: 'composition_not_supported' }
  }

  if (MODIFIER_ONLY_KEYS.has(event.key)) {
    return { kind: 'browser', reason: 'modifier_only' }
  }

  if (isPlatformCopyShortcut(event, platform, hasSelection)) {
    return { kind: 'browser', reason: 'copy_shortcut' }
  }

  if (isPlatformPasteShortcut(event, platform)) {
    return { kind: 'browser', reason: 'paste_shortcut' }
  }

  if (isSupportedControlLetter(event)) {
    const controlByte = String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64)
    return { kind: 'bytes', text: controlByte }
  }

  if (isPrintableKey(event)) {
    return { kind: 'text', text: event.key }
  }

  if (hasNoModifiers(event) && SIMPLE_KEY_MAP[event.key]) {
    return { kind: 'bytes', text: SIMPLE_KEY_MAP[event.key] }
  }

  if (hasNoModifiers(event) && NAVIGATION_KEY_MAP[event.key]) {
    return { kind: 'bytes', text: NAVIGATION_KEY_MAP[event.key] }
  }

  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
    return { kind: 'unsupported', reason: 'modifier_combo_not_supported' }
  }

  return { kind: 'unsupported', reason: 'key_not_supported_in_phase_1' }
}

export const createTerminalPasteIntent = (text: string): TerminalInputIntent => {
  if (text.length === 0) {
    return { kind: 'browser', reason: 'empty_paste' }
  }

  return { kind: 'paste', text }
}

export const logUnsupportedTerminalKeydown = (
  intent: TerminalInputIntent,
  event: KeyboardEvent,
) => {
  if (!import.meta.env.DEV || intent.kind !== 'unsupported') {
    return
  }

  const signature = `${intent.reason}:${summarizeKeyboardEvent(event)}`
  if (loggedUnsupportedKeyEvents.has(signature)) {
    return
  }
  loggedUnsupportedKeyEvents.add(signature)

  console.warn('[terminal-input] unsupported keydown', {
    reason: intent.reason,
    key: event.key,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  })
}

export const logUnsupportedTerminalComposition = (event: CompositionEvent) => {
  if (!import.meta.env.DEV) {
    return
  }

  const signature = event.type
  if (loggedCompositionEvents.has(signature)) {
    return
  }
  loggedCompositionEvents.add(signature)

  console.warn('[terminal-input] composition event ignored', {
    type: event.type,
  })
}
