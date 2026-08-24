import assert from 'node:assert/strict'
import test from 'node:test'
import type { NewSessionRequest, PromptRequest } from '@agentclientprotocol/sdk'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn, asPiRpcProcess } from '../helpers/fakes.js'

test('PiAcpAgent keeps independently created sessions live', async t => {
  const processes: FakePiRpcProcess[] = []
  t.mock.method(PiRpcProcess, 'spawn', async () => {
    const process = new FakePiRpcProcess()
    processes.push(process)
    return asPiRpcProcess(process)
  })

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  try {
    const params: NewSessionRequest = { cwd: process.cwd(), mcpServers: [] }
    const sessionA = await agent.newSession(params)
    const sessionB = await agent.newSession(params)

    const prompt = (sessionId: string, text: string): PromptRequest => ({
      sessionId,
      prompt: [{ type: 'text', text }]
    })
    const promptA = agent.prompt(prompt(sessionA.sessionId, 'A'))
    await new Promise<void>(resolve => setImmediate(resolve))
    processes[0].emit({ type: 'agent_settled' })
    await promptA

    const promptB = agent.prompt(prompt(sessionB.sessionId, 'B'))
    await new Promise<void>(resolve => setImmediate(resolve))
    processes[1].emit({ type: 'agent_settled' })
    await promptB

    assert.equal(processes.length, 2)
    assert.deepEqual(
      processes[0].prompts.map(({ message }) => message),
      ['A']
    )
    assert.deepEqual(
      processes[1].prompts.map(({ message }) => message),
      ['B']
    )
  } finally {
    agent.dispose()
  }
})
