import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test(
  'disposeAndWait observes a child that exits immediately on SIGTERM',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-rpc-dispose-'))
    const script = join(directory, 'fake-pi.mjs')
    const pidFile = join(directory, 'pid')
    await writeFile(
      script,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.stdin.setEncoding('utf8')
process.stdin.on('data', data => {
  for (const line of data.split('\\n')) {
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.type === 'get_state') process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true, data: {} }) + '\\n')
  }
})
`
    )
    await chmod(script, 0o755)

    let proc: PiRpcProcess | undefined
    try {
      proc = await PiRpcProcess.spawn({ cwd: directory, piCommand: script })
      const pid = Number(await readFile(pidFile, 'utf8'))
      const timeoutMs = 100
      const started = performance.now()
      await proc.disposeAndWait(timeoutMs)
      const elapsed = performance.now() - started
      assert.ok(elapsed < timeoutMs * 2, `disposeAndWait took ${elapsed}ms`)
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    } finally {
      await proc?.disposeAndWait(50).catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('disposeAndWait waits for a SIGKILLed process to be gone', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-rpc-dispose-'))
  const script = join(directory, 'fake-pi.mjs')
  const pidFile = join(directory, 'pid')
  await writeFile(
    script,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.on('SIGTERM', () => {})
process.stdin.setEncoding('utf8')
process.stdin.on('data', data => {
  for (const line of data.split('\\n')) {
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.type === 'get_state') process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true, data: {} }) + '\\n')
  }
})
`
  )
  await chmod(script, 0o755)

  let proc: PiRpcProcess | undefined
  try {
    proc = await PiRpcProcess.spawn({ cwd: directory, piCommand: script })
    const pid = Number(await readFile(pidFile, 'utf8'))
    await proc.disposeAndWait(50)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    await proc?.disposeAndWait(50).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
