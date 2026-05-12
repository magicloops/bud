import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createFileOpenClickHandler,
  getInlineCodeFileCandidate,
  getMarkdownLinkAction,
  getMarkdownLinkFileCandidate,
} from './markdown-file-actions.ts'
import type { FilePathCandidate } from '../../../lib/file-paths.ts'
import type { MessageFileActionContext } from '../types'

test('markdown link file actions detect local paths and ignore external links', () => {
  const actions = createActions()

  assert.deepEqual(getMarkdownLinkFileCandidate('./web/src/lib/api.ts#L42', actions), {
    path_kind: 'relative',
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
    path_kind: 'relative',
    raw_path: 'service/src/files/file-session.ts:12:4',
    relative_path: 'service/src/files/file-session.ts',
    line: 12,
    column: 4,
    source_surface: 'inline_code',
  })
  assert.equal(getInlineCodeFileCandidate('npm run build', actions), null)
  assert.equal(getInlineCodeFileCandidate('README.md', undefined), null)
})

test('markdown link actions classify absolute file links and inert local preview links', () => {
  const actions = createActions()
  assert.deepEqual(getMarkdownLinkFileCandidate('/Users/adam/bud/bud.spec.md', actions), {
    path_kind: 'absolute_posix',
    raw_path: '/Users/adam/bud/bud.spec.md',
    requested_path: '/Users/adam/bud/bud.spec.md',
    display_path: '/Users/adam/bud/bud.spec.md',
    source_surface: 'markdown_link',
  })
  assert.deepEqual(getMarkdownLinkAction('/Users/adam/bud/bud.spec.md', actions, { inertLocalLinks: true }), {
    kind: 'file',
    candidate: {
      path_kind: 'absolute_posix',
      raw_path: '/Users/adam/bud/bud.spec.md',
      requested_path: '/Users/adam/bud/bud.spec.md',
      display_path: '/Users/adam/bud/bud.spec.md',
      source_surface: 'markdown_link',
    },
  })
  assert.deepEqual(getMarkdownLinkAction('./next.md', actions, {
    inertLocalLinks: true,
    allowedPathKinds: ['absolute_posix'],
  }), {
    kind: 'unsupported_local',
  })
  assert.deepEqual(getMarkdownLinkAction('https://example.com/docs', actions, { inertLocalLinks: true }), {
    kind: 'external',
    href: 'https://example.com/docs',
  })
  assert.deepEqual(getMarkdownLinkAction('', actions, { inertLocalLinks: true }), {
    kind: 'unsafe',
  })
  assert.deepEqual(getMarkdownLinkAction('javascript:alert(1)', actions, { inertLocalLinks: true }), {
    kind: 'unsafe',
  })
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
