import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

type JsonRpcResponse = { id: number; result?: { sessionId?: string }; error?: { code: number; message: string } }
type Scenario = 'empty' | 'auth' | 'mixed' | 'runtime'
const REQUEST_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 1000

function entrypoint(explicitPath?: string): { command: string; args: string[] } {
  const entry = explicitPath ?? process.env.PI_ACP_INTEGRATION_ENTRY ?? 'src/index.ts'
  if (entry.endsWith('.ts')) return { command: process.execPath, args: ['--import', 'tsx', entry] }
  if (entry.endsWith('.js')) return { command: process.execPath, args: [entry] }
  return { command: entry, args: [] }
}

async function runScenario(
  mode: Scenario,
  action: (request: Request) => Promise<void> = async request => {
    const response = await request.call('session/new', { cwd: request.cwd, mcpServers: [] })
    assert.ok(response.error)
  }
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-acp-integration-'))
  const fake = join(dir, 'fake-pi.mjs')
  await writeFile(fake, fakePi(mode))
  await chmod(fake, 0o755)
  const target = entrypoint()
  const child = spawn(target.command, target.args, {
    cwd: process.cwd(),
    env: { ...process.env, PI_ACP_PI_COMMAND: fake },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const stderr: string[] = []
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const rl = createInterface({ input: child.stdout })
  const responses = new Map<
    number,
    { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  let nextId = 1
  let protocolError: Error | null = null
  const fail = (error: Error) => {
    protocolError ??= new Error(`${error.message}; stderr: ${stderr.join('').trim() || '(empty)'}`)
    for (const [id, pending] of responses) {
      clearTimeout(pending.timer)
      responses.delete(id)
      pending.reject(protocolError)
    }
  }
  rl.on('line', line => {
    try {
      const value = JSON.parse(line) as JsonRpcResponse
      if (typeof value.id === 'number') {
        const pending = responses.get(value.id)
        if (pending) {
          responses.delete(value.id)
          clearTimeout(pending.timer)
          pending.resolve(value)
        }
      }
    } catch (error) {
      fail(new Error(`Malformed ACP stdout: ${String(error)}`))
    }
  })
  child.on('error', error => fail(new Error(`ACP child error: ${error.message}`)))
  child.on('exit', (code, signal) => {
    if (responses.size) fail(new Error(`ACP child exited (code=${code}, signal=${signal})`))
  })
  const request: Request = {
    cwd: dir,
    call(method, params) {
      if (protocolError) return Promise.reject(protocolError)
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          responses.delete(id)
          reject(new Error(`Timed out waiting for ${method}; stderr: ${stderr.join('').trim() || '(empty)'}`))
        }, REQUEST_TIMEOUT_MS)
        responses.set(id, { resolve, reject, timer })
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
        try {
          child.stdin.write(payload, error => {
            if (error) fail(new Error(`ACP stdin write failed: ${error.message}`))
          })
        } catch (error) {
          fail(new Error(`ACP stdin write failed: ${String(error)}`))
        }
      })
    }
  }
  try {
    await request.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'test', version: '1' }
    })
    await action(request)
    if (protocolError) throw protocolError
  } finally {
    rl.close()
    child.stdin.end()
    await stop(child)
    await rm(dir, { recursive: true, force: true })
  }
}

type Request = { cwd: string; call(method: string, params: unknown): Promise<JsonRpcResponse> }

function fakePi(mode: Scenario): string {
  return `#!/usr/bin/env node
import readline from 'node:readline';
const mode = ${JSON.stringify(mode)};
const models = [{provider:'openai', id:'gpt-test', name:'GPT Test'}];
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  if (r.type === 'get_state') out({type:'response',id:r.id,command:r.type,success:mode==='mixed'?false:true,error:mode==='mixed'?'Authentication required':undefined,data:{thinkingLevel:'medium',model:mode==='runtime'?{provider:'openai',id:'gpt-test',name:'GPT Test'}:null}});
  else if (r.type === 'get_available_models') out({type:'response',id:r.id,command:r.type,success:mode==='auth'?false:true,error:mode==='auth'?'Authentication required':undefined,data:{models:mode==='empty'||mode==='mixed'?[]:models}});
  else if (r.type === 'get_commands') out({type:'response',id:r.id,command:r.type,success:true,data:{commands:[]}});
  else if (r.type === 'get_session_stats') out({type:'response',id:r.id,command:r.type,success:true,data:{}});
  else if (r.type === 'prompt') { out({type:'response',id:r.id,command:r.type,success:true}); if (mode==='runtime') { out({type:'message_update',assistantMessageEvent:{type:'error',reason:'error',error:{stopReason:'error',errorMessage:'No API key for provider: openai'}}}); out({type:'agent_settled'}); } }
});`
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>(resolve => {
    let killTimer: NodeJS.Timeout | undefined
    const fallbackTimer = setTimeout(() => {
      child.kill('SIGKILL')
      killTimer = setTimeout(resolve, EXIT_TIMEOUT_MS)
    }, EXIT_TIMEOUT_MS)
    child.once('exit', () => {
      clearTimeout(fallbackTimer)
      if (killTimer) clearTimeout(killTimer)
      resolve()
    })
  })
}

test('entrypoint dispatches by explicit file extension', () => {
  assert.deepEqual(entrypoint('/tmp/server.ts'), {
    command: process.execPath,
    args: ['--import', 'tsx', '/tmp/server.ts']
  })
  assert.deepEqual(entrypoint('/tmp/server.js'), { command: process.execPath, args: ['/tmp/server.js'] })
  assert.deepEqual(entrypoint('/tmp/server'), { command: '/tmp/server', args: [] })
})

test('session/new reports zero models as an internal error', async () => {
  await runScenario('empty', async request => {
    const response = await request.call('session/new', { cwd: request.cwd, mcpServers: [] })
    assert.equal(response.error?.code, -32603)
    assert.match(response.error?.message ?? '', /No models configured/)
  })
})

test('session/new reports startup authentication failures on the wire', async () => {
  for (const mode of ['mixed', 'auth'] as const)
    await runScenario(mode, async request => {
      const response = await request.call('session/new', { cwd: request.cwd, mcpServers: [] })
      assert.equal(response.error?.code, -32000)
    })
})

test('session/prompt reports runtime authentication failures on the wire', async () => {
  await runScenario('runtime', async request => {
    const created = await request.call('session/new', { cwd: request.cwd, mcpServers: [] })
    assert.ok(created.result?.sessionId)
    const response = await request.call('session/prompt', {
      sessionId: created.result!.sessionId,
      prompt: [{ type: 'text', text: 'hello' }]
    })
    assert.equal(response.error?.code, -32000)
    assert.match(response.error?.message ?? '', /Authentication required|API key/i)
  })
})
