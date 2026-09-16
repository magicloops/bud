import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { BrowserObservationContent } from './browser-observation'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
test('browser evidence stays collapsed and images use only authenticated artifact paths', async () => {
  const path = '/api/threads/242d4d45-ed64-47ac-9446-1a229d68c673/browser-images/1999999999999-01M2KFXEFBTPXR71B57JFBW9Z1'
  for (const candidate of [path, 'https://example.com/image', '/api/threads/../private']) {
    let tree!: ReturnType<typeof create>
    await act(async () => { tree = create(<BrowserObservationContent payload={{data:{observation:{text:'link "Story 16"',truncated:true},image_artifact:{path:candidate}}}} />) })
    assert.equal(tree.root.findAllByType('img').length, 0)
    assert.equal(tree.root.findAllByType('pre').length, 0)
    await act(async () => { tree.root.findByType('button').props.onClick() })
    assert.equal(tree.root.findByType('pre').children[0], 'link "Story 16"')
    assert.equal(tree.root.findAllByType('img').length, candidate === path ? 1 : 0)
    if (candidate === path) {
      await act(async () => { tree.root.findByType('img').props.onError() })
      assert.match(JSON.stringify(tree.toJSON()), /unavailable or expired/)
    }
    await act(async () => tree.unmount())
  }
})
