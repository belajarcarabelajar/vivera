// Command hook for AskUserQuestion: `bun ask.ts permission|posttool|stop` with the
// hook input as JSON on stdin. Every failure exits 0 with no output, so the
// terminal dialog is never blocked.
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  askKey,
  basename,
  hasAnswers,
  lastAssistantHasToolUse,
  latestAssistantText,
  permissionOutput,
  socketPath,
  stateDir,
  type Answers,
} from './ask-core'

type Input = {
  session_id?: string
  transcript_path?: string
  cwd?: string
  tool_input?: Record<string, unknown>
}
type State = { id: string; socket: string; pid: number; session_id: string }

// The bridge holds /wait for 25 s; this only catches a connection that never answers.
const WAIT_TIMEOUT_MS = 60_000
const RESOLVE_TIMEOUT_MS = 5_000
const PARENT_CHECK_MS = 1_000
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024
const TRANSCRIPT_POLL_MS = 100
const TRANSCRIPT_WAIT_MS = 2_000

function call(socket: string, method: string, path: string, body?: unknown, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<Response> {
  return fetch(`http://bridge${path}`, {
    method,
    unix: socket,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit)
}

async function resolveAsk(socket: string, id: string, body: object): Promise<void> {
  try {
    const res = await call(socket, 'POST', `/resolve/${encodeURIComponent(id)}`, body)
    await res.arrayBuffer()
  } catch {
    // The terminal outcome stands whether or not the bridge heard about it.
  }
}

function readState(file: string): State | null {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return typeof s?.id === 'string' && typeof s?.socket === 'string' ? s : null
  } catch {
    return null
  }
}

function writeState(file: string, state: State): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  renameSync(tmp, file)
}

function removeState(file: string): void {
  rmSync(file, { force: true })
}

// Only the tail is read: a long session's transcript runs to many MiB.
function readTranscriptTail(path: string | undefined): string[] {
  if (!path) return []
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    return start > 0 ? lines.slice(1) : lines
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Measured live: the hook can start before the current message (its text, then its
// tool_use) is flushed, which would send the previous turn's text as context.
async function currentAssistantText(path: string | undefined): Promise<string> {
  const deadline = Date.now() + TRANSCRIPT_WAIT_MS
  let lines = readTranscriptTail(path)
  while (path && !lastAssistantHasToolUse(lines) && Date.now() < deadline) {
    await Bun.sleep(TRANSCRIPT_POLL_MS)
    lines = readTranscriptTail(path)
  }
  return latestAssistantText(lines)
}

async function permission(input: Input): Promise<void> {
  const toolInput = input.tool_input ?? {}
  if (hasAnswers(toolInput.answers)) return
  const questions = toolInput.questions
  if (!Array.isArray(questions)) return
  const socket = socketPath(process.env)
  const dir = stateDir(process.env)
  if (!socket || !dir) return
  const sessionId = input.session_id ?? ''
  const file = join(dir, `${askKey(sessionId, questions)}.json`)

  let id: string
  try {
    const res = await call(socket, 'POST', '/ask', {
      project: basename(input.cwd ?? ''),
      session: sessionId ? sessionId.slice(0, 8) : basename(input.cwd ?? ''),
      context: await currentAssistantText(input.transcript_path),
      questions,
    })
    if (!res.ok) return
    id = String(((await res.json()) as { id?: unknown }).id)
  } catch {
    return
  }
  writeState(file, { id, socket, pid: process.pid, session_id: sessionId })

  // Set by the first path that ends the hook, so a late /wait reply or a second signal does nothing.
  let ending = false
  // Once a cancel starts it is the only path that exits: its /resolve closes the
  // held /wait, and an exit from the loop then would skip deleting the state.
  let cancelling: Promise<void> | undefined
  const cancel = () => {
    if (ending) return
    ending = true
    cancelling = (async () => {
      await resolveAsk(socket, id, { by: 'cancelled' })
      removeState(file)
      process.exit(0)
    })()
  }
  process.on('SIGTERM', cancel)
  process.on('SIGINT', cancel)
  const parent = process.ppid
  setInterval(() => {
    if (ending) return
    if (process.ppid !== parent) return cancel()
    // posttool or stop deleted the state: the ask is settled even when their /resolve never reached the bridge.
    const state = readState(file)
    if (!state || state.pid !== process.pid) {
      ending = true
      process.exit(0)
    }
  }, PARENT_CHECK_MS)

  let failures = 0
  while (!ending) {
    let body: { status?: string; answers?: Answers }
    try {
      const res = await call(socket, 'GET', `/wait/${encodeURIComponent(id)}`, undefined, WAIT_TIMEOUT_MS)
      if (!res.ok) break
      body = (await res.json()) as typeof body
      failures = 0
    } catch {
      // One dropped long-poll must not end listening to Telegram for the rest of the dialog.
      if (++failures >= 3) break
      continue
    }
    if (ending) break
    if (body.status === 'answered' && hasAnswers(body.answers)) {
      ending = true
      removeState(file)
      // Awaited so process.exit in main cannot cut a piped write short.
      await Bun.write(Bun.stdout, JSON.stringify(permissionOutput(toolInput, body.answers)))
      return
    }
    if (body.status === 'closed') {
      removeState(file)
      break
    }
    if (body.status !== 'pending') break
  }
  if (cancelling) await cancelling
  // Giving up on Telegram keeps the state, so a later terminal answer still resolves the ask.
}

async function posttool(input: Input): Promise<void> {
  const toolInput = input.tool_input ?? {}
  const dir = stateDir(process.env)
  if (!dir || !Array.isArray(toolInput.questions)) return
  const file = join(dir, `${askKey(input.session_id ?? '', toolInput.questions)}.json`)
  const state = readState(file)
  if (!state) return
  removeState(file)
  await resolveAsk(state.socket, state.id, hasAnswers(toolInput.answers) ? { by: 'terminal', answers: toolInput.answers } : { by: 'cancelled' })
}

async function stop(input: Input): Promise<void> {
  const dir = stateDir(process.env)
  if (!dir || !input.session_id) return
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.json'))
  } catch {
    return
  }
  for (const name of names) {
    const file = join(dir, name)
    const state = readState(file)
    if (!state || state.session_id !== input.session_id) continue
    removeState(file)
    await resolveAsk(state.socket, state.id, { by: 'cancelled' })
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  let input: Input
  try {
    input = JSON.parse(await Bun.stdin.text())
  } catch {
    return
  }
  if (mode === 'permission') await permission(input)
  else if (mode === 'posttool') await posttool(input)
  else if (mode === 'stop') await stop(input)
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
)
