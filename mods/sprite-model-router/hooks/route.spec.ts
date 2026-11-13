import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTE = join(import.meta.dir, 'route.ts')
const SCRATCH = join(process.env.HOME ?? '.', '.cache/tmp/vivera-mods-cmdhook-t2', `run-${process.pid}`)
const OPUS = 'claude-opus-5-5'

beforeAll(() => mkdirSync(SCRATCH, { recursive: true }))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

let n = 0
function transcript(models: string[]): string {
  const path = join(SCRATCH, `t${n++}.jsonl`)
  const lines = models.flatMap((model) => [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { model, role: 'assistant', content: [] } }),
  ])
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

type Run = { code: number | null; stdout: string }

function runHook(toolInput: Record<string, unknown>, opts: { models?: string[]; option?: string; transcriptPath?: string; raw?: string } = {}): Run {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.CLAUDE_PLUGIN_OPTION_READONLYMODEL
  if (opts.option !== undefined) env.CLAUDE_PLUGIN_OPTION_READONLYMODEL = opts.option
  const input = {
    session_id: 's1',
    transcript_path: opts.transcriptPath ?? transcript(opts.models ?? [OPUS]),
    cwd: SCRATCH,
    permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: toolInput,
    tool_use_id: 'toolu_test',
  }
  const proc = Bun.spawnSync([process.execPath, ROUTE], {
    stdin: Buffer.from(opts.raw ?? JSON.stringify(input)),
    env,
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString() }
}

function agent(fields: Record<string, unknown>): Record<string, unknown> {
  return { description: 'probe', prompt: 'look into one thing', subagent_type: 'general-purpose', ...fields }
}

function routedModel(run: Run): string | null {
  expect(run.code).toBe(0)
  if (run.stdout.trim() === '') return null
  const out = JSON.parse(run.stdout)
  expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
  return out.hookSpecificOutput.updatedInput.model
}

describe('read-only sprites under an Opus or Fable parent', () => {
  // The generated sprite names are wrapped in U+00A0 (docs/guide/getting-started-quick-start-4.md).
  for (const sprite of ['aqua', 'timid', 'staid', 'Explore', ' aqua ', ' aqua ']) {
    test(`${JSON.stringify(sprite)} runs on sonnet by default`, () => {
      expect(routedModel(runHook(agent({ subagent_type: sprite })))).toBe('sonnet')
    })
  }

  test('updatedInput keeps every other tool_input field', () => {
    const input = agent({ subagent_type: 'aqua', run_in_background: true })
    const out = JSON.parse(runHook(input).stdout)
    expect(out.hookSpecificOutput.updatedInput).toEqual({ ...input, model: 'sonnet' })
  })

  test('the haiku option routes them to haiku', () => {
    expect(routedModel(runHook(agent({ subagent_type: 'timid' }), { option: 'haiku' }))).toBe('haiku')
    expect(routedModel(runHook(agent({ subagent_type: 'Explore' }), { option: 'haiku' }))).toBe('haiku')
  })

  test('a Fable parent counts as expensive too', () => {
    expect(routedModel(runHook(agent({ subagent_type: 'staid' }), { models: ['claude-fable-5-2'] }))).toBe('sonnet')
  })

  test('the parent model is the last assistant entry in the transcript', () => {
    expect(routedModel(runHook(agent({ subagent_type: 'aqua' }), { models: ['claude-sonnet-5-5', OPUS] }))).toBe('sonnet')
    expect(routedModel(runHook(agent({ subagent_type: 'aqua' }), { models: [OPUS, 'claude-sonnet-5-5'] }))).toBeNull()
  })

  test('an assistant entry after more than 1 MiB of other lines is still found', () => {
    const path = bigTranscript({ before: OPUS, after: OPUS })
    expect(routedModel(runHook(agent({ subagent_type: 'aqua' }), { transcriptPath: path }))).toBe('sonnet')
  })
})

// The hook reads only the last 1 MiB of the transcript, because transcripts reach tens of MB.
const FILLER = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } })
function bigTranscript(models: { before?: string; after?: string }): string {
  const path = join(SCRATCH, `big${n++}.jsonl`)
  const lines: string[] = []
  if (models.before) lines.push(JSON.stringify({ type: 'assistant', message: { model: models.before, content: [] } }))
  for (let i = 0; i < 1200; i++) lines.push(FILLER)
  if (models.after) lines.push(JSON.stringify({ type: 'assistant', message: { model: models.after, content: [] } }))
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

describe('everything else is left alone', () => {
  const kept: Array<[string, Record<string, unknown>, string[]?]> = [
    ['an implementer', { subagent_type: 'chef' }],
    ['the debugger', { subagent_type: 'bold' }],
    ['a non-read-only built-in agent', { subagent_type: 'general-purpose' }],
    ['a missing subagent_type', { subagent_type: undefined }],
    ['an explicit model from the caller', { subagent_type: 'aqua', model: 'opus' }],
    ['a fork', { subagent_type: 'fork' }],
    ['a teammate', { subagent_type: 'aqua', team_name: 'crew' }],
    ['a Sonnet parent (never routes up)', { subagent_type: 'aqua' }, ['claude-sonnet-5-5']],
    ['a Haiku parent (never routes up)', { subagent_type: 'aqua' }, ['claude-haiku-5-5']],
    ['an unknown parent (no assistant entry yet)', { subagent_type: 'aqua' }, []],
  ]
  for (const [name, fields, models] of kept) {
    test(name, () => {
      expect(routedModel(runHook(agent(fields), { models }))).toBeNull()
    })
  }

  test('readOnlyModel off is a kill switch', () => {
    expect(routedModel(runHook(agent({ subagent_type: 'aqua' }), { option: 'off' }))).toBeNull()
  })

  test('a missing transcript file means an unknown parent', () => {
    expect(routedModel(runHook(agent({ subagent_type: 'aqua' }), { transcriptPath: join(SCRATCH, 'absent.jsonl') }))).toBeNull()
  })

  test('an assistant entry only before the last 1 MiB means an unknown parent', () => {
    const path = bigTranscript({ before: OPUS })
    expect(routedModel(runHook(agent({ subagent_type: 'aqua' }), { transcriptPath: path }))).toBeNull()
  })

  test('stdin that is not JSON exits 0 with no output', () => {
    expect(routedModel(runHook({}, { raw: 'not json' }))).toBeNull()
  })
})
