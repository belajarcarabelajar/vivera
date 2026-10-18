// scripts/install-messages.test.mjs
//
// What install.sh SAYS, as a first-time user reads it: the closing line must not claim more than
// happened, the optional-tool warnings must match what the mode and tier ask for, a harness that is
// not detected is named once, a harness without a skills dir says what is done for it, graphify is
// warned about once, and a HOME that cannot be written fails with an installer line. Every run uses
// the sandbox from scripts/lib/install-sandbox.mjs (temp HOME, PATH of symlinks).

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './lib/install-sandbox.mjs';

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox(opts = { tools: ['git', 'bun'] }) {
  const sb = makeSandbox(opts);
  open.push(sb);
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const mkdir = (sb, rel) => fs.mkdirSync(at(sb, rel), { recursive: true });
const lines = (text) => text.split('\n');
const shim = (sb, name) => {
  const file = path.join(sb.bin, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
};

// Makes the home read-only for fn, then restores it, even when fn throws.
function readOnly(sb, fn) {
  const chmod = Bun.which('chmod');
  Bun.spawnSync([chmod, '-R', 'a-w', sb.home]);
  try {
    // Control: a write would fail here, so an unchanged snapshot means the installer wrote nothing.
    expect(() => fs.writeFileSync(at(sb, 'probe'), 'x')).toThrow();
    fn();
  } finally {
    Bun.spawnSync([chmod, '-R', 'u+w', sb.home]);
  }
}

const PLANTED = '==> Vivera farm planted: the Ultimate AI Coding Skill installation is complete!';
const UPDATED = '==> Vivera updated: links and rendered agents match this checkout';
const DRY_FINISH = '==> Dry run finished: nothing was written (run again without --dry-run to apply it)';
const nothingSelected = (verb) => `==> Nothing was selected: --only and --skip left no target, so no skills or sprite agents were ${verb}`;

describe('1: the closing line says what happened', () => {
  test('messages: a real install still ends with the planted line (control)', () => {
    const sb = sandbox();
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(lines(r.stdout.trim()).pop()).toBe(PLANTED);
  });

  test('messages: a dry run ends by saying it was a dry run and wrote nothing, never "planted"', () => {
    const sb = sandbox();
    const r = sb.run(['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Vivera farm planted');
    expect(r.stdout).not.toContain('installation is complete');
    expect(lines(r.stdout.trim()).pop()).toBe(DRY_FINISH);
    expect(sb.snapshot()).toEqual([]);
  });

  test('messages: an empty selection (--only agents --skip agents) says nothing was selected and still exits 0', () => {
    const sb = sandbox();
    const r = sb.run(['--only', 'agents', '--skip', 'agents']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Vivera farm planted');
    expect(lines(r.stdout.trim()).pop()).toBe(nothingSelected('installed'));
    expect(fs.existsSync(at(sb, '.agents'))).toBe(false);
  });

  test('messages: a dry run on a read-only HOME says it was a dry run, not "planted"', () => {
    const sb = sandbox();
    readOnly(sb, () => {
      const r = sb.run(['--dry-run']);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('Vivera farm planted');
      expect(lines(r.stdout.trim()).pop()).toBe(DRY_FINISH);
      expect(sb.snapshot()).toEqual([]);
    });
  });

  test('messages: --update says the same for a dry run and for an empty selection, and keeps its own line otherwise', () => {
    const sb = sandbox();
    const dry = sb.run(['--update', '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).not.toContain(UPDATED);
    expect(lines(dry.stdout.trim()).pop()).toBe(DRY_FINISH);
    expect(sb.snapshot()).toEqual([]);

    const none = sb.run(['--update', '--only', 'agents', '--skip', 'agents']);
    expect(none.status).toBe(0);
    expect(none.stdout).not.toContain(UPDATED);
    expect(lines(none.stdout.trim()).pop()).toBe(nothingSelected('updated'));

    const real = sb.run(['--update']);
    expect(real.status).toBe(0);
    expect(lines(real.stdout.trim()).pop()).toBe(UPDATED);
  });
});

describe('2: optional-tool warnings follow the tier and the mode', () => {
  const WARN = 'optional tool';

  test('messages: tier standard warns about the tools it lacks (control)', () => {
    const sb = sandbox();
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("optional tool 'tgrep' not found");
    expect(r.stderr).toContain("optional tool 'rtk' not found");
  });

  test('messages: tier minimal installs the skills and prints no optional-tool warning', () => {
    const sb = sandbox({ tools: [] });
    const r = sb.run(['--tier', 'minimal']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(WARN);
    expect(r.stderr).toBe('');
    // Positive control: the install really ran, so the empty stderr is not an early exit.
    expect(lines(r.stdout.trim()).pop()).toBe(PLANTED);
  });

  test('messages: --check and --uninstall print no optional-tool warning, whatever --tier says', () => {
    const sb = sandbox();
    expect(sb.run([]).status).toBe(0);
    for (const args of [['--check'], ['--uninstall', '--dry-run'], ['--check', '--tier', 'standard'], ['--uninstall']]) {
      const r = sb.run(args);
      expect({ args, warned: r.stderr.includes(WARN) }).toEqual({ args, warned: false });
    }
  });

  test('messages: --update keeps the tier it was given: minimal is quiet, standard warns', () => {
    const sb = sandbox();
    expect(sb.run(['--update', '--tier', 'minimal']).stderr).not.toContain(WARN);
    expect(sb.run(['--update']).stderr).toContain("optional tool 'tgrep' not found");
  });
});

describe('3: a harness that is not detected is named once', () => {
  const BARE =
    '[INFO] not detected, skipped: antigravity, antigravity-cli, antigravity-builtin, opencode, claude, codex, cursor, copilot (name one with --only to install anyway)';

  test('messages: a bare HOME names every undetected harness in one line, in a real run and a dry run', () => {
    const sb = sandbox();
    const dry = sb.run(['--dry-run']);
    expect(dry.status).toBe(0);
    expect(lines(dry.stdout).filter((l) => l.startsWith('[INFO] not detected'))).toEqual([BARE]);
    expect(sb.snapshot()).toEqual([]);

    const real = sb.run([]);
    expect(real.status).toBe(0);
    expect(lines(real.stdout).filter((l) => l.startsWith('[INFO] not detected'))).toEqual([BARE]);
  });

  test('messages: a detected harness is left out of the line', () => {
    const sb = sandbox();
    mkdir(sb, '.claude');
    mkdir(sb, '.codex');
    const r = sb.run(['--dry-run']);
    const line = lines(r.stdout).find((l) => l.startsWith('[INFO] not detected'));
    expect(line).toBe(
      '[INFO] not detected, skipped: antigravity, antigravity-cli, antigravity-builtin, opencode, cursor, copilot (name one with --only to install anyway)',
    );
  });

  test('messages: --only prints no such line, even for a harness that is absent', () => {
    const sb = sandbox();
    const r = sb.run(['--only', 'claude', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('not detected');
  });

  test('messages: a harness the user skipped is not reported as "not detected"', () => {
    const sb = sandbox();
    const r = sb.run(['--skip', 'claude,codex', '--dry-run']);
    const line = lines(r.stdout).find((l) => l.startsWith('[INFO] not detected'));
    expect(line).toContain('copilot');
    expect(line).not.toContain('claude');
    expect(line).not.toContain('codex');
  });

  test('messages: when every harness is detected there is no line', () => {
    const sb = sandbox();
    for (const dir of ['.gemini/antigravity-cli/builtin/skills', '.config/opencode', '.claude', '.codex', '.cursor', '.copilot']) mkdir(sb, dir);
    const r = sb.run(['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('not detected');
    // Positive control: the same run did reach every harness.
    expect(r.stdout).toContain('Would link');
  });

  test('messages: --update names them too', () => {
    const sb = sandbox();
    const r = sb.run(['--update', '--dry-run']);
    expect(r.stdout).toContain('[INFO] not detected, skipped: antigravity,');
  });
});

describe('4: a harness without a skills dir says what is done for it', () => {
  const WHY = 'no skills target of its own (its skills come from ~/.agents/skills)';

  for (const id of ['codex', 'cursor', 'copilot']) {
    test(`messages: --only ${id} says it installs its sprite agents only`, () => {
      const sb = sandbox();
      const r = sb.run(['--only', id]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`[INFO] ${id}: ${WHY}; installing its sprite agents only`);
      expect(r.stdout).not.toContain(`[SKIP] ${id}: its skills come from`);
      expect(fs.readdirSync(at(sb, `.${id}/agents`)).length).toBeGreaterThan(0);
    });
  }

  test('messages: in a dry run it says "would install", and at tier minimal it says nothing is installed', () => {
    const sb = sandbox();
    const dry = sb.run(['--only', 'codex', '--dry-run']);
    expect(dry.stdout).toContain(`[INFO] codex: ${WHY}; would install its sprite agents only`);
    expect(sb.snapshot()).toEqual([]);

    const minimal = sb.run(['--only', 'codex', '--tier', 'minimal']);
    expect(minimal.status).toBe(0);
    expect(minimal.stdout).toContain(`[INFO] codex: ${WHY}; no sprite agents at tier minimal, so nothing to install`);
    expect(fs.existsSync(at(sb, '.codex'))).toBe(false);
  });
});

describe('5: a missing graphify is warned about once', () => {
  const graphifyLines = (text) => lines(text).filter((l) => l.includes("optional tool 'graphify'"));

  test('messages: one line carries both consequences, in a real run and a dry run', () => {
    const sb = sandbox();
    for (const args of [[], ['--dry-run'], ['--update']]) {
      const r = sb.run(args);
      const found = graphifyLines(r.stderr);
      expect({ args, count: found.length }).toEqual({ args, count: 1 });
      expect(found[0]).toContain('knowledge-graph query');
      expect(found[0]).toContain('pre-commit graph refresh');
      expect(found[0]).toContain('size gate');
      expect(found[0]).not.toContain('skipping core.hooksPath');
    }
  });

  test('messages: with graphify present there is no graphify warning, and it is reported found (control)', () => {
    const sb = sandbox();
    shim(sb, 'graphify');
    const r = sb.run(['--dry-run']);
    expect(graphifyLines(r.stderr)).toEqual([]);
    expect(r.stdout).toContain('[OK] Optional tool found: graphify');
  });

  test('messages: graphify hooks hint appears once with graphify present, never without it', () => {
    const hintLines = (text) => lines(text).filter((l) => l.includes('graphify:hooks'));
    const sb = sandbox();

    const without = sb.run(['--dry-run']);
    expect(without.status).toBe(0);
    expect(hintLines(without.stdout + without.stderr)).toEqual([]);
    // Positive control: this run did reach install_hooks and took the missing-graphify branch.
    expect(graphifyLines(without.stderr)).toHaveLength(1);

    shim(sb, 'graphify');
    for (const args of [[], ['--dry-run'], ['--update']]) {
      const r = sb.run(args);
      expect({ args, status: r.status }).toEqual({ args, status: 0 });
      const found = hintLines(r.stdout + r.stderr);
      expect({ args, count: found.length }).toEqual({ args, count: 1 });
      expect(found[0]).toContain('bun run graphify:hooks --install');
      expect(found[0]).toContain('bun run graphify:hooks --uninstall');
    }
  });
});

describe('6: a HOME that cannot be written fails with an installer line', () => {
  test('messages: install, --copy and --update name the directory and the reason, write nothing, exit 1', () => {
    // Copy mode asks for cmp and diff before it touches the HOME, so they are on this PATH.
    const sb = sandbox({ tools: ['git', 'bun', 'cmp', 'diff'] });
    readOnly(sb, () => {
      for (const args of [[], ['--copy'], ['--update']]) {
        const r = sb.run(args);
        expect({ args, status: r.status }).toEqual({ args, status: 1 });
        expect(r.stderr).toContain(`[FAIL] cannot create ${at(sb, '.config/ai')}: Permission denied (is HOME writable?)`);
        expect({ args, bare: lines(r.stderr).some((l) => l.startsWith('mkdir:')) }).toEqual({ args, bare: false });
        expect(sb.snapshot()).toEqual([]);
      }
    });
  });
});

describe('7: a dry run names what the pre-commit hook does', () => {
  test('messages: the dry-run hook line names the blocking size gate before the graph refresh', () => {
    const sb = sandbox({ tools: ['git', 'bun'], git: true });
    const r = sb.run(['--dry-run']);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toContain(
      '[DRY-RUN]   - .githooks/pre-commit -> blocking file size gate on staged files, then non-blocking graphify update and graphify:sync',
    );
  });
});
