import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import type { PiAuthCheckResult } from '../../src/pi-rpc/process.js'

type Session = {
  sessionId: string
  cwd: string
  proc: FakePiRpcProcess
  setStartupInfo(value: string): void
  sendStartupInfoIfPending(): Promise<void>
}

class InjectedSessions {
  readonly entries = new Map<string, Session>()
  constructor(private readonly session: Session) {}
  async create(_params: Parameters<SessionManager['create']>[0]): Promise<Session> {
    this.entries.set(this.session.sessionId, this.session)
    return this.session
  }
  close(sessionId: string): void {
    this.session.proc.dispose()
    this.entries.delete(sessionId)
  }
  async closeAndWait(sessionId: string): Promise<void> {
    this.session.proc.dispose()
    this.entries.delete(sessionId)
  }
}

function setup(proc = new FakePiRpcProcess()) {
  const session = {
    sessionId: `s-${Math.random()}`,
    cwd: process.cwd(),
    proc,
    setStartupInfo() {},
    async sendStartupInfoIfPending() {}
  }
  const sessions = new InjectedSessions(session)
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {})
  Reflect.set(agent, 'sessions', sessions)
  return {
    agent,
    proc,
    sessions,
    request: { cwd: process.cwd(), mcpServers: [] } as Parameters<PiAcpAgent['newSession']>[0]
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

test('selected openai model checks its provider and creates a ready session', async () => {
  const proc = new FakePiRpcProcess()
  proc.state = { model: { provider: 'openai', id: 'model' }, thinkingLevel: 'medium' }
  proc.availableModels = { models: [{ provider: 'openai', id: 'model', name: 'model' }] }
  const { agent, request } = setup(proc)
  const result = await agent.newSession(request)
  assert.equal(result.sessionId.startsWith('s-'), true)
  assert.deepEqual(proc.authProviders, ['openai'])
})

test('stale selected provider is rejected before auth and cleans up', async () => {
  const proc = new FakePiRpcProcess()
  proc.state = { model: { provider: 'stale', id: 'model' }, thinkingLevel: 'medium' }
  proc.availableModels = { models: [{ provider: 'advertised', id: 'model', name: 'model' }] }
  const { agent, proc: trackedProc, sessions, request } = setup(proc)
  await assert.rejects(agent.newSession(request), error => errorCode(error) === -32603)
  assert.deepEqual(trackedProc.authProviders, [])
  assert.equal(trackedProc.disposed, true)
  assert.equal(sessions.entries.size, 0)
})

test('unadvertised selected model is rejected before auth and cleans up', async () => {
  const proc = new FakePiRpcProcess()
  proc.state = { model: { provider: 'openai', id: 'new-model' }, thinkingLevel: 'medium' }
  proc.availableModels = { models: [{ provider: 'openai', id: 'other-model', name: 'other-model' }] }
  const { agent, request } = setup(proc)
  await assert.rejects(agent.newSession(request), error => errorCode(error) === -32603)
  assert.deepEqual(proc.authProviders, [])
  assert.equal(proc.disposed, true)
})

test('newSession waits for deferred auth and then succeeds', async () => {
  let resolve!: (result: PiAuthCheckResult) => void
  const auth = new Promise<PiAuthCheckResult>(r => {
    resolve = r
  })
  const { agent, proc, request } = setup()
  proc.authCheck = async () => auth
  let settled = false
  const pending = agent.newSession(request).then(() => {
    settled = true
  })
  await new Promise(resolveTick => setImmediate(resolveTick))
  assert.equal(settled, false)
  resolve({ status: 'ready' })
  await pending
  assert.equal(settled, true)
})

test('credential auth failures reject with auth methods and clean up', async t => {
  for (const reason of ['credentials_not_configured', 'credential_not_available'] as const) {
    await t.test(reason, async () => {
      const { agent, proc, sessions, request } = setup()
      proc.authResult = { status: 'not_ready', reason }
      await assert.rejects(agent.newSession(request), error => {
        assert.equal(errorCode(error), -32000)
        assert.ok((error as { data?: { authMethods?: unknown[] } }).data?.authMethods?.length)
        return true
      })
      assert.equal(proc.disposed, true)
      assert.equal(sessions.entries.size, 0)
    })
  }
})

test('invalid auth statuses reject internally and clean up', async t => {
  for (const result of [
    { status: 'not_ready', reason: 'provider_not_found' },
    { status: 'invalid', reason: 'invalid_state' }
  ] as const) {
    await t.test(result.status + '-' + result.reason, async () => {
      const { agent, proc, sessions, request } = setup()
      proc.authResult = result
      await assert.rejects(agent.newSession(request), error => errorCode(error) === -32603)
      assert.equal(proc.disposed, true)
      assert.equal(sessions.entries.size, 0)
    })
  }
})

test('auth hook rejection rejects internally and cleans up', async () => {
  const { agent, proc, sessions, request } = setup()
  proc.authCheck = async () => {
    throw new Error('auth failed')
  }
  await assert.rejects(agent.newSession(request), error => errorCode(error) === -32603)
  assert.equal(proc.disposed, true)
  assert.equal(sessions.entries.size, 0)
})

test('non-auth state error rejects internally and cleans up', async () => {
  const { agent, proc, sessions, request } = setup()
  proc.getStateError = new Error('state failed')
  await assert.rejects(agent.newSession(request), error => errorCode(error) === -32603)
  assert.equal(proc.disposed, true)
  assert.equal(sessions.entries.size, 0)
})
