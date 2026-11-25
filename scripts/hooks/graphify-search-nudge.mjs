#!/usr/bin/env bun
// scripts/hooks/graphify-search-nudge.mjs
//
// Claude Code PreToolUse hook. The first time an agent searches a repository
// that has a graphify graph (Grep, Glob, Read of a source file, or a Bash
// rg/grep/fd/find/ag), it adds one line of context naming the graph and the
// query command, unless that agent already queried the graph.
//
// The first search gets the reminder. If the agent keeps searching without
// ever querying the graph, the reminder repeats after every REPEAT_EVERY
// searches, at most MAX_REMINDERS times per session and agent (2026-11-11:
// 14 days of transcripts showed 36 graph queries against 19,301 searches, so
// a single early note was not enough). State lives in a small file. The reminder only adds context: it never prints a
// permission decision.
//
// Gate (user 2026-11-18, after the reminders left the ratio at about 1:1,560):
// before the first graph query of a session and agent, a recursive content
// search (Grep on a directory, Bash rg, grep -r) whose target directory lies in
// a registered repository is blocked with exit 2 and a stderr message naming
// the exact query command. `cd <dir> && rg ...` is followed. Read, Glob,
// find/fd, single-file searches, pipe filters and searches outside a graph
// repository are never blocked. At most MAX_BLOCKS blocks per session and agent;
// after that, or after any graph query, searches run and the reminders apply.
// Fail-open: any parse, status or state failure lets the call through, and a
// block is only printed after its count was saved.
// Parallel calls (Code Mode batches, 2026-11-26): several hook processes can
// read the state file at once and the last write wins, which once dropped a
// recorded query and let three searches each print "1 of 2". The two facts that
// must survive live outside the state file and are only ever created: a
// `<state>.queried` marker, and one `<state>.block-<n>` slot per block, claimed
// with O_EXCL so the cap holds across processes. A query and a search in the
// same parallel batch stay order-dependent: the search may run first.
// Kill switch: GRAPHIFY_GATE=0, or the file ~/.local/state/graphify-gate/off
// (path overridable with GRAPHIFY_GATE_OFF_FILE). Revert: git revert the commit
// that added the gate, or keep the kill switch file.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../lib/atomic-write.mjs';
import { graphifyStatus } from '../lib/graphify-status.mjs';
import { shellArg } from './graphify-session-start.mjs';

const SEARCH_COMMANDS = new Set(['rg', 'grep', 'fd', 'find', 'ag']);
const QUERY_SUBCOMMANDS = new Set(['query', 'path', 'explain']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const REPEAT_EVERY = 25;
export const MAX_REMINDERS = 3;
export const MAX_BLOCKS = 2;

// rg flags that take a separate value word, so the value is not read as the
// pattern or a path. Long forms written as --flag=value are one word anyway.
const RG_VALUE_FLAGS = new Set([
  '-e', '--regexp', '-f', '--file', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not',
  '--type-add', '--type-clear', '-m', '--max-count', '-A', '--after-context', '-B', '--before-context',
  '-C', '--context', '-M', '--max-columns', '-j', '--threads', '-E', '--encoding', '--sort', '--sortr',
  '--color', '--colors', '-r', '--replace', '-d', '--max-depth', '--max-filesize', '--pre', '--pre-glob',
  '--path-separator', '--engine', '--field-match-separator', '--field-context-separator', '--context-separator',
]);
const GREP_VALUE_FLAGS = new Set([
  '-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '--after-context', '-B', '--before-context',
  '-C', '--context', '--include', '--exclude', '--exclude-dir', '--label', '-d', '--directories', '-D', '--devices',
]);

// Quote-aware split of a shell command into pipelines of word lists:
// [[words of first command, words after |, ...], ...] for each && || ; or
// newline separated part. Quotes are removed from words; $(...), heredocs and
// escapes inside double quotes are not modelled (worst case: one missed block).
export function shellPipelines(command) {
  const pipelines = [];
  let pipeline = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    pipeline.push(words);
    words = [];
  };
  const endPipeline = () => {
    endCommand();
    pipelines.push(pipeline.filter((w) => w.length));
    pipeline = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
      continue;
    }
    if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      endPipeline();
      i++;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      endPipeline();
      continue;
    }
    if (ch === '|') {
      endCommand();
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endPipeline();
  return pipelines.filter((p) => p.length);
}

function stripPrefix(words) {
  let i = 0;
  while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i++;
  if (words[i] === 'timeout') {
    i++;
    while (i < words.length && words[i].startsWith('-')) i++;
    i++;
  }
  return words.slice(i);
}

function resolveFrom(base, p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(base, p);
}

// dup-defs: allow a stat-based guard private to this hook; lan-claude's isDir is a TypeScript mod helper
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Paths a recursive rg/grep would search, or null when the words are not one.
function searchPaths(words) {
  const prog = program(words[0]);
  let valueFlags;
  if (prog === 'rg') valueFlags = RG_VALUE_FLAGS;
  else if (prog === 'grep' || prog === 'egrep' || prog === 'fgrep') valueFlags = GREP_VALUE_FLAGS;
  else return null;
  const positional = [];
  let patternGiven = false;
  let recursive = prog === 'rg';
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--') {
      positional.push(...words.slice(i + 1));
      break;
    }
    if (w.startsWith('--')) {
      const name = w.split('=')[0];
      if (name === '--regexp' || name === '--file') patternGiven = true;
      if (name === '--recursive' || name === '--dereference-recursive') recursive = true;
      if (!w.includes('=') && valueFlags.has(w)) i++;
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      // A short cluster (-rn, -ie) takes the next word as a value only when its
      // last letter is a value flag; attached values (-A3, -m5) end in a digit.
      if (prog !== 'rg' && /^-[A-Za-z]*[rR]/.test(w)) recursive = true;
      const last = `-${w[w.length - 1]}`;
      if (last === '-e' || last === '-f') patternGiven = true;
      if (valueFlags.has(last)) i++;
      continue;
    }
    positional.push(w);
  }
  if (!recursive) return null;
  return patternGiven ? positional : positional.slice(1);
}

// The directory a recursive content search would walk, or null. Follows a
// leading `cd <dir>` chain; a single-file target or a pipe filter is null.
export function gateTarget(toolName, toolInput, cwd) {
  if (toolName === 'Grep') {
    const p = typeof toolInput.path === 'string' && toolInput.path ? resolveFrom(cwd, toolInput.path) : cwd;
    return isDir(p) ? p : null;
  }
  if (toolName !== 'Bash' || typeof toolInput.command !== 'string') return null;
  let dir = cwd;
  for (const pipeline of shellPipelines(toolInput.command)) {
    const words = stripPrefix(pipeline[0]);
    if (!words.length) continue;
    if (program(words[0]) === 'cd') {
      if (pipeline.length === 1 && words[1]) dir = resolveFrom(dir, words[1]);
      continue;
    }
    const paths = searchPaths(words);
    if (paths === null) continue;
    const targets = paths.length ? paths.map((p) => resolveFrom(dir, p)) : [dir];
    const target = targets.find(isDir);
    if (target) return target;
  }
  return null;
}

export function blockText(graphPath, nth) {
  const root = path.dirname(path.dirname(graphPath));
  return (
    `Blocked by the graphify gate (${nth} of ${MAX_BLOCKS}): this search walks a repository that has a graphify knowledge graph, and this session has not queried it yet. ` +
    `Ask the graph first, then search again: \`graphify query "<question>" --graph ${shellArg(graphPath)}\` ` +
    `(or \`graphify path "A" "B"\` / \`graphify explain "X"\` with the same --graph flag, or MCP query_graph with project_path: ${root}). ` +
    'After one graph query, searches run normally. Read, Glob, find and single-file searches are never blocked.'
  );
}

function gateEnabled(env) {
  if (env.GRAPHIFY_GATE === '0') return false;
  const off = env.GRAPHIFY_GATE_OFF_FILE || path.join(os.homedir(), '.local', 'state', 'graphify-gate', 'off');
  try {
    return !existsSync(off);
  } catch {
    return false;
  }
}

// Shell parsing is deliberately shallow: split on && || ; | and newlines, then
// skip leading VAR=value words and one leading `timeout N`. Quotes are not
// tracked, so the worst case is one missed or one extra reminder.
function segments(command) {
  return command.split(/&&|\|\||[;|\n]/);
}

function commandWords(segment) {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i++;
  if (words[i] === 'timeout') i += 2;
  return words.slice(i);
}

function program(word) {
  return word ? path.basename(word) : '';
}

function isQuery(toolName, toolInput) {
  if (toolName.startsWith('mcp__graphify__')) return true;
  if (toolName !== 'Bash' || typeof toolInput.command !== 'string') return false;
  return segments(toolInput.command).some((seg) => {
    const words = commandWords(seg);
    return program(words[0]) === 'graphify' && QUERY_SUBCOMMANDS.has(words[1]);
  });
}

function isSearch(toolName, toolInput) {
  if (toolName === 'Grep' || toolName === 'Glob') return true;
  if (toolName === 'Read') {
    const p = toolInput.file_path;
    return typeof p === 'string' && !/\.md$/i.test(p) && !/(^|[\\/])graphify-out[\\/]/.test(p);
  }
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return SEARCH_COMMANDS.has(program(commandWords(segments(toolInput.command)[0])[0]));
  }
  return false;
}

export function toolKind(input) {
  const toolName = typeof input?.tool_name === 'string' ? input.tool_name : '';
  const toolInput = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (isQuery(toolName, toolInput)) return 'query';
  if (isSearch(toolName, toolInput)) return 'search';
  return 'other';
}

export function reminderText(graphPath, nth = 1, searches = 0) {
  const root = path.dirname(path.dirname(graphPath));
  const lead =
    nth > 1 ? `Reminder ${nth} of ${MAX_REMINDERS}: ${searches} searches since the last note and no graph query yet. ` : '';
  return (
    lead +
    `This repository has a graphify knowledge graph at ${graphPath}. ` +
    'A query returns the nodes, files and relations that match a question in one call: ' +
    `\`graphify query "<question>" --graph ${shellArg(graphPath)}\`. ` +
    '`graphify path "A" "B"` and `graphify explain "X"` take the same --graph flag. ' +
    `Over MCP, pass \`project_path: ${root}\` to query_graph; without it the server reads the global graph, which may not include this repository.`
  );
}

function remindersOf(state) {
  if (Number.isInteger(state.reminders)) return state.reminders;
  return state.reminded ? 1 : 0;
}

function dueForReminder(state) {
  if (state.queried) return false;
  const n = remindersOf(state);
  if (n === 0) return true;
  return n < MAX_REMINDERS && (state.searches ?? 0) + 1 >= REPEAT_EVERY;
}

function needsStatus(input, state) {
  return toolKind(input) === 'search' && dueForReminder(state);
}

// Pure: returns the stdout line (or null) and the state to persist.
export function decide(input, state, status) {
  const kind = toolKind(input);
  if (kind === 'query') return { output: null, nextState: { ...state, queried: true } };
  if (kind !== 'search' || state.queried) return { output: null, nextState: state };
  if (dueForReminder(state) && status?.kind === 'registered') {
    const nth = remindersOf(state) + 1;
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: reminderText(status.graphPath, nth, (state.searches ?? 0) + 1),
      },
    });
    return { output, nextState: { ...state, reminded: true, reminders: nth, searches: 0 } };
  }
  if (remindersOf(state) > 0 && remindersOf(state) < MAX_REMINDERS) {
    return { output: null, nextState: { ...state, searches: (state.searches ?? 0) + 1 } };
  }
  return { output: null, nextState: state };
}

function safeId(id) {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Path of a marker file that sits beside the state file.
function sideFile(file, suffix) {
  return file.replace(/\.json$/, `.${suffix}`);
}

// Claims the lowest free block slot above `from` with O_EXCL and returns its
// number, or null when every slot is taken or a slot cannot be created.
function claimBlock(file, from) {
  for (let n = from + 1; n <= MAX_BLOCKS; n++) {
    try {
      closeSync(openSync(sideFile(file, `block-${n}`), 'wx'));
      return n;
    } catch (e) {
      if (e?.code === 'EEXIST') continue;
      return null;
    }
  }
  return null;
}

// Returns { block } when the call must be stopped, else null. The block slot is
// created before a block is returned, so a slot that cannot be created never blocks.
function gate(input, state, cwd, file, stateDir, env) {
  if (state.queried || !gateEnabled(env)) return null;
  const blocks = Number.isInteger(state.blocks) ? state.blocks : 0;
  if (blocks >= MAX_BLOCKS) return null;
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (toolKind(input) === 'query') return null;
  let dir;
  try {
    dir = gateTarget(toolName, toolInput, cwd);
  } catch {
    return null;
  }
  if (!dir) return null;
  let s;
  if (state.gateStatus?.dir === dir) {
    s = state.gateStatus;
  } else {
    const st = graphifyStatus(dir);
    s = { dir, kind: st.kind, graphPath: st.graphPath };
  }
  const next = { ...state, gateStatus: s };
  let nth = null;
  try {
    mkdirSync(stateDir, { recursive: true });
    if (s.kind === 'registered') {
      nth = claimBlock(file, blocks);
      next.blocks = nth ?? MAX_BLOCKS;
    }
    writeFileAtomic(file, `${JSON.stringify(next)}\n`);
  } catch {
    // The slot, not the state file, records the block.
  }
  if (nth === null) return null;
  return { block: blockText(s.graphPath, nth) };
}

export function handle(raw, env = process.env) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { session_id: sessionId, agent_id: agentId, cwd } = input;
  if (typeof sessionId !== 'string' || !sessionId || typeof cwd !== 'string' || !cwd) return null;

  const stateDir = env.GRAPHIFY_HOOK_STATE_DIR || path.join(os.tmpdir(), 'graphify-hooks');
  const agent = typeof agentId === 'string' && agentId ? agentId : 'main';
  const file = path.join(stateDir, `${safeId(sessionId)}.${safeId(agent)}.json`);
  const state = readState(file);
  const queriedMarker = sideFile(file, 'queried');
  try {
    if (!state.queried && existsSync(queriedMarker)) state.queried = true;
  } catch {
    // An unreadable marker counts as no query yet.
  }

  const blocked = gate(input, state, cwd, file, stateDir, env);
  if (blocked) return blocked;

  let status = null;
  let nextStatus = state.status;
  if (needsStatus(input, state)) {
    // Cached per cwd so only the first search of a session and agent pays
    // for the git calls; every later PreToolUse stays a file read.
    if (state.status?.cwd === cwd) {
      status = state.status;
    } else {
      const s = graphifyStatus(cwd);
      status = { cwd, kind: s.kind, graphPath: s.graphPath };
      nextStatus = status;
    }
  }

  const { output, nextState } = decide(input, state, status);
  if (nextState.queried && !state.queried) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(queriedMarker, '');
    } catch {
      // The state file below still records the query.
    }
  }
  const toWrite = { ...nextState, status: nextStatus };
  if (JSON.stringify(toWrite) !== JSON.stringify(state)) {
    // Persist before printing: if the state cannot be saved, a printed reminder
    // would repeat on every search, so stay silent instead. Atomic because
    // parallel tool calls run this hook concurrently on the same file.
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileAtomic(file, `${JSON.stringify(toWrite)}\n`);
    } catch {
      return null;
    }
  }
  return output;
}

if (import.meta.main) {
  try {
    const output = handle(readFileSync(0, 'utf8'));
    if (output && typeof output === 'object' && output.block) {
      process.stderr.write(`${output.block}\n`);
      process.exitCode = 2;
    } else {
      if (output) process.stdout.write(`${output}\n`);
      process.exitCode = 0;
    }
  } catch {
    process.exitCode = 0;
  }
}
