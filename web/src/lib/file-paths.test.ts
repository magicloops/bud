import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFilePathCandidate } from './file-paths.ts'

test('parseFilePathCandidate accepts relative file paths', () => {
  assert.deepEqual(parseFilePathCandidate('README.md', 'inline_code'), {
    raw_path: 'README.md',
    relative_path: 'README.md',
    source_surface: 'inline_code',
  })
  assert.deepEqual(parseFilePathCandidate('./web/src/lib/api.ts', 'markdown_link'), {
    raw_path: './web/src/lib/api.ts',
    relative_path: 'web/src/lib/api.ts',
    source_surface: 'markdown_link',
  })
})

test('parseFilePathCandidate extracts line and column suffixes', () => {
  assert.deepEqual(parseFilePathCandidate('web/src/lib/api.ts:42:7', 'inline_code'), {
    raw_path: 'web/src/lib/api.ts:42:7',
    relative_path: 'web/src/lib/api.ts',
    line: 42,
    column: 7,
    source_surface: 'inline_code',
  })
  assert.deepEqual(parseFilePathCandidate('web/src/lib/api.ts#L42-L48', 'markdown_link'), {
    raw_path: 'web/src/lib/api.ts#L42-L48',
    relative_path: 'web/src/lib/api.ts',
    line: 42,
    source_surface: 'markdown_link',
  })
})

test('parseFilePathCandidate rejects unsafe or non-file forms', () => {
  for (const value of [
    '/etc/passwd',
    '/Users/adam/bud/README.md',
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
