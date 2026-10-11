// scripts/install-check.test.mjs
//
// `install.sh --check`: a read-only report of every link the selected targets should have, one line
// per path ([ok], [missing], [stale], [dangling] or [foreign]) and a last line `check: CURRENT`
// (exit 0) or `check: N problem(s)` (exit 1). The banner and prerequisite lines print before it and
// are not asserted on. Every run uses the sandbox from scripts/lib/install-sandbox.mjs.

import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './lib/install-sandbox.mjs';

const MASTER = 'Super Ultra Code Plan Implementation.md';
const PKG = '.agents/skills/super-ultra-code-plan';
const LINE = /^\[(ok|missing|stale|dangling|foreign|skip)\] /;

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox(tools = ['git', 'bun']) {
  const sb = makeSandbox({ tools });
  open.push(sb);
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const link = (sb, target, rel) => {
  fs.mkdirSync(path.dirname(at(sb, rel)), { recursive: true });
  fs.symlinkSync(target, at(sb, rel));
};
const reportLines = (r) => r.stdout.split('\n').filter((l) => LINE.test(l));
const kinds = (r) => reportLines(r).map((l) => l.match(LINE)[1]);
const linkCount = (sb) => sb.snapshot().filter((l) => l.split('|')[1] === 'l').length;

test('check: after a normal install every link is [ok] and the run exits 0 with CURRENT', () => {
  const sb = sandbox();
  expect(sb.run([]).status).toBe(0);
  const links = linkCount(sb);
  expect(links).toBeGreaterThan(5);
  const r = sb.run(['--check']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('check: CURRENT');
  expect(kinds(r).filter((k) => k === 'ok').length).toBe(links);
  expect(kinds(r).every((k) => k === 'ok')).toBe(true);
});

test('check: on a bare HOME every link is [missing], the count is reported, and nothing is created', () => {
  const sb = sandbox();
  const r = sb.run(['--check']);
  expect(r.status).toBe(1);
  const found = kinds(r);
  expect(found.length).toBeGreaterThan(5);
  expect(found.every((k) => k === 'missing')).toBe(true);
  expect(r.stdout).toContain(`check: ${found.length} problem(s)`);
  expect(sb.snapshot()).toEqual([]);
});

test('check: a link into the old ai-skills repo is named [dangling], and a normal install makes it pass', () => {
  const sb = sandbox();
  const dest = at(sb, `${PKG}/SKILL.md`);
  const old = `/x/ai-skills/${MASTER}`;
  link(sb, old, `${PKG}/SKILL.md`);
  const r = sb.run(['--check']);
  expect(r.status).toBe(1);
  expect(r.stdout).toContain(`[dangling] ${dest} -> ${old} (expected ${path.join(sb.repo, MASTER)})`);

  expect(sb.run([]).status).toBe(0);
  const after = sb.run(['--check']);
  expect(after.status).toBe(0);
  expect(after.stdout).toContain('check: CURRENT');
});

test('check: a real file where a link belongs is [foreign] and says what --update would do', () => {
  const sb = sandbox();
  expect(sb.run([]).status).toBe(0);
  const dest = at(sb, `${PKG}/mermaid.config.json`);
  fs.rmSync(dest);
  fs.writeFileSync(dest, 'mine');
  const r = sb.run(['--check']);
  expect(r.status).toBe(1);
  expect(r.stdout).toContain(`[foreign] ${dest} (not a vivera link; --update would move it aside)`);
  expect(r.stdout).toContain('check: 1 problem(s)');
  expect(fs.readFileSync(dest, 'utf8')).toBe('mine');
});

test('check: a live link to somewhere else in this repo is [stale]', () => {
  const sb = sandbox();
  expect(sb.run([]).status).toBe(0);
  const dest = at(sb, `${PKG}/SKILL.md`);
  const other = path.join(sb.repo, 'package.json');
  fs.rmSync(dest);
  fs.symlinkSync(other, dest);
  const r = sb.run(['--check']);
  expect(r.status).toBe(1);
  expect(r.stdout).toContain(`[stale] ${dest} -> ${other} (expected ${path.join(sb.repo, MASTER)})`);
});

test('check: a correct link whose repo file is gone is [dangling] with its source missing', () => {
  const sb = sandbox();
  expect(sb.run([]).status).toBe(0);
  fs.rmSync(path.join(sb.repo, 'templates'), { recursive: true });
  const r = sb.run(['--check']);
  expect(r.status).toBe(1);
  expect(r.stdout).toContain(`[dangling] ${at(sb, `${PKG}/templates`)} (its source is missing)`);
  expect(r.stdout).toContain('check: 1 problem(s)');
});

test('check: it writes nothing, also when the home is read-only', () => {
  const sb = sandbox();
  const bare = sb.snapshot();
  expect(sb.run(['--check']).status).toBe(1);
  expect(sb.snapshot()).toEqual(bare);

  expect(sb.run([]).status).toBe(0);
  const installed = sb.snapshot();
  expect(sb.run(['--check']).status).toBe(0);
  expect(sb.snapshot()).toEqual(installed);

  const chmod = Bun.which('chmod');
  Bun.spawnSync([chmod, '-R', 'a-w', sb.home]);
  try {
    // Control: the home really is read-only now, so a write attempt below would have shown.
    expect(() => fs.writeFileSync(at(sb, 'probe'), 'x')).toThrow();
    const r = sb.run(['--check']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('check: CURRENT');
    expect(sb.snapshot()).toEqual(installed);
  } finally {
    Bun.spawnSync([chmod, '-R', 'u+w', sb.home]);
  }
});

test('check: --only claude checks just the Claude Code package and --skip agents leaves the agents package out', () => {
  const sb = sandbox();
  const only = sb.run(['--check', '--only', 'claude']);
  expect(only.status).toBe(1);
  const lines = reportLines(only);
  expect(lines.length).toBeGreaterThan(5);
  for (const l of lines) expect(l).toContain(`${sb.home}/.claude/skills/`);
  expect(only.stdout).not.toContain(`${sb.home}/.agents`);
  expect(only.stdout).not.toContain(`${sb.home}/.config/ai`);

  expect(sb.run([]).status).toBe(0);
  const skip = sb.run(['--check', '--skip', 'agents']);
  expect(skip.status).toBe(0);
  expect(skip.stdout).toContain('check: CURRENT');
  expect(skip.stdout).toContain(`${sb.home}/.config/ai/`);
  expect(skip.stdout).not.toContain(`${sb.home}/.agents`);
});

test('check: a target without skills is reported as skipped and is not a problem', () => {
  const sb = sandbox();
  const r = sb.run(['--check', '--only', 'codex']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('[skip] codex: no skills target');
  expect(r.stdout).toContain('check: CURRENT');
});

test('check: tier minimal works with no git and no bun on PATH', () => {
  const sb = sandbox([]);
  expect(sb.run(['--tier', 'minimal']).status).toBe(0);
  const r = sb.run(['--check', '--tier', 'minimal']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('check: CURRENT');
});

test('check: --dry-run is accepted and changes nothing about the report', () => {
  const sb = sandbox();
  expect(sb.run([]).status).toBe(0);
  fs.rmSync(path.join(sb.repo, 'examples'), { recursive: true });
  const plain = sb.run(['--check']);
  const dry = sb.run(['--check', '--dry-run']);
  expect(dry.status).toBe(plain.status);
  expect(dry.status).toBe(1);
  expect(reportLines(dry)).toEqual(reportLines(plain));
  expect(dry.stdout).toContain('check: 1 problem(s)');
});

test('check: a leftover backup file next to a correct link is not mentioned', () => {
  const sb = sandbox();
  expect(sb.run([]).status).toBe(0);
  fs.writeFileSync(at(sb, `${PKG}/SKILL.md.vivera-bak-20250101T000000Z`), 'old');
  const r = sb.run(['--check']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('check: CURRENT');
  expect(r.stdout).not.toContain('vivera-bak');
});
