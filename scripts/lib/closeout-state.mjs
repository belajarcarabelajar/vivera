// scripts/lib/closeout-state.mjs
//
// The close-out loop's machine-local state: due.json (the last --due result,
// read by the session-start note) and kept-open.json (the owner's keep-open
// answers, each pinned to the plan's hash). Kept outside the plan file because
// writing there changes the hash and needs a commit.

import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

export const stateDir = () => process.env.VIVERA_CLOSEOUT_STATE || path.join(homedir(), '.local', 'state', 'vivera-closeout');

const dueFile = () => path.join(stateDir(), 'due.json');
const keptFile = () => path.join(stateDir(), 'kept-open.json');

function parse(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Reads stay side-effect free because the session-start hook only reads.
const read = (file) => (existsSync(file) ? parse(file) : null);

function write(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  // Only an unreadable file is backed up, so the .bak keeps the corrupt copy instead of the next good one.
  if (existsSync(file) && parse(file) === null) copyFileSync(file, `${file}.bak`);
  writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
}

export function readDue() {
  const v = read(dueFile());
  return v && Array.isArray(v.plans) ? v : { generated_at: null, plans: [] };
}

export const writeDue = (obj) => write(dueFile(), obj);
export const readKept = () => read(keptFile()) ?? {};
export const writeKept = (obj) => write(keptFile(), obj);
