// Mirror of agents/crew.json; vivera's scripts/sprite-model-router.test.mjs fails when they drift.
export const ROSTER: Record<string, string> = {
  chef: 'implementer',
  nappy: 'implementer',
  hoggy: 'implementer',
  timid: 'researcher',
  aqua: 'researcher',
  staid: 'reviewer',
  bold: 'debugger',
}

// Roles that never edit files, so a wrong answer costs a re-check, not a broken tree.
export const READ_ONLY_ROLES = new Set(['researcher', 'reviewer'])

// Built-in Claude Code subagents that only explore/read and otherwise inherit the session model.
export const READ_ONLY_BUILTINS = new Set(['Explore'])

// Only ever routes down: a parent already on Sonnet or Haiku keeps its model.
const EXPENSIVE_PARENT = /opus|fable/i

// PreToolUse input has no model field; the transcript's last assistant entry carries it.
export function parentModelFrom(transcriptText: string): string | null {
  const lines = transcriptText.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.includes('"assistant"')) continue
    try {
      const entry = JSON.parse(line)
      const model = entry?.type === 'assistant' ? entry.message?.model : undefined
      if (typeof model === 'string' && model !== '') return model
    } catch {}
  }
  return null
}

export function decide(args: {
  toolInput: Record<string, unknown>
  parentModel: string | null
  target: string
}): string | null {
  const { toolInput, parentModel, target } = args
  if (target === 'off') return null
  // An explicit model from the caller, a fork or a teammate is someone else's decision.
  if (toolInput.model || toolInput.team_name) return null
  if (typeof toolInput.subagent_type !== 'string') return null
  const sprite = toolInput.subagent_type.trim()
  if (sprite === '' || sprite === 'fork') return null
  const role = ROSTER[sprite] ?? (READ_ONLY_BUILTINS.has(sprite) ? 'built-in' : undefined)
  if (!role || (role !== 'built-in' && !READ_ONLY_ROLES.has(role))) return null
  if (!parentModel || !EXPENSIVE_PARENT.test(parentModel)) return null
  return target
}
