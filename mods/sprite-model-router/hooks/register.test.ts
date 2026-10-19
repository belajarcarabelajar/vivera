import { describe, expect, test } from 'claude-code/testing'
import type { Args } from 'claude-code'

const OPUS = 'claude-opus-5-5'

function spawn(fields: Partial<Args<'agent.spawn'>>): Args<'agent.spawn'> {
  return {
    tool_use_id: 'toolu_test',
    prompt: 'look into one thing',
    description: 'probe',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: OPUS,
    background: true,
    fork: false,
    ...fields,
  }
}

// Each test's own agent.spawn hook stands for the engine: it answers with the model it was handed.
describe('read-only sprites under an Opus parent', () => {
  // The generated names are wrapped in U+00A0 (docs/guide/getting-started-quick-start-4.md).
  for (const sprite of ['aqua', 'timid', 'staid', ' aqua ', '\u00a0aqua\u00a0']) {
    test(`${JSON.stringify(sprite)} runs on sonnet`, async ($, on) => {
      on('agent.spawn', async (_$, e) => ({ model: e.model ?? e.parentModel }))
      const out = await $.agent.spawn(spawn({ subagentType: sprite }))
      expect(out.model).toBe('sonnet')
    })
  }

  test('the haiku option routes them to haiku', { options: { readOnlyModel: 'haiku' } }, async ($, on) => {
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? e.parentModel }))
    expect((await $.agent.spawn(spawn({ subagentType: 'timid' }))).model).toBe('haiku')
  })

  test('a Fable parent counts as expensive too', async ($, on) => {
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? e.parentModel }))
    expect((await $.agent.spawn(spawn({ subagentType: 'staid', parentModel: 'claude-fable-5-1' }))).model).toBe('sonnet')
  })

  // The engine already puts the plugin name in front of every $.ui.log line.
  test('the log line does not repeat the plugin name', async ($, on) => {
    const lines: string[] = []
    on('ui.log', async (_$, e) => (lines.push(e.text), { value: undefined }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? e.parentModel }))
    await $.agent.spawn(spawn({ subagentType: 'staid' }))
    expect(lines).toEqual([`staid (reviewer) → sonnet, parent ${OPUS}`])
  })
})

describe('everything else keeps the parent or the caller decision', () => {
  const kept: Array<[string, Partial<Args<'agent.spawn'>>]> = [
    ['an implementer', { subagentType: 'chef' }],
    ['the debugger', { subagentType: 'bold' }],
    ['a built-in agent', { subagentType: 'Explore' }],
    ['an explicit model from the caller', { subagentType: 'aqua', model: 'opus' }],
    ['a fork', { subagentType: 'aqua', fork: true }],
    ['a resumed run', { subagentType: 'aqua', resume: { agentId: 'a1' } }],
    ['a teammate', { subagentType: 'aqua', isTeammate: true }],
    ['a Sonnet parent (never routes up)', { subagentType: 'aqua', parentModel: 'claude-sonnet-5-5' }],
    ['a Haiku parent (never routes up)', { subagentType: 'aqua', parentModel: 'claude-haiku-5-5' }],
  ]
  for (const [name, fields] of kept) {
    test(name, async ($, on) => {
      on('agent.spawn', async (_$, e) => ({ model: e.model ?? e.parentModel }))
      const input = spawn(fields)
      expect((await $.agent.spawn(input)).model).toBe(input.model ?? input.parentModel)
    })
  }

  test('readOnlyModel off is a kill switch', { options: { readOnlyModel: 'off' } }, async ($, on) => {
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? e.parentModel }))
    expect((await $.agent.spawn(spawn({ subagentType: 'aqua' }))).model).toBe(OPUS)
  })
})
