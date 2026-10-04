import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractFrontmatter, parseUltraPlanYaml, validatePlan } from './ultra-plan-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANS_DIR = path.join(ROOT, 'docs', 'code-plan', 'plans');

// The regression these lock.
//
// The first version of scripts/backfill-plan-impacts.mjs reported a file as
// having no consumer because its regex stripped `.mjs` from the stem and then
// required the closing quote immediately, so `from './plan-publish-frontmatter.mjs'`
// never matched. 83 of 127 tasks came back as the "checked, nothing found"
// sentinel. Every plan still VALIDATED, because a sentinel is a legal entry: the
// gate passed while most entries said nothing. That is the failure mode this
// whole key was built to avoid, reproduced inside the tool that fills it in.
//
// So the assertions below are about the SHAPE of the entries, not merely that
// the key exists.

const plans = () => (fs.existsSync(PLANS_DIR)
  ? fs.readdirSync(PLANS_DIR).filter((f) => f.endsWith('.md')).sort()
  : []);

test('every task in every local plan declares at least one impact', {
  skip: plans().length === 0
    ? 'docs/code-plan/plans is absent: it is gitignored machine-local storage, so a fresh clone carries none'
    : false,
}, () => {
  const warned = [];
  for (const f of plans()) {
    const { frontmatter } = extractFrontmatter(fs.readFileSync(path.join(PLANS_DIR, f), 'utf8'));
    const { warnings } = validatePlan(parseUltraPlanYaml(frontmatter), null);
    for (const w of warnings.filter((x) => /declare no impacts/.test(x))) warned.push(`${f}: ${w}`);
  }
  assert.deepEqual(warned, [], `these plans still leave tasks without an impact claim:\n${warned.join('\n')}`);
});

test('an impact entry that names a module names a REAL consumer of it', () => {
  // The assertion that would have caught the `.mjs` bug directly: every entry
  // claiming N consumers must have N importable files, not zero.
  if (plans().length === 0) return;
  const lying = [];
  for (const f of plans()) {
    const { frontmatter } = extractFrontmatter(fs.readFileSync(path.join(PLANS_DIR, f), 'utf8'));
    for (const t of parseUltraPlanYaml(frontmatter).tasks) {
      for (const entry of t.impacts ?? []) {
        const m = /^(scripts\/[^ ]+?) - (\d+) consumer/.exec(entry);
        if (!m) continue;
        const claimed = Number(m[2]);
        if (claimed === 0) continue; // an explicit zero is a different claim
        const stem = path.basename(m[1]).replace(/\.[cm]?js$/, '');
        let found = 0;
        for (const other of allJsFiles()) {
          if (other === m[1]) continue;
          const src = fs.readFileSync(path.join(ROOT, other), 'utf8');
          const re = new RegExp(`from\\s+['"][^'"]*${stem}\\.[cm]?js['"]`);
          if (re.test(src)) found++;
        }
        if (found !== claimed) lying.push(`${f} ${t.id}: claims ${claimed} consumer(s) of ${stem}, found ${found}`);
      }
    }
  }
  assert.deepEqual(lying, [], `consumer counts that do not survive a re-scan:\n${lying.join('\n')}`);
});

test('a backfilled entry is flow-style and its evidence names something checkable', () => {
  if (plans().length === 0) return;
  const weak = [];
  for (const f of plans()) {
    const { frontmatter } = extractFrontmatter(fs.readFileSync(path.join(PLANS_DIR, f), 'utf8'));
    for (const t of parseUltraPlanYaml(frontmatter).tasks) {
      for (const entry of t.impacts ?? []) {
        // Evidence is whatever runnable command the author cited. This deliberately
      // does NOT whitelist tools: an earlier version accepted `rg -n` only and
      // then `bun` only, and each time it rejected legitimate entries citing
      // `bun test …` and `snipset snippet expand`. A tool whitelist in a linter
      // is how the linter starts rejecting correct work.
      //
      // The shape is: a surface, an ASCII ` - ` separator, then the evidence.
      const parts = entry.split(' - ');
      const hasEvidence = parts.length >= 2 && parts[0].trim() !== '' && parts.slice(1).join(' - ').trim().length >= 8;
        if (!hasEvidence) weak.push(`${f} ${t.id}: ${entry.slice(0, 80)}`);
        // The separator is an ASCII hyphen, NOT an em dash: the format is
        // documented in the plan template that way, and an em dash would put a
        // U+2014 into a string the validator prints when a claim is rejected.
        if (entry.includes('—')) weak.push(`${f} ${t.id}: em dash in an impact entry: ${entry.slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(weak.slice(0, 5), [], `entries with no checkable evidence:\n${weak.join('\n')}`);
});

test('the sentinel is honest about what it checked', () => {
  if (plans().length === 0) return;
  const bad = [];
  for (const f of plans()) {
    const { frontmatter } = extractFrontmatter(fs.readFileSync(path.join(PLANS_DIR, f), 'utf8'));
    for (const t of parseUltraPlanYaml(frontmatter).tasks) {
      for (const entry of t.impacts ?? []) {
        if (!entry.startsWith('none:')) continue;
        // "none" without a command is the same false pass as an empty list.
        if (!/none: \S/.test(entry)) bad.push(`${f} ${t.id}: ${entry.slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(bad, [], `sentinels that name no command:\n${bad.join('\n')}`);
});

test('the backfill script is idempotent: a second run finds nothing to do', () => {
  // Idempotency is what makes it safe to point at a directory someone else is
  // also editing. A script that appends a second `impacts:` line on every run
  // would be a corruption tool.
  if (plans().length === 0) return;
  const script = path.join(ROOT, 'scripts', 'backfill-plan-impacts.mjs');
  const before = plans().map((f) => fs.readFileSync(path.join(PLANS_DIR, f), 'utf8'));
  const r = fs.existsSync(script)
    ? spawnSync('bun', [script, '--dry-run'], { cwd: ROOT, encoding: 'utf8' })
    : null;
  if (!r) return; // the script is deletable; its absence must not fail the suite
  assert.match(r.stdout + r.stderr, /0 task\(s\) across 0 plan\(s\) would change/,
    `a second dry run must find nothing to do, got:\n${r.stdout}${r.stderr}`);
  const after = plans().map((f) => fs.readFileSync(path.join(PLANS_DIR, f), 'utf8'));
  assert.deepEqual(after, before, 'a dry run must not touch a file');
});

function allJsFiles() {
  const out = [];
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (/\.[cm]?js$/.test(e.name)) out.push(r);
    }
  };
  walk(ROOT);
  return out;
}