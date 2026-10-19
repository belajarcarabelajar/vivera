import type { Register } from 'claude-code'

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

// Only ever routes down: a parent already on Sonnet or Haiku keeps its model.
const EXPENSIVE_PARENT = /opus|fable/i

export const register: Register = (on, options) => {
  const target = String(options.readOnlyModel ?? 'sonnet')

  on('agent.spawn', async ($, e, next) => {
    if (target === 'off') return next(e)
    // An explicit model from the caller, a fork, a resumed run, a workflow
    // agent or a teammate is someone else's decision.
    if (e.model || e.fork || e.resume || e.workflow || e.isTeammate) return next(e)
    const sprite = e.subagentType.trim()
    const role = ROSTER[sprite]
    if (!role || !READ_ONLY_ROLES.has(role)) return next(e)
    if (!EXPENSIVE_PARENT.test(e.parentModel)) return next(e)
    $.ui.log(`sprite-model-router: ${sprite} (${role}) → ${target}, parent ${e.parentModel}`)
    return next({ ...e, model: target })
  })
}
