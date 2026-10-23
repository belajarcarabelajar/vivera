import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startBridge } from './server'
import { createTelegram, TelegramError } from './telegram'

const log = (line: string) => console.error(`telegram-ask: ${line}`)

function fail(message: string): never {
  log(message)
  process.exit(2)
}

// Telegram allows one getUpdates poller per token (a second gets 409). When another
// program already polls the bot and forwards updates to POST /update, set it to 0.
export function pollEnabled(env: Record<string, string | undefined>): boolean {
  return env.TELEGRAM_ASK_POLL !== '0'
}

export function defaultEnvPath(env: Record<string, string | undefined>): string {
  const config = env.XDG_CONFIG_HOME || join(env.HOME ?? '', '.config')
  return join(config, 'vivera-telegram-ask', '.env')
}

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let value = line.slice(eq + 1).trim()
    const quote = value[0]
    const close = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1
    // A quoted value ends at its closing quote; an unquoted one at whitespace followed by #.
    if (close > 0) value = value.slice(1, close)
    else value = value.replace(/\s+#.*$/, '')
    env[line.slice(0, eq).trim()] = value
  }
  return env
}

async function main() {
  const envPath = process.env.TELEGRAM_ASK_ENV || defaultEnvPath(process.env)
  let text: string
  try {
    text = readFileSync(envPath, 'utf8')
  } catch {
    fail(`cannot read env file ${envPath}: create it (mode 600) with TELEGRAM_BOT_TOKEN=... and TELEGRAM_CHAT_ID=... lines`)
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
  let bridge: Awaited<ReturnType<typeof startBridge>>
  try {
    bridge = await startBridge({ socketPath, telegram, chatId: env.TELEGRAM_CHAT_ID, log })
  } catch (e) {
    fail((e as Error).message)
  }
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

  if (!pollEnabled(process.env)) {
    log('polling off (updates are forwarded to POST /update)')
    return
  }
  log('polling Telegram (set TELEGRAM_ASK_POLL=0 when another program polls this bot)')

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
