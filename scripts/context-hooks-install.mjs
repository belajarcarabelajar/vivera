#!/usr/bin/env bun
// scripts/context-hooks-install.mjs
//
// Adds, removes, or checks the opt-in context hooks (output cap, output
// replacement, session journal) in a Claude Code settings file.
//
// Usage: bun run context:hooks (--install | --uninstall | --check) [--settings <path>] [--hooks-dir <dir>] [--dry-run]
//
// Same safety model as graphify-hooks-install.mjs, through scripts/lib/settings-hooks.mjs:
// only entries whose command points into one of the owner marks below are
// touched, a reinstall replaces them instead of adding a second set, a file
// that cannot be parsed is refused untouched, and writes are atomic with a
// one generation `.bak`. Identical bytes are never rewritten.
//
// Revert: `bun run context:hooks --uninstall` removes only these entries. To
// switch the hooks off without editing settings, create the kill switch file
// ~/.local/state/vivera/context-hooks-off (or `context-hooks-off` under
// $VIVERA_HOOK_STATE_DIR when set); delete it to switch them back on.

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { graphifyStatus } from './lib/graphify-status.mjs';
import * as settingsHooks from './lib/settings-hooks.mjs';
import { CONTEXT_HOOK_SPECS as SPECS, contextHookEntries } from './lib/context-hook-entries.mjs';

const OWNER_MARKS = ['/scripts/hooks/output-cap', '/scripts/hooks/output-replace', '/scripts/hooks/session-journal'];
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const EVENTS = [...new Set(SPECS.map((s) => s.event))];

const USAGE = `usage: bun scripts/context-hooks-install.mjs (--install | --uninstall | --check) [options]

  --install          replace the context hook entries with fresh ones (idempotent)
  --uninstall        remove only the context hook entries
  --check            exit 0 when all five entries and the hook scripts exist, else 1
  --settings <path>  settings file (default: ~/.claude/settings.json)
  --hooks-dir <dir>  directory holding the hook scripts (default: this repository's scripts/hooks,
                     which --install refuses when this repository is a linked git worktree)
  --dry-run          print the resulting JSON and write nothing
  -h, --help         this message`;

const label = (spec) => `hooks.${spec.event} entry with matcher ${spec.matcher} running ${[spec.script, ...spec.args].join(' ')}`;

function freshEntries(hooksDir, bunPath) {
  return contextHookEntries((file, args) => settingsHooks.hookCommand(bunPath, `${hooksDir}/${file}`, args).command);
}

/** Returns a copy of `settings` with our old entries removed and the five fresh ones appended. */
export function installEntries(settings, hooksDir, bunPath) {
  return settingsHooks.installEntries(settings, freshEntries(hooksDir, bunPath), EVENTS, OWNER_MARKS);
}

/** Returns a copy of `settings` with only our entries removed. */
export function uninstallEntries(settings) {
  return settingsHooks.uninstallEntries(settings, EVENTS, OWNER_MARKS);
}

/** Reports which of the five entries (matcher, script and mode argument) and hook scripts are missing. */
export function checkEntries(settings, hooksDir) {
  settingsHooks.validateSettings(settings, EVENTS);
  const missing = [];
  for (const spec of SPECS) {
    const tail = `"${hooksDir}/${spec.script}"${spec.args.map((a) => ` ${a}`).join('')}`;
    const found = (settings.hooks?.[spec.event] ?? []).some((e) =>
      settingsHooks.isOwned(e, OWNER_MARKS) && e.matcher === spec.matcher
      && settingsHooks.commandsOf(e).some((c) => c.endsWith(tail)));
    if (!found) missing.push(label(spec));
  }
  for (const script of new Set(SPECS.map((s) => s.script))) {
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
    console.error(`context-hooks-install: ${opts.error}`);
    console.error(USAGE);
    return 2;
  }

  const target = path.resolve(opts.settings ?? path.join(os.homedir(), '.claude', 'settings.json'));
  const hooksDir = path.resolve(opts.hooksDir ?? path.join(scriptsDir, 'hooks'));

  if (opts.mode === 'install' && opts.hooksDir === undefined && !opts.dryRun) {
    // These hooks fire on nearly every tool call, so entries pointing into a
    // session worktree would fail on every call once the worktree is removed.
    const status = graphifyStatus(scriptsDir);
    if (status.kind !== 'not-git' && status.root !== status.mainRoot) {
      console.error(`context-hooks-install: refused, ${target} left untouched: ${status.root} is a linked git worktree, and hooks pointing into it break once the worktree is removed.`);
      console.error(`Hooks must point at the main checkout ${status.mainRoot}: run \`bun run context:hooks --install\` from ${status.mainRoot}, or pass --hooks-dir <dir> to choose explicitly.`);
      return 1;
    }
  }

  const exists = existsSync(target);
  if (!exists && opts.mode === 'check') {
    console.log(`missing: settings file ${target}`);
    return 1;
  }
  if (!exists && opts.mode === 'uninstall') {
    console.log(`context hooks: ${target} does not exist, nothing to remove`);
    return 0;
  }

  let before;
  let next;
  try {
    const read = settingsHooks.readSettings(target);
    before = read.before;
    if (opts.mode === 'check') {
      const result = checkEntries(read.settings, hooksDir);
      if (result.ok) {
        console.log(`context hooks: installed in ${target}`);
        return 0;
      }
      for (const m of result.missing) console.log(`missing: ${m}`);
      return 1;
    }
    next = opts.mode === 'install' ? installEntries(read.settings, hooksDir, process.execPath) : uninstallEntries(read.settings);
  } catch (err) {
    console.error(`context-hooks-install: refused, ${target} left untouched: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (opts.dryRun) {
    process.stdout.write(text);
    return 0;
  }
  const verb = opts.mode === 'install' ? 'installed in' : 'removed from';
  if (!settingsHooks.writeSettings(target, text, before)) {
    console.log(`context hooks: already ${verb} ${target}, nothing written`);
    return 0;
  }
  console.log(`context hooks: ${verb} ${target}${exists ? ` (previous content in ${target}.bak)` : ''}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
