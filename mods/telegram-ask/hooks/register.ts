import type { Register } from 'claude-code'

const SOCKET_NAME = 'vivera-telegram-ask.sock'

// Read once per process: the runtime dir does not change under a running session.
let runtimeDir: string | undefined

type Answers = Record<string, string>
type Outcome = { from: 'telegram'; answers: Answers } | { from: 'dialog'; value: unknown } | { from: 'dialogError'; error: unknown }

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

function hasAnswers(value: unknown): value is Answers {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0
}

export const register: Register = (on, options) => {
  const configured = String(options.socketPath ?? '').trim()

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (hasAnswers(e.answers)) return next(e)

    const dialog = next(e)
    const settled: Promise<Outcome> = dialog.then(
      value => ({ from: 'dialog', value }),
      error => ({ from: 'dialogError', error }),
    )

    let socketPath = configured
    let id: string
    try {
      if (!socketPath) {
        if (runtimeDir === undefined) {
          const ran = await $.process.run(['printenv', 'XDG_RUNTIME_DIR'])
          runtimeDir = ran.exitCode === 0 ? ran.stdout.trim() : ''
        }
        if (!runtimeDir) throw new Error('XDG_RUNTIME_DIR is not set')
        socketPath = `${runtimeDir}/${SOCKET_NAME}`
      }
      const root = await $.session.root()
      const sessionId = await $.session.id()
      const asked = await $.http.fetch('http://bridge/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: basename(root),
          session: sessionId ? sessionId.slice(0, 8) : basename(await $.session.cwd()),
          context: await latestClaudeText(),
          questions: e.questions,
        }),
        socketPath,
      })
      if (!asked.ok) throw new Error(`ask answered ${asked.status}`)
      id = String(JSON.parse(asked.text).id)
    } catch {
      $.ui.notice(e.tool_use_id, 'telegram-ask: bridge offline')
      return dialog
    }
    $.ui.notice(e.tool_use_id, 'telegram-ask: juga dikirim ke Telegram')

    // Set once the race settles, so a /resolve the bridge never got cannot leave a poll looping.
    let raceOver = false
    const fromTelegram = waitForTelegram(id, socketPath)
    const first = await Promise.race([
      settled,
      fromTelegram.then(answers => (answers ? ({ from: 'telegram', answers } as Outcome) : settled)),
    ])
    raceOver = true

    if (first.from === 'telegram') return { result: { questions: e.questions, answers: first.answers } }

    const result = first.from === 'dialog' ? (first.value as { result?: { answers?: unknown } }) : undefined
    const answers = result?.result?.answers
    await resolve(id, socketPath, hasAnswers(answers) ? { by: 'terminal', answers } : { by: 'cancelled' })
    return dialog

    async function latestClaudeText(): Promise<string> {
      try {
        const messages = await $.session.messages({ as: 'api' })
        const last = [...messages].reverse().find(m => m.role === 'assistant')
        if (!last) return ''
        return last.content
          .flatMap(block => (block.type === 'text' ? [block.text] : []))
          .join('\n')
      } catch {
        return ''
      }
    }

    // Polls until the bridge has answers; null when it closed, forgot the id, or failed.
    async function waitForTelegram(askId: string, sock: string): Promise<Answers | null> {
      while (!raceOver) {
        try {
          const res = await $.http.fetch(`http://bridge/wait/${askId}`, { socketPath: sock })
          if (!res.ok) return null
          const body = JSON.parse(res.text) as { status?: string; answers?: Answers }
          if (body.status === 'answered' && body.answers) return body.answers
          if (body.status !== 'pending') return null
        } catch {
          return null
        }
      }
      return null
    }

    async function resolve(askId: string, sock: string, body: object): Promise<void> {
      try {
        await $.http.fetch(`http://bridge/resolve/${askId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          socketPath: sock,
        })
      } catch {
        // The terminal answer stands whether or not the bridge heard about it.
      }
    }
  }).catch(($, e, next) => next(e))
}
