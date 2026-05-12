import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFilePathCandidate } from './file-paths.ts'

test('parseFilePathCandidate accepts relative file paths', () => {
  assert.deepEqual(parseFilePathCandidate('README.md', 'inline_code'), {
    path_kind: 'relative',
    raw_path: 'README.md',
    relative_path: 'README.md',
    source_surface: 'inline_code',
  })
  assert.deepEqual(parseFilePathCandidate('./web/src/lib/api.ts', 'markdown_link'), {
    path_kind: 'relative',
    raw_path: './web/src/lib/api.ts',
    relative_path: 'web/src/lib/api.ts',
    source_surface: 'markdown_link',
  })
})

test('parseFilePathCandidate extracts line and column suffixes', () => {
  assert.deepEqual(parseFilePathCandidate('web/src/lib/api.ts:42:7', 'inline_code'), {
    path_kind: 'relative',
    raw_path: 'web/src/lib/api.ts:42:7',
    relative_path: 'web/src/lib/api.ts',
    line: 42,
    column: 7,
    source_surface: 'inline_code',
  })
  assert.deepEqual(parseFilePathCandidate('web/src/lib/api.ts#L42-L48', 'markdown_link'), {
    path_kind: 'relative',
    raw_path: 'web/src/lib/api.ts#L42-L48',
    relative_path: 'web/src/lib/api.ts',
    line: 42,
    source_surface: 'markdown_link',
  })
})

test('parseFilePathCandidate accepts high-confidence absolute POSIX file paths', () => {
  assert.deepEqual(parseFilePathCandidate('/Users/adam/bud/README.md', 'markdown_link'), {
    path_kind: 'absolute_posix',
    raw_path: '/Users/adam/bud/README.md',
    requested_path: '/Users/adam/bud/README.md',
    display_path: '/Users/adam/bud/README.md',
    source_surface: 'markdown_link',
  })
  assert.deepEqual(parseFilePathCandidate('/Users/adam/bud/service/src/files/file-session.ts:42:7', 'inline_code'), {
    path_kind: 'absolute_posix',
    raw_path: '/Users/adam/bud/service/src/files/file-session.ts:42:7',
    requested_path: '/Users/adam/bud/service/src/files/file-session.ts',
    display_path: '/Users/adam/bud/service/src/files/file-session.ts',
    line: 42,
    column: 7,
    source_surface: 'inline_code',
  })
  assert.deepEqual(parseFilePathCandidate('/workspaces/bud/Makefile', 'markdown_link'), {
    path_kind: 'absolute_posix',
    raw_path: '/workspaces/bud/Makefile',
    requested_path: '/workspaces/bud/Makefile',
    display_path: '/workspaces/bud/Makefile',
    source_surface: 'markdown_link',
  })
})

test('parseFilePathCandidate rejects unsafe or non-file forms', () => {
  for (const value of [
    '/etc/passwd',
    '/settings',
    '/api/threads',
    '/Users/adam/bud/docs/',
    '//example.com/file.ts',
    '~/secrets.txt',
    '../outside.txt',
    'service/../outside.txt',
    'C:/Users/adam/file.txt',
    'C:\\Users\\adam\\file.txt',
    'https://example.com/file.ts',
    'test@example.com',
    'src/',
    'not-a-file',
  ]) {
    assert.equal(parseFilePathCandidate(value, 'plain_text'), null, value)
  }
})
