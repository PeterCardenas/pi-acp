import test from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPiAuth } from '../../src/pi-rpc/process.js'

function temp(t: { after: (fn: () => void) => void }): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-auth-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  return cwd
}

test('checkPiAuth asynchronously spawns the exact auth command and accepts ready', async t => {
  const cwd = temp(t)
  const argsFile = join(cwd, 'args')
  const command = join(cwd, 'pi-fake')
  writeFileSync(
    command,
    `#!/bin/sh\nprintf '%s|%s|%s' "$*" "$PWD" "$PI_AUTH_MARKER" > ${argsFile}\nprintf '%s\\n' '{"provider":"openai","status":"ready","code":0}'\n`,
    { mode: 0o755 }
  )
  const result = await checkPiAuth('openai', {
    cwd,
    piCommand: command,
    env: { ...process.env, PI_AUTH_MARKER: 'inherited' }
  })
  assert.deepEqual(result, { status: 'ready' })
  assert.equal(readFileSync(argsFile, 'utf8'), `auth check --provider openai --json|${cwd}|inherited`)
})

test('checkPiAuth parses not_ready exit 1', async t => {
  const cwd = temp(t)
  const command = join(cwd, 'pi-fake')
  writeFileSync(
    command,
    `#!/bin/sh\nprintf '%s\\n' '{"provider":"openai","status":"not_ready","reason":"credentials_not_configured","code":1}'\nexit 1\n`,
    { mode: 0o755 }
  )
  assert.deepEqual(await checkPiAuth('openai', { cwd, piCommand: command }), {
    status: 'not_ready',
    reason: 'credentials_not_configured'
  })
})

test('checkPiAuth parses invalid_state exit 2 as invalid', async t => {
  const cwd = temp(t)
  const command = join(cwd, 'pi-fake')
  writeFileSync(
    command,
    `#!/bin/sh\nprintf '%s\\n' '{"provider":"openai","status":"invalid","reason":"invalid_state"}'\nexit 2\n`,
    { mode: 0o755 }
  )
  assert.deepEqual(await checkPiAuth('openai', { cwd, piCommand: command }), {
    status: 'invalid',
    reason: 'invalid_state'
  })
})

test('checkPiAuth rejects mismatched provider and status/exit mismatch without leaking output', async t => {
  const cwd = temp(t)
  const command = join(cwd, 'pi-fake')
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '{"provider":"SECRET","status":"ready"}'\nexit 1\n`, {
    mode: 0o755
  })
  await assert.rejects(
    () => checkPiAuth('openai', { cwd, piCommand: command }),
    error => !(error as Error).message.includes('SECRET')
  )
})

test('checkPiAuth rejects status and exit mismatch', async t => {
  const cwd = temp(t)
  const command = join(cwd, 'pi-fake')
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '{"provider":"openai","status":"ready"}'\nexit 1\n`, {
    mode: 0o755
  })
  await assert.rejects(() => checkPiAuth('openai', { cwd, piCommand: command }))
})

test('checkPiAuth rejects unsafe providers before executing', async t => {
  const cwd = temp(t)
  const marker = join(cwd, 'marker')
  const command = join(cwd, 'pi-fake')
  writeFileSync(command, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
  await assert.rejects(() => checkPiAuth('openai;touch', { cwd, piCommand: command }))
  assert.throws(() => accessSync(marker))
})

test(
  'checkPiAuth kills timed out POSIX child and settles promptly',
  { skip: platform() === 'win32', timeout: 2000 },
  async t => {
    const cwd = temp(t)
    const pidFile = join(cwd, 'pid')
    const command = join(cwd, 'pi-fake')
    writeFileSync(command, `#!/bin/sh\necho $$ > ${pidFile}\nwhile :; do :; done\n`, { mode: 0o755 })
    await assert.rejects(() => checkPiAuth('openai', { cwd, piCommand: command, timeoutMs: 50 }), /timed out/)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.throws(() => process.kill(pid, 0))
  }
)

test('checkPiAuth rejects output larger than 64 KiB', async t => {
  const cwd = temp(t)
  const command = join(cwd, 'pi-fake')
  writeFileSync(command, `#!/bin/sh\nprintf '%*s' 65537 x`, { mode: 0o755 })
  await assert.rejects(() => checkPiAuth('openai', { cwd, piCommand: command, timeoutMs: 1000 }), /exceeded limit/)
})

test('checkPiAuth rejects malformed output without leaking it', async t => {
  const cwd = temp(t)
  const command = join(cwd, 'pi-fake')
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' 'SECRET-OUTPUT'`, { mode: 0o755 })
  await assert.rejects(
    () => checkPiAuth('openai', { cwd, piCommand: command }),
    error => !(error as Error).message.includes('SECRET-OUTPUT')
  )
})
