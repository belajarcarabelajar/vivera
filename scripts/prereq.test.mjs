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
// The validator runs on the real tree; its tier check exits first, but a throwaway HOME keeps the user's
// own HOME out of the run if that early exit were ever lost.
const throwawayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-prereq-home-'));
process.on('exit', () => fs.rmSync(throwawayHome, { recursive: true, force: true }));
const validatorEnv = (extra = {}) => ({ ...process.env, HOME: throwawayHome, ...extra });

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

  test('a row with only a tool name throws and names its 1-based line number', () => {
    const text = '# header\n\ngit\n';
    expect(() => parseTierTable(text)).toThrow(/line 3/);
  });

  test('a row with a tool and required_from but no loss is accepted with an empty loss', () => {
    expect(parseTierTable('git\tstandard\n')).toEqual([{ tool: 'git', from: 'standard', loss: '' }]);
    expect(parseTierTable('git\tstandard\t\n')).toEqual([{ tool: 'git', from: 'standard', loss: '' }]);
  });

  test('one normalization: BOM and CR dropped, blanks trimmed around each field, loss keeps a tab inside', () => {
    const text = '﻿  # indented comment\r\n \t\r\n\r\n﻿ git \t standard \t core\tsetup \r\n\tgh\tfull\tPR\r\nrtk\tnever\tx';
    expect(parseTierTable(text)).toEqual([
      { tool: 'git', from: 'standard', loss: 'core\tsetup' },
      { tool: 'gh', from: 'full', loss: 'PR' },
      { tool: 'rtk', from: 'never', loss: 'x' },
    ]);
  });

  test('an empty tool or empty required_from (a double tab) throws and names the line', () => {
    expect(() => parseTierTable('git\t\tx\n')).toThrow(/line 1/);
    expect(() => parseTierTable('# c\n\tstandard\tx\n')).toThrow(/line 2/);
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
      cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: validatorEnv(),
    });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain('bogus');
  }, 65_000);

  test('VIVERA_TIER=bogus exits 2 as well', () => {
    const r = spawnSync(process.execPath, [VALIDATOR], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: validatorEnv({ VIVERA_TIER: 'bogus' }),
    });
    expect(r.status).toBe(2);
  }, 65_000);
});

describe('validate-skill --tier=<x> (the equals form)', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [VALIDATOR, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: validatorEnv(env) });

  test('--tier=bogus exits 2 and names the value, like --tier bogus', () => {
    const r = run(['--tier=bogus']);
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain('bogus');
  }, 65_000);

  test('--tier= with nothing after it exits 2', () => {
    expect(run(['--tier=']).status).toBe(2);
  }, 65_000);

  // Without tgrep and gh on PATH, tier full prints the two errors and a lower tier records two SKIPs.
  // The run is cut off after a few seconds: the prerequisite lines come before any slow check.
  test('--tier=minimal is honored, not ignored: the missing tools become SKIPs, and --tier=full keeps the errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-tierflag-'));
    try {
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.mkdirSync(path.join(dir, 'home'));
      fs.symlinkSync(process.execPath, path.join(dir, 'bin', 'bun'));
      const cut = (tier) => {
        const r = spawnSync(path.join(dir, 'bin', 'bun'), [VALIDATOR, tier], {
          cwd: ROOT, encoding: 'utf8', timeout: 8000, env: { PATH: path.join(dir, 'bin'), HOME: path.join(dir, 'home') },
        });
        return `${r.stdout ?? ''}${r.stderr ?? ''}`;
      };
      const minimal = cut('--tier=minimal');
      expect(minimal).toContain('SKIPPED: prerequisite tgrep at tier minimal');
      expect(minimal).toContain('SKIPPED: prerequisite gh at tier minimal');
      expect(minimal).not.toContain('Prerequisite missing');
      const full = cut('--tier=full');
      expect(full).toContain('Prerequisite missing: tgrep');
      expect(full).toContain('Prerequisite missing: gh');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// The bash reader (scripts/install/prereq.sh, used by install.sh) and the JavaScript one
// (scripts/lib/prereq.mjs, used by validate-skill and the tests) read the same table, so they must give
// the same answer for it however it is damaged: the same tools required at each tier, or both refuse.
describe('the two tier-table readers agree', () => {
  const PREREQ_SH = path.join(ROOT, 'scripts', 'install', 'prereq.sh');
  const BASE = ['git\tstandard\tcore', 'bun\tstandard\tscripts', 'gh\tfull\tPR', 'tgrep\tfull\tsearch', 'rtk\tnever\tproxy'];
  const joined = (lines, eol = '\n', final = true) => lines.join(eol) + (final ? eol : '');
  const withRow = (row, at = 1) => joined([...BASE.slice(0, at), row, ...BASE.slice(at)]);

  // name -> [table text, true when both readers must refuse it]
  const VARIANTS = {
    plain: [joined(BASE), false],
    'empty file': ['', false],
    'comments only': ['# a\n  # b\n', false],
    'bare CR line': [withRow('\r'), false],
    'indented comment': [withRow('   # note'), false],
    'tab-indented comment': [withRow('\t# note'), false],
    'spaces-only line': [withRow('    '), false],
    'tab-only line': [withRow('\t\t'), false],
    'trailing space after required_from': [joined(['git\tstandard \tcore', ...BASE.slice(1)]), false],
    'trailing space after the tool name': [joined(['git \tstandard\tcore', ...BASE.slice(1)]), false],
    'spaces around every field': [joined(['  git  \t  standard  \t  core  ', ...BASE.slice(1)]), false],
    'BOM before a comment': [`﻿# header\n${joined(BASE)}`, false],
    'BOM before a row': [`﻿${joined(BASE)}`, false],
    'BOM before a row in the middle': [withRow('﻿newtool\tfull\tx'), false],
    'leading tab': [joined(['\tgit\tstandard\tcore', ...BASE.slice(1)]), false],
    'two columns, no loss': [joined(['git\tstandard', ...BASE.slice(1)]), false],
    'trailing tab, empty loss': [joined(['git\tstandard\t', ...BASE.slice(1)]), false],
    'a tab inside the loss': [joined(['git\tstandard\tcore\tsetup', ...BASE.slice(1)]), false],
    CRLF: [joined(BASE, '\r\n'), false],
    'CRLF with a BOM': [`﻿${joined(BASE, '\r\n')}`, false],
    'no final newline': [joined(BASE, '\n', false), false],
    'double tab': [joined(['git\t\tstandard\tcore', ...BASE.slice(1)]), true],
    'tool name only': [joined(['git', ...BASE.slice(1)]), true],
    'duplicate tool': [withRow('git\tfull\tagain', 3), true],
    'unknown required_from': [withRow('x\tsometimes\ty'), true],
    'required_from in the wrong case': [withRow('x\tStandard\ty'), true],
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-readers-'));
  afterEach(() => {});
  const files = {};
  let n = 0;
  for (const [name, [text]] of Object.entries(VARIANTS)) {
    files[name] = path.join(dir, `table-${n++}.tsv`);
    fs.writeFileSync(files[name], text);
  }

  // The stubs print what check_tier_prereqs would have acted on; nothing is looked up on the machine.
  const STUBS = 'check_prereq() { echo "required $1"; }; check_optional() { echo "optional $1"; }; . "$1"; check_tier_prereqs "$2" "$3"';
  function viaBash(file, tier) {
    const r = spawnSync('bash', ['-c', STUBS, '_', PREREQ_SH, tier, file], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  function viaJs(text, tier) {
    try {
      const rows = parseTierTable(text);
      const required = new Set(requiredAt(rows, tier));
      return rows.map((r) => `${required.has(r.tool) ? 'required' : 'optional'} ${r.tool}`);
    } catch {
      return 'error';
    }
  }

  for (const [name, [text, refused]] of Object.entries(VARIANTS)) {
    for (const tier of TIERS) {
      test(`${name}: both readers agree at ${tier}`, () => {
        const sh = viaBash(files[name], tier);
        const js = viaJs(text, tier);
        const shAnswer = sh.status === 0 ? sh.stdout.split('\n').filter(Boolean) : 'error';
        expect({ name, tier, sh: shAnswer }).toEqual({ name, tier, sh: js });
        expect({ name, tier, refused: js === 'error' }).toEqual({ name, tier, refused });
        if (refused) {
          // Refused before any tool was asked about, and with a message that names the table line.
          expect(sh.stdout).toBe('');
          expect(sh.status).toBe(1);
          expect(sh.stderr).toMatch(/line \d+/);
        }
      });
    }
  }

  test('the real table gives the same required set in both readers at every tier', () => {
    const real = path.join(ROOT, 'scripts', 'install', 'tiers.tsv');
    const text = fs.readFileSync(real, 'utf8');
    for (const tier of TIERS) {
      const sh = viaBash(real, tier);
      expect(sh.status).toBe(0);
      expect(sh.stdout.split('\n').filter(Boolean)).toEqual(viaJs(text, tier));
    }
  });

  test('the duplicate tool and the unknown required_from are named by their table line', () => {
    expect(viaBash(files['duplicate tool'], 'full').stderr).toMatch(/line 4.*git/);
    expect(viaBash(files['unknown required_from'], 'full').stderr).toMatch(/line 2.*sometimes/);
    expect(() => parseTierTable(VARIANTS['duplicate tool'][0])).toThrow(/line 4.*git/);
    expect(() => parseTierTable(VARIANTS['unknown required_from'][0])).toThrow(/line 2.*sometimes/);
  });

  test('cleanup', () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
