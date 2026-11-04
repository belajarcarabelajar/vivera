import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCRIPTS = join(ROOT, 'scripts');

const DELETED = [
  'scripts/hooks/output-cap.mjs',
  'scripts/hooks/output-cap.test.mjs',
  'scripts/hooks/output-replace.mjs',
  'scripts/hooks/output-replace.test.mjs',
  'scripts/hooks/session-journal.mjs',
  'scripts/hooks/session-journal.test.mjs',
  'scripts/lib/hook-io.mjs',
  'scripts/lib/hook-io.test.mjs',
  'scripts/lib/context-hook-entries.mjs',
  'scripts/context-hooks-install.mjs',
  'scripts/context-hooks-install.test.mjs',
];

const EXCLUDED = new Set([
  'scripts/drop-context-hooks.test.mjs',
]);

// A whole string literal naming a deleted module, bare or repo-relative. Absolute
// paths inside command strings are left alone: settings-hooks.test.mjs uses them as
// arbitrary fixture commands for the graphify installer helpers.
const REF = /['"`](?:\.{1,2}\/)*(?:scripts\/)?(?:lib\/|hooks\/)?(?:(?:hook-io|context-hook-entries|context-hooks-install)(?:\.mjs)?|(?:output-cap|output-replace|session-journal)\.mjs)['"`]/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

describe('context hooks removal', () => {
  test.each(DELETED)('%s is gone', (path) => {
    expect(existsSync(join(ROOT, path))).toBe(false);
  });

  test('no file under scripts/ imports or names a deleted module', () => {
    const offenders = [];
    for (const file of walk(SCRIPTS)) {
      const rel = relative(ROOT, file);
      if (EXCLUDED.has(rel)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (REF.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('package.json has no context:hooks script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.scripts)).not.toContain('context:hooks');
  });
});
