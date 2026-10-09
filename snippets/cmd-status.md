# Snippet Command: Status Check

> Type this into the agent chat to ask where things stand: the session's plan, its
> pull requests, and any job still running. Read-only. It replaces "is it done?",
> "monitor", and "check the log again".

---

Status check, read-only. Answer as a table from the plan file checklist, `bun scripts/pr-registry.mjs status`, and the job's own log, not from memory: done (with evidence), running (state, elapsed, exit code if ended, last 20 log lines), blocked (on what), waiting on me. Do not restart or kill anything. Check remote hosts with `timeout`. If a state is unknown, say unknown and name the one command that settles it. Report once; do not poll in a loop.
