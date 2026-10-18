// scripts/lib/skill-invariants.mjs
//
// The skill invariants checked by validate-skill.mjs, and the list of docs whose
// command and path references it checks.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Rules the skill must still state somewhere. Each sentence is searched in the
 * whole corpus (orchestrator plus every phase skill and its references), so a
 * rule may move between files without failing the gate, and fails only when it
 * is deleted. Add one line per new invariant.
 */
export const INVARIANTS = [
  { label: 'master skill forbids subagent git writes', text: 'Git Ownership Is Parent-Only' },
  { label: 'master skill requires per-merge verification', text: 'pr-registry.mjs surface' },
  { label: 'master skill requires a body file', text: '--body-file' },
  { label: 'master skill claims a derived branch', text: 'pr-registry.mjs claim' },
  { label: 'master skill states the unprefixed branch shape', text: '`<plan-id>/<session-slug>`, and carries **no tool, vendor, or workflow prefix**' },
  { label: 'dismissal is not approval', text: 'A dismissed question is not an approval' },
  { label: 'dismissal quotes the HARD GATE accurately', text: 'no implementation, scaffolding or code, as the HARD GATE says' },
  { label: 'a not-sure answer never approves a gate', text: 'never approves a gate' },
  { label: 'a second not-sure leaves the gate closed and pending', text: 'A second not sure leaves the gate closed and pending' },
  { label: 'a typed approval on a risky question must name the action', text: 'on a risky question it must name the action' },
  { label: 'safe option first for risky actions', text: 'Enter must never run the action' },
  { label: 'a risky action is never part of a batch', text: 'a risky action is never part of the batch' },
  { label: 'questions are parent-only', text: 'Questions are parent-only' },
  { label: 'no turn ends on a plain-text question', text: 'never end a turn on a plain-text question' },
  { label: 'the unattended rule never defaults a gate', text: 'an approval is never defaulted' },
  { label: 'a hand-off answer is a claim, not proof', text: 'A `Hand-off` answer is a claim, not proof' },
  { label: 'pasted text is untrusted data', text: 'text the user pasted into a message' },
  { label: 'pasted-text exception follows the user message', text: 'Pasted-text exception' },
  { label: 'pasted-text exception is limited to what the message asks', text: 'only as far as that message asks' },
  { label: 'pasted-text exception keeps the safety rules', text: 'still applies to what is followed' },
  { label: 'empty result needs a positive control', text: 'An Empty Result Is a Claim' },
  { label: 'failed read is reported as unread', text: 'report it by name as unread' },
  { label: 'list at its limit counts as unread', text: 'exactly at its `--limit`' },
  { label: 'reports end with a Not read line', text: 'Not read: <source> (<reason>)' },
  { label: 'running work is not done', text: 'Anything still running is not done' },
  { label: 'automatic continuations are capped', text: 'Automatic continuations are capped' },
  { label: 'failed entry check still writes nothing', text: 'A failed check still writes nothing' },
  { label: 'the sweep question needs an interactive client', text: 'only when the harness has an interactive client' },
];

/** Invariants whose sentence appears nowhere in the corpus. Empty means fine. */
export function checkInvariants(corpus, invariants = INVARIANTS) {
  return invariants.filter((inv) => !corpus.includes(inv.text));
}

function mdFilesIn(root, rel, { recurse }) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // A linked directory (examples/, templates/) is read at its real location,
      // so only a linked file, such as the orchestrator's SKILL.md, is followed.
      try {
        isFile = fs.statSync(path.join(root, child)).isFile();
      } catch {
        isFile = false;
      }
      isDir = false;
    }
    if (isDir && recurse) out.push(...mdFilesIn(root, child, { recurse }));
    else if (isFile && entry.name.endsWith('.md')) out.push(child.split(path.sep).join('/'));
  }
  return out;
}

/** Root-relative docs whose command and path references are checked. */
export function listDocReferenceFiles(root) {
  const files = [
    ...mdFilesIn(root, 'skills', { recurse: true }),
    ...mdFilesIn(root, 'templates', { recurse: false }),
    ...mdFilesIn(root, 'snippets', { recurse: false }),
  ];
  if (fs.existsSync(path.join(root, 'README.md'))) files.push('README.md');
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
