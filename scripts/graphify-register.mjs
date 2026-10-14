#!/usr/bin/env bun
// scripts/graphify-register.mjs
//
// Builds a repository's graphify graph and adds it to the global graphify
// registry, or records with --never that the repository opted out.
//
// The graph always lands in the main checkout, so running this from a linked
// worktree registers the main checkout instead of a throwaway copy. The output
// directory is hidden through info/exclude rather than .gitignore so that
// registering never leaves a change in the working tree.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { graphifyStatus, graphPathFor } from './lib/graphify-status.mjs';

const UPDATE_TIMEOUT_MS = 600_000;
const ADD_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;
const STDERR_TAIL_LINES = 20;
const IGNORE_LINE = 'graphify-out/';
const UNDO = 'git config --unset graphify.register';

const USAGE = `Usage: bun scripts/graphify-register.mjs <dir> [--never]

Builds the graphify graph for the repository that contains <dir> (its main
checkout when <dir> is a linked worktree) and adds it to the global registry.

  --never   opt the repository out instead (sets graphify.register=never)
  --help    show this help

Environment: GRAPHIFY_BIN overrides the graphify executable.
Exit codes: 0 done or opted out, 1 graphify failed or missing, 2 usage error.`;

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
}

function runGraphify(graphifyBin, step, args, timeout) {
  const r = spawnSync(graphifyBin, args, {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error?.code === 'ENOENT') {
    return [`${step}: graphify not found at ${graphifyBin} (install graphify or set GRAPHIFY_BIN)`];
  }
  if (r.error) return [`${step}: graphify failed to run: ${r.error.message}`, ...tail(r.stderr)];
  if (r.status !== 0) {
    const how = r.status === null ? `signal ${r.signal}` : `exit code ${r.status}`;
    return [`${step}: graphify failed with ${how}`, ...tail(r.stderr)];
  }
  return null;
}

function tail(stderr) {
  if (!stderr) return [];
  return stderr
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .slice(-STDERR_TAIL_LINES)
    .map((l) => `  ${l}`);
}

function ensureExcluded(mainRoot) {
  if (git(mainRoot, ['check-ignore', '-q', IGNORE_LINE]).status === 0) {
    return `${IGNORE_LINE} already ignored`;
  }
  const r = git(mainRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.status !== 0) return null;
  const exclude = path.join(r.stdout.trim(), 'info', 'exclude');
  let current = '';
  try {
    current = readFileSync(exclude, 'utf8');
  } catch {}
  // A negation elsewhere can keep check-ignore failing, so guard against
  // appending the same line on every run.
  if (current.split(/\r?\n/).includes(IGNORE_LINE)) {
    return `${IGNORE_LINE} already listed in ${exclude}`;
  }
  mkdirSync(path.dirname(exclude), { recursive: true });
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(exclude, `${sep}${IGNORE_LINE}\n`);
  return `added ${IGNORE_LINE} to ${exclude}`;
}

export function register(
  dir,
  { graphifyBin = process.env.GRAPHIFY_BIN || 'graphify', never = false } = {},
) {
  const target = path.resolve(dir);
  const status = graphifyStatus(target);
  if (status.kind === 'not-git') {
    return { exitCode: 2, lines: [`not a git repository: ${target}`] };
  }
  const { mainRoot } = status;

  if (never) {
    const r = git(mainRoot, ['config', 'graphify.register', 'never']);
    if (r.status !== 0) {
      return { exitCode: 1, lines: [`could not set graphify.register=never in ${mainRoot}`, ...tail(r.stderr)] };
    }
    return {
      exitCode: 0,
      lines: [`opted out of graphify: ${mainRoot} (graphify.register=never; undo: ${UNDO})`],
    };
  }
  if (status.kind === 'opted-out') {
    return {
      exitCode: 0,
      lines: [`skipped: ${mainRoot} is opted out of graphify (undo: ${UNDO})`],
    };
  }

  const lines = [];
  const name = path.basename(mainRoot);
  const graphPath = graphPathFor(mainRoot);

  const updateFail = runGraphify(graphifyBin, 'update', ['update', mainRoot], UPDATE_TIMEOUT_MS);
  if (updateFail) return { exitCode: 1, lines: [...lines, ...updateFail] };
  lines.push(`built graph: ${graphPath}`);

  const excluded = ensureExcluded(mainRoot);
  if (excluded) lines.push(excluded);

  const addArgs = ['global', 'add', graphPath, '--as', name];
  const addFail = runGraphify(graphifyBin, 'global add', addArgs, ADD_TIMEOUT_MS);
  if (addFail) return { exitCode: 1, lines: [...lines, ...addFail] };
  lines.push(`registered ${graphPath} as ${name}`);

  return { exitCode: 0, lines };
}

function main(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const never = args.includes('--never');
  const unknown = args.filter((a) => a.startsWith('-') && a !== '--never');
  const dirs = args.filter((a) => !a.startsWith('-'));
  if (unknown.length > 0 || dirs.length !== 1) {
    if (unknown.length > 0) console.error(`unknown option: ${unknown.join(' ')}`);
    console.error(USAGE);
    return 2;
  }
  const { exitCode, lines } = register(dirs[0], { never });
  const out = exitCode === 0 ? console.log : console.error;
  for (const line of lines) out(line);
  return exitCode;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
