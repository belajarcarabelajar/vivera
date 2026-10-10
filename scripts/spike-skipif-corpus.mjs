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

export const UNREAD_MISSING_SOURCE = 'source plan not on this host';
export const UNREAD_NO_SOURCE_PATH = 'mirror has no tasks and no source_path';

/**
 * Where a vault mirror's runner contract lives.
 *
 * Since #45 the publisher drops `tasks` from the mirror, so the contract is
 * only in the source plan named by `source_path`. A legacy mirror that still
 * carries `tasks` is its own contract. A mirror that does not parse is passed
 * through unchanged so `collect()` reports it the way it always has.
 */
function resolveMirror(mirror) {
  let plan;
  try {
    plan = parseUltraPlanYaml(extractFrontmatter(fs.readFileSync(mirror, 'utf8')).frontmatter);
  } catch {
    return { file: mirror };
  }
  if (Array.isArray(plan.tasks) && plan.tasks.length > 0) return { file: mirror };
  const sourcePath = typeof plan.source_path === 'string' ? plan.source_path : '';
  if (sourcePath === '') return { unread: UNREAD_NO_SOURCE_PATH };
  if (!fs.existsSync(sourcePath)) return { unread: UNREAD_MISSING_SOURCE, sourcePath };
  return { file: sourcePath };
}

/**
 * The files to harvest, each listed once by resolved path, plus the mirrors
 * whose contract could not be reached. A source plan reached through several
 * mirrors, or through a mirror and this checkout's own plans directory, keeps
 * the attribution of the first mirror in sorted order.
 */
export function planFiles(vault, ownDir = path.join(ROOT, 'docs', 'code-plan', 'plans')) {
  const files = [];
  const unread = [];
  const seen = new Set();
  const add = (file, project, label) => {
    const key = path.resolve(file);
    if (seen.has(key)) return;
    seen.add(key);
    files.push({ file, project, label });
  };
  const projectsDir = path.join(vault, '01 - Projects');
  if (fs.existsSync(projectsDir)) {
    for (const project of fs.readdirSync(projectsDir).sort()) {
      const plansDir = path.join(projectsDir, project, 'plans');
      if (!fs.existsSync(plansDir)) continue;
      for (const name of fs.readdirSync(plansDir).sort()) {
        if (!name.endsWith('.md')) continue;
        const mirror = path.join(plansDir, name);
        const resolved = resolveMirror(mirror);
        // The label stays the mirror path so a row's source does not embed a
        // host-specific absolute path when the contract came from source_path.
        if (resolved.file) add(resolved.file, project, path.relative(vault, mirror));
        else unread.push({ mirror, project, reason: resolved.unread, sourcePath: resolved.sourcePath });
      }
    }
  }
  if (fs.existsSync(ownDir)) {
    for (const name of fs.readdirSync(ownDir).sort()) {
      const file = path.join(ownDir, name);
      if (name.endsWith('.md')) add(file, 'vivera', path.relative(ROOT, file));
    }
  }
  return { files, unread };
}

function rowsFromFile(file, project, rel) {
  const md = fs.readFileSync(file, 'utf8');
  // Older source plans have no frontmatter at all: no runner contract to
  // harvest, which is a different gap from a contract that fails to parse.
  if (!md.startsWith('---')) return null;
  const { frontmatter } = extractFrontmatter(md);
  const plan = parseUltraPlanYaml(frontmatter);
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
  let noFrontmatter = 0;
  const { files, unread } = planFiles(vault);
  for (const { file, project, label } of files) {
    try {
      const fileRows = rowsFromFile(file, project, label);
      if (fileRows === null) noFrontmatter++;
      else rows.push(...fileRows);
    } catch (err) {
      // A plan that does not parse is itself a finding, but it must not abort
      // the harvest. The gap is reported rather than hidden.
      skipped++;
      process.stderr.write(`skipped unparseable plan: ${path.basename(file)} (${err.message})\n`);
    }
  }
  if (skipped > 0) process.stderr.write(`skipped ${skipped} unparseable plan file(s)\n`);
  if (noFrontmatter > 0) {
    process.stderr.write(`${noFrontmatter} plan file(s) have no frontmatter, so no run commands\n`);
  }
  const byReason = new Map();
  for (const u of unread) {
    const where = u.sourcePath ? `: ${u.sourcePath}` : '';
    process.stderr.write(`unread vault mirror: ${path.relative(vault, u.mirror)} (${u.reason}${where})\n`);
    byReason.set(u.reason, (byReason.get(u.reason) || 0) + 1);
  }
  for (const [reason, n] of byReason) process.stderr.write(`${n} vault mirror(s) unread: ${reason}\n`);
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
