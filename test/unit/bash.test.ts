import test from 'node:test'
import assert from 'node:assert/strict'
import { bashOutputDelta, bashResultText } from '../../src/acp/translate/bash.js'

test('bashResultText: extracts scalar content', () => {
  assert.equal(bashResultText({ content: 'partial output' }), 'partial output')
})

test('bashOutputDelta: emits only appended output, including final output', () => {
  assert.equal(bashOutputDelta('', 'one'), 'one')
  assert.equal(bashOutputDelta('one', 'one\ntwo'), '\ntwo')
  assert.equal(bashOutputDelta('one\ntwo', 'one\ntwo\nfinal'), '\nfinal')
})
