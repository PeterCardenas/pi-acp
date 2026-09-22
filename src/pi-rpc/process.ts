import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { platform } from 'node:os'
import * as readline from 'node:readline'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'set_thinking_level'; id?: string; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiExtensionUiResponse =
  { id: string; value: string } | { id: string; confirmed: boolean } | { id: string; cancelled: true }

export type PiRpcEvent = Record<string, unknown>

export type PiAuthReason = (typeof AUTH_REASONS)[number]
export type PiAuthCheckResult =
  { status: 'ready' } | { status: 'not_ready'; reason: PiAuthReason } | { status: 'invalid'; reason: 'invalid_state' }

const AUTH_REASONS = [
  'credentials_not_configured',
  'credential_not_available',
  'provider_not_found',
  'invalid_state'
] as const
export type PiAuthCheckOptions = {
  cwd: string
  piCommand?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export async function checkPiAuth(provider: string, options: PiAuthCheckOptions): Promise<PiAuthCheckResult> {
  if (!/^[A-Za-z0-9._-]+$/.test(provider))
    return Promise.reject(new Error('Pi auth check returned an invalid provider'))
  const cmd = getPiCommand(options.piCommand)
  const child = spawn(cmd, ['auth', 'check', '--provider', provider, '--json'], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: shouldUseShellForPiCommand(cmd)
  })
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stdoutBytes = 0
    let settled = false
    let terminalError: Error | undefined
    let terminationRequested = false
    let taskkill: ChildProcess | undefined
    let terminationWatchdog: NodeJS.Timeout | undefined
    const forceKillAndWatch = () => {
      if (terminationWatchdog) return
      child.kill('SIGKILL')
      terminationWatchdog = setTimeout(() => {
        if (terminalError) finish(terminalError)
      }, 1000)
    }
    const terminate = () => {
      if (terminationRequested) return
      terminationRequested = true
      if (platform() === 'win32' && child.pid) {
        taskkill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
          shell: false
        })
        taskkill.once('close', onTaskkillClose)
        taskkill.once('error', onTaskkillError)
      } else {
        child.kill('SIGKILL')
      }
    }
    const requestTermination = (error: Error) => {
      if (terminalError) return
      terminalError = error
      terminate()
    }
    const finish = (error?: Error, result?: PiAuthCheckResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (terminationWatchdog) clearTimeout(terminationWatchdog)
      if (taskkill) {
        taskkill.removeListener('close', onTaskkillClose)
        taskkill.removeListener('error', onTaskkillError)
      }
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error('Pi auth check returned an invalid result'))
    }
    const onStdout = (chunk: Buffer) => {
      if (stdoutBytes + chunk.byteLength > 65536) {
        requestTermination(new Error('Pi auth check output exceeded limit'))
        return
      }
      stdout += chunk.toString()
      stdoutBytes += chunk.byteLength
    }
    const onStderr = () => undefined
    const onError = () => finish(new Error('Pi auth check failed to start'))
    const onTaskkillClose = (code: number | null) => {
      if (code === 0 && terminalError) return child.kill()
      if (terminalError) forceKillAndWatch()
    }
    const onTaskkillError = () => {
      if (terminalError) forceKillAndWatch()
    }
    const onClose = (code: number | null) => {
      if (terminalError) return finish(terminalError)
      try {
        const value: unknown = JSON.parse(stdout.trim())
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        const record = value as Record<string, unknown>
        // Pi 0.84.3 AuthCheckResult uses ready/0, provider_not_found/1, and invalid/2.
        if (record.provider !== provider) throw new Error()
        if (record.status === 'ready' && code === 0) return finish(undefined, { status: 'ready' })
        if (
          record.status === 'not_ready' &&
          code === 1 &&
          typeof record.reason === 'string' &&
          (AUTH_REASONS as readonly string[]).includes(record.reason)
        ) {
          if (record.reason === 'invalid_state' || record.reason === 'provider_not_found')
            return finish(undefined, { status: 'invalid', reason: 'invalid_state' })
          return finish(undefined, { status: 'not_ready', reason: record.reason as PiAuthReason })
        }
        if (record.status === 'invalid' && record.reason === 'invalid_state' && code === 2)
          return finish(undefined, { status: 'invalid', reason: 'invalid_state' })
      } catch {
        /* handled below */
      }
      finish(new Error('Pi auth check returned an invalid result'))
    }
    const timer = setTimeout(() => {
      requestTermination(new Error('Pi auth check timed out'))
    }, options.timeoutMs ?? 20000)
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  readonly cwd: string
  readonly piCommand: string
  private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly preludeLines: string[] = []

  private constructor(child: ChildProcessWithoutNullStreams, cwd: string, piCommand: string) {
    this.child = child
    this.cwd = cwd
    this.piCommand = piCommand

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        // pi may emit a human-readable prelude on stdout before NDJSON starts.
        // Capture it so the ACP adapter can surface it on session start.
        const cleaned = stripAnsi(String(line)).trimEnd()
        if (cleaned) this.preludeLines.push(cleaned)
        return
      }

      if (msg?.type === 'response') {
        const id = typeof msg.id === 'string' ? msg.id : undefined
        if (id) {
          const pending = this.pending.get(id)
          if (pending) {
            this.pending.delete(id)
            pending.resolve(msg as PiRpcResponse)
            return
          }
        }
      }

      for (const h of this.eventHandlers) h(msg as PiRpcEvent)
    })

    child.on('exit', (code, signal) => {
      const err = new Error(`pi process exited (code=${code}, signal=${signal})`)
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })

    child.on('error', err => {
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = ['--mode', 'rpc', '--no-themes']
    if (params.sessionPath) args.push('--session', params.sessionPath)

    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: process.env,
      shell: shouldUseShellForPiCommand(cmd)
    })

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    child.stderr.on('data', () => {
      // leave stderr untouched; ACP clients may capture it.
    })

    const proc = new PiRpcProcess(child, params.cwd, cmd)

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await proc.getState()) as any
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch {
      // ignore for now
    }

    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.killed) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  async disposeAndWait(timeoutMs = 2000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return

    const waitForClose = (): { promise: Promise<boolean>; cancel: () => void } => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const onClose = () => settle(true)
      const settle = (closed: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.child.off('close', onClose)
        resolvePromise(closed)
      }
      let resolvePromise!: (closed: boolean) => void
      const promise = new Promise<boolean>(resolve => {
        resolvePromise = resolve
        this.child.once('close', onClose)
        if (this.child.exitCode !== null || this.child.signalCode !== null) {
          settle(true)
          return
        }
        timer = setTimeout(() => settle(this.child.exitCode !== null || this.child.signalCode !== null), timeoutMs)
      })
      return { promise, cancel: () => settle(false) }
    }

    const graceful = waitForClose()
    this.dispose('SIGTERM')
    if (await graceful.promise) return

    const forced = waitForClose()
    try {
      if (platform() === 'win32') {
        await new Promise<void>((resolve, reject) => {
          const killer = spawn('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true })
          killer.once('error', reject)
          killer.once('close', code => (code === 0 ? resolve() : reject(new Error(`taskkill failed (${code})`))))
        })
      } else {
        this.child.kill('SIGKILL')
      }
    } catch (error) {
      forced.cancel()
      throw error
    }

    if (!(await forced.promise)) throw new Error('pi process did not exit')
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  async checkAuth(provider: string): Promise<PiAuthCheckResult> {
    return checkPiAuth(provider, { cwd: this.cwd, piCommand: this.piCommand })
  }

  async prompt(message: string, images: unknown[] = []): Promise<void> {
    const res = await this.request({ type: 'prompt', message, images })
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setThinkingLevel(level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions })
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(signal?: AbortSignal): Promise<unknown> {
    const res = await this.request({ type: 'get_session_stats' }, signal)
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(cmd: PiRpcCommand, signal?: AbortSignal): Promise<PiRpcResponse> {
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }

    const line = `${JSON.stringify(withId)}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        this.pending.delete(id)
        signal?.removeEventListener('abort', cancel)
        fn()
      }
      const cancel = () => finish(() => reject(new DOMException('The operation was aborted', 'AbortError')))
      this.pending.set(id, {
        resolve: value => finish(() => resolve(value)),
        reject: error => finish(() => reject(error))
      })
      if (signal?.aborted) {
        cancel()
        return
      }
      signal?.addEventListener('abort', cancel, { once: true })
      void this.writeLine(line).catch(error => finish(() => reject(error)))
    })
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.child.stdin.write(line, error => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      } catch (error: unknown) {
        reject(error)
      }
    })
  }
}
