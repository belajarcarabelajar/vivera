#!/usr/bin/env bun
// scripts/closeout-hooks-install.mjs
//
// Adds, removes, or checks the close-out SessionStart note in a Claude Code
// settings file, usually the global ~/.claude/settings.json that every other
// tool also edits. Like scripts/graphify-hooks-install.mjs it owns only the
// entries whose command points into `/scripts/hooks/closeout-`, replaces them
// instead of appending twice, refuses a file it cannot parse, and writes
// atomically with a one generation `.bak`.

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as settingsHooks from './lib/settings-hooks.mjs';

const OWNER_MARKS = ['/scripts/hooks/closeout-'];
const EVENTS = ['SessionStart'];
const HOOK_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hooks', 'closeout-session-start.mjs');

const USAGE = `usage: bun scripts/closeout-hooks-install.mjs (--add | --check | --remove) [--settings <path>]

  --add              replace the close-out SessionStart entry with a fresh one (idempotent)
  --remove           remove only the close-out entry
  --check            exit 0 when the entry runs this checkout's hook and the hook exists, else 1
  --settings <path>  settings file (default: ~/.claude/settings.json)
  -h, --help         this message`;

// dup-defs: allow graphify-hooks-install.mjs owns other OWNER_MARKS
const isOurs = (entry) => settingsHooks.isOwned(entry, OWNER_MARKS);

/** Returns a copy of `settings` with our old entry removed and a fresh one appended. */
export function addEntries(settings, hookFile, bunPath) {
  const fresh = { SessionStart: [{ hooks: [settingsHooks.hookCommand(bunPath, hookFile)] }] };
  return settingsHooks.installEntries(settings, fresh, EVENTS, OWNER_MARKS);
}

/** Returns a copy of `settings` with only our entry removed. */
export function removeEntries(settings) {
  return settingsHooks.uninstallEntries(settings, EVENTS, OWNER_MARKS);
}

/** Reports whether a matcherless SessionStart entry runs `hookFile` and the file exists. */
// dup-defs: allow graphify-hooks-install.mjs checks three entries and two scripts, this one entry
export function checkEntries(settings, hookFile) {
  settingsHooks.validateSettings(settings, EVENTS);
  const matchesAll = (m) => m === undefined || m === '' || m === '*';
  const present = (settings.hooks?.SessionStart ?? []).some((e) =>
    isOurs(e) && matchesAll(e.matcher) && settingsHooks.commandsOf(e).some((c) => c.includes(`"${hookFile}"`)));
  const missing = [];
  if (!present) missing.push(`hooks.SessionStart entry without a matcher running ${hookFile}`);
  if (!existsSync(hookFile)) missing.push(`hook script ${hookFile}`);
  return { ok: missing.length === 0, missing };
}

/** Parses argv (without the runtime and script path). */
export function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const opts = { mode: undefined, settings: undefined, help: false };
  const modes = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--add' || a === '--remove' || a === '--check') modes.push(a.slice(2));
    else if (a === '--settings') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return { ...opts, error: `${a} needs a value` };
      opts.settings = value;
      i += 1;
    } else return { ...opts, error: `unknown argument: ${a}` };
  }
  if (opts.help) return opts;
  if (modes.length !== 1) return { ...opts, error: 'choose exactly one of --add, --remove, --check' };
  opts.mode = modes[0];
  return opts;
}

/** Runs the CLI and returns its exit code. */
export function main(argv, { hookFile = HOOK_FILE } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.error) {
    console.error(`closeout-hooks-install: ${opts.error}`);
    console.error(USAGE);
    return 2;
  }

  const target = path.resolve(opts.settings ?? path.join(os.homedir(), '.claude', 'settings.json'));
  const exists = existsSync(target);
  if (!exists && opts.mode === 'check') {
    console.log(`missing: settings file ${target}`);
    return 1;
  }
  if (!exists && opts.mode === 'remove') {
    console.log(`closeout hook: ${target} does not exist, nothing to remove`);
    return 0;
  }

  let before;
  let next;
  try {
    const read = settingsHooks.readSettings(target);
    before = read.before;
    if (opts.mode === 'check') {
      const result = checkEntries(read.settings, hookFile);
      if (result.ok) {
        console.log(`closeout hook: installed in ${target}`);
        return 0;
      }
      for (const m of result.missing) console.log(`missing: ${m}`);
      return 1;
    }
    next = opts.mode === 'add' ? addEntries(read.settings, hookFile, process.execPath) : removeEntries(read.settings);
  } catch (err) {
    console.error(`closeout-hooks-install: refused, ${target} left untouched: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const verb = opts.mode === 'add' ? 'installed in' : 'removed from';
  if (!settingsHooks.writeSettings(target, `${JSON.stringify(next, null, 2)}\n`, before)) {
    console.log(`closeout hook: already ${verb} ${target}, nothing written`);
    return 0;
  }
  console.log(`closeout hook: ${verb} ${target}${exists ? ` (previous content in ${target}.bak)` : ''}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
