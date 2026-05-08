import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createFileOpenClickHandler,
  getInlineCodeFileCandidate,
  getMarkdownLinkFileCandidate,
} from './markdown-file-actions.ts'
import type { FilePathCandidate } from '../../../lib/file-paths.ts'
import type { MessageFileActionContext } from '../types'

test('markdown link file actions detect local paths and ignore external links', () => {
  const actions = createActions()

  assert.deepEqual(getMarkdownLinkFileCandidate('./web/src/lib/api.ts#L42', actions), {
    raw_path: './web/src/lib/api.ts#L42',
    relative_path: 'web/src/lib/api.ts',
    line: 42,
    source_surface: 'markdown_link',
  })
  assert.equal(getMarkdownLinkFileCandidate('https://example.com/api.ts', actions), null)
  assert.equal(getMarkdownLinkFileCandidate('./web/src/lib/api.ts', undefined), null)
})

test('inline code file actions detect file paths and ignore low-confidence code', () => {
  const actions = createActions()

  assert.deepEqual(getInlineCodeFileCandidate('service/src/files/file-session.ts:12:4', actions), {
    raw_path: 'service/src/files/file-session.ts:12:4',
    relative_path: 'service/src/files/file-session.ts',
    line: 12,
    column: 4,
    source_surface: 'inline_code',
  })
  assert.equal(getInlineCodeFileCandidate('npm run build', actions), null)
  assert.equal(getInlineCodeFileCandidate('README.md', undefined), null)
})

test('file action click handler is lazy and calls open exactly once per click', () => {
  const opened: FilePathCandidate[] = []
  const actions = createActions(opened)
  const candidate = getInlineCodeFileCandidate('README.md', actions)
  assert.ok(candidate)

  const handler = createFileOpenClickHandler(actions, candidate)
  assert.deepEqual(opened, [])

  handler()
  assert.deepEqual(opened, [candidate])
})

function createActions(opened: FilePathCandidate[] = []): MessageFileActionContext {
  return {
    source: {
      kind: 'assistant_message',
      message_id: '22222222-2222-4222-8222-222222222222',
      client_id: '33333333-3333-4333-8333-333333333333',
    },
    onOpenFileCandidate(candidate) {
      opened.push(candidate)
    },
  }
}
