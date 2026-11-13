import { createHash } from 'node:crypto'

export type Answers = Record<string, string>

export const SOCKET_NAME = 'vivera-telegram-ask.sock'

export function hasAnswers(value: unknown): value is Answers {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

// Key order is normalised so PermissionRequest and PostToolUse map the same questions to one key.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function askKey(sessionId: string, questions: unknown): string {
  return createHash('sha256').update(`${sessionId}\n${canonical(questions)}`).digest('hex')
}

export function permissionOutput(toolInput: Record<string, unknown>, answers: Answers) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { ...toolInput, answers } },
    },
  }
}

// True once the last assistant entry holds a tool_use block, which Claude Code writes
// after the text of the same message.
export function lastAssistantHasToolUse(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue
    let entry: { type?: string; message?: { content?: unknown } }
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (entry?.type !== 'assistant') continue
    const content = entry.message?.content
    return Array.isArray(content) && content.some(b => (b as { type?: string })?.type === 'tool_use')
  }
  return false
}

// The transcript stores one assistant message as several entries (one per content
// block) sharing message.id, so the text of the last message is gathered across them.
export function latestAssistantText(lines: string[]): string {
  const entries: Array<{ id?: string; texts: string[] }> = []
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: { type?: string; message?: { id?: string; content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue
    const texts = (entry.message.content as Array<{ type?: string; text?: unknown }>)
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
    entries.push({ id: entry.message.id, texts })
  }
  let last = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].texts.length > 0) {
      last = i
      break
    }
  }
  if (last < 0) return ''
  const id = entries[last].id
  let first = last
  while (id !== undefined && first > 0 && entries[first - 1].id === id) first--
  return entries
    .slice(first, last + 1)
    .flatMap(e => e.texts)
    .join('\n')
}

export function socketPath(env: Record<string, string | undefined>): string | null {
  const configured = (env.CLAUDE_PLUGIN_OPTION_SOCKETPATH ?? '').trim()
  if (configured) return configured
  return env.XDG_RUNTIME_DIR ? `${env.XDG_RUNTIME_DIR}/${SOCKET_NAME}` : null
}

export function stateDir(env: Record<string, string | undefined>): string | null {
  const override = (env.TELEGRAM_ASK_STATE_DIR ?? '').trim()
  if (override) return override
  return env.XDG_RUNTIME_DIR ? `${env.XDG_RUNTIME_DIR}/vivera-telegram-ask/state` : null
}
