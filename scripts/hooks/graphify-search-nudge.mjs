#!/usr/bin/env bun
// scripts/hooks/graphify-search-nudge.mjs
//
// Claude Code PreToolUse hook. The first time an agent searches a repository
// that has a graphify graph (Grep, Glob, Read of a source file, or a Bash
// rg/grep/fd/find/ag), it adds one line of context naming the graph and the
// query command, unless that agent already queried the graph.
//
// One reminder per session and agent, tracked in a small state file, so the
// nudge never turns into noise. The hook only adds context: it never prints a
// permission decision, and every failure path prints nothing and exits 0, so a
// broken hook can never block or alter a tool call.

import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../lib/atomic-write.mjs';
import { graphifyStatus } from '../lib/graphify-status.mjs';
import { shellArg } from './graphify-session-start.mjs';

const SEARCH_COMMANDS = new Set(['rg', 'grep', 'fd', 'find', 'ag']);
const QUERY_SUBCOMMANDS = new Set(['query', 'path', 'explain']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

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

export function reminderText(graphPath) {
  return (
    `This repository has a graphify knowledge graph at ${graphPath}. ` +
    'A query returns the nodes, files and relations that match a question in one call: ' +
    `\`graphify query "<question>" --graph ${shellArg(graphPath)}\`. ` +
    '`graphify path "A" "B"` and `graphify explain "X"` take the same --graph flag. ' +
    'This note appears once per session and agent.'
  );
}

function needsStatus(input, state) {
  return toolKind(input) === 'search' && !state.queried && !state.reminded;
}

// Pure: returns the stdout line (or null) and the state to persist.
export function decide(input, state, status) {
  const kind = toolKind(input);
  if (kind === 'query') return { output: null, nextState: { ...state, queried: true } };
  if (kind === 'search' && !state.queried && !state.reminded && status?.kind === 'registered') {
    const output = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reminderText(status.graphPath) },
    });
    return { output, nextState: { ...state, reminded: true } };
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
    if (output) process.stdout.write(`${output}\n`);
  } catch {}
  process.exitCode = 0;
}
