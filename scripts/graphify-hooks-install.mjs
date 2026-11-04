#!/usr/bin/env bun
// scripts/graphify-hooks-install.mjs
//
// Adds, removes, or checks the graphify hooks in a Claude Code settings file.
//
// The target is usually the user's global ~/.claude/settings.json, which every
// other tool on the machine also edits. Hand-editing it invites three silent
// failures: a second paste duplicates the entries so each hook fires twice, an
// uninstall by hand deletes a neighbour's hook, and a stray comma leaves a file
// Claude Code refuses to load. This script owns only the entries whose command
// points into `/scripts/hooks/graphify-`, replaces them instead of appending
// twice, refuses a file it cannot parse, and writes atomically with a one
// generation `.bak` so the previous file is one copy away.

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { graphifyStatus } from './lib/graphify-status.mjs';
import * as settingsHooks from './lib/settings-hooks.mjs';

// Anchored because a matcher with regex characters is tested unanchored, so
// `Read` alone would also fire on any tool whose name merely contains it.
export const MATCHER = '^(Grep|Glob|Read|Bash|mcp__graphify__.*)$';

const OWNER_MARKS = ['/scripts/hooks/graphify-'];
const START_SCRIPT = 'graphify-session-start.mjs';
const NUDGE_SCRIPT = 'graphify-search-nudge.mjs';
const EVENTS = ['SessionStart', 'SubagentStart', 'PreToolUse'];
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `usage: bun scripts/graphify-hooks-install.mjs (--install | --uninstall | --check) [options]

  --install          replace the graphify hook entries with fresh ones (idempotent)
  --uninstall        remove only the graphify hook entries
  --check            exit 0 when all three entries and both hook scripts exist, else 1
  --settings <path>  settings file (default: ~/.claude/settings.json)
  --hooks-dir <dir>  directory holding the hook scripts (default: this repository's scripts/hooks,
                     which --install refuses when this repository is a linked git worktree)
  --dry-run          print the resulting JSON and write nothing
  -h, --help         this message`;

/** True when any hook command in this matcher entry runs one of our scripts. */
export function isOurs(entry) {
  return settingsHooks.isOwned(entry, OWNER_MARKS);
}

/** Throws when the settings cannot be merged without guessing. */
export function validateSettings(settings) {
  settingsHooks.validateSettings(settings, EVENTS);
}

function freshEntries(hooksDir, bunPath) {
  const hook = (script) => settingsHooks.hookCommand(bunPath, `${hooksDir}/${script}`);
  return {
    SessionStart: [{ hooks: [hook(START_SCRIPT)] }],
    SubagentStart: [{ hooks: [hook(START_SCRIPT)] }],
    PreToolUse: [{ matcher: MATCHER, hooks: [hook(NUDGE_SCRIPT)] }],
  };
}

/** Returns a copy of `settings` with our old entries removed and fresh ones appended. */
export function installEntries(settings, hooksDir, bunPath) {
  validateSettings(settings);
  const fresh = freshEntries(hooksDir, bunPath);
  if (!Object.values(fresh).flat().every(isOurs)) {
    // Otherwise the next install could not find these entries and would add a second set.
    throw new Error(`the hooks dir must end in scripts/hooks so later runs can recognise the entries: ${hooksDir}`);
  }
  return settingsHooks.installEntries(settings, fresh, EVENTS, OWNER_MARKS);
}

/** Returns a copy of `settings` with only our entries removed. */
export function uninstallEntries(settings) {
  return settingsHooks.uninstallEntries(settings, EVENTS, OWNER_MARKS);
}

/** Reports which of the three entries and two script files are missing. */
export function checkEntries(settings, hooksDir) {
  validateSettings(settings);
  const matchesAll = (m) => m === undefined || m === '' || m === '*';
  const has = (event, script, matcherOk) => (settings.hooks?.[event] ?? []).some((e) =>
    isOurs(e) && matcherOk(e.matcher) && settingsHooks.commandsOf(e).some((c) => c.includes(`"${hooksDir}/${script}"`)));

  const missing = [];
  if (!has('SessionStart', START_SCRIPT, matchesAll)) missing.push(`hooks.SessionStart entry without a matcher running ${START_SCRIPT}`);
  if (!has('SubagentStart', START_SCRIPT, matchesAll)) missing.push(`hooks.SubagentStart entry running ${START_SCRIPT}`);
  if (!has('PreToolUse', NUDGE_SCRIPT, (m) => m === MATCHER)) missing.push(`hooks.PreToolUse entry with matcher ${MATCHER} running ${NUDGE_SCRIPT}`);
  for (const script of [START_SCRIPT, NUDGE_SCRIPT]) {
    const file = path.join(hooksDir, script);
    if (!existsSync(file)) missing.push(`hook script ${file}`);
  }
  return { ok: missing.length === 0, missing };
}

/** Parses argv (without the runtime and script path). */
export function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const opts = { mode: undefined, settings: undefined, hooksDir: undefined, dryRun: false, help: false };
  const modes = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--install' || a === '--uninstall' || a === '--check') modes.push(a.slice(2));
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--settings' || a === '--hooks-dir') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return { ...opts, error: `${a} needs a value` };
      if (a === '--settings') opts.settings = value;
      else opts.hooksDir = value;
      i += 1;
    } else return { ...opts, error: `unknown argument: ${a}` };
  }
  if (opts.help) return opts;
  if (modes.length !== 1) return { ...opts, error: 'choose exactly one of --install, --uninstall, --check' };
  opts.mode = modes[0];
  return opts;
}

/** Runs the CLI and returns its exit code; `scriptsDir` stands in for this file's directory. */
export function main(argv, { scriptsDir = SCRIPTS_DIR } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.error) {
    console.error(`graphify-hooks-install: ${opts.error}`);
    console.error(USAGE);
    return 2;
  }

  const target = path.resolve(opts.settings ?? path.join(os.homedir(), '.claude', 'settings.json'));
  const hooksDir = path.resolve(opts.hooksDir ?? path.join(scriptsDir, 'hooks'));

  if (opts.mode === 'install' && opts.hooksDir === undefined && !opts.dryRun) {
    // Session worktrees are deleted after merge, so hooks pointing into one
    // would make every later session start on this machine report hook errors.
    // `worktree` is only set once a graph exists, so compare the roots directly.
    const status = graphifyStatus(scriptsDir);
    if (status.kind !== 'not-git' && status.root !== status.mainRoot) {
      console.error(`graphify-hooks-install: refused, ${target} left untouched: ${status.root} is a linked git worktree, and hooks pointing into it break once the worktree is removed.`);
      console.error(`Hooks must point at the main checkout ${status.mainRoot}: run \`bun run graphify:hooks --install\` from ${status.mainRoot}, or pass --hooks-dir <dir> to choose explicitly.`);
      return 1;
    }
  }

  const exists = existsSync(target);

  if (!exists && opts.mode === 'check') {
    console.log(`missing: settings file ${target}`);
    return 1;
  }
  if (!exists && opts.mode === 'uninstall') {
    console.log(`graphify hooks: ${target} does not exist, nothing to remove`);
    return 0;
  }

  let before;
  let next;
  try {
    const read = settingsHooks.readSettings(target);
    before = read.before;
    const { settings } = read;
    if (opts.mode === 'check') {
      const result = checkEntries(settings, hooksDir);
      if (result.ok) {
        console.log(`graphify hooks: installed in ${target}`);
        return 0;
      }
      for (const m of result.missing) console.log(`missing: ${m}`);
      return 1;
    }
    next = opts.mode === 'install' ? installEntries(settings, hooksDir, process.execPath) : uninstallEntries(settings);
  } catch (err) {
    console.error(`graphify-hooks-install: refused, ${target} left untouched: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (opts.dryRun) {
    process.stdout.write(text);
    return 0;
  }
  const verb = opts.mode === 'install' ? 'installed in' : 'removed from';
  if (!settingsHooks.writeSettings(target, text, before)) {
    console.log(`graphify hooks: already ${verb} ${target}, nothing written`);
    return 0;
  }
  console.log(`graphify hooks: ${verb} ${target}${exists ? ` (previous content in ${target}.bak)` : ''}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
