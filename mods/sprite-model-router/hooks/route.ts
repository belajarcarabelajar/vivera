// Auto mode: belum terbukti (live probes 2026-11-13 ran in bypass and in default mode, both routed).
// PreToolUse command hook on the Agent tool. Claude Code 2.1.323 Code Mode refuses a
// plugin whose JavaScript hooks module registers agent.spawn; command hooks are allowed.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { decide, parentModelFrom } from './route-core.ts'

// Transcripts reach tens of MB and the hook has a 10 s timeout on every Agent call.
const TAIL_BYTES = 1024 * 1024

function readTail(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const offset = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - offset)
    const read = readSync(fd, buf, 0, buf.length, offset)
    const text = buf.subarray(0, read).toString('utf8')
    return offset > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}

try {
  const input = JSON.parse(await Bun.stdin.text())
  const toolInput = input?.tool_input
  if (toolInput && typeof toolInput === 'object') {
    let transcript = ''
    try {
      if (typeof input.transcript_path === 'string') transcript = readTail(input.transcript_path)
    } catch {}
    const target = process.env.CLAUDE_PLUGIN_OPTION_READONLYMODEL || 'sonnet'
    const model = decide({ toolInput, parentModel: parentModelFrom(transcript), target })
    if (model) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { ...toolInput, model },
          },
        }),
      )
    }
  }
} catch {}
process.exit(0)
