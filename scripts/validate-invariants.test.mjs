import { test, expect, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyMermaidResult } from './validate-lib.mjs';
import { INVARIANTS, checkInvariants, listDocReferenceFiles } from './lib/skill-invariants.mjs';
import { MASTER_NAME, readSkillCorpus } from './skill-corpus.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const tmpRoot = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

describe('INVARIANTS', () => {
  const sample = INVARIANTS.find((i) => i.label === 'dismissal is not approval');

  test('each entry has a label and a sentence, and labels are unique', () => {
    expect(INVARIANTS.length).toBeGreaterThan(0);
    for (const inv of INVARIANTS) {
      expect(typeof inv.label).toBe('string');
      expect(typeof inv.text).toBe('string');
      expect(inv.text.length).toBeGreaterThan(5);
    }
    expect(new Set(INVARIANTS.map((i) => i.label)).size).toBe(INVARIANTS.length);
  });

  test('every invariant holds in the real skill corpus', () => {
    expect(checkInvariants(readSkillCorpus(ROOT))).toEqual([]);
  });

  test('an invariant is found after its sentence moves to a references file', () => {
    const root = tmpRoot('vivera-inv-');
    write(root, MASTER_NAME, '# orchestrator\n');
    write(root, 'skills/sucp-rules/SKILL.md', '# rules index\n');
    write(root, 'skills/sucp-rules/references/07-x.md', `Some prose. ${sample.text}. More prose.\n`);
    const missing = checkInvariants(readSkillCorpus(root), [sample]);
    fs.rmSync(root, { recursive: true, force: true });
    expect(missing).toEqual([]);
  });

  test('an invariant fails when its sentence is removed from every file', () => {
    const root = tmpRoot('vivera-inv-');
    write(root, MASTER_NAME, '# orchestrator\n');
    write(root, 'skills/sucp-rules/SKILL.md', '# rules index\n');
    write(root, 'skills/sucp-rules/references/07-x.md', 'The sentence is gone.\n');
    const missing = checkInvariants(readSkillCorpus(root), [sample]);
    fs.rmSync(root, { recursive: true, force: true });
    expect(missing).toEqual([sample]);
  });
});

describe('listDocReferenceFiles', () => {
  test('reads a symlinked SKILL.md once and never walks symlinked directories', () => {
    const root = tmpRoot('vivera-docfiles-');
    write(root, MASTER_NAME, '# master\n');
    write(root, 'templates/a.md', 'a\n');
    write(root, 'templates/sub/nested.md', 'not listed: templates is one level\n');
    write(root, 'snippets/s.md', 's\n');
    write(root, 'README.md', 'r\n');
    write(root, 'skills/one/SKILL.md', 'one\n');
    write(root, 'skills/one/references/r.md', 'r\n');
    fs.mkdirSync(path.join(root, 'skills', 'master'), { recursive: true });
    fs.symlinkSync(`../../${MASTER_NAME}`, path.join(root, 'skills', 'master', 'SKILL.md'));
    fs.symlinkSync('../../templates', path.join(root, 'skills', 'master', 'templates'));
    const files = listDocReferenceFiles(root);
    fs.rmSync(root, { recursive: true, force: true });
    expect(files).toEqual([
      'README.md',
      'skills/master/SKILL.md',
      'skills/one/SKILL.md',
      'skills/one/references/r.md',
      'snippets/s.md',
      'templates/a.md',
    ]);
  });
});

describe('classifyMermaidResult', () => {
  const titled = 'flowchart LR\n  accTitle: t\n  accDescr: d\n  A --> B';
  const wiredSvg = '<svg aria-labelledby="t" aria-describedby="d"><title id="t">t</title><desc id="d">d</desc></svg>';

  test('a rendered, titled, wired block is ok and cacheable', () => {
    expect(classifyMermaidResult({ result: { ok: true, svg: wiredSvg }, source: titled })).toEqual({ status: 'ok', cacheable: true });
  });

  test('a rendered block whose SVG lacks the wiring is not cacheable', () => {
    expect(classifyMermaidResult({ result: { ok: true, svg: '<svg></svg>' }, source: titled })).toEqual({ status: 'no-wiring', cacheable: false });
  });

  test('a failed render is invalid and not cacheable', () => {
    expect(classifyMermaidResult({ result: { ok: false, error: 'x' }, source: titled })).toEqual({ status: 'invalid', cacheable: false });
  });

  test('a cached block still gets the source-level a11y check', () => {
    expect(classifyMermaidResult({ result: { ok: true, cached: true }, source: 'flowchart LR\n  A --> B' })).toEqual({ status: 'no-a11y', cacheable: false });
    expect(classifyMermaidResult({ result: { ok: true, cached: true }, source: titled })).toEqual({ status: 'ok', cacheable: true });
  });
});

// The tree under test is the working tree: tracked files plus untracked ones not ignored.
const copyTrackedTree = (dest) => {
  const ls = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(ls.status, 0, `git ls-files failed: ${ls.stderr}`);
  const tar = spawnSync('tar', ['-C', ROOT, '--null', '-T', '-', '-cf', '-'], {
    input: ls.stdout, encoding: null, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(tar.status, 0, `tar of the tree failed: ${tar.stderr?.toString().slice(0, 300)}`);
  const untar = spawnSync('tar', ['-C', dest, '-xf', '-'], { input: tar.stdout, encoding: null });
  assert.equal(untar.status, 0, `untar into the fixture failed: ${untar.stderr?.toString().slice(0, 300)}`);
};

// A stub mmdc that exits 127 hides any global mmdc, so the render pass is skipped.
const runGateWithoutMmdc = (tree, noMmdc) => {
  const env = { ...process.env, PATH: `${noMmdc}${path.delimiter}${process.env.PATH}` };
  delete env.PLAN_ISSUES_CONFIG;
  const r = spawnSync('bun', [path.join(tree, 'scripts', 'validate-skill.mjs')], { cwd: tree, encoding: 'utf8', timeout: 180_000, env });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

test('the gate fails when an invariant sentence is deleted from every skill file, wherever it lived', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-invariant-'));
  const noMmdc = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-nommdc-'));
  try {
    copyTrackedTree(tmp);
    fs.writeFileSync(path.join(noMmdc, 'mmdc'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
    const sentence = 'A dismissed question is not an approval';
    const missing = `Skill invariant missing: dismissal is not approval: "${sentence}"`;
    const files = [
      'Super Ultra Code Plan Implementation.md',
      ...fs.readdirSync(path.join(tmp, 'skills'), { recursive: true })
        .filter((rel) => rel.endsWith('.md') && !rel.startsWith('super-ultra-code-plan'))
        .map((rel) => path.join('skills', rel)),
    ];
    const originals = new Map(files.map((rel) => [rel, fs.readFileSync(path.join(tmp, rel), 'utf8')]));
    assert.ok([...originals.values()].some((t) => t.includes(sentence)), 'the fixture must start with the sentence present');

    for (const [rel, text] of originals) fs.writeFileSync(path.join(tmp, rel), text.replaceAll(sentence, ''));
    const without = runGateWithoutMmdc(tmp, noMmdc);
    assert.equal(without.status, 1, `a corpus without the sentence must fail the gate\n${without.out.slice(-600)}`);
    assert.ok(without.out.includes(missing), `the failure must name the invariant\n${without.out.slice(-600)}`);

    for (const [rel, text] of originals) fs.writeFileSync(path.join(tmp, rel), text.replaceAll(sentence, ''));
    fs.appendFileSync(path.join(tmp, 'skills', 'sucp-rules', 'references', '09-anti-patterns.md'), `\n${sentence}.\n`);
    const moved = runGateWithoutMmdc(tmp, noMmdc);
    assert.ok(!moved.out.includes(missing), `the sentence in a references file must satisfy the invariant\n${moved.out.slice(-600)}`);
    assert.match(moved.out, /Skill invariants present/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(noMmdc, { recursive: true, force: true });
  }
});
