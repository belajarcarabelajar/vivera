import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startBridge } from './server'
import { createTelegram, TelegramError } from './telegram'

const log = (line: string) => console.error(`telegram-ask: ${line}`)

function fail(message: string): never {
  log(message)
  process.exit(2)
}

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    env[line.slice(0, eq).trim()] = value
  }
  return env
}

async function main() {
  const envPath = process.env.TELEGRAM_ASK_ENV ?? join(process.env.HOME ?? '', 'Proyek/gmail-otp-telegram/.env')
  let text: string
  try {
    text = readFileSync(envPath, 'utf8')
  } catch {
    fail(`cannot read env file ${envPath}`)
  }
  const env = parseEnvFile(text)
  for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) if (!env[key]) fail(`${key} missing in ${envPath}`)

  const runtime = process.env.XDG_RUNTIME_DIR
  const socketPath = process.env.TELEGRAM_ASK_SOCKET ?? (runtime ? join(runtime, 'vivera-telegram-ask.sock') : '')
  if (!socketPath) fail('set TELEGRAM_ASK_SOCKET or XDG_RUNTIME_DIR')

  // A hung connection would stall polling forever; 45 s covers the 30 s long-poll.
  const telegram = createTelegram({
    token: env.TELEGRAM_BOT_TOKEN,
    fetch: ((url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(45_000) })) as typeof fetch,
  })
  const bridge = await startBridge({ socketPath, telegram, chatId: env.TELEGRAM_CHAT_ID, log })
  log(`listening on ${socketPath}`)

  let running = true
  const stop = async (signal: string) => {
    if (!running) return
    running = false
    log(`${signal}: stopping`)
    await bridge.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))

  let offset = 0
  let backoff = 1_000
  while (running) {
    try {
      const updates = await telegram.getUpdates(offset, 30)
      backoff = 1_000
      for (const update of updates) {
        offset = update.update_id + 1
        await bridge.handleUpdate(update).catch((e) => log(`update ${update.update_id} failed: ${(e as Error).name}`))
      }
      if (updates.length > 0) log(`handled ${updates.length} updates`)
    } catch (e) {
      if (!running) break
      const status = e instanceof TelegramError ? e.status : 0
      if (status === 409) {
        log('getUpdates 409: another poller holds this bot; retrying in 30 s')
        await Bun.sleep(30_000)
      } else {
        log(`getUpdates failed (${status || (e as Error).name}); retrying in ${backoff / 1000} s`)
        await Bun.sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }
}

if (import.meta.main) await main()
