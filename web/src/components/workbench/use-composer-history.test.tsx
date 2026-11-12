import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement, useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import type { ApiMessage } from '../../lib/api-types'
import { useComposerHistory } from './use-composer-history'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const message = (id: string, content: string, overrides: Partial<ApiMessage> = {}): ApiMessage => ({
  message_id: `row-${id}`, client_id: id, role: 'user', content,
  created_at: '2026-11-12T00:00:00Z', metadata: {}, ...overrides,
} as ApiMessage)

type Source = { rows: ApiMessage[]; more: boolean; loading: boolean; error: boolean }
type Page = { rows?: ApiMessage[]; more?: boolean; error?: boolean }
type KeyOptions = Partial<Pick<KeyboardEvent<HTMLTextAreaElement>, 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>> & {
  isComposing?: boolean
  keyCode?: number
}

async function mountHistory(rows: ApiMessage[], draft = '', more = false) {
  const input = {
    value: draft, selectionStart: 0, selectionEnd: 0,
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start
      this.selectionEnd = end
    },
  }
  const requests: ((page: Page) => void)[] = []
  let history!: ReturnType<typeof useComposerHistory>
  let setText!: (text: string) => void
  let setSource!: Dispatch<SetStateAction<Source>>
  let view!: ReactTestRenderer
  let identity = 'owner-A:thread-A'

  function Harness({ initialRows, initialDraft, initialMore }: {
    initialRows: ApiMessage[]; initialDraft: string; initialMore: boolean
  }) {
    const [text, updateText] = useState(initialDraft)
    const [source, updateSource] = useState<Source>({ rows: initialRows, more: initialMore, loading: false, error: false })
    const textareaRef = useRef(input as HTMLTextAreaElement)
    setText = updateText
    setSource = updateSource
    useLayoutEffect(() => {
      if (input.value !== text) {
        input.value = text
        input.setSelectionRange(text.length, text.length)
      }
    }, [text])
    const load = useCallback(() => {
      updateSource((current) => ({ ...current, loading: true, error: false }))
      return new Promise<void>((resolve) => requests.push((page) => {
        updateSource((current) => ({
          rows: page.rows ?? current.rows,
          more: page.more ?? current.more,
          loading: false,
          error: page.error ?? false,
        }))
        resolve()
      }))
    }, [])
    history = useComposerHistory({
      messageText: text, onMessageChange: updateText, textareaRef,
      messageHistory: source.rows, hasOlderMessages: source.more,
      isLoadingOlderMessages: source.loading, olderMessagesError: source.error,
      onLoadOlderMessages: load,
    })
    return null
  }

  await act(async () => {
    view = create(createElement(Harness, { key: identity, initialRows: rows, initialDraft: draft, initialMore: more }))
  })

  return {
    input,
    requests,
    get loading() { return history.isLoadingHistory },
    caret(start: number, end = start) { input.setSelectionRange(start, end) },
    async key(key: string, options: KeyOptions = {}) {
      let prevented = false
      let handled = false
      await act(async () => {
        handled = history.onKeyDown({
          key, currentTarget: input, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
          ...options,
          nativeEvent: { isComposing: options.isComposing ?? false, keyCode: options.keyCode ?? 0 },
          preventDefault() { prevented = true },
        } as unknown as KeyboardEvent<HTMLTextAreaElement>)
      })
      return { handled, prevented }
    },
    async edit(text: string) {
      await act(async () => { history.cancelPending(); setText(text) })
      input.setSelectionRange(text.length, text.length)
    },
    async cancel() { await act(async () => history.cancelPending()) },
    async submit() { await act(async () => { history.reset(); setText('') }) },
    async source(patch: Partial<Source>) {
      await act(async () => setSource((current) => ({ ...current, ...patch })))
    },
    async finish(index: number, page: Page) { await act(async () => requests[index](page)) },
    async remount(nextRows: ApiMessage[], nextIdentity: string) {
      identity = nextIdentity
      await act(async () => view.update(createElement(Harness, {
        key: identity, initialRows: nextRows, initialDraft: '', initialMore: false,
      })))
    },
    async unmount() { await act(async () => view.unmount()) },
  }
}

test('recalls only canonical nonempty user messages and restores the draft and caret', async () => {
  const h = await mountHistory([
    message('old', 'first'), message('assistant', 'answer', { role: 'assistant' }),
    message('new', 'second'), message('empty', '  \n'),
    message('pending', 'not sent', { metadata: { optimistic: true } }),
  ], 'my unfinished draft')
  try {
    h.caret(3)
    assert.deepEqual(await h.key('ArrowDown'), { handled: false, prevented: false })
    assert.deepEqual(await h.key('ArrowUp'), { handled: false, prevented: false })
    h.caret(0)
    assert.deepEqual(await h.key('ArrowUp'), { handled: true, prevented: true })
    assert.equal(h.input.value, 'second')
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'first')
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'first', 'oldest entry does not wrap')
    await h.key('ArrowDown')
    assert.equal(h.input.value, 'second')
    await h.key('ArrowDown')
    assert.equal(h.input.value, 'my unfinished draft')
    assert.equal(h.input.selectionStart, 0)
    assert.equal(h.input.selectionEnd, 0)
  } finally { await h.unmount() }
})

test('duplicate text stays distinct by identity and recalled edits do not change the saved transcript', async () => {
  const rows = [message('first', 'same'), message('second', 'same')]
  const h = await mountHistory(rows, 'draft')
  try {
    await h.key('ArrowUp')
    await h.edit('edited second')
    h.caret(0)
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'same')
    await h.key('ArrowDown')
    assert.equal(h.input.value, 'edited second')
    await h.key('Escape')
    assert.equal(h.input.value, 'draft')
    assert.deepEqual(rows.map((row) => row.content), ['same', 'same'])
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'same', 'a new browsing session uses canonical text')
  } finally { await h.unmount() }
})

test('prepended and newly sent rows do not shift the selected message', async () => {
  const first = message('first', 'first')
  const second = message('second', 'second')
  const h = await mountHistory([first, second])
  try {
    await h.key('ArrowUp')
    await h.source({ rows: [message('older', 'older'), first, second, message('third', 'third')] })
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'first')
    await h.key('ArrowDown')
    assert.equal(h.input.value, 'second')
    await h.key('ArrowDown')
    assert.equal(h.input.value, 'third')
    await h.key('ArrowDown')
    assert.equal(h.input.value, '')
  } finally { await h.unmount() }
})

test('multiline drafts preserve native movement while uninterrupted recall cycles whole messages', async () => {
  const h = await mountHistory([message('older', 'older'), message('latest', 'line one\nline two')], 'draft one\ndraft two')
  try {
    h.caret(13)
    assert.deepEqual(await h.key('ArrowUp'), { handled: false, prevented: false })
    h.caret(3)
    assert.deepEqual(await h.key('ArrowUp'), { handled: false, prevented: false })
    h.caret(0)
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'line one\nline two')
    assert.equal(h.input.selectionStart, h.input.value.length)
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'older')
    await h.key('ArrowDown')
    assert.equal(h.input.value, 'line one\nline two')
    assert.equal(h.input.selectionStart, h.input.value.length)
    await h.key('ArrowLeft')
    h.caret(4)
    assert.deepEqual(await h.key('ArrowUp'), { handled: false, prevented: false })
    assert.deepEqual(await h.key('ArrowDown'), { handled: false, prevented: false })
    h.caret(h.input.value.length)
    await h.key('ArrowDown')
    assert.equal(h.input.value, 'draft one\ndraft two')
    assert.equal(h.input.selectionStart, 0)
  } finally { await h.unmount() }
})

test('a soft-wrapped draft keeps native arrows until the exact text boundary', async () => {
  const draft = 'a long draft without hard line breaks '.repeat(30)
  const h = await mountHistory([message('sent', 'sent')], draft)
  try {
    h.caret(draft.length)
    assert.deepEqual(await h.key('ArrowUp'), { handled: false, prevented: false })
    h.caret(100)
    assert.deepEqual(await h.key('ArrowUp'), { handled: false, prevented: false })
    assert.deepEqual(await h.key('ArrowDown'), { handled: false, prevented: false })
    assert.equal(h.input.value, draft)
    h.caret(0)
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'sent')
    await h.key('Escape')
    assert.equal(h.input.value, draft)
  } finally { await h.unmount() }
})

test('selections, modifiers and IME composition never recall history', async () => {
  const h = await mountHistory([message('sent', 'sent')], 'draft')
  try {
    for (const options of [
      { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true },
      { isComposing: true }, { keyCode: 229 },
    ]) {
      assert.deepEqual(await h.key('ArrowUp', options), { handled: false, prevented: false })
      assert.equal(h.input.value, 'draft')
    }
    h.caret(0, 3)
    assert.deepEqual(await h.key('ArrowUp'), { handled: false, prevented: false })
    assert.equal(h.input.value, 'draft')
  } finally { await h.unmount() }
})

test('empty history leaves native arrows untouched', async () => {
  const h = await mountHistory([])
  try {
    assert.deepEqual(await h.key('ArrowUp'), { handled: false, prevented: false })
    assert.deepEqual(await h.key('ArrowDown'), { handled: false, prevented: false })
    assert.equal(h.requests.length, 0)
  } finally { await h.unmount() }
})

test('one Up loads through assistant-only pages and recalls one older user message', async () => {
  const latest = message('latest', 'latest')
  const assistant = message('assistant', 'answer', { role: 'assistant' })
  const h = await mountHistory([latest], 'draft', true)
  try {
    await h.key('ArrowUp')
    await h.key('ArrowUp')
    assert.equal(h.loading, true)
    assert.equal(h.requests.length, 1)
    await h.key('ArrowUp')
    assert.equal(h.requests.length, 1, 'key repeat does not duplicate pending requests')
    await h.finish(0, { rows: [assistant, latest], more: true })
    assert.equal(h.requests.length, 2)
    assert.equal(h.input.value, 'latest')
    await h.finish(1, { rows: [message('older', 'older'), assistant, latest], more: false })
    assert.equal(h.input.value, 'older')
    assert.equal(h.loading, false)
    assert.equal(h.requests.length, 2)
    await h.key('Escape')
    assert.equal(h.input.value, 'draft')
  } finally { await h.unmount() }
})

test('history can start outside the loaded user-message window and stops at end of history', async () => {
  const assistant = message('assistant', 'answer', { role: 'assistant' })
  const h = await mountHistory([assistant], 'draft', true)
  try {
    await h.key('ArrowUp')
    assert.equal(h.requests.length, 1)
    await h.finish(0, { more: false })
    assert.equal(h.loading, false)
    assert.equal(h.input.value, 'draft')
    assert.equal(h.requests.length, 1)
  } finally { await h.unmount() }
})

test('a failed page stops loading; a fresh Up retries without losing the draft', async () => {
  const h = await mountHistory([], 'draft', true)
  try {
    await h.key('ArrowUp')
    await h.finish(0, { error: true })
    assert.equal(h.loading, false)
    assert.equal(h.requests.length, 1)
    assert.equal(h.input.value, 'draft')
    await h.key('ArrowUp')
    assert.equal(h.requests.length, 2)
    await h.finish(1, { rows: [message('old', 'recovered')], more: false })
    assert.equal(h.input.value, 'recovered')
    await h.key('ArrowDown')
    assert.equal(h.input.value, 'draft')
  } finally { await h.unmount() }
})

test('editing before the first recall saves the new draft after a late page arrives', async () => {
  const h = await mountHistory([], 'original', true)
  try {
    await h.key('ArrowUp')
    assert.equal(h.loading, true)
    await h.edit('new draft')
    await h.finish(0, { rows: [message('old', 'sent message')], more: false })
    assert.equal(h.input.value, 'new draft')
    h.caret(0)
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'sent message')
    await h.key('ArrowDown')
    assert.equal(h.input.value, 'new draft')
  } finally { await h.unmount() }
})

test('editing after a failed first recall replaces the saved draft for the next attempt', async () => {
  const h = await mountHistory([], 'original', true)
  try {
    await h.key('ArrowUp')
    await h.finish(0, { error: true })
    await h.edit('new draft')
    h.caret(0)
    await h.key('ArrowUp')
    await h.finish(1, { rows: [message('old', 'sent message')], more: false })
    assert.equal(h.input.value, 'sent message')
    await h.key('ArrowDown')
    assert.equal(h.input.value, 'new draft')
  } finally { await h.unmount() }
})

test('editing, blur, cursor movement, Down, Escape and submit cancel late history recall', async () => {
  for (const action of ['edit', 'blur', 'move', 'down', 'escape', 'submit'] as const) {
    const latest = message('latest', 'latest')
    const h = await mountHistory([latest], 'draft', true)
    try {
      await h.key('ArrowUp')
      await h.key('ArrowUp')
      assert.equal(h.loading, true)
      if (action === 'edit') await h.edit('new writing')
      if (action === 'blur') await h.cancel()
      if (action === 'move') await h.key('ArrowLeft')
      if (action === 'down') await h.key('ArrowDown')
      if (action === 'escape') await h.key('Escape')
      if (action === 'submit') await h.submit()
      const expected = h.input.value
      await h.finish(0, { rows: [message('old', 'old'), latest], more: false })
      assert.equal(h.input.value, expected, action)
      assert.equal(h.loading, false, action)
      if (action === 'submit') {
        assert.deepEqual(await h.key('ArrowDown'), { handled: false, prevented: false })
      }
    } finally { await h.unmount() }
  }
})

test('owner/thread remount clears recalled text, draft and pending work', async () => {
  const h = await mountHistory([], 'private draft', true)
  try {
    await h.key('ArrowUp')
    await h.remount([message('other', 'other owner')], 'owner-B:thread-A')
    await h.finish(0, { rows: [message('old-owner', 'private old message')], more: false })
    assert.equal(h.input.value, '')
    assert.equal(h.loading, false)
    assert.deepEqual(await h.key('Escape'), { handled: false, prevented: false })
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'other owner')
    await h.remount([message('other-thread', 'other thread')], 'owner-B:thread-B')
    await h.key('ArrowUp')
    assert.equal(h.input.value, 'other thread')
    await h.key('ArrowDown')
    assert.equal(h.input.value, '')
  } finally { await h.unmount() }
})
