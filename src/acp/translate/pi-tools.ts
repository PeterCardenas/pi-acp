function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function recordProp(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function stringProp(value: unknown, key: string): string | undefined {
  const prop = recordProp(value, key)
  return typeof prop === 'string' ? prop : undefined
}

function numberProp(value: unknown, key: string): number | undefined {
  const prop = recordProp(value, key)
  return typeof prop === 'number' ? prop : undefined
}

export function toolPath(value: unknown): string | undefined {
  const visited = new WeakSet<object>()

  function findPath(current: unknown, depth: number): string | undefined {
    if (depth > 32 || !isRecord(current)) return undefined
    if (visited.has(current)) return undefined
    visited.add(current)

    return (
      stringProp(current, 'path') ??
      stringProp(current, 'file_path') ??
      findPath(recordProp(current, 'args'), depth + 1) ??
      findPath(recordProp(current, 'input'), depth + 1) ??
      findPath(recordProp(current, 'rawInput'), depth + 1)
    )
  }

  return findPath(value, 0)
}

export function toolCallTitle(toolName: string, args: unknown): string {
  const path = toolPath(args)
  return path && ['read', 'edit', 'write'].includes(toolName) ? `${toolName} ${path}` : toolName
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = recordProp(result, 'details')

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = stringProp(details, 'diff')
  if (diff?.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = recordProp(result, 'content')
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .map(c => (recordProp(c, 'type') === 'text' ? (stringProp(c, 'text') ?? '') : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    stringProp(details, 'stdout') ??
    stringProp(result, 'stdout') ??
    stringProp(details, 'output') ??
    stringProp(result, 'output')

  const stderr = stringProp(details, 'stderr') ?? stringProp(result, 'stderr')

  const exitCode =
    numberProp(details, 'exitCode') ??
    numberProp(result, 'exitCode') ??
    numberProp(details, 'code') ??
    numberProp(result, 'code')

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
