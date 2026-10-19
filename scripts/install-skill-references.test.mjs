// scripts/install-skill-references.test.mjs
//
// A phase skill may keep its long sections in skills/<name>/references/*.md beside its SKILL.md. An
// installed phase skill must carry that directory, or the index it installs points at files that are
// not there. install.sh runs in the shared sandbox (scripts/lib/install-sandbox.mjs); install.ps1 runs
// against a small fake checkout and skips visibly when PowerShell is absent.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './lib/install-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = 'Super Ultra Code Plan Implementation.md';
const REF_TEXT = 'reference fixture\n';
const PHASE_REL = '.agents/skills/sucp-rules';

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function shSandbox() {
  const sb = makeSandbox({ tools: ['git', 'bun'] });
  open.push(sb);
  put(path.join(sb.repo, 'skills', 'sucp-rules', 'references', '01-x.md'), REF_TEXT);
  return sb;
}

describe('install.sh ships a phase skill references/ directory', () => {
  test('install places references/01-x.md in the profile', () => {
    const sb = shSandbox();
    const r = sb.run([]);
    expect(r.status).toBe(0);
    const placed = path.join(sb.home, PHASE_REL, 'references', '01-x.md');
    expect(fs.existsSync(placed)).toBe(true);
    expect(fs.readFileSync(placed, 'utf8')).toBe(REF_TEXT);
  });

  test('--check after an install is CURRENT and lists the references entry as ok', () => {
    const sb = shSandbox();
    expect(sb.run([]).status).toBe(0);
    const r = sb.run(['--check']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('check: CURRENT');
    expect(r.stdout).toContain(`[ok] ${path.join(sb.home, PHASE_REL, 'references')}`);
  });

  test('--check before an install reports the references entry as missing', () => {
    const sb = shSandbox();
    const r = sb.run(['--check']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`[missing] ${path.join(sb.home, PHASE_REL, 'references')}`);
  });

  test('--uninstall removes the references entry and the emptied phase dir', () => {
    const sb = shSandbox();
    expect(sb.run([]).status).toBe(0);
    expect(fs.existsSync(path.join(sb.home, PHASE_REL, 'references', '01-x.md'))).toBe(true);
    const r = sb.run(['--uninstall']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(sb.home, PHASE_REL, 'references'))).toBe(false);
    expect(fs.existsSync(path.join(sb.home, PHASE_REL))).toBe(false);
  });
});

const shell = process.env.PWSH ?? Bun.which('pwsh') ?? Bun.which('powershell');
if (!shell) console.log('install-skill-references.test: no PowerShell (PWSH, pwsh, powershell); the install.ps1 tests are skipped');

const bases = [];
afterAll(() => {
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true });
});

function psFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-ps1-refs-'));
  bases.push(base);
  const chk = path.join(base, 'chk');
  const home = path.join(base, 'h');
  put(path.join(chk, MASTER), 'master\n');
  put(path.join(chk, 'skills', 'sucp-a', 'SKILL.md'), 'skill a\n');
  put(path.join(chk, 'skills', 'sucp-a', 'references', '01-x.md'), REF_TEXT);
  put(path.join(chk, 'skills', 'sucp-b', 'SKILL.md'), 'skill b\n');
  put(path.join(chk, 'templates', 't.md'), 'template\n');
  put(path.join(chk, 'examples', 'e.md'), 'example\n');
  put(path.join(chk, 'mermaid.config.json'), '{}\n');
  put(path.join(chk, 'mermaid.dark.config.json'), '{"dark":true}\n');
  put(path.join(chk, '.claude', 'hooks', 'require-exit-code.mjs'), 'hook\n');
  fs.copyFileSync(path.join(ROOT, 'install.ps1'), path.join(chk, 'install.ps1'));
  const libDir = path.join(ROOT, 'scripts', 'install');
  for (const f of fs.readdirSync(libDir).filter((x) => /^windows-.*\.ps1$/.test(x))) {
    put(path.join(chk, 'scripts', 'install', f), fs.readFileSync(path.join(libDir, f), 'utf8'));
  }
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { base, home, ps1: path.join(chk, 'install.ps1'), skills: path.join(home, '.claude', 'skills') };
}

function psRun(fx, args) {
  const r = Bun.spawnSync([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fx.ps1, '-Only', 'claude', ...args], {
    cwd: fx.base,
    env: { ...process.env, USERPROFILE: fx.home, HOME: path.join(fx.base, 'pshome'), POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off', DOTNET_CLI_TELEMETRY_OPTOUT: '1', VIVERA_NOW: '20260101T000000Z' },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe.skipIf(!shell)('install.ps1 ships a phase skill references/ directory', () => {
  test('install places references/01-x.md and -Check is CURRENT', () => {
    const fx = psFixture();
    const inst = psRun(fx, []);
    expect({ code: inst.code, err: inst.err }).toEqual({ code: 0, err: '' });
    const placed = path.join(fx.skills, 'sucp-a', 'references', '01-x.md');
    expect(fs.existsSync(placed)).toBe(true);
    expect(fs.readFileSync(placed, 'utf8')).toBe(REF_TEXT);
    expect(fs.existsSync(path.join(fx.skills, 'sucp-b', 'references'))).toBe(false);
    const chk = psRun(fx, ['-Check']);
    expect({ code: chk.code, err: chk.err }).toEqual({ code: 0, err: '' });
    expect(chk.out).toContain('check: CURRENT');
  });
});
