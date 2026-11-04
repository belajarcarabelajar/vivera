#!/usr/bin/env bun
// scripts/hooks/session-journal.mjs
//
// `record` (PostToolUse on Edit, Write, NotebookEdit and PostToolUseFailure on
// Bash) appends one JSON row per edit or failed command to
// <scratchDir>/journal/<session_id>.jsonl. `inject` (SessionStart, source
// "compact" only) turns that session's rows plus the git branch and HEAD into
// a short state block, so a compacted session gets facts back instead of a
// summary's guesses. The plan file wins on any difference, and the block says so.
//
// Fail-open through runHook: kill switch, errors and bad input give no output.
//
// Revert: remove the session-journal entries with the context hooks installer
// (--uninstall), then delete this file and session-journal.test.mjs.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runHook } from '../lib/hook-io.mjs';

const HEADER =
  'Session state from the context hooks journal (facts only; the plan file wins on any difference):';
const BLOCK_BUDGET = 2048;
const CMD_LIMIT = 200;
const EDITED_LIMIT = 10;
const GIT_TIMEOUT_MS = 2000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const PLAN_MARK = '/docs/code-plan/plans/';

function validSessionId(id) {
  return typeof id === 'string' && id !== '' && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

function journalFile(paths, sessionId) {
  return path.join(paths.scratchDir, 'journal', `${sessionId}.jsonl`);
}

export function parseExitCode(error) {
  if (typeof error !== 'string') return null;
  const match = /^Exit code (\d+)\s*$/.exec(error.split('\n', 1)[0]);
  return match ? Number(match[1]) : null;
}

// A newline in a command or path would let journal text forge a block line
// (for example a fake "plan:" line), so whitespace runs become one space and
// control characters are dropped.
export function oneLine(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\s+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .trim();
}

function rowFor(input) {
  const t = new Date().toISOString();
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (input.hook_event_name === 'PostToolUse' && EDIT_TOOLS.has(input.tool_name)) {
    const file = input.tool_name === 'NotebookEdit' ? toolInput.notebook_path : toolInput.file_path;
    if (typeof file !== 'string' || file === '') return null;
    const base = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    return { t, kind: 'edit', path: path.resolve(base, file) };
  }
  if (input.hook_event_name === 'PostToolUseFailure' && input.tool_name === 'Bash') {
    const cmd = oneLine(toolInput.command).slice(0, CMD_LIMIT);
    return { t, kind: 'fail', cmd, exit: parseExitCode(input.error) };
  }
  return null;
}

function record(input, paths) {
  if (!validSessionId(input.session_id)) return null;
  const row = rowFor(input);
  if (!row) return null;
  const file = journalFile(paths, input.session_id);
  // Command text can be sensitive, so the journal is private to the user.
  // defer: no journal rotation, upgrade when a journal file passes 1 MB
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return null;
}

function readRows(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch {}
  }
  return rows;
}

function gitLine(cwd, args) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  try {
    const proc = Bun.spawnSync(['git', '-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, stderr: 'ignore' });
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function bytes(lines) {
  return Buffer.byteLength(lines.join('\n'));
}

export function buildBlock({ rows, branch, head }) {
  const editedAll = [];
  let lastFail = null;
  let plan = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.kind === 'edit' && typeof row.path === 'string') {
      const p = oneLine(row.path);
      if (!p) continue;
      if (!editedAll.includes(p) && editedAll.length < EDITED_LIMIT) editedAll.push(p);
      if (plan === null && p.includes(PLAN_MARK)) plan = p;
    } else if (row.kind === 'fail' && lastFail === null) {
      const exit = Number.isInteger(row.exit) ? row.exit : null;
      lastFail = { cmd: oneLine(row.cmd), exit };
    }
  }
  const hasJournal = editedAll.length > 0 || lastFail !== null;
  if (!hasJournal && !branch && !head) return null;

  const before = [HEADER];
  if (branch) before.push(`branch: ${branch}`);
  if (head) before.push(`HEAD: ${head}`);
  const after = [];
  if (lastFail) after.push(`last failure: exit ${lastFail.exit ?? 'null'}: ${lastFail.cmd ?? ''}`);
  if (plan) after.push(`plan: ${plan}`);

  // The edited line takes only as many paths as fit, so long paths do not push
  // the failure and plan lines out of the budget.
  let edited = [];
  for (const p of editedAll) {
    const candidate = [...edited, p];
    if (bytes([...before, `edited: ${candidate.join(', ')}`, ...after]) > BLOCK_BUDGET) break;
    edited = candidate;
  }
  const lines = [...before, ...(edited.length ? [`edited: ${edited.join(', ')}`] : []), ...after];

  const kept = [];
  for (const line of lines) {
    if (bytes([...kept, line]) > BLOCK_BUDGET) break;
    kept.push(line);
  }
  return kept.join('\n');
}

function inject(input, paths) {
  if (input.source !== 'compact') return null;
  if (!validSessionId(input.session_id)) return null;
  const rows = readRows(journalFile(paths, input.session_id));
  const block = buildBlock({
    rows,
    branch: gitLine(input.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: gitLine(input.cwd, ['rev-parse', '--short', 'HEAD']),
  });
  if (!block) return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: block } };
}

const MODES = { record, inject };

if (import.meta.main) {
  const mode = Object.hasOwn(MODES, process.argv[2] ?? '') ? MODES[process.argv[2]] : null;
  runHook('session-journal', (input, paths) => (mode ? mode(input, paths) : null));
}
