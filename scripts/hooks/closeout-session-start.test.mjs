// scripts/hooks/closeout-session-start.test.mjs
//
// Guards for the SessionStart hook that names landed plans the close-out loop
// last measured READY. The hook is spawned the way Claude Code runs it (one
// JSON object on stdin, context JSON on stdout) with VIVERA_CLOSEOUT_STATE
// pointed at a temp dir on every spawn, so the real cache is never read.

import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashOf } from '../lib/plan-issue-render.mjs';

const HOOK = path.join(import.meta.dir, 'closeout-session-start.mjs');
const VIVERA_ROOT = path.resolve(import.meta.dir, '..', '..');
const TAIL = `. \`bun ${VIVERA_ROOT}/scripts/plan-close-loop.mjs --due\` re-measures; the Close plan question lists them.`;
const tempDirs = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(tag) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `closeout-session-start-${tag}-`)));
  tempDirs.push(d);
  return d;
}

// The hook only walks up for .git, so a bare marker stands in for a repository.
function repo(tag, { gitFile = false } = {}) {
  const root = tempDir(tag);
  if (gitFile) writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  else mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'docs', 'code-plan', 'plans'), { recursive: true });
  mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true });
  return root;
}

function planFile(root, id, text = `---\nstatus: Approved\n---\n# ${id}\n`) {
  const file = path.join(root, 'docs', 'code-plan', 'plans', `${id}.md`);
  writeFileSync(file, text);
  return file;
}

// Mirrors readPlan in scripts/plan-close-loop.mjs: the hash --due caches is
// hashOf over the plan file read as utf8.
function entry(root, id, overrides = {}) {
  const file = planFile(root, id);
  return {
    plan: id, repo: root, file, hash: hashOf(readFileSync(file, 'utf8')),
    verdict: 'READY', asserted: 0, tickable: 1, pending_pr: null, ...overrides,
  };
}

function state({ plans, kept, dueRaw, keptRaw } = {}) {
  const dir = tempDir('state');
  if (dueRaw !== undefined) writeFileSync(path.join(dir, 'due.json'), dueRaw);
  else if (plans) writeFileSync(path.join(dir, 'due.json'), JSON.stringify({ generated_at: '2026-11-26T00:00:00Z', plans }));
  if (keptRaw !== undefined) writeFileSync(path.join(dir, 'kept-open.json'), keptRaw);
  else if (kept) writeFileSync(path.join(dir, 'kept-open.json'), JSON.stringify(kept));
  return dir;
}

function runHook(stdin, stateDir) {
  const r = Bun.spawnSync([process.execPath, HOOK], {
    stdin: Buffer.from(stdin),
    env: { ...process.env, VIVERA_CLOSEOUT_STATE: stateDir },
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const event = (name, cwd) => JSON.stringify({ hook_event_name: name, cwd, session_id: 'test-session' });

function contextFrom(r) {
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toMatch(/^[^\n]+\n?$/);
  const out = JSON.parse(r.stdout);
  expect(Object.keys(out)).toEqual(['hookSpecificOutput']);
  expect(Object.keys(out.hookSpecificOutput)).toEqual(['hookEventName', 'additionalContext']);
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
  const text = out.hookSpecificOutput.additionalContext;
  expect(text).not.toMatch(/\bmust\b|mandatory/i);
  expect(text).not.toContain(String.fromCodePoint(0x2014));
  expect(text).not.toContain('\n');
  return text;
}

function expectSilent(r) {
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('');
}

test('READY plans of the session repository are named in one line', () => {
  const root = repo('cwd');
  const dir = state({ plans: [entry(root, 'p-one'), entry(root, 'p-two')] });
  expect(contextFrom(runHook(event('SessionStart', root), dir)))
    .toBe(`closeout: 2 landed plan(s) measured READY: p-one, p-two${TAIL}`);
});

test('a cwd in a subdirectory resolves to the repository root', () => {
  const root = repo('subdir');
  const dir = state({ plans: [entry(root, 'p-sub')] });
  expect(contextFrom(runHook(event('SessionStart', path.join(root, 'sub', 'deeper')), dir)))
    .toBe(`closeout: 1 landed plan(s) measured READY: p-sub${TAIL}`);
});

test('a linked worktree whose .git is a file counts as the repository root', () => {
  const root = repo('wtfile', { gitFile: true });
  const dir = state({ plans: [entry(root, 'p-wt')] });
  expect(contextFrom(runHook(event('SessionStart', path.join(root, 'sub')), dir)))
    .toBe(`closeout: 1 landed plan(s) measured READY: p-wt${TAIL}`);
});

// Real git, so the .git file of the linked worktree has the shape git writes.
// Global and system config are cut off so a user hook or signing setting cannot break the fixture.
function git(cwd, ...args) {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

test('a linked worktree also matches READY plans of its main checkout', () => {
  const main = tempDir('wtmain');
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'init');
  mkdirSync(path.join(main, 'docs', 'code-plan', 'plans'), { recursive: true });
  const linked = path.join(tempDir('wtlinked'), 'wt');
  git(main, 'worktree', 'add', '-q', '--detach', linked);
  mkdirSync(path.join(linked, 'sub'));
  const dir = state({ plans: [entry(main, 'p-main'), entry(repo('wtother'), 'p-other')] });
  const want = `closeout: 1 landed plan(s) measured READY: p-main${TAIL}`;
  expect(contextFrom(runHook(event('SessionStart', linked), dir))).toBe(want);
  expect(contextFrom(runHook(event('SessionStart', path.join(linked, 'sub')), dir))).toBe(want);
});

test("another repository's plan is hidden, and with none left the hook is silent", () => {
  const mine = repo('mine');
  const other = repo('other');
  const dir = state({ plans: [entry(other, 'p-other'), entry(mine, 'p-mine')] });
  expect(contextFrom(runHook(event('SessionStart', mine), dir)))
    .toBe(`closeout: 1 landed plan(s) measured READY: p-mine${TAIL}`);
  const onlyOther = state({ plans: [entry(other, 'p-other2')] });
  expectSilent(runHook(event('SessionStart', mine), onlyOther));
});

test('a cwd inside the vivera checkout lists READY plans of every repository', () => {
  const a = repo('va');
  const b = repo('vb');
  const dir = state({ plans: [entry(a, 'p-a'), entry(b, 'p-b')] });
  const want = `closeout: 2 landed plan(s) measured READY: p-a, p-b${TAIL}`;
  expect(contextFrom(runHook(event('SessionStart', VIVERA_ROOT), dir))).toBe(want);
  expect(contextFrom(runHook(event('SessionStart', path.join(VIVERA_ROOT, 'scripts')), dir))).toBe(want);
});

// Only reachable from a linked worktree of vivera: the main checkout of that worktree counts as vivera too.
function viveraGitText() {
  try {
    return readFileSync(path.join(VIVERA_ROOT, '.git'), 'utf8');
  } catch {
    return '';
  }
}
test.skipIf(!/^gitdir: .+\/\.git\/worktrees\//.test(viveraGitText()))('the main checkout of the vivera worktree lists every repository', () => {
  const viveraMain = viveraGitText().match(/^gitdir: (.+)\/\.git\/worktrees\//)[1];
  const a = repo('vma');
  const b = repo('vmb');
  const dir = state({ plans: [entry(a, 'p-a'), entry(b, 'p-b')] });
  expect(contextFrom(runHook(event('SessionStart', viveraMain), dir)))
    .toBe(`closeout: 2 landed plan(s) measured READY: p-a, p-b${TAIL}`);
});

test('a sibling directory whose name starts with the vivera path is not vivera', () => {
  const a = repo('sib');
  const dir = state({ plans: [entry(a, 'p-sib')] });
  expectSilent(runHook(event('SessionStart', `${VIVERA_ROOT}-not-vivera`), dir));
});

test('only verdict READY counts', () => {
  const root = repo('verdicts');
  const plans = ['NOT-READY', 'NEEDS-HUMAN', 'NO-FILE', 'PR-OPEN', 'PR-STALE', 'UNREADABLE', null]
    .map((v, i) => entry(root, `p-${i}`, { verdict: v }));
  expectSilent(runHook(event('SessionStart', root), state({ plans })));
  plans.push(entry(root, 'p-ready'));
  expect(contextFrom(runHook(event('SessionStart', root), state({ plans }))))
    .toBe(`closeout: 1 landed plan(s) measured READY: p-ready${TAIL}`);
});

test('a plan whose file changed since the measurement is hidden as stale', () => {
  const root = repo('stale');
  const stale = entry(root, 'p-stale');
  writeFileSync(stale.file, '---\nstatus: Approved\n---\n# edited after --due\n');
  const dir = state({ plans: [stale, entry(root, 'p-fresh')] });
  expect(contextFrom(runHook(event('SessionStart', root), dir)))
    .toBe(`closeout: 1 landed plan(s) measured READY: p-fresh${TAIL}`);
});

test('a plan whose file is gone is hidden', () => {
  const root = repo('gone');
  const gone = entry(root, 'p-gone');
  rmSync(gone.file);
  expectSilent(runHook(event('SessionStart', root), state({ plans: [gone] })));
});

test('a plan kept open at the cached hash is hidden; kept at an older hash it is listed', () => {
  const root = repo('kept');
  const kept = entry(root, 'p-kept');
  const old = entry(root, 'p-old');
  const dir = state({
    plans: [kept, old],
    kept: { 'p-kept': { hash: kept.hash, at: '2026-11-26', reason: 'r' }, 'p-old': { hash: 'deadbeef', at: '2026-11-25', reason: 'r' } },
  });
  expect(contextFrom(runHook(event('SessionStart', root), dir)))
    .toBe(`closeout: 1 landed plan(s) measured READY: p-old${TAIL}`);
});

test('a corrupt kept-open.json on its own does not hide or break the note', () => {
  const root = repo('keptbad');
  const dir = state({ plans: [entry(root, 'p-k')], keptRaw: '{not json' });
  expect(contextFrom(runHook(event('SessionStart', root), dir)))
    .toBe(`closeout: 1 landed plan(s) measured READY: p-k${TAIL}`);
});

test('more than eight plans list the first eight and count the rest', () => {
  const root = repo('many');
  const plans = Array.from({ length: 11 }, (_, i) => entry(root, `p${i + 1}`));
  expect(contextFrom(runHook(event('SessionStart', root), state({ plans }))))
    .toBe(`closeout: 11 landed plan(s) measured READY: p1, p2, p3, p4, p5, p6, p7, p8, +3 more${TAIL}`);
});

test('a missing, empty, or corrupt cache prints nothing', () => {
  const root = repo('corrupt');
  const good = entry(root, 'p-good');
  expectSilent(runHook(event('SessionStart', root), tempDir('empty-state')));
  for (const dueRaw of ['', '{not json', 'null', '[]', '{"plans":{}}', '{"plans":[]}']) {
    expectSilent(runHook(event('SessionStart', root), state({ dueRaw })));
  }
  const bad = [null, 42, 'x', { ...good, file: 7 }, { ...good, hash: null }, { ...good, repo: [] }, { ...good, plan: {} }];
  expectSilent(runHook(event('SessionStart', root), state({ plans: bad })));
  expect(contextFrom(runHook(event('SessionStart', root), state({ plans: [...bad, good] }))))
    .toBe(`closeout: 1 landed plan(s) measured READY: p-good${TAIL}`);
});

test('SubagentStart and other events print nothing', () => {
  const root = repo('events');
  const dir = state({ plans: [entry(root, 'p-e')] });
  for (const name of ['SubagentStart', 'PreToolUse', 'Stop']) expectSilent(runHook(event(name, root), dir));
});

test('unreadable stdin or a missing, relative, or non-string cwd prints nothing', () => {
  const root = repo('stdin');
  const dir = state({ plans: [entry(root, 'p-s')] });
  for (const input of ['', '   \n', '{not json', 'null', '[]', '"SessionStart"', '42']) expectSilent(runHook(input, dir));
  expectSilent(runHook(JSON.stringify({ hook_event_name: 'SessionStart' }), dir));
  for (const cwd of [42, '', '.', 'sub']) expectSilent(runHook(event('SessionStart', cwd), dir));
});

test('a cwd outside any repository prints nothing', () => {
  const root = repo('outside');
  const dir = state({ plans: [entry(root, 'p-o')] });
  expectSilent(runHook(event('SessionStart', tempDir('plain')), dir));
});
