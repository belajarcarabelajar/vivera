#!/usr/bin/env bun
// Sends a one-line notice through the running bridge: bun notify.ts "<text>"
// A missing or failing bridge prints one line and still exits 0, so a caller such
// as an overnight run never fails because of it. Exit 2 on a usage error.
import { join } from 'node:path'

// Same resolution as the bridge daemon in main.ts, so both meet on one socket.
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TELEGRAM_ASK_SOCKET) return env.TELEGRAM_ASK_SOCKET
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'vivera-telegram-ask.sock') : ''
}

async function main(argv: string[]): Promise<number> {
  const text = argv.join(' ')
  if (!text.trim()) {
    console.error('usage: notify.ts "<text>"')
    return 2
  }
  const sock = socketPath()
  try {
    if (!sock) throw new Error('no socket path')
    const res = await fetch('http://bridge/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      unix: sock,
      signal: AbortSignal.timeout(10_000),
    } as RequestInit)
    if (!res.ok) console.error(`notify: bridge answered ${res.status} (${sock})`)
  } catch {
    console.error(`notify: bridge not running (${sock || 'set TELEGRAM_ASK_SOCKET or XDG_RUNTIME_DIR'})`)
  }
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
