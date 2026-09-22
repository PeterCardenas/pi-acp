import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiAuthCheckResult, PiRpcEvent, PiRpcProcess } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []
  sessionStats: unknown = {
    tokens: { input: 0 },
    cost: 0,
    contextUsage: { tokens: 0, contextWindow: 8192, percent: 0 }
  }

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  authResult: PiAuthCheckResult = { status: 'ready' }
  authCheck?: (provider: string) => Promise<PiAuthCheckResult>
  authProviders: string[] = []
  disposed = false
  async checkAuth(provider: string): Promise<PiAuthCheckResult> {
    this.authProviders.push(provider)
    return this.authCheck?.(provider) ?? this.authResult
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  getStateError?: Error
  state: unknown = { model: { provider: 'test', id: 'model' }, thinkingLevel: 'medium' }
  async getState(): Promise<unknown> {
    if (this.getStateError) throw this.getStateError
    return this.state
  }

  dispose(): void {
    this.disposed = true
  }

  async disposeAndWait(): Promise<void> {
    this.dispose()
  }

  async getSessionStats(_signal?: AbortSignal): Promise<unknown> {
    return this.sessionStats
  }

  availableModels: unknown = { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  async getAvailableModels(): Promise<unknown> {
    return this.availableModels
  }

  async getMessages(): Promise<unknown> {
    return { messages: [] }
  }
}

export function asPiRpcProcess(proc: FakePiRpcProcess): PiRpcProcess {
  return proc as unknown as PiRpcProcess
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
