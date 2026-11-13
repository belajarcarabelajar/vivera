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
// Research and review need judgment, so they get Sonnet (user choice 2026-11-14).
export const ROLE_MODEL: Record<string, string> = {
  researcher: 'sonnet',
  reviewer: 'sonnet',
}
export const READ_ONLY_ROLES = new Set(Object.keys(ROLE_MODEL))

// Built-in Claude Code subagents that only search and read, and otherwise inherit the session model.
export const BUILTIN_MODEL: Record<string, string> = {
  Explore: 'haiku',
}

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

// option is readOnlyModel from /config: off is the kill switch; any other value (auto, or sonnet and haiku
// left over from 0.2.0) keeps the per-agent map above.
export function decide(args: {
  toolInput: Record<string, unknown>
  parentModel: string | null
  option: string
}): string | null {
  const { toolInput, parentModel, option } = args
  if (option === 'off') return null
  // An explicit model from the caller, a fork or a teammate is someone else's decision.
  if (toolInput.model || toolInput.team_name) return null
  if (typeof toolInput.subagent_type !== 'string') return null
  const sprite = toolInput.subagent_type.trim()
  if (sprite === '' || sprite === 'fork') return null
  const role = ROSTER[sprite]
  const model = role ? ROLE_MODEL[role] : BUILTIN_MODEL[sprite]
  if (!model) return null
  if (!parentModel || !EXPENSIVE_PARENT.test(parentModel)) return null
  return model
}
