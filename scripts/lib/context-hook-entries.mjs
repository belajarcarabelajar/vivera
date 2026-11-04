// scripts/lib/context-hook-entries.mjs
//
// The one list of context hook entries. scripts/context-hooks-install.mjs
// writes them into the owner's settings and scripts/lib/eval-hooks.mjs into
// the eval fixture, so the eval measures exactly what the installer installs.

// Anchored because a matcher with regex characters is tested unanchored, so
// `Bash` alone would also fire on any tool whose name merely contains it.
export const CONTEXT_HOOK_SPECS = [
  { event: 'PreToolUse', matcher: '^Read$', script: 'output-cap.mjs', args: [] },
  { event: 'PostToolUse', matcher: '^(Bash|mcp__.*)$', script: 'output-replace.mjs', args: [] },
  { event: 'PostToolUse', matcher: '^(Edit|Write|NotebookEdit)$', script: 'session-journal.mjs', args: ['record'] },
  { event: 'PostToolUseFailure', matcher: '^Bash$', script: 'session-journal.mjs', args: ['record'] },
  { event: 'SessionStart', matcher: 'compact', script: 'session-journal.mjs', args: ['inject'] },
];

/** `{event: [entry, ...]}` in spec order; `commandFor(file, args)` builds each command string. */
export function contextHookEntries(commandFor) {
  const out = {};
  for (const spec of CONTEXT_HOOK_SPECS) {
    const hook = { type: 'command', command: commandFor(spec.script, spec.args), timeout: 10 };
    (out[spec.event] ??= []).push({ matcher: spec.matcher, hooks: [hook] });
  }
  return out;
}
