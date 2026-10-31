// scripts/rule-audit.test.mjs
//
// The rule audit reads the rule handbook (docs/memory/*.md plus the Retired line in
// MEMORY.md) and the eval scenarios, and reports each rule's topic, first-seen date,
// cited repo paths that no longer exist, and the scenarios that link it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditRules } from './rule-audit.mjs';

const SCRIPT = path.join(import.meta.dir, 'rule-audit.mjs');
const row = (id, text) => `| ${id} | ${text} | s |`;
const topic = (...rows) => ['# T', '', '| # | Rule | Origin session |', '|---|---|---|', ...rows, ''].join('\n');

let root;

function write(rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-audit-'));
  write('scripts/present.mjs', '');
  write('docs/kept/.keep', '');
  write('docs/memory/gates.md', topic(
    row('L1', 'WHEN x → DO run `scripts/present.mjs` and read `docs/kept/`, NOT `scripts/gone.mjs`'),
    row('L2', 'WHEN y → DO `bun test` with `--json`, NOT z'),
  ));
  write('docs/memory/tools.md', topic(
    row('L3', 'WHEN a → DO read `docs/missing-dir/`, then `missing-dir/`, NOT b'),
    row('L6', 'WHEN e → DO read `build/out/`, `lib/helper.mjs` and `util/dup.mjs`, NOT f'),
  ));
  write('docs/memory/other-repositories.md', topic(row('L5', 'WHEN c → DO edit `apps/web/src/other.ts`, NOT d')));
  write('MEMORY.md', '# MEMORY.md\n\n| Topic | File | Rules |\n|---|---|---|\n\nRetired: L4\n');
  write('evals/scenarios/alpha.json', JSON.stringify({ id: 'alpha', rules: ['L1'] }));
  write('evals/scenarios/beta.json', JSON.stringify({ id: 'beta', rules: ['L1', 'L3'] }));
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Answers `git log ... -S "| L<n> |"` for L1 only, reports build/out/ as ignored, and lists
// tracked files where lib/helper.mjs has one suffix match and util/dup.mjs has two.
const TRACKED = 'scripts/present.mjs\nscripts/lib/helper.mjs\na/util/dup.mjs\nb/util/dup.mjs\n';
function stubGit(args) {
  if (args[0] === 'check-ignore') return args.includes('build/out/') ? 'build/out/\n' : null;
  if (args[0] === 'ls-files') return TRACKED;
  return args.includes('| L1 |') ? '2026-10-09\n2026-10-03\n' : '';
}

const byId = (report) => Object.fromEntries(report.rules.map((r) => [r.id, r]));

describe('auditRules', () => {
  test('a backticked repo path that does not exist is a missing path; existing ones and non-paths are not', () => {
    const r = byId(auditRules({ root, git: stubGit }));
    expect(r.L1.missingPaths).toEqual(['scripts/gone.mjs']);
    expect(r.L2.missingPaths).toEqual([]);
    expect(r.L3.missingPaths).toEqual(['docs/missing-dir/']);
  });

  test('a gitignored path and a path that is a suffix of tracked files are not missing', () => {
    expect(byId(auditRules({ root, git: stubGit })).L6.missingPaths).toEqual([]);
  });

  test('a short path that is the tail of a longer path in the same row is not checked on its own', () => {
    expect(byId(auditRules({ root, git: stubGit })).L3.missingPaths).toEqual(['docs/missing-dir/']);
  });

  test('without git, an ignored or suffix-resolved path counts as missing', () => {
    expect(byId(auditRules({ root, git: () => null })).L6.missingPaths)
      .toEqual(['build/out/', 'lib/helper.mjs', 'util/dup.mjs']);
  });

  test('rows in other-repositories.md skip the path check', () => {
    expect(byId(auditRules({ root, git: stubGit })).L5.missingPaths).toEqual([]);
  });

  test('each rule names its topic file', () => {
    const r = byId(auditRules({ root, git: stubGit }));
    expect(r.L1.topic).toBe('docs/memory/gates.md');
    expect(r.L5.topic).toBe('docs/memory/other-repositories.md');
  });

  test('firstSeen is the earliest date git reports, and unknown without history', () => {
    const r = byId(auditRules({ root, git: stubGit }));
    expect(r.L1.firstSeen).toBe('2026-10-03');
    expect(r.L2.firstSeen).toBe('unknown');
    expect(byId(auditRules({ root, git: () => null })).L1.firstSeen).toBe('unknown');
  });

  test('a scenario that lists a rule in its rules array links it', () => {
    const r = byId(auditRules({ root, git: stubGit }));
    expect(r.L1.scenarios).toEqual(['alpha', 'beta']);
    expect(r.L3.scenarios).toEqual(['beta']);
    expect(r.L2.scenarios).toEqual([]);
  });

  test('a retired ID is counted as retired and is not listed as a rule', () => {
    const report = auditRules({ root, git: stubGit });
    expect(report.rules.map((r) => r.id)).toEqual(['L1', 'L2', 'L3', 'L5', 'L6']);
    expect(report.totals).toEqual({ rules: 5, retired: 1, withScenario: 2, withMissingPath: 2 });
  });
});

function run(...args) {
  const p = Bun.spawnSync(['bun', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe('rule-audit CLI', () => {
  test('--json prints the rules and totals as JSON', () => {
    const { code, out } = run('--json', '--root', root);
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(Object.keys(data).sort()).toEqual(['rules', 'totals']);
    expect(Object.keys(data.rules[0]).sort()).toEqual(['firstSeen', 'id', 'missingPaths', 'scenarios', 'topic']);
    expect(data.totals.rules).toBe(5);
  });

  test('the table says "no scenario" for an unlinked rule, never "unused", and ends with the totals line', () => {
    const { code, out } = run('--root', root);
    expect(code).toBe(0);
    expect(out).toMatch(/L2\b.*no scenario/);
    expect(out).not.toMatch(/unused/i);
    expect(out.trim().split('\n').at(-1)).toBe('rules: 5, retired: 1, with a scenario: 2, with a missing path: 3');
  });

  test('an unknown flag or a --root without a value is a usage error, exit 2', () => {
    expect(run('--bogus').code).toBe(2);
    expect(run('--root').code).toBe(2);
  });

  test('a root without docs/memory exits 1', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-audit-empty-'));
    try {
      const { code, err } = run('--root', empty);
      expect(code).toBe(1);
      expect(err).toContain('E_PRECOND_INPUT');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('the audit writes no files', () => {
    const list = () => fs.readdirSync(root, { recursive: true }).sort();
    const before = list();
    run('--root', root);
    run('--json', '--root', root);
    expect(list()).toEqual(before);
  });
});
