import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) return undefined
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`)
    }
    return this.session
  }
}

test('PiAcpAgent: newSession returns configOptions for provider, model, and thinking selectors', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return {
            models: [
              { provider: 'test', id: 'alpha', name: 'Alpha' },
              { provider: 'test', id: 'beta', name: 'Beta' }
            ]
          }
        },
        async getState() {
          return {
            thinkingLevel: 'high',
            model: { provider: 'test', id: 'beta' }
          }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal(result.models?.currentModelId, 'test/beta')
    assert.equal(result.modes?.currentModeId, 'high')
    assert.deepEqual(result.configOptions, [
      {
        type: 'select',
        id: 'provider',
        category: 'model',
        name: 'Provider',
        description: 'Select the provider for this session',
        currentValue: 'test',
        options: [{ value: 'test', name: 'test', description: null }]
      },
      {
        type: 'select',
        id: 'model',
        category: 'model',
        name: 'Model',
        description: 'Select the model for this session',
        currentValue: 'beta',
        options: [
          { value: 'alpha', name: 'test/Alpha', description: null },
          { value: 'beta', name: 'test/Beta', description: null }
        ]
      },
      {
        type: 'select',
        id: 'thought_level',
        category: 'thought_level',
        name: 'Thinking',
        description: 'Set the reasoning effort for this session',
        currentValue: 'high',
        options: [
          { value: 'off', name: 'Thinking: off', description: null },
          { value: 'minimal', name: 'Thinking: minimal', description: null },
          { value: 'low', name: 'Thinking: low', description: null },
          { value: 'medium', name: 'Thinking: medium', description: null },
          { value: 'high', name: 'Thinking: high', description: null },
          { value: 'xhigh', name: 'Thinking: xhigh', description: null }
        ]
      }
    ])
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: setSessionConfigOption maps model changes to pi and emits config_option_update', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  const setModelCalls: Array<{ provider: string; modelId: string }> = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [
            { provider: 'test', id: 'alpha', name: 'Alpha' },
            { provider: 'test', id: 'beta', name: 'Beta' }
          ]
        }
      },
      async getState() {
        return state
      },
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
        state.model = { provider, id: modelId }
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'beta'
  } as any)

  assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'beta' }])
  assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'beta')
  assert.deepEqual(conn.updates, [
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: result.configOptions
      }
    }
  ])
})

test('PiAcpAgent: config model selection preserves slash-containing model IDs for the current provider', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'openrouter', id: 'anthropic/claude-sonnet' }
  }
  const setModelCalls: Array<{ provider: string; modelId: string }> = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [
            { provider: 'openrouter', id: 'anthropic/claude-sonnet', name: 'Claude Sonnet' },
            { provider: 'other', id: 'anthropic/claude-sonnet', name: 'Other Claude Sonnet' }
          ]
        }
      },
      async getState() {
        return state
      },
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
        state.model = { provider, id: modelId }
      }
    }
  }
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'anthropic/claude-sonnet'
  } as any)

  assert.deepEqual(setModelCalls, [{ provider: 'openrouter', modelId: 'anthropic/claude-sonnet' }])
})

test('PiAcpAgent: rapid provider then model requests apply the requested model after the provider switch', async () => {
  const conn = new FakeAgentSideConnection()
  const state = { model: { provider: 'one', id: 'a' }, thinkingLevel: 'medium' }
  const calls: Array<{ provider: string; modelId: string }> = []
  let providerSetModelStarted!: () => void
  let releaseProviderSetModel!: () => void
  const providerSetModelStartedPromise = new Promise<void>(resolve => {
    providerSetModelStarted = resolve
  })
  const providerSetModelReleasePromise = new Promise<void>(resolve => {
    releaseProviderSetModel = resolve
  })

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [
            { provider: 'one', id: 'a', name: 'A' },
            { provider: 'two', id: 'b', name: 'B' },
            { provider: 'two', id: 'c', name: 'C' }
          ]
        }
      },
      async getState() {
        return { ...state, model: { ...state.model } }
      },
      async setModel(provider: string, modelId: string) {
        calls.push({ provider, modelId })
        if (provider === 'two' && modelId === 'b') {
          providerSetModelStarted()
          await providerSetModelReleasePromise
        }
        state.model = { provider, id: modelId }
      }
    }
  }
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const providerRequest = agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'provider',
    value: 'two'
  } as any)
  await providerSetModelStartedPromise

  const modelRequest = agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'c'
  } as any)

  releaseProviderSetModel()
  await Promise.all([providerRequest, modelRequest])

  assert.deepEqual(calls, [
    { provider: 'two', modelId: 'b' },
    { provider: 'two', modelId: 'c' }
  ])
  assert.deepEqual(state.model, { provider: 'two', id: 'c' })
  assert.deepEqual(
    conn.updates.map(update => {
      const options = update.update.sessionUpdate === 'config_option_update' ? update.update.configOptions : []
      return options.find(option => option.id === 'model')?.currentValue
    }),
    ['b', 'c']
  )
})

test('PiAcpAgent: rapid thought-level updates await ordered mode notifications without unhandled rejection', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  const modeNotifications: string[] = []
  const unhandledRejections: unknown[] = []
  let firstNotificationStarted!: () => void
  let releaseFirstNotification!: () => void
  const firstNotificationStartedPromise = new Promise<void>(resolve => {
    firstNotificationStarted = resolve
  })
  const firstNotificationPromise = new Promise<void>(resolve => {
    releaseFirstNotification = resolve
  })
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason)
  }
  const originalSessionUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async msg => {
    if (msg.update.sessionUpdate === 'current_mode_update') {
      modeNotifications.push(msg.update.currentModeId)
      if (modeNotifications.length === 1) {
        firstNotificationStarted()
        await firstNotificationPromise
      }
      if (msg.update.currentModeId === 'high') {
        throw new Error('current mode notification failed')
      }
    }
    await originalSessionUpdate(msg)
  }

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        return state
      },
      async setThinkingLevel(level: string) {
        state.thinkingLevel = level
      }
    }
  }
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  let firstRequest: Promise<unknown> | undefined
  let secondRequest: Promise<unknown> | undefined
  process.on('unhandledRejection', onUnhandledRejection)
  try {
    firstRequest = agent.setSessionConfigOption({
      sessionId: 's1',
      configId: 'thought_level',
      value: 'low'
    } as any)
    await firstNotificationStartedPromise

    secondRequest = agent.setSessionConfigOption({
      sessionId: 's1',
      configId: 'thought_level',
      value: 'high'
    } as any)
    await new Promise<void>(resolve => setImmediate(resolve))

    assert.deepEqual(modeNotifications, ['low'])
    assert.equal(conn.updates.length, 0)

    releaseFirstNotification()
    await firstRequest
    await assert.rejects(secondRequest, /current mode notification failed/)
    await new Promise<void>(resolve => setImmediate(resolve))

    assert.deepEqual(modeNotifications, ['low', 'high'])
    assert.deepEqual(
      conn.updates.map(update => update.update.sessionUpdate),
      ['current_mode_update', 'config_option_update']
    )
    assert.deepEqual(unhandledRejections, [])
  } finally {
    releaseFirstNotification()
    await firstRequest?.catch(() => undefined)
    await secondRequest?.catch(() => undefined)
    process.off('unhandledRejection', onUnhandledRejection)
  }
})

test('PiAcpAgent: provider selection uses a model from that provider and filters model choices', async () => {
  const conn = new FakeAgentSideConnection()
  const state = { model: { provider: 'one', id: 'a' }, thinkingLevel: 'medium' }
  const calls: Array<{ provider: string; modelId: string }> = []
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [
            { provider: 'one', id: 'a', name: 'A' },
            { provider: 'two', id: 'b', name: 'B' },
            { provider: 'two', id: 'c', name: 'C' }
          ]
        }
      },
      async getState() {
        return state
      },
      async setModel(provider: string, modelId: string) {
        calls.push({ provider, modelId })
        state.model = { provider, id: modelId }
      }
    }
  }
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({ sessionId: 's1', configId: 'provider', value: 'two' } as any)

  assert.deepEqual(calls, [{ provider: 'two', modelId: 'b' }])
  const modelOption = result.configOptions.find(option => option.id === 'model')
  assert.equal(modelOption?.type, 'select')
  if (modelOption?.type === 'select') {
    assert.deepEqual(modelOption.options, [
      { value: 'b', name: 'two/B', description: null },
      { value: 'c', name: 'two/C', description: null }
    ])
  }
})

test('PiAcpAgent: setSessionConfigOption maps thought level changes to pi and emits sync updates', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  const thinkingLevels: string[] = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }]
        }
      },
      async getState() {
        return state
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
        state.thinkingLevel = level
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'thought_level',
    value: 'xhigh'
  } as any)

  assert.deepEqual(thinkingLevels, ['xhigh'])
  assert.equal(result.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'xhigh')
  assert.deepEqual(conn.updates, [
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'xhigh'
      }
    },
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: result.configOptions
      }
    }
  ])
})
