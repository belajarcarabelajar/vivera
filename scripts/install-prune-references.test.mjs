// scripts/install-prune-references.test.mjs
//
// A phase skill that leaves the checkout is pruned by `install.sh --update`. When that skill shipped a
// references/ directory, the installer placed it too (a link, or a managed copy), so the prune has to
// take it as well or the directory is never emptied. A copy the user edited stays.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './lib/install-sandbox.mjs';

const PHASE = 'sucp-zzz-gone';
const PHASE_REL = `.agents/skills/${PHASE}`;

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

// Installs a checkout that has an extra phase skill with references/, then removes that skill from
// the checkout, so the installed one is stale.
function staleWithReferences(installArgs) {
  const sb = makeSandbox({ tools: ['git', 'bun'] });
  open.push(sb);
  // Copy mode needs cmp and diff to judge a copy, and the sandbox PATH does not carry them by default.
  for (const tool of ['cmp', 'diff']) fs.symlinkSync(Bun.which(tool), path.join(sb.bin, tool));
  const src = path.join(sb.repo, 'skills', PHASE);
  put(path.join(src, 'SKILL.md'), '---\nname: sucp-zzz-gone\ndescription: fixture\n---\n# Gone\n');
  put(path.join(src, 'references', '01-x.md'), 'reference fixture\n');
  expect(sb.run([...installArgs, '--only', 'agents']).status).toBe(0);
  expect(fs.existsSync(path.join(sb.home, PHASE_REL, 'references', '01-x.md'))).toBe(true);
  fs.rmSync(src, { recursive: true });
  return sb;
}

describe('update prunes a stale phase skill together with its references', () => {
  test('link install: the references link goes and the phase directory is removed', () => {
    const sb = staleWithReferences([]);
    const r = sb.run(['--update', '--only', 'agents']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[PRUNED] ${path.join(sb.home, PHASE_REL)}\n`);
    expect(fs.lstatSync(path.join(sb.home, PHASE_REL), { throwIfNoEntry: false })).toBeUndefined();
  });

  test('copy install: the unedited references copy goes and the phase directory is removed', () => {
    const sb = staleWithReferences(['--copy']);
    const r = sb.run(['--copy', '--update', '--only', 'agents']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[PRUNED] ${path.join(sb.home, PHASE_REL)}\n`);
    expect(fs.lstatSync(path.join(sb.home, PHASE_REL), { throwIfNoEntry: false })).toBeUndefined();
  });

  test('copy install: an edited references copy stays, with the directory that holds it', () => {
    const sb = staleWithReferences(['--copy']);
    const edited = path.join(sb.home, PHASE_REL, 'references', '01-x.md');
    fs.writeFileSync(edited, 'my own notes\n');
    const r = sb.run(['--copy', '--update', '--only', 'agents']);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(edited, 'utf8')).toBe('my own notes\n');
  });
});
