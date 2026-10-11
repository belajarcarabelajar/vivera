import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TIERS,
  parseTierTable,
  tierRank,
  requiredAt,
  checkPrereqs,
  hasTool,
  loadTierTable,
} from './lib/prereq.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate-skill.mjs');

const SAMPLE = [
  '# tool<TAB>required_from<TAB>capability lost',
  '',
  'git\tstandard\tcore setup',
  '   ',
  '# a comment between rows',
  'gh\tfull\tPR creation',
  'rtk\tnever\toutput proxy',
  '',
].join('\n');

describe('parseTierTable', () => {
  test('ignores comment lines and blank lines', () => {
    expect(parseTierTable(SAMPLE)).toEqual([
      { tool: 'git', from: 'standard', loss: 'core setup' },
      { tool: 'gh', from: 'full', loss: 'PR creation' },
      { tool: 'rtk', from: 'never', loss: 'output proxy' },
    ]);
  });

  test('a row with two columns throws and names its 1-based line number', () => {
    const text = '# header\n\ngit\tstandard\n';
    expect(() => parseTierTable(text)).toThrow(/line 3/);
  });

  test('an unknown required_from value throws and names the line', () => {
    const text = 'git\tstandard\tx\ngh\tsometimes\ty\n';
    expect(() => parseTierTable(text)).toThrow(/line 2.*sometimes/);
  });

  test('a duplicate tool throws and names the line of the second row', () => {
    const text = 'git\tstandard\tx\n# c\ngit\tfull\ty\n';
    expect(() => parseTierTable(text)).toThrow(/line 3.*git/);
  });
});

describe('tiers', () => {
  test('TIERS lists minimal, standard, full in order', () => {
    expect(TIERS).toEqual(['minimal', 'standard', 'full']);
  });

  test('tierRank orders the tiers and rejects an unknown one', () => {
    expect(TIERS.map(tierRank)).toEqual([0, 1, 2]);
    expect(() => tierRank('bogus')).toThrow(/bogus/);
  });

  test('requiredAt rejects an unknown tier', () => {
    expect(() => requiredAt(parseTierTable(SAMPLE), 'bogus')).toThrow(/bogus/);
  });

  test('a never tool is required at no tier, a full tool only at full', () => {
    const rows = parseTierTable(SAMPLE);
    expect(requiredAt(rows, 'full')).toEqual(['git', 'gh']);
    expect(requiredAt(rows, 'standard')).toEqual(['git']);
  });
});

describe('the real tier table', () => {
  const rows = loadTierTable();

  test('loadTierTable reads scripts/install/tiers.tsv with all nine tools', () => {
    expect(rows.map((r) => r.tool)).toEqual([
      'git', 'bun', 'gh', 'tgrep', 'graphify', 'rtk', 'context-mode', 'opencode', 'snipset',
    ]);
    expect(rows.every((r) => r.loss.length > 0)).toBe(true);
  });

  test('minimal requires nothing, standard git and bun, full also gh and tgrep', () => {
    expect(requiredAt(rows, 'minimal')).toEqual([]);
    expect(requiredAt(rows, 'standard')).toEqual(['git', 'bun']);
    expect(requiredAt(rows, 'full')).toEqual(['git', 'bun', 'gh', 'tgrep']);
  });

  test('the full-tier set is what validate-skill treats as mandatory', () => {
    const validator = fs.readFileSync(VALIDATOR, 'utf8');
    for (const tool of ['tgrep', 'gh']) {
      expect(validator).toContain(`'${tool}'`);
    }
    expect(new Set(requiredAt(rows, 'full'))).toEqual(new Set(['git', 'bun', 'gh', 'tgrep']));
  });
});

describe('checkPrereqs', () => {
  const rows = loadTierTable();
  const allButGh = (tool) => (tool === 'gh' ? null : `${tool} 1.0.0`);

  test('at full a missing required tool is one error naming it, no warning', () => {
    const { errors, warnings } = checkPrereqs({ tier: 'full', rows, has: allButGh });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('gh');
    expect(warnings).toEqual([]);
  });

  test('at standard the same missing tool is a warning naming the lost capability', () => {
    const { errors, warnings } = checkPrereqs({ tier: 'standard', rows, has: allButGh });
    expect(errors).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('gh');
    expect(warnings[0]).toContain('plan issue sync and PR creation');
  });

  test('a missing never tool is a warning at every tier, never an error', () => {
    for (const tier of TIERS) {
      const { errors, warnings } = checkPrereqs({
        tier, rows, has: (tool) => (tool === 'snipset' ? null : `${tool} 1.0.0`),
      });
      expect(errors).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('snipset');
    }
  });

  test('every tool present gives no errors and no warnings', () => {
    expect(checkPrereqs({ tier: 'full', rows, has: (t) => `${t} 1.0.0` })).toEqual({ errors: [], warnings: [] });
  });

  test('minimal with nothing installed has no errors', () => {
    const { errors } = checkPrereqs({ tier: 'minimal', rows, has: () => null });
    expect(errors).toEqual([]);
  });
});

describe('hasTool', () => {
  const realHome = process.env.HOME;
  const made = [];
  afterEach(() => {
    process.env.HOME = realHome;
    while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
  });

  const fakeHome = (relDir, name, body) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-prereq-'));
    made.push(home);
    const dir = path.join(home, relDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
    return home;
  };

  test('returns the first line of --version output for a tool on PATH', () => {
    const out = hasTool('bun');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('\n');
  });

  test('returns null for a tool that exists nowhere', () => {
    expect(hasTool('vivera-no-such-tool-zz')).toBeNull();
  });

  test('falls back to $HOME/.local/bin', () => {
    process.env.HOME = fakeHome('.local/bin', 'vivera-fake-a', '#!/bin/sh\necho "fake-a 1.2.3"\necho second\n');
    expect(hasTool('vivera-fake-a')).toBe('fake-a 1.2.3');
  });

  test('falls back to $HOME/.bun/bin', () => {
    process.env.HOME = fakeHome('.bun/bin', 'vivera-fake-b', '#!/bin/sh\necho "fake-b 4.5.6"\n');
    expect(hasTool('vivera-fake-b')).toBe('fake-b 4.5.6');
  });

  test('a tool whose --version exits non-zero counts as missing', () => {
    process.env.HOME = fakeHome('.local/bin', 'vivera-fake-c', '#!/bin/sh\necho broken\nexit 1\n');
    expect(hasTool('vivera-fake-c')).toBeNull();
  });
});

describe('validate-skill tier flag', () => {
  // The tier is validated at the top of the prerequisite block, before any of
  // the slow Mermaid gates, so a bad value must exit 2 within seconds.
  test('--tier bogus exits 2 and names the value', () => {
    const r = spawnSync(process.execPath, [VALIDATOR, '--tier', 'bogus'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain('bogus');
  }, 65_000);

  test('VIVERA_TIER=bogus exits 2 as well', () => {
    const r = spawnSync(process.execPath, [VALIDATOR], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, VIVERA_TIER: 'bogus' },
    });
    expect(r.status).toBe(2);
  }, 65_000);
});
