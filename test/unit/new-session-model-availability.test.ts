import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

type TestSession = {
  sessionId: string
  cwd: string
  proc: {
    getAvailableModels(): Promise<{ models: unknown[] }>
    getState(): Promise<unknown>
  }
}

type NewSessionRequest = Parameters<PiAcpAgent['newSession']>[0]

class FakeSessions {
  closeCalls: string[] = []

  constructor(private readonly session: TestSession) {}

  async create(_params: Parameters<SessionManager['create']>[0]): Promise<TestSession> {
    return this.session
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId)
  }
}

test('PiAcpAgent: state auth error takes precedence over empty available models', async () => {
  const conn = new FakeAgentSideConnection()
  const session = {
    sessionId: 's-auth',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [] }
      },
      async getState() {
        throw new Error('authentication required: no api key')
      }
    }
  }
  const sessions = new FakeSessions(session)
  const agent = new PiAcpAgent(asAgentConn(conn), {})
  Reflect.set(agent, 'sessions', sessions)
  const request = { cwd: process.cwd(), mcpServers: [] } satisfies NewSessionRequest
  await assert.rejects(agent.newSession(request), (error: unknown) => {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === -32000
  })
  assert.deepEqual(sessions.closeCalls, ['s-auth'])
})

test('PiAcpAgent: newSession throws internal error when pi reports zero available models', async () => {
  const conn = new FakeAgentSideConnection()

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [] }
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const agent = new PiAcpAgent(asAgentConn(conn), {})
  Reflect.set(agent, 'sessions', sessions)

  let threw = false
  const request = { cwd: process.cwd(), mcpServers: [] } satisfies NewSessionRequest
  try {
    await agent.newSession(request)
  } catch (error: unknown) {
    threw = true
    assert.equal(typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined, -32603)
    assert.match(
      String(typeof error === 'object' && error !== null && 'message' in error ? error.message : ''),
      /No models configured/i
    )
  }

  assert.equal(threw, true)
  assert.deepEqual(sessions.closeCalls, ['s1'])
})
