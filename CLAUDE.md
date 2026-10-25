<!-- Claude Code reads AGENTS.md only when no CLAUDE.md exists in this directory or a parent, and a parent
CLAUDE.md (such as one in the home directory) would hide it, so this file imports it explicitly. -->
@AGENTS.md

## Usage habits (measured 2026-10-26, rules L85 to L89 in MEMORY.md)

A scan of 3,135 session logs (10 days, about $10,978) found context length, subagent fan-out, tool output, always-loaded text, and effort as the biggest levers. Evidence and shares are in `docs/memory`.

- Context: compact or start fresh at about 150k tokens or at a plan phase boundary, with a 10-line handoff note (L85).
- Subagents: bundle chunks to 15+ turns each, inline for 3-step jobs, implementers to Sonnet only after a parity eval (L86).
- Output: cap reads and commands at the source (`offset` and `limit`, `rg -m`, tests to a scratch file plus `tail -40`) (L87).
- Always-loaded text: one-task runbooks go to on-demand files with a 2-line pointer; keep `~/AGENTS.md` under 67k characters (L88).
- Effort: default `high`; `xhigh` or `max` only for the one hard step (L89).
