// scripts/lib/eval-hooks.mjs
//
// Fixture extras for scripts/eval-run.mjs: `--with-hook <set>` installs a hook set
// as project settings in the throwaway fixture, and a scenario's `generate` map
// writes large deterministic files at run time instead of committing them.
//
//   hookSet(name, UsageError)        the allowlisted set name, else throws UsageError
//   generateProblem(spec)            null, or why a scenario's `generate` is malformed
//   generateFixtures(dest, spec)     {"<relpath>": {"lines": N, "template": "text {i}"}},
//                                    {i} counted from 1; no spec writes nothing
//   installHooks(dest, set, {sourceDir})  copies the hooks to <dest>/.claude/hooks/
//                                    and writes <dest>/.claude/settings.json; sourceDir
//                                    defaults to EVAL_HOOKS_SRC (for the tests), else scripts/
//   safeRelative, RefusedError       shared with eval-run.mjs overlays

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class RefusedError extends Error {}

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function safeRelative(p) {
  const norm = path.normalize(String(p));
  if (path.isAbsolute(norm) || norm === '..' || norm.startsWith(`..${path.sep}`) || norm === '.') {
    throw new RefusedError(`refused: overlay path escapes the fixture: ${p}`);
  }
  return norm;
}

// State and scratch sit beside the project, inside the run dir the sandbox lets the
// agent write, and outside the fixture's git tree so its status stays as scored.
// Claude Code hook entries have no env of their own, so the command sets them.
const ENV = 'VIVERA_HOOK_STATE_DIR="$CLAUDE_PROJECT_DIR/../hook-state" VIVERA_HOOK_SCRATCH_DIR="$CLAUDE_PROJECT_DIR/../hook-scratch"';
const command = (file, mode) => `${ENV} "$HOME/.bun/bin/bun" "$CLAUDE_PROJECT_DIR/.claude/hooks/hooks/${file}"${mode ? ` ${mode}` : ''}`;
const entry = (matcher, file, mode) => ({ matcher, hooks: [{ type: 'command', command: command(file, mode), timeout: 10 }] });

// Same entries as scripts/context-hooks-install.mjs (plan 2026-11-05-context-hooks, T6).
const SETS = {
  context: {
    files: ['lib/hook-io.mjs', 'hooks/output-cap.mjs', 'hooks/output-replace.mjs', 'hooks/session-journal.mjs'],
    hooks: () => ({
      PreToolUse: [entry('Read', 'output-cap.mjs')],
      PostToolUse: [entry('Bash|mcp__.*', 'output-replace.mjs'), entry('Edit|Write|NotebookEdit', 'session-journal.mjs', 'record')],
      PostToolUseFailure: [entry('Bash', 'session-journal.mjs', 'record')],
      SessionStart: [entry('compact', 'session-journal.mjs', 'inject')],
    }),
  },
};

export function hookSet(name, UsageError) {
  if (!Object.hasOwn(SETS, name)) throw new UsageError(`--with-hook must be one of: ${Object.keys(SETS).join(', ')}`);
  return name;
}

export function generateProblem(spec) {
  if (spec === undefined) return null;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return 'generate must be a map of path to {lines, template}';
  for (const [rel, f] of Object.entries(spec)) {
    try {
      safeRelative(rel);
    } catch {
      return `generate path escapes the fixture: ${rel}`;
    }
    if (!Number.isInteger(f?.lines) || f.lines < 1) return `generate ${rel}: lines must be a positive integer`;
    if (typeof f.template !== 'string') return `generate ${rel}: template must be a string`;
  }
  return null;
}

export function generateFixtures(dest, spec) {
  for (const [rel, { lines, template }] of Object.entries(spec ?? {})) {
    const target = path.join(dest, safeRelative(rel));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = [];
    for (let i = 1; i <= lines; i++) out.push(`${template.replaceAll('{i}', String(i))}\n`);
    fs.writeFileSync(target, out.join(''));
  }
}

export function installHooks(dest, set, { sourceDir = process.env.EVAL_HOOKS_SRC || SCRIPTS } = {}) {
  if (!Object.hasOwn(SETS, set)) throw new Error(`unknown hook set: ${set}`);
  const base = path.join(dest, '.claude', 'hooks');
  for (const rel of SETS[set].files) {
    const target = path.join(base, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, rel), target);
  }
  fs.writeFileSync(path.join(dest, '.claude', 'settings.json'), `${JSON.stringify({ hooks: SETS[set].hooks() }, null, 2)}\n`);
}
