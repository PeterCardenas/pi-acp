import test from 'node:test'
import assert from 'node:assert/strict'
import { maybeAuthRequiredError } from '../../src/acp/auth-required.js'

test('classifies provider 401 as auth required', () => {
  assert.equal(maybeAuthRequiredError(new Error('provider request failed with 401'))?.code, -32000)
})

test('does not classify filesystem permission denied as auth required', () => {
  assert.equal(maybeAuthRequiredError(new Error('permission denied reading file')), null)
})

test('does not classify unrelated embedded numeric text as auth required', () => {
  assert.equal(maybeAuthRequiredError(new Error('build-401-ready')), null)
})

test('does not classify benign authentication configuration status as auth required', () => {
  assert.equal(maybeAuthRequiredError(new Error('authentication configuration status: ready')), null)
})

test('does not classify API key validation service availability as auth required', () => {
  assert.equal(maybeAuthRequiredError(new Error('API key validation service unavailable')), null)
})

test('does not classify API key configuration status as auth required', () => {
  assert.equal(maybeAuthRequiredError(new Error('API key configuration loaded')), null)
})

test('classifies missing provider API key as auth required', () => {
  assert.equal(maybeAuthRequiredError(new Error('No API key for provider'))?.code, -32000)
})

test('classifies invalid API key as auth required', () => {
  assert.equal(maybeAuthRequiredError(new Error('invalid API key'))?.code, -32000)
})
