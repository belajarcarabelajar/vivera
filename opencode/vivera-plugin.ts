// opencode/vivera-plugin.ts
//
// OpenCode half of two Vivera Stop hooks: "every passing claim names its evidence"
// (.claude/hooks/require-exit-code.mjs, its check()) and "a turn-end message under an open plan opens
// with the progress meter" (.claude/hooks/require-progress-meter.mjs, its meterReason()). Both halves
// call the hook's own function, so the patterns live in one file each.
//
// How it works (read from the OpenCode 2.2.7 binary and measured in an isolated HOME, 2026-11-15):
// an external plugin's ctx.session has hook, get, context and synthetic. When a turn ends with no queued input, OpenCode fires
// the session hook "experimental.idle" with {sessionID, background}. The plugin reads the session
// context, and when the last assistant text claims a pass without "exit 0", it adds one synthetic
// message with the rewrite request, which resumes the session. Only when that check has no reason, the
// meter check runs on JSON.stringify(items) as the transcript text, so a plan path any tool call or
// message mentioned counts; a relative path resolves against process.cwd(), because no session
// directory was found in the plugin API this file was written against. Each nudge carries its own
// metadata.source (NUDGE_SOURCE, METER_SOURCE). The built-in GoalPlugin continues a
// turn the same way, and it also reads session.context oldest first (findLastIndex), as this file does.
//
// Difference from Claude Code: OpenCode cannot hold the message back, so the first answer stays
// visible and the rewrite follows it. Only top-level, non-background sessions where the
// vivera skill is active are checked, mirroring the skill-scoped Stop hook.
// One nudge per assistant message, and never a nudge for the answer to a nudge from either source (the
// Claude hook's stop_hook_active). Every error lets the turn end untouched.
//
// No runtime import from "@opencode/plugin": the package is not installed where the plugin loads.
//
// Install: opencode plugin add belajarcarabelajar/vivera (a Git specifier; a local path is refused).
// Measured 2026-11-15 in an isolated HOME: a git+file specifier of this branch shows up in /api/plugin
// as id "vivera", status "active". Copying this file alone into ~/.config/opencode/plugins does not
// work, because the import above is relative to the repository.
// Revert: opencode plugin remove <the specifier you added>.

import { check } from "../.claude/hooks/require-exit-code.mjs"
import { meterReason } from "../.claude/hooks/require-progress-meter.mjs"

export const NUDGE_SOURCE = "vivera-exit-code"
export const METER_SOURCE = "vivera-progress-meter"
const SOURCES = [NUDGE_SOURCE, METER_SOURCE]
const SKILL = "vivera"

type Item = { id?: string; type?: string; skill?: string; name?: string; text?: string; content?: { type?: string; text?: string }[]; metadata?: { source?: string } }
type Input = { items: Item[]; session: { id?: string; parentID?: string } | null | undefined; background?: boolean; nudged: Set<string> }

// The last assistant answer a nudge may still ask to rewrite, or null.
function lastAnswer({ items, session, background, nudged }: Input): { id: string; text: string } | null {
  if (background || !session || session.parentID) return null
  if (!items.some((i) => i.type === "skill" && (i.skill === SKILL || i.name === SKILL))) return null
  const at = items.findLastIndex((i) => i.type === "assistant")
  if (at === -1) return null
  const last = items[at]
  if (!last.id || nudged.has(last.id)) return null
  // A nudge since the owner's last message means this answer is the rewrite, however many tool
  // steps it took; the Claude hook's stop_hook_active allows exactly one rewrite request too.
  const sinceUser = items.slice(items.findLastIndex((i) => i.type === "user") + 1, at)
  if (sinceUser.some((i) => i.type === "synthetic" && SOURCES.includes(i.metadata?.source ?? ""))) return null
  const text = (last.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
  return { id: last.id, text }
}

export function decideNudge(input: Input): { messageID: string; reason: string } | null {
  const answer = lastAnswer(input)
  const reason = answer && check({ last_assistant_message: answer.text })
  return answer && reason ? { messageID: answer.id, reason } : null
}

export function decideMeterNudge(input: Input & { cwd: string }): { messageID: string; reason: string } | null {
  const answer = lastAnswer(input)
  const reason = answer && meterReason({ transcript: JSON.stringify(input.items), cwd: input.cwd, message: answer.text })
  return answer && reason ? { messageID: answer.id, reason } : null
}

const g = globalThis as { __viveraNudged?: Set<string> }
const nudged = (g.__viveraNudged ??= new Set())

export default {
  id: "vivera",
  async setup(ctx: any) {
    await ctx.session.hook("experimental.idle", async (event: { sessionID: string; background?: boolean }) => {
      try {
        const [session, items] = await Promise.all([
          ctx.session.get({ sessionID: event.sessionID }),
          ctx.session.context({ sessionID: event.sessionID }),
        ])
        const input = { items: Array.isArray(items) ? items : [], session, background: event.background, nudged }
        const exit = decideNudge(input)
        const meter = exit ? null : decideMeterNudge({ ...input, cwd: process.cwd() })
        const verdict = exit ?? meter
        if (!verdict) return
        nudged.add(verdict.messageID)
        await ctx.session.synthetic({
          sessionID: event.sessionID,
          text: verdict.reason,
          description: exit ? "vivera: name the exit code" : "vivera: open with the progress meter",
          metadata: { source: exit ? NUDGE_SOURCE : METER_SOURCE },
        })
      } catch {
        // A failing check must never trap the session.
      }
    })
  },
}
