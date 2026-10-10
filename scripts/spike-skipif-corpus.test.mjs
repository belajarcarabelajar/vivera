import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import * as corpusModule from './spike-skipif-corpus.mjs';
import {
  normalizeCmd, stableId, buildCorpus, balanceOf, resolveVault, collect, planFiles,
} from './spike-skipif-corpus.mjs';
import { classifySpikeSkipIf } from './spike-skipif-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'spike-skipif-corpus.mjs');

// The CLI tests below harvest the real vault; the hermetic ones above build
// their own rows. Without a vault `collect()` fails closed with
// `E_PRECOND_VAULT`, and a suite that reported that as a red test would be
// reporting "this host has no vault" as a corpus defect. The min-rows test is
// the sharpest case: it asserts exit 1 with `/E_PRECOND/`, which the missing
// vault satisfies for the wrong reason. All three are skipped, with the reason,
// when the vault is absent — the same convention the vault-live tests use in
// vault-index.test.mjs. Set `OBSIDIAN_VAULT` to point them at a vault elsewhere.
const VAULT = resolveVault();
const live = fs.existsSync(VAULT) ? test : test.skip;

test('normalizeCmd collapses whitespace but never reorders segments', () => {
  assert.equal(normalizeCmd('  bun   test    scripts/  '), 'bun test scripts/');
  // Collapsing must not merge two different commands. If it did, two distinct
  // actions would collapse into one row and the agreement metric in T4 would
  // silently gain a point it never earned.
  assert.notEqual(normalizeCmd('git commit -m "a"'), normalizeCmd('git commit -am "a"'));
});

test('normalizeCmd turns every non-string or blank input into empty', () => {
  for (const bad of ['', '   ', undefined, null, 42, {}, []]) {
    assert.equal(normalizeCmd(bad), '', `input ${JSON.stringify(bad)} should normalize to empty`);
  }
});

test('stableId is deterministic and content-addressed', () => {
  const a = stableId('bun test scripts/');
  assert.equal(a, stableId('bun test scripts/'));
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, stableId('git push origin main'));
});

test('buildCorpus dedupes on the normalized command and keeps first source', () => {
  const rows = [
    { cmd: 'bun test scripts/', source: 'a.md' },
    { cmd: 'bun  test  scripts/', source: 'b.md' },
    { cmd: 'git push origin main', source: 'c.md' },
    { cmd: '', source: 'd.md' },
  ];
  const corpus = buildCorpus(rows);
  assert.equal(corpus.length, 2, 'the blank command must be dropped');
  const bun = corpus.find((r) => r.cmd === 'bun test scripts/');
  assert.equal(bun.source, 'a.md', 'first source wins so the row is read-order independent');
});

test('buildCorpus attaches the classifySpikeSkipIf label to every row', () => {
  const corpus = buildCorpus([
    { cmd: 'bun test scripts/x.test.mjs', source: 'a.md' },
    { cmd: "grep -q 'Marker' src/x.md", source: 'b.md' },
  ]);
  const labels = corpus.map((r) => r.label).sort();
  assert.deepEqual(labels, ['behavioural', 'loose']);
  // The label must come from the frozen snapshot, not from a copy of it.
  for (const row of corpus) assert.equal(row.label, classifySpikeSkipIf(row.cmd));
});

test('buildCorpus sorts by stable id so a re-run is byte-identical', () => {
  const corpus = buildCorpus([
    { cmd: 'zzz command', source: 'a' },
    { cmd: 'aaa command', source: 'b' },
  ]);
  const ids = corpus.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort());
});

test('balanceOf reports both classes, and the count of rows', () => {
  const corpus = buildCorpus([
    { cmd: 'bun test a', source: 'a' },
    { cmd: 'git status', source: 'b' },
    { cmd: "grep -q 'x' f.md", source: 'c' },
  ]);
  const b = balanceOf(corpus);
  assert.equal(b.total, 3);
  assert.equal(b.behavioural + b.loose, b.total, 'every row must carry exactly one of the two labels');
  assert.ok(b.behavioural > 0 && b.loose > 0);
});

test('balanceOf flags a degenerate corpus so the CLI can refuse it', () => {
  const oneClass = buildCorpus([
    { cmd: 'bun test a', source: 'a' },
    { cmd: 'git status', source: 'b' },
  ]);
  assert.equal(balanceOf(oneClass).degenerate, true, 'a single-class corpus cannot measure calibration');
});

// A fixture vault whose mirrors no longer carry the runner contract, the shape
// the publisher has written since #45. `collect()` also reads this checkout's
// own plans directory, so assertions check for fixture commands, not totals.
function planMd(fields, cmds) {
  const lines = ['---', 'schema: ultra-plan/v1', ...fields];
  if (cmds.length > 0) {
    lines.push('tasks:', '  - id: T1', '    run:');
    for (const cmd of cmds) lines.push(`      - cmd: "${cmd}"`);
  }
  lines.push('---', '', '# fixture', '');
  return lines.join('\n');
}

function fixtureVault() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skipif-corpus-'));
  const vault = path.join(tmp, 'vault');
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src, { recursive: true });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const sourceA = path.join(src, 'plan-a.md');
  write(sourceA, planMd([], ['bun test fixture/only-in-source-a.test.mjs']));
  const legacySource = path.join(src, 'legacy-source.md');
  write(legacySource, planMd([], ['bun test fixture/legacy-source-must-not-be-read.test.mjs']));
  const missing = path.join(src, 'not-on-this-host.md');
  const mirror = (project, name, fields, cmds = []) =>
    write(path.join(vault, '01 - Projects', project, 'plans', name), planMd(fields, cmds));
  mirror('fixproj', 'a.md', [`source_path: "${sourceA}"`]);
  mirror('fixproj', 'legacy.md', [`source_path: "${legacySource}"`], ['bun test fixture/legacy-mirror.test.mjs']);
  mirror('fixproj', 'missing.md', [`source_path: "${missing}"`]);
  mirror('fixproj2', 'a-again.md', [`source_path: "${sourceA}"`]);
  return { tmp, vault, sourceA };
}

function captureStderr(fn) {
  const original = process.stderr.write;
  let text = '';
  process.stderr.write = (chunk) => {
    text += String(chunk);
    return true;
  };
  try {
    return { value: fn(), stderr: text };
  } finally {
    process.stderr.write = original;
  }
}

test('collect follows source_path when the mirror carries no tasks', () => {
  const fx = fixtureVault();
  try {
    const { value: corpus } = captureStderr(() => collect(fx.vault));
    const row = corpus.find((r) => r.cmd === 'bun test fixture/only-in-source-a.test.mjs');
    assert.ok(row, 'the run command held only by the source plan must be harvested');
    assert.equal(row.project, 'fixproj', 'attribution keeps the mirror project name');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('collect reports a mirror whose source_path is missing and keeps harvesting', () => {
  const fx = fixtureVault();
  try {
    const { value: corpus, stderr } = captureStderr(() => collect(fx.vault));
    assert.match(stderr, /1 vault mirror\(s\) unread: source plan not on this host/);
    assert.match(stderr, /missing\.md/, 'the unread mirror is named, not only counted');
    assert.ok(corpus.some((r) => r.cmd === 'bun test fixture/only-in-source-a.test.mjs'));
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('collect still reads a legacy mirror that carries tasks itself', () => {
  const fx = fixtureVault();
  try {
    const { value: corpus } = captureStderr(() => collect(fx.vault));
    assert.ok(corpus.some((r) => r.cmd === 'bun test fixture/legacy-mirror.test.mjs'));
    assert.ok(
      !corpus.some((r) => r.cmd === 'bun test fixture/legacy-source-must-not-be-read.test.mjs'),
      'a mirror with its own tasks is the contract; its source_path is not followed',
    );
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('planFiles lists a source plan once when two mirrors point at it', () => {
  const fx = fixtureVault();
  try {
    const { files, unread } = planFiles(fx.vault);
    const hits = files.filter((f) => path.resolve(f.file) === path.resolve(fx.sourceA));
    assert.equal(hits.length, 1, 'each resolved file is read once');
    assert.equal(hits[0].project, 'fixproj', 'the first mirror in sorted order wins attribution');
    assert.deepEqual(unread.map((u) => path.basename(u.mirror)), ['missing.md']);
    const resolved = files.map((f) => path.resolve(f.file));
    assert.equal(new Set(resolved).size, resolved.length, 'no file appears twice, own plans included');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('planFiles reads a plan once when it is reached through a mirror and the own plans directory', () => {
  const fx = fixtureVault();
  const ownDir = path.dirname(fx.sourceA);
  const onlyOwn = path.join(ownDir, 'only-own.md');
  fs.writeFileSync(onlyOwn, planMd([], ['bun test fixture/only-own.test.mjs']));
  try {
    const { files } = planFiles(fx.vault, ownDir);
    const hitsA = files.filter((f) => path.resolve(f.file) === path.resolve(fx.sourceA));
    assert.equal(hitsA.length, 1, 'reached both ways, read once');
    assert.equal(hitsA[0].project, 'fixproj', 'the mirror reaches it first and keeps attribution');
    const own = files.filter((f) => path.resolve(f.file) === path.resolve(onlyOwn));
    assert.equal(own.length, 1, 'a plan only in the own directory is still read');
    assert.equal(own[0].project, 'vivera');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

live('the CLI harvests the vault and reports a balanced corpus', () => {
  const r = spawnSync('bun', [CLI, '--stats'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const stats = JSON.parse(r.stdout);
  assert.ok(stats.total >= 150, `only ${stats.total} rows; the spike precondition requires at least 150`);
  assert.equal(stats.degenerate, false, 'the harvested corpus is single-class, so calibration is unmeasurable');
  assert.ok(stats.behavioural > 0 && stats.loose > 0);
});

live('the CLI writes valid JSON, one row per unique command, sorted by id', () => {
  const out = path.join(ROOT, 'spike-out', 'corpus.test.json');
  const r = spawnSync('bun', [CLI, '--out', out], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(rows.length >= 150);
  assert.equal(new Set(rows.map((x) => x.cmd)).size, rows.length, 'the corpus must contain no duplicate command');
  const ids = rows.map((x) => x.id);
  assert.deepEqual(ids, [...ids].sort(), 'rows must be sorted by id for a reproducible file');
  for (const row of rows) {
    assert.equal(typeof row.id, 'string');
    assert.equal(typeof row.cmd, 'string');
    assert.ok(['behavioural', 'loose'].includes(row.label), `unexpected label ${row.label}`);
    assert.equal(row.label, classifySpikeSkipIf(row.cmd), 'the label must agree with the frozen classifier snapshot');
    assert.equal(typeof row.source, 'string');
    assert.equal(typeof row.project, 'string');
  }
  fs.rmSync(out, { force: true });
});

live('the CLI exits non-zero on a degenerate corpus rather than emitting it', () => {
  // The negative control. T1's E_PRECOND_IMBALANCE guard only means something
  // if it can actually fail, and v1 shipped a 77-row corpus that cleared its
  // size threshold while measuring nothing.
  const r = spawnSync('bun', [CLI, '--min-rows', '100000'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1, 'an unmeetable size precondition must fail closed');
  assert.match(r.stderr, /E_PRECOND/);
});

// The frozen record is gitignored evidence that git cannot restore, so every
// test below points the guard at a fixture and never at spike-out/.
function frozenFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-corpus-'));
  const frozen = path.join(dir, 'corpus.json');
  fs.writeFileSync(frozen, '["frozen"]\n');
  return { dir, frozen };
}

test('frozenCorpusRefusal refuses only an existing frozen target', () => {
  const fx = frozenFixture();
  try {
    const refuse = corpusModule.frozenCorpusRefusal;
    assert.equal(typeof refuse, 'function', 'frozenCorpusRefusal is exported');
    assert.match(refuse(fx.frozen, fx.frozen), /frozen/);
    assert.match(refuse(fx.frozen, fx.frozen), /--out/);
    assert.equal(refuse(path.join(fx.dir, 'other.json'), fx.frozen), null);
    assert.equal(refuse(path.join(fx.dir, 'gone.json'), path.join(fx.dir, 'gone.json')), null);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

live('the CLI refuses to overwrite the frozen corpus and leaves it byte-identical', () => {
  const fx = frozenFixture();
  try {
    const env = { ...process.env, SPIKE_CORPUS_FROZEN_PATH: fx.frozen };
    const r = spawnSync('bun', [CLI, '--out', fx.frozen], { cwd: ROOT, encoding: 'utf8', env });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /frozen/);
    assert.equal(fs.readFileSync(fx.frozen, 'utf8'), '["frozen"]\n');
    const other = path.join(fx.dir, 'fresh.json');
    const w = spawnSync('bun', [CLI, '--out', other], { cwd: ROOT, encoding: 'utf8', env });
    assert.equal(w.status, 0, w.stdout + w.stderr);
    assert.ok(JSON.parse(fs.readFileSync(other, 'utf8')).length >= 150);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
