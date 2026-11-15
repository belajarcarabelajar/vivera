// opencode/vivera-plugin.ts
//
// OpenCode half of the sucp rule "every passing claim names its evidence". The Claude Code half is the
// Stop hook .claude/hooks/require-exit-code.mjs; both use its check(), so the patterns live in one file.
//
// How it works (read from the OpenCode 2.2.7 binary and measured in an isolated HOME, 2026-11-15,
// docs/code-plan/spikes/2026-11-15-oc-idle-hook/): when a turn ends with no queued input, OpenCode fires
// the session hook "experimental.idle" with {sessionID, background}. The plugin reads the session
// context, and when the last assistant text claims a pass without "exit 0", it adds one synthetic
// message with the rewrite request, which resumes the session. The built-in GoalPlugin continues a
// turn the same way.
//
// Difference from Claude Code: OpenCode cannot hold the message back, so the first answer stays
// visible and the rewrite follows it. Only top-level, non-background sessions where the
// super-ultra-code-plan skill is active are checked, mirroring the skill-scoped Stop hook.
// One nudge per assistant message, and never a nudge for the answer to a nudge (the Claude hook's
// stop_hook_active). Every error lets the turn end untouched.
//
// No runtime import from "@opencode/plugin": the package is not installed where the plugin loads.
//
// Install: opencode plugin add belajarcarabelajar/vivera (a Git specifier; a local path is refused).
// Measured 2026-11-15 in an isolated HOME: a git+file specifier of this branch shows up in /api/plugin
// as id "vivera", status "active". Copying this file alone into ~/.config/opencode/plugins does not
// work, because the import above is relative to the repository.
// Revert: opencode plugin remove <the specifier you added>.

import { check } from "../.claude/hooks/require-exit-code.mjs"

export const NUDGE_SOURCE = "vivera-exit-code"
const SKILL = "super-ultra-code-plan"

type Item = { id?: string; type?: string; skill?: string; name?: string; text?: string; content?: { type?: string; text?: string }[]; metadata?: { source?: string } }
type Input = { items: Item[]; session: { id?: string; parentID?: string } | null | undefined; background?: boolean; nudged: Set<string> }

export function decide({ items, session, background, nudged }: Input): { messageID: string; reason: string } | null {
  if (background || !session || session.parentID) return null
  if (!items.some((i) => i.type === "skill" && (i.skill === SKILL || i.name === SKILL))) return null
  const at = items.findLastIndex((i) => i.type === "assistant")
  if (at === -1) return null
  const last = items[at]
  if (!last.id || nudged.has(last.id)) return null
  const before = items.slice(0, at).findLast((i) => i.type !== "assistant")
  if (before?.type === "synthetic" && before.metadata?.source === NUDGE_SOURCE) return null
  const text = (last.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
  const reason = check({ last_assistant_message: text })
  return reason ? { messageID: last.id, reason } : null
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
        const verdict = decide({ items: Array.isArray(items) ? items : [], session, background: event.background, nudged })
        if (!verdict) return
        nudged.add(verdict.messageID)
        await ctx.session.synthetic({
          sessionID: event.sessionID,
          text: verdict.reason,
          description: "vivera: name the exit code",
          metadata: { source: NUDGE_SOURCE },
        })
      } catch {
        // A failing check must never trap the session.
      }
    })
  },
}
