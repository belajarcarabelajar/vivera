import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { FakeBridge } from './ask-spec-helpers'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ASK = join(import.meta.dir, 'ask.ts')
const HOOKS_JSON = join(import.meta.dir, 'hooks.json')
const SCRATCH = join(process.env.HOME ?? '', '.cache/tmp/vivera-mods-cmdhook-t1')
const SESSION = '0123456789abcdef-aaaa'
const OTHER_SESSION = 'fedcba9876543210-bbbb'

// Each test spawns one to three Bun processes; the 5 s default is too tight on a loaded box.
setDefaultTimeout(30_000)

const QUESTIONS = [
  {
    question: 'Which database?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'Postgres', description: 'relational' },
      { label: 'SQLite', description: 'one file' },
    ],
  },
]
const TERMINAL = { 'Which database?': 'SQLite' }
const PHONE = { 'Which database?': 'Postgres' }


let dir: string
let sock: string
let stateDir: string
let transcript: string
let bridge: FakeBridge
const procs: Array<ReturnType<typeof Bun.spawn>> = []

beforeEach(async () => {
  mkdirSync(SCRATCH, { recursive: true })
  dir = mkdtempSync(join(SCRATCH, 'ask-'))
  sock = join(dir, 'bridge.sock')
  stateDir = join(dir, 'state')
  transcript = join(dir, 'transcript.jsonl')
  writeFileSync(
    transcript,
    [
      { type: 'assistant', message: { id: 'msg_0', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Older reply.' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'pick a db' }] } },
      { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Two options fit.' }] } },
      { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Pick one.' }] } },
      { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: {} }] } },
    ]
      .map(e => JSON.stringify(e))
      .join('\n') + '\n',
  )
  bridge = new FakeBridge(sock)
})

afterEach(async () => {
  for (const p of procs.splice(0)) p.kill('SIGKILL')
  await bridge.stop()
  rmSync(dir, { recursive: true, force: true })
})

function permissionInput(over: { session_id?: string; tool_input?: object } = {}) {
  return {
    session_id: SESSION,
    transcript_path: transcript,
    cwd: '/home/me/Proyek/shop',
    permission_mode: 'bypassPermissions',
    prompt_id: 'p1',
    effort: 'medium',
    hook_event_name: 'PermissionRequest',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: QUESTIONS },
    ...over,
  }
}

function postInput(answers: Record<string, string>, session_id = SESSION, questions: unknown = QUESTIONS) {
  return {
    session_id,
    transcript_path: transcript,
    cwd: '/home/me/Proyek/shop',
    hook_event_name: 'PostToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions, answers },
    tool_response: {},
  }
}

function hookEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CLAUDE_PLUGIN_OPTION_SOCKETPATH: sock,
    TELEGRAM_ASK_STATE_DIR: stateDir,
    ...extra,
  }
}

// Runs `bun ask.ts <mode>` the way Claude Code runs a command hook: JSON on stdin.
function hook(mode: string, input: object, env = hookEnv()) {
  const proc = Bun.spawn([process.execPath, ASK, mode], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env })
  procs.push(proc)
  proc.stdin.write(JSON.stringify(input))
  proc.stdin.end()
  const done = (async () => {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, stdout, stderr }
  })()
  return { proc, done }
}

function stateFiles(): string[] {
  return existsSync(stateDir) ? readdirSync(stateDir).filter(n => n.endsWith('.json')) : []
}

function allowOutput(toolInput: object, answers: Record<string, string>) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { ...toolInput, answers } },
    },
  }
}

describe('permission: the race from the Telegram side', () => {
  test('a call that already carries answers makes no bridge call and prints nothing', async () => {
    await bridge.start()
    const run = hook('permission', permissionInput({ tool_input: { questions: QUESTIONS, answers: TERMINAL } }))
    const out = await run.done
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(bridge.sent).toEqual([])
  })

  test('the ask carries the project, a short session label, the latest Claude text and the questions', async () => {
    await bridge.start()
    const run = hook('permission', permissionInput())
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    expect(bridge.sent[0]).toEqual({
      method: 'POST',
      path: '/ask',
      body: { project: 'shop', session: '01234567', context: 'Two options fit.\nPick one.', questions: QUESTIONS },
    })
    bridge.answer('ask1', PHONE)
    expect((await run.done).code).toBe(0)
  })

  test('a Telegram answer prints the allow decision with those answers and leaves no state', async () => {
    await bridge.start()
    const run = hook('permission', permissionInput())
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    expect(stateFiles().length).toBe(1)
    bridge.answer('ask1', PHONE)
    const out = await run.done
    expect(out.code).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual(allowOutput({ questions: QUESTIONS }, PHONE))
    expect(stateFiles()).toEqual([])
  })

  test('multi-select and free-text answers pass through unchanged', async () => {
    await bridge.start()
    const questions = [
      { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint', description: '' }, { label: 'Types', description: '' }] },
      { question: 'Branch name?', header: 'Branch', multiSelect: false, options: [{ label: 'main', description: '' }, { label: 'dev', description: '' }] },
    ]
    const answers = { 'Which checks?': 'Lint, Types', 'Branch name?': 'feat/ünïcode "quoted"' }
    const run = hook('permission', permissionInput({ tool_input: { questions } }))
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    bridge.answer('ask1', answers)
    const out = await run.done
    expect(JSON.parse(out.stdout)).toEqual(allowOutput({ questions }, answers))
  })

  test('an empty socketPath option falls back to $XDG_RUNTIME_DIR/vivera-telegram-ask.sock', async () => {
    bridge = new FakeBridge(join(dir, 'vivera-telegram-ask.sock'))
    await bridge.start()
    const run = hook('permission', permissionInput(), hookEnv({ CLAUDE_PLUGIN_OPTION_SOCKETPATH: '', XDG_RUNTIME_DIR: dir }))
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    bridge.answer('ask1', PHONE)
    expect(JSON.parse((await run.done).stdout)).toEqual(allowOutput({ questions: QUESTIONS }, PHONE))
  })
})

// Measured live: the hook can start before Claude Code has flushed the current
// message (text, then tool_use, same message.id) to the transcript.
describe('permission: a transcript that is still being written', () => {
  const OLD = { type: 'assistant', message: { id: 'msg_0', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Older reply.' }] } }

  test('waits for the tool_use entry and sends the text of the current message', async () => {
    writeFileSync(transcript, JSON.stringify(OLD) + '\n')
    await bridge.start()
    const run = hook('permission', permissionInput())
    await Bun.sleep(400)
    appendFileSync(
      transcript,
      [
        { type: 'assistant', message: { id: 'msg_2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'now asking' }] } },
        { type: 'assistant', message: { id: 'msg_2', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_2', name: 'AskUserQuestion', input: {} }] } },
      ]
        .map(e => JSON.stringify(e))
        .join('\n') + '\n',
    )
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    expect((bridge.sent[0].body as { context: string }).context).toBe('now asking')
    bridge.answer('ask1', PHONE)
    expect((await run.done).code).toBe(0)
  })

  test('with no tool_use ever written it still asks within about 2.5 s, with the text there is', async () => {
    writeFileSync(transcript, JSON.stringify(OLD) + '\n')
    await bridge.start()
    const started = Date.now()
    const run = hook('permission', permissionInput())
    await bridge.until(() => bridge.paths().includes('POST /ask'), 'the /ask')
    expect(Date.now() - started).toBeLessThan(2_500)
    expect((bridge.sent[0].body as { context: string }).context).toBe('Older reply.')
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    bridge.answer('ask1', PHONE)
    expect((await run.done).code).toBe(0)
  })
})

describe('permission: fail open, the dialog stays', () => {
  test('a bridge that closes the ask ends the hook with no output and no state', async () => {
    await bridge.start()
    bridge.waitReplies.ask1 = [{ status: 200, body: { status: 'closed' } }]
    const out = await hook('permission', permissionInput()).done
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(stateFiles()).toEqual([])
  })

  test('an offline bridge ends the hook with no output and no state', async () => {
    const out = await hook('permission', permissionInput()).done
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(stateFiles()).toEqual([])
  })

  test('a bridge that refuses the question ends the hook after the one /ask', async () => {
    bridge.askStatus = 400
    await bridge.start()
    const out = await hook('permission', permissionInput()).done
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(bridge.paths()).toEqual(['POST /ask'])
    expect(stateFiles()).toEqual([])
  })

  test('a /wait that drops once does not stop listening to Telegram', async () => {
    await bridge.start()
    bridge.waitReplies.ask1 = ['drop', { status: 200, body: { status: 'answered', answers: PHONE } }]
    const out = await hook('permission', permissionInput()).done
    expect(JSON.parse(out.stdout)).toEqual(allowOutput({ questions: QUESTIONS }, PHONE))
    expect(bridge.waits()).toEqual(['GET /wait/ask1', 'GET /wait/ask1'])
  })

  test('three dropped /wait requests in a row end the hook with no output', async () => {
    await bridge.start()
    bridge.waitReplies.ask1 = ['drop', 'drop', 'drop', { status: 200, body: { status: 'answered', answers: PHONE } }]
    const out = await hook('permission', permissionInput()).done
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(bridge.waits().length).toBe(3)
  })

  test('a 404 on /wait (bridge restarted) ends the hook with no output', async () => {
    await bridge.start()
    bridge.waitReplies.ask1 = [{ status: 200, body: { status: 'pending' } }, { status: 404 }]
    const out = await hook('permission', permissionInput()).done
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(bridge.waits()).toEqual(['GET /wait/ask1', 'GET /wait/ask1'])
  })
})

describe('permission: the hook is stopped', () => {
  test('SIGTERM resolves the ask as cancelled, deletes the state and exits 0', async () => {
    bridge.resolveDelayMs = 300
    await bridge.start()
    const run = hook('permission', permissionInput())
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    expect(stateFiles().length).toBe(1)
    run.proc.kill('SIGTERM')
    const out = await run.done
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(bridge.sent.find(s => s.path === '/resolve/ask1')?.body).toEqual({ by: 'cancelled' })
    expect(stateFiles()).toEqual([])
  })

  test('a parent that goes away resolves the ask as cancelled and deletes the state', async () => {
    bridge.resolveDelayMs = 300
    await bridge.start()
    const inFile = join(dir, 'in.json')
    const outFile = join(dir, 'out.txt')
    writeFileSync(inFile, JSON.stringify(permissionInput()))
    const parent = Bun.spawn(['sh', '-c', `"$0" "$1" permission < "$2" > "$3" 2>&1 & sleep 60`, process.execPath, ASK, inFile, outFile], {
      env: hookEnv(),
    })
    procs.push(parent)
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    parent.kill('SIGKILL')
    await bridge.until(() => bridge.paths().includes('POST /resolve/ask1'), 'the cancel')
    expect(bridge.sent.find(s => s.path === '/resolve/ask1')?.body).toEqual({ by: 'cancelled' })
    await bridge.until(() => stateFiles().length === 0, 'the state to go')
    expect(readFileSync(outFile, 'utf8')).toBe('')
  })
})

describe('posttool: the terminal answered first', () => {
  test('resolves the pending ask as terminal with the answers, and the permission hook exits quietly', async () => {
    await bridge.start()
    const run = hook('permission', permissionInput())
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    const post = await hook('posttool', postInput(TERMINAL)).done
    expect(post).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(bridge.sent.find(s => s.path === '/resolve/ask1')?.body).toEqual({ by: 'terminal', answers: TERMINAL })
    expect(await run.done).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(stateFiles()).toEqual([])
  })

  test('a failed resolve still ends the permission hook once its state is gone', async () => {
    await bridge.start()
    const run = hook('permission', permissionInput())
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    bridge.resolveStatus = 500
    const post = await hook('posttool', postInput(TERMINAL)).done
    expect(post).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(stateFiles()).toEqual([])
    expect(await run.done).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  test('with no pending ask for these questions it sends nothing', async () => {
    await bridge.start()
    const post = await hook('posttool', postInput(TERMINAL)).done
    expect(post).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(bridge.sent).toEqual([])
  })
})

describe('stop: end of turn', () => {
  test('cancels only the asks of this session', async () => {
    await bridge.start()
    const mine = hook('permission', permissionInput())
    await bridge.until(() => bridge.waits().length === 1, 'the first /wait')
    const other = hook('permission', permissionInput({ session_id: OTHER_SESSION }))
    await bridge.until(() => bridge.waits().length === 2, 'the second /wait')
    expect(stateFiles().length).toBe(2)

    const stop = await hook('stop', { session_id: SESSION, transcript_path: transcript, cwd: '/home/me/Proyek/shop', hook_event_name: 'Stop' }).done
    expect(stop).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(bridge.sent.filter(s => s.path.startsWith('/resolve/')).map(s => [s.path, s.body])).toEqual([['/resolve/ask1', { by: 'cancelled' }]])
    expect(await mine.done).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(stateFiles().length).toBe(1)

    bridge.answer('ask2', PHONE)
    expect(JSON.parse((await other.done).stdout)).toEqual(allowOutput({ questions: QUESTIONS }, PHONE))
  })
})

describe('hooks.json', () => {
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'))

  test('wires PermissionRequest, PostToolUse and Stop to ask.ts with no JavaScript module', () => {
    expect(config.modules).toBeUndefined()
    expect(Object.keys(config.hooks).sort()).toEqual(['PermissionRequest', 'PostToolUse', 'Stop'])
    const [perm] = config.hooks.PermissionRequest
    expect(perm.matcher).toBe('AskUserQuestion')
    expect(perm.hooks[0]).toMatchObject({ type: 'command', timeout: 86400 })
    expect(perm.hooks[0].command).toEndWith('ask.ts" permission')
    const [post] = config.hooks.PostToolUse
    expect(post.matcher).toBe('AskUserQuestion')
    expect(post.hooks[0]).toMatchObject({ type: 'command', timeout: 30 })
    expect(post.hooks[0].command).toEndWith('ask.ts" posttool')
    expect(config.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', timeout: 30 })
    expect(config.hooks.Stop[0].hooks[0].command).toEndWith('ask.ts" stop')
  })

  test('the command finds bun and runs from CLAUDE_PLUGIN_ROOT under sh', async () => {
    const command: string = config.hooks.Stop[0].hooks[0].command
    const proc = Bun.spawn(['sh', '-c', command], {
      stdin: new Blob([JSON.stringify({ session_id: SESSION, hook_event_name: 'Stop' })]),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...hookEnv(), CLAUDE_PLUGIN_ROOT: join(import.meta.dir, '..') },
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' })
  })
})
