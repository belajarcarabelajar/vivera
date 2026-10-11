#!/usr/bin/env bun
// scripts/gen-sprite-agents.mjs
//
// Renders the Harvest Sprite crew into agent files for one harness. Claude Code
// labels a running subagent with its agent name, so four role agents shared by
// a wave of parallel chunks all show the same label. Each sprite is a named copy
// of one role template (agents/roles/<role>.md), listed in agents/crew.json.
//
// The pieces live in scripts/sprite-agents/: crew.mjs (roster and templates),
// sync.mjs (write, refuse, remove), guard.mjs (prose guard for harnesses
// without a hook), registry.mjs (loads every targets/*.mjs), targets/<id>.mjs
// (one renderer per harness). This file is the CLI, and it re-exports the names
// its tests import.
//
// Targets:
//   - claude, the default: the repository's .claude/agents, committed and
//     checked in CI, or a user-level directory such as ~/.claude/agents
//     (install.sh), where $CLAUDE_PROJECT_DIR points at whatever project the
//     session opened, so the hook path is pinned to this repository with
//     --hook-root. Without that the guard script is missing in other projects
//     and the hook stops guarding;
//   - opencode with --out ~/.config/opencode/agents (install.sh): the OpenCode
//     v2 format, which skips a Claude Code file without a message.
//   Any other id is a file in scripts/sprite-agents/targets/.
//
// --clean removes every file this script generated from --out, so an
// uninstall can undo an install. A file without the marker is left alone.
//
// Usage: bun scripts/gen-sprite-agents.mjs [--check | --clean] [--out <dir>] [--hook-root <dir>]
//                                          [--target <id>] [--roles <dir>] [--crew <file>]
// Exit: 0 in sync, written or cleaned, 1 drift, refusal, or bad input.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookScripts, loadCrewPlan, parseCrew } from './sprite-agents/crew.mjs';
import { TARGETS, targetIds } from './sprite-agents/registry.mjs';
import { MARKER, syncDir } from './sprite-agents/sync.mjs';
import { OPENCODE_COLORS, renderOpenCodeAgent } from './sprite-agents/targets/opencode.mjs';
import { renderAgent } from './sprite-agents/targets/claude.mjs';

export { MARKER, OPENCODE_COLORS, parseCrew, renderAgent, renderOpenCodeAgent, syncDir };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(ROOT, '.claude', 'agents');

function getTarget(id) {
  if (!Object.hasOwn(TARGETS, id)) throw new Error(`--target must be one of ${targetIds().join(', ')} (got ${id})`);
  return TARGETS[id];
}

export function planOutputs({ rolesDir, crewFile, hookRoot, target = 'claude' }) {
  const t = getTarget(target);
  const outputs = new Map();
  for (const { member, template } of loadCrewPlan({ rolesDir, crewFile })) {
    // Only Claude Code runs hooks, so only its files point at a script under the root.
    if (hookRoot !== undefined && t.id === 'claude') {
      for (const rel of hookScripts(template)) {
        if (!fs.existsSync(path.join(hookRoot, rel))) throw new Error(`hook script ${path.join(hookRoot, rel)} does not exist`);
      }
    }
    outputs.set(t.outName(member.sprite), t.render(template, member, { hookRoot }));
  }
  return outputs;
}

function parseArgs(argv) {
  const opts = {
    check: false,
    clean: false,
    rolesDir: path.join(ROOT, 'agents', 'roles'),
    crewFile: path.join(ROOT, 'agents', 'crew.json'),
    outDir: undefined,
    hookRoot: undefined,
    target: 'claude',
  };
  const valued = { '--roles': 'rolesDir', '--crew': 'crewFile', '--out': 'outDir', '--hook-root': 'hookRoot' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--clean') opts.clean = true;
    else if ((arg === '--target' || arg in valued) && i + 1 < argv.length) {
      const value = argv[++i];
      // A flag in the value slot is a forgotten value, and taking it would write into a directory named like the flag.
      // A single dash stays a path.
      if (value.startsWith('--')) throw new Error(`${arg} needs a value (got ${value})`);
      if (arg === '--target') opts.target = value;
      else {
        // path.resolve('') is the working directory, which --clean would then empty.
        if (value === '') throw new Error(`${arg} needs a non-empty value`);
        opts[valued[arg]] = path.resolve(value);
      }
    } else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  const target = getTarget(opts.target);
  if (opts.check && opts.clean) throw new Error('--clean removes files and --check writes nothing; pass one of them');
  // Removing files has no default directory: the Claude default is this repository's committed agents.
  if (opts.clean && opts.outDir === undefined) throw new Error('--clean needs --out <dir>');
  // A target with nothing committed here has no safe default directory.
  if (target.requiresOut && opts.outDir === undefined) throw new Error(`--target ${target.id} needs --out <dir>`);
  if (opts.hookRoot !== undefined && target.id !== 'claude') throw new Error('--hook-root applies to --target claude only, the one target that runs hooks');
  opts.outDir ??= DEFAULT_OUT_DIR;
  return opts;
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const target = TARGETS[opts.target];
    // Cleaning is a sync against nothing: every marked file is stale, an unmarked one is not ours.
    const outputs = opts.clean ? new Map() : planOutputs(opts);
    // The depth a sync scans comes from where the target writes: only a <dir>/<file> layout owns a second
    // level. A flat target must not look into subdirectories, which belong to the user.
    const nested = target.outName('sprite').includes('/');
    const r = syncDir(opts.outDir, outputs, { check: opts.check, ext: target.ext, nested });
    for (const f of r.refused) {
      const why = r.inTheWay.includes(f) ? 'something that is not a generated file is in the way' : 'not generated by this script';
      console.error(`${path.join(opts.outDir, f)}: ${why}, left untouched`);
    }
    for (const d of r.drift) console.error(`${path.join(opts.outDir, d)}`);
    // agents:gen rewrites only the committed .claude/agents. Any other directory, target or hook root
    // is an installed copy. scripts/install/check.sh matches the "sprite agents are out of date:" prefix.
    const committed = opts.target === 'claude' && opts.hookRoot === undefined && opts.outDir === DEFAULT_OUT_DIR;
    if (r.drift.length > 0) console.error(`sprite agents are out of date: run ${committed ? 'bun run agents:gen' : './install.sh --update'}`);
    const failed = r.refused.length > 0 || r.drift.length > 0;
    // A refusal does not undo the files already written and removed, so the report comes before the exit code.
    // --check writes nothing, so a failed check has no summary to give.
    if (!(opts.check && failed)) {
      for (const f of r.removed) console.log(`removed ${path.join(opts.outDir, f)}`);
      if (opts.clean) {
        console.log(`${r.removed.length} generated file(s) removed from ${opts.outDir}`);
      } else {
        const refused = r.refused.length > 0 ? `, ${r.refused.length} refused` : '';
        const changes = opts.check ? 'in sync' : `${r.written.length} written, ${r.removed.length} removed${refused}`;
        console.log(`${outputs.size} sprite agent(s) in ${opts.outDir}: ${changes}`);
      }
    }
    if (failed) process.exitCode = 1;
  } catch (e) {
    console.error(String(e.message));
    process.exit(1);
  }
}
