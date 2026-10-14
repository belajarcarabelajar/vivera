// scripts/hooks/graphify-session-start.mjs
//
// Claude Code SessionStart and SubagentStart hook. It tells a session whether
// its repository has a graphify knowledge graph and how to query it, or, at
// session start in a repository without one, how registration works.
//
// A failing hook would add noise to every session start, so every path exits 0
// and anything unexpected prints nothing. The text states facts and commands
// without imperative wording, because the Claude Code hooks docs warn that
// commanding language in injected context can trip prompt-injection defenses.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphifyStatus } from '../lib/graphify-status.mjs';

const EVENTS = new Set(['SessionStart', 'SubagentStart']);
const VIVERA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Plain paths stay readable; anything a shell would split or expand is
// single-quoted so a copied command still works in a directory with spaces.
export function shellArg(s) {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function registeredText(s) {
  const parts = [`graphify: the knowledge graph for the main checkout ${s.mainRoot} is ${s.graphPath}.`];
  if (s.worktree) {
    parts.push(
      `This session runs in the linked worktree ${s.root}; the graph describes the main checkout, so changes made only in this worktree are not in it.`,
    );
  }
  if (s.stale) {
    parts.push(
      `The graph is older than the last commit; \`graphify update ${shellArg(s.mainRoot)}\` refreshes it offline.`,
    );
  }
  parts.push(
    `\`graphify query "<question>" --graph ${shellArg(s.graphPath)}\` (and \`graphify path "A" "B"\` or \`graphify explain "X"\` with the same --graph), or the MCP tool query_graph with project_path set to ${s.mainRoot}, returns a scoped subgraph of the relevant files and symbols, which narrows the search before grepping or reading source files.`,
  );
  return parts.join(' ');
}

function unregisteredText(s, viveraRoot) {
  const command = `bun ${shellArg(`${viveraRoot}/scripts/graphify-register.mjs`)} ${shellArg(s.mainRoot)}`;
  return [
    `graphify: ${s.mainRoot} has no knowledge graph, so graph queries are unavailable for it.`,
    `Registration builds one offline in about 13 s per 2,000 files with \`${command}\`, and the same command with --never records that registration is not offered again for this repository.`,
    'The user asked to be offered registration through the question tool (Register now, Not now, Never for this repository) when a session starts in an unregistered repository.',
    'A dismissed question registers nothing; only an explicit Register now does.',
  ].join(' ');
}

export function contextFor(event, status, viveraRoot) {
  if (!EVENTS.has(event)) return null;
  if (status?.kind === 'registered') return registeredText(status);
  if (status?.kind === 'unregistered' && event === 'SessionStart') return unregisteredText(status, viveraRoot);
  return null;
}

async function main() {
  const input = JSON.parse(await Bun.stdin.text());
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const { hook_event_name: event, cwd } = input;
  // git -C resolves '' and relative paths against this process's directory,
  // which is not necessarily the session's, so only an absolute cwd is trusted.
  if (!EVENTS.has(event) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return;
  const text = contextFor(event, graphifyStatus(cwd), VIVERA_ROOT);
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
