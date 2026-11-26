// scripts/hooks/closeout-session-start.mjs
//
// Claude Code SessionStart hook. It names the landed plans that the close-out
// loop (scripts/plan-close-loop.mjs --due) last measured READY, read from the
// cache only, so a session start never measures anything itself.
//
// A failing hook would add noise to every session start, so every path exits 0
// and anything unexpected prints nothing. The text states facts and a command
// without imperative wording, because the Claude Code hooks docs warn that
// commanding language in injected context can trip prompt-injection defenses.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDue, readKept } from '../lib/closeout-state.mjs';
import { hashOf } from '../lib/plan-issue-render.mjs';
import { shellArg } from './graphify-session-start.mjs';

const VIVERA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_LISTED = 8;

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(dir, root) {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A linked worktree has a .git file instead of a directory; both mark the top.
function gitToplevel(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

const str = (v) => typeof v === 'string' && v !== '';

// Hashed the way --due hashes (utf8 text), so an edit after the measurement hides the plan.
function currentHash(file) {
  try {
    return hashOf(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readyPlans(due, kept, scopeRepo) {
  const out = [];
  for (const e of due.plans) {
    if (!e || typeof e !== 'object' || e.verdict !== 'READY') continue;
    if (![e.plan, e.repo, e.file, e.hash].every(str)) continue;
    if (scopeRepo && real(e.repo) !== scopeRepo) continue;
    if (kept[e.plan]?.hash === e.hash) continue;
    if (currentHash(path.resolve(e.repo, e.file)) !== e.hash) continue;
    out.push(e.plan);
  }
  return out;
}

export function noteFor(ids, viveraRoot) {
  if (ids.length === 0) return null;
  const listed = ids.slice(0, MAX_LISTED);
  if (ids.length > MAX_LISTED) listed.push(`+${ids.length - MAX_LISTED} more`);
  const command = `bun ${shellArg(`${viveraRoot}/scripts/plan-close-loop.mjs`)} --due`;
  return `closeout: ${ids.length} landed plan(s) measured READY: ${listed.join(', ')}. \`${command}\` re-measures; the Close plan question lists them.`;
}

async function main() {
  const input = JSON.parse(await Bun.stdin.text());
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const { hook_event_name: event, cwd } = input;
  if (event !== 'SessionStart' || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return;
  const dir = real(cwd);
  let scopeRepo = null;
  if (!isInside(dir, real(VIVERA_ROOT))) {
    const top = gitToplevel(dir);
    if (!top) return;
    scopeRepo = top;
  }
  const text = noteFor(readyPlans(readDue(), readKept(), scopeRepo), VIVERA_ROOT);
  if (!text) return;
  const out = { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch {}
  process.exitCode = 0;
}
