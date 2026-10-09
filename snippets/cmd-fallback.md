# Snippet Command: Fallback When a Tool Fails

> Type this into the agent chat when a tool or service failed and the agent is
> looping or improvising. It names the fallback ladder and the one boundary the
> agent must not cross: it never swaps in a local run for a remote one.

---

A tool or service failed. Do not loop on it. Quote the error once, then take the next rung and say which one: skill tool, then `~/vivera/skills/<name>/SKILL.md`; TinyFish `search`, then `fetch_content`, then `run_web_automation` only if the plan names it; structured question tool, then a numbered checklist in the final message. If an environment boundary blocks the step (VPS unreachable, auth missing, permission denied), stop that step and ask me; do not substitute a local run that changes where the work happens. Keep going on independent work.
