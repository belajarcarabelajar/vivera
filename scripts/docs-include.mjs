#!/usr/bin/env bun
// scripts/docs-include.mjs
//
// Checks that every docs code block marked `<!-- include: <path>[#<region>] -->`
// equals the repository file it names, so a page cannot drift from the code it
// shows (syntax and rules: scripts/lib/docs-include.mjs). `--write` refreshes
// stale blocks in place and never touches a file with a structural error.
//
//   bun scripts/docs-include.mjs [--root <dir>] (--check | --write) [files...]
//
// Without files: README.md, every source in apps/docs/pages.json, and the ID
// twins under apps/docs/content/id. File paths are relative to --root.
//
// Exit 0 ok, 1 findings, 2 usage error.

import fs from 'node:fs';
import path from 'node:path';
import { checkIncludes, defaultFiles, rootReader } from './lib/docs-include.mjs';

export const USAGE = 'usage: bun scripts/docs-include.mjs [--root <dir>] (--check | --write) [files...]';

/** `{ mode, root, files }`, or `{ error }` for a usage problem. */
export function parseArgs(argv) {
  const opts = { root: process.cwd(), modes: [], files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check' || a === '--write') opts.modes.push(a.slice(2));
    else if (a === '--root') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) return { error: '--root needs a value' };
      opts.root = argv[++i];
    } else if (a.startsWith('--')) return { error: `unknown argument: ${a}` };
    else opts.files.push(a);
  }
  if (opts.modes.length !== 1) return { error: 'exactly one of --check, --write is required' };
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { error: `--root ${opts.root} is not a directory` };
  return { mode: opts.modes[0], root, files: opts.files };
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`docs-include: ${opts.error}`);
    console.error(USAGE);
    return 2;
  }
  const { root, mode } = opts;
  const read = rootReader(root);
  const files = opts.files.length ? opts.files : defaultFiles(root);
  const findings = [];
  let updated = 0;
  for (const file of files) {
    const text = read(file);
    if (text === null) {
      findings.push(`${file}: file does not exist`);
      continue;
    }
    const r = checkIncludes(file, text, read);
    if (mode === 'write' && r.changes.length) {
      fs.writeFileSync(path.join(root, file), r.output);
      for (const c of r.changes) console.log(c);
      updated += r.changes.length;
      // What the rewrite fixed is no longer a finding; anything else stays.
      findings.push(...checkIncludes(file, r.output, read).findings);
    } else findings.push(...r.findings);
  }
  for (const f of findings) console.log(f);
  if (mode === 'write') console.log(`docs-include: updated ${updated} block(s), ${findings.length} finding(s) left in ${files.length} file(s)`);
  else console.log(`docs-include: ${findings.length} finding(s) in ${files.length} file(s)`);
  return findings.length ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
