import test from 'node:test'
import assert from 'node:assert/strict'
import { toolCallTitle, toolResultToText } from '../../src/acp/translate/pi-tools.js'

test('toolCallTitle: includes paths for file tools', () => {
  assert.equal(toolCallTitle('read', { path: 'a.ts' }), 'read a.ts')
  assert.equal(toolCallTitle('edit', { path: 'a.ts' }), 'edit a.ts')
  assert.equal(toolCallTitle('write', { file_path: 'b.ts' }), 'write b.ts')
})

test('toolCallTitle: does not recurse forever through cyclic args', () => {
  const args: { args?: unknown } = {}
  args.args = args

  assert.equal(toolCallTitle('edit', args), 'edit')
})

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: extracts scalar content text', () => {
  const text = toolResultToText({ content: 'read result' })
  assert.equal(text, 'read result')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})
