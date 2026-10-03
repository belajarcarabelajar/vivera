#!/usr/bin/env node
// Spike T1 — extract and label the skip_if corpus.
//
// Every `run[].cmd` this workspace's plans declare is a command a person wrote
// and believed was runnable. Labelling each one with the frozen
// `classifySpikeSkipIf` gives a reference label that was already in production
// and already unit-tested when this corpus was recorded, so the probe in T4
// compares a model against a fact rather than against another opinion.
//
// The classifier is imported from `./spike-skipif-classifier.mjs`, NOT from
// `./ultra-plan-runner.mjs`. The live `classifySkipIf` is changing — it gains
// `sentinel` and `unknown`, and its `FILE_PROBE` widens — and every one of those
// changes makes rows of this corpus stale. The committed 200-row corpus and
// the published 0.995 are the record of one classifier; re-importing the live
// one would silently point the record at a different thing.
//
// The YAML subset is parsed by importing the runner's own parser. A second
// parser in this repository would be a second answer to "what does a plan say",
// and the two would eventually disagree. That parser is the right thing to keep
// importing even while the classifier is frozen separately — the freeze is about
// one function, not about the runner.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractFrontmatter, parseUltraPlanYaml } from './ultra-plan-runner.mjs';
import { classifySpikeSkipIf } from './spike-skipif-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_VAULT = path.join(process.env.HOME || '', 'Dokumen', 'Obsidian Vault');

/**
 * The vault to harvest, honouring the `OBSIDIAN_VAULT` seam.
 *
 * One resolver rather than a `process.env.OBSIDIAN_VAULT || DEFAULT_VAULT`
 * scattered through the file: the test file has to ask the same question the
 * CLI answers, and a second copy of the expression is how the two drift apart.
 * The seam also lets the test decide, without spawning the CLI, whether the
 * vault this module needs is present on the current host at all.
 */
export function resolveVault() {
  return process.env.OBSIDIAN_VAULT || DEFAULT_VAULT;
}

// `empty` is a third classifySpikeSkipIf return, but it only fires on a blank or
// non-string command. Those rows are dropped during normalisation, so a
// harvested corpus is necessarily two-class. Labelling it as anything else
// would invent a class with no examples to measure.
export const LABELS = ['behavioural', 'loose'];

export function normalizeCmd(cmd) {
  if (typeof cmd !== 'string') return '';
  return cmd.trim().replace(/\s+/g, ' ');
}

export function stableId(normalized) {
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}

export function buildCorpus(rows) {
  const byCmd = new Map();
  for (const row of rows) {
    const cmd = normalizeCmd(row.cmd);
    if (cmd === '') continue;
    // First source wins, so the row does not depend on directory read order.
    if (!byCmd.has(cmd)) {
      const label = classifySpikeSkipIf(cmd);
      byCmd.set(cmd, {
        id: stableId(cmd),
        cmd,
        label,
        source: row.source,
        project: row.project || 'unknown',
      });
    }
  }
  return [...byCmd.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function balanceOf(corpus) {
  let behavioural = 0;
  let loose = 0;
  for (const row of corpus) {
    if (row.label === 'behavioural') behavioural++;
    else if (row.label === 'loose') loose++;
  }
  const total = corpus.length;
  // A corpus with only one class cannot measure calibration: every bin would
  // have a constant outcome and the expected calibration error would be
  // reporting the class prior, not the model. v1 shipped exactly this.
  return { total, behavioural, loose, degenerate: behavioural === 0 || loose === 0 };
}

function planFiles(vault) {
  const files = [];
  const projectsDir = path.join(vault, '01 - Projects');
  if (fs.existsSync(projectsDir)) {
    for (const project of fs.readdirSync(projectsDir).sort()) {
      const plansDir = path.join(projectsDir, project, 'plans');
      if (!fs.existsSync(plansDir)) continue;
      for (const file of fs.readdirSync(plansDir).sort()) {
        if (file.endsWith('.md')) files.push({ file: path.join(plansDir, file), project });
      }
    }
  }
  const ownDir = path.join(ROOT, 'docs', 'code-plan', 'plans');
  if (fs.existsSync(ownDir)) {
    for (const file of fs.readdirSync(ownDir).sort()) {
      if (file.endsWith('.md')) files.push({ file: path.join(ownDir, file), project: 'vivera' });
    }
  }
  return files;
}

function rowsFromFile(file, project) {
  const md = fs.readFileSync(file, 'utf8');
  const { frontmatter } = extractFrontmatter(md);
  const plan = parseUltraPlanYaml(frontmatter);
  const rel = path.relative(project === 'vivera' ? ROOT : resolveVault(), file);
  const rows = [];
  for (const task of plan.tasks || []) {
    for (const step of task.run || []) {
      if (step && typeof step.cmd === 'string') {
        rows.push({ cmd: step.cmd, source: `${rel}#${task.id}`, project });
      }
    }
  }
  return rows;
}

export function collect(vault = resolveVault()) {
  if (!fs.existsSync(vault)) {
    throw new Error(`E_PRECOND_VAULT: vault not found at ${vault}`);
  }
  const rows = [];
  let skipped = 0;
  for (const { file, project } of planFiles(vault)) {
    try {
      rows.push(...rowsFromFile(file, project));
    } catch (err) {
      // A plan that does not parse is itself a finding, but it must not abort
      // the harvest. The gap is reported rather than hidden.
      skipped++;
      process.stderr.write(`skipped unparseable plan: ${path.basename(file)} (${err.message})\n`);
    }
  }
  if (skipped > 0) process.stderr.write(`skipped ${skipped} unparseable plan file(s)\n`);
  return buildCorpus(rows);
}

export function checkPreconditions(corpus, minRows) {
  const balance = balanceOf(corpus);
  if (balance.total < minRows) {
    throw new Error(`E_PRECOND_SIZE: ${balance.total} rows harvested, need at least ${minRows}`);
  }
  if (balance.degenerate) {
    throw new Error(
      `E_PRECOND_IMBALANCE: corpus is single-class `
      + `(behavioural ${balance.behavioural}, loose ${balance.loose}); calibration cannot be measured`
    );
  }
  return balance;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const minIdx = args.indexOf('--min-rows');
  const minRows = minIdx === -1 ? 150 : Number(args[minIdx + 1]);
  const corpus = collect();
  const balance = checkPreconditions(corpus, minRows);
  if (args.includes('--stats')) {
    console.log(JSON.stringify(balance));
    process.exit(0);
  }
  const outIdx = args.indexOf('--out');
  const out = outIdx === -1 ? path.join(ROOT, 'spike-out', 'corpus.json') : path.resolve(ROOT, args[outIdx + 1]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(corpus, null, 2)}\n`);
  const pct = (n) => `${((n / balance.total) * 100).toFixed(1)}%`;
  console.log(
    `corpus: ${balance.total} commands `
    + `(${balance.behavioural} behavioural ${pct(balance.behavioural)}, `
    + `${balance.loose} loose ${pct(balance.loose)}) -> ${path.relative(ROOT, out)}`
  );
}
