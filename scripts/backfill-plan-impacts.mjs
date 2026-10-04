#!/usr/bin/env bun
// scripts/backfill-plan-impacts.mjs
//
// Derive `tasks[].impacts` for plans that predate the key, from what each task
// actually declared it touched.
//
// WHY A SCRIPT AND NOT HAND-WRITING.
//
// Twelve plans hold 108 tasks. Hand-writing 108 impact claims would be writing
// 108 analyses, and an analysis nobody performed is a fabrication wearing the
// costume of a record. Every entry this script writes is DERIVED from something
// checkable: the `files` each task already declared in its own frontmatter, plus
// the consumers of those files in the current tree, plus the command that shows
// them. The claim is "this is the surface, and here is how to see it", which is
// true whether or not anyone thought about it at the time.
//
// The distinction is stated in the plan's own prose, which this script writes:
// these are RETROSPECTIVE. The plan predates the gate; the audit happened when
// the key landed, not when the task ran.
//
// WHAT IT WRITES, per task:
//   impacts: ["<surface> - <the command that shows it>", ...]
//
// Capped at MAX_IMPACTS per task. An uncapped list is a wall of text that stops
// being read, and a list nobody reads is decoration. When a task touches many
// files, the highest-signal surfaces come first: a file another module imports
// outranks a file only this plan's own scripts import.
//
// WHAT IT DOES NOT DO:
//   - touch `defaults.require_impacts`, so a backfilled plan stays on the
//     warn-only path until its author opts in
//   - touch any file outside docs/code-plan/plans/
//   - guess. A file with no detected consumer and no detectable contract gets
//     the sentinel `none: <command>`, which says "this was checked" rather than
//     "there was nothing to check".
//
// Usage:
//   bun scripts/backfill-plan-impacts.mjs --dry-run   report, write nothing
//   bun scripts/backfill-plan-impacts.mjs             rewrite in place
//
// REVERT: `git checkout docs/code-plan/plans/` in a checkout that tracks it, or
// restore from `<plan>.md.bak` in one that does not. The script itself is
// deletable; nothing else imports it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFrontmatter, parseUltraPlanYaml } from './ultra-plan-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANS_DIR = path.join(ROOT, 'docs', 'code-plan', 'plans');

const MAX_IMPACTS = 3;

// A file that is a PLAN, TEMPLATE or SNIPPET is not code with consumers, it is
// documentation a human or an agent reads, and its blast radius is "who follows
// this instruction". Naming the reader is the honest entry for those, and it is
// what the copy-rule and contract checks are there to keep true.
const DOC_EXTENSIONS = new Set(['.md']);

/** Does another tracked file import or require this module? */
function consumersOf(relFile, tracked) {
  const stem = path.basename(relFile).replace(/\.[cm]?js$/, '');
  const hits = [];
  for (const other of tracked) {
    if (other === relFile) continue;
    if (!/\.[cm]?js$/.test(other)) continue;
    let src;
    try { src = fs.readFileSync(path.join(ROOT, other), 'utf8'); } catch { continue; }
    // The EXTENSION IS PART OF THE SPECIFIER. An earlier version stripped `.mjs`
    // off the stem and then required the closing quote immediately, so
    // `from './plan-publish-frontmatter.mjs'` never matched and every module was
    // reported as having no consumer. 83 of 127 tasks came back as the "checked,
    // nothing found" sentinel because of that one missing `\.[cm]?js`, which is
    // what a hollow backfill looks like: the gate passes and the entries say
    // nothing.
    const spec = `${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[cm]?js`;
    const re = new RegExp(`(?:from\\s+['"][^'"]*${spec}['"]|require\\(\\s*['"][^'"]*${spec}['"]\\s*\\))`);
    if (re.test(src)) hits.push(other);
  }
  return hits;
}

/**
 * Surfaces that are read by a GATE or by a consumer that is not an import.
 *
 * Most of these have no importer, which is exactly why an import-only scan
 * called them empty. Each one has a reader, and the reader is the blast radius:
 *
 *  - the master skill file is symlinked into `skills/super-ultra-code-plan/` and
 *    is what an agent loads, so a task that edits it changes what every future
 *    session does
 *  - `snippets/*.md` are pushed into the Snipset database by `sync-snippets.mjs`
 *    and are what the agent actually receives when a trigger fires
 *  - `templates/*.md` are asserted by `validate-skill.mjs` and quoted by agents
 *  - the gate scripts themselves are run by `bun run ci`
 */
function isGateOrConsumer(relFile) {
  if (relFile === 'Super Ultra Code Plan Implementation.md') return true;
  if (relFile.startsWith('snippets/') || relFile.startsWith('templates/')) return true;
  if (relFile.startsWith('skills/')) return true;
  return [
    'scripts/validate-skill.mjs',
    'scripts/ultra-plan-runner.mjs',
    'scripts/check-runner-contract.mjs',
    'scripts/check-copy-rules.mjs',
    'scripts/pr-registry.mjs',
    'scripts/plan-publish.mjs',
    'scripts/plan-publish-registry.mjs',
    'scripts/plan-issue-sync.mjs',
    'scripts/plan-mark-done.mjs',
    'scripts/sync-snippets.mjs',
    'scripts/plan-lifecycle-audit.mjs',
    'scripts/agents-md-current.mjs',
    'scripts/graphify-plugin-drift.mjs',
    'scripts/graphify-sync.mjs',
    'scripts/render-diagrams.sh',
    'scripts/install.sh',
    'install.sh',
    'package.json',
    'bun.lock',
    'AGENTS.md',
    'README.md',
    'MEMORY.md',
    'snippets.manifest.json',
    'mermaid.config.json',
    'mermaid.dark.config.json',
    'puppeteer-config.json',
  ].includes(relFile);
}

function evidenceFor(relFile) {
  const base = path.basename(relFile);
  return `rg -n ${JSON.stringify(base)} scripts/ templates/ snippets/ README.md AGENTS.md`;
}

function entryFor(relFile, consumers) {
  const surface = relFile.replace(/^scripts\//, 'scripts/');
  if (consumers.length > 0) {
    const shown = consumers.slice(0, 2).join(', ');
    const more = consumers.length > 2 ? `, +${consumers.length - 2} more` : '';
    return `${surface} - ${consumers.length} consumer(s): ${shown}${more} - ${evidenceFor(relFile)}`;
  }
  if (isGateOrConsumer(relFile)) {
    const reader = relFile.startsWith('snippets/') ? 'pushed to the Snipset database by sync-snippets.mjs and asserted by validate-skill.mjs'
      : relFile.startsWith('templates/') ? 'asserted by validate-skill.mjs and quoted by agents following the plan'
      : relFile === 'Super Ultra Code Plan Implementation.md' ? 'symlinked as the skill an agent loads, so it decides what every future session does'
      : 'a gate, a published contract, or a manifest read by the pipeline';
    return `${surface} - no importer, but it has a reader: ${reader} - ${evidenceFor(relFile)}`;
  }
  return null;
}

function impactsFor(task, tracked) {
  const files = task.files && typeof task.files === 'object' ? task.files : {};
  const touched = [...(files.modify ?? []), ...(files.create ?? [])];
  if (touched.length === 0) {
    // A real case, not a hypothetical: several plans have a T0 whose `files` is
    // `{ create: [], modify: [], test: [] }` because the work was prose or
    // investigation rather than code. For those the blast radius is not a path,
    // it is whoever reads the task, so the evidence has to point at the task.
    return [`none: rg -n '### Task ${task.id}\\b' <this plan> - the task declares no files, so its surface is its prose rather than a path, and the reader of that prose is the consumer`];
  }

  const entries = [];
  let checked = 0;
  for (const f of touched) {
    checked++;
    const consumers = DOC_EXTENSIONS.has(path.extname(f)) ? [] : consumersOf(f, tracked);
    const entry = entryFor(f, consumers);
    if (entry) entries.push(entry);
    if (entries.length >= MAX_IMPACTS) break;
  }

  if (entries.length === 0) {
    // No consumer found and not a gate. That is a checked finding, not an
    // absence of one, and the sentinel says which command established it.
    return [`none: ${evidenceFor(touched[0])} - checked ${checked} declared file(s), no consumer and no gate found`];
  }
  return entries;
}

function trackedFiles() {
  const out = [];
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'graphify-out') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(ROOT);
  return out;
}

/**
 * Insert `impacts:` immediately after the task's `depends_on:` line inside the
 * frontmatter, at the same indent. Text-level rather than parse-and-reserialise,
 * because re-serialising would reformat the whole frontmatter and bury a
 * backfill in noise. The parse afterwards is what proves the result.
 */
function insertImpacts(source, plan) {
  const fmEnd = source.indexOf('\n---', source.indexOf('---') + 3);
  if (fmEnd === -1) throw new Error('no closing frontmatter fence');
  const head = source.slice(0, fmEnd);
  const tail = source.slice(fmEnd);

  const lines = head.split('\n');
  const out = [];
  let currentTask = null;
  const taskOrder = plan.tasks.map((t) => t.id);

  for (const line of lines) {
    const taskStart = /^(\s*)- id:\s*(\S+)/.exec(line);
    if (taskStart) currentTask = taskStart[2];
    out.push(line);
    if (currentTask === null) continue;
    const depLine = /^(\s*)depends_on:/.exec(line);
    if (!depLine) continue;
    const idx = taskOrder.indexOf(currentTask);
    if (idx === -1) continue;
    const impacts = impactsFor(plan.tasks[idx], currentTask === null ? [] : globalThis.__tracked);
    const indent = `${depLine[1]}impacts: [`;
    out.push(`${indent}${impacts.map((s) => JSON.stringify(s)).join(', ')}]`);
  }
  return out.join('\n') + tail;
}

const dryRun = process.argv.includes('--dry-run');

if (!fs.existsSync(PLANS_DIR)) {
  console.error('docs/code-plan/plans is absent; nothing to backfill (it is gitignored machine-local storage)');
  process.exit(0);
}

globalThis.__tracked = trackedFiles();
const files = fs.readdirSync(PLANS_DIR).filter((f) => f.endsWith('.md')).sort();
let changedPlans = 0;
let changedTasks = 0;

for (const f of files) {
  const full = path.join(PLANS_DIR, f);
  const source = fs.readFileSync(full, 'utf8');
  const { frontmatter } = extractFrontmatter(source);
  const plan = parseUltraPlanYaml(frontmatter);
  const missing = plan.tasks.filter((t) => !Array.isArray(t.impacts) || t.impacts.length === 0);
  if (missing.length === 0) continue;

  const next = insertImpacts(source, plan);
  // The parse is the proof the text-level edit produced valid frontmatter.
  const reparsed = parseUltraPlanYaml(extractFrontmatter(next).frontmatter);
  const stillMissing = reparsed.tasks.filter((t) => !Array.isArray(t.impacts) || t.impacts.length === 0);
  if (stillMissing.length > 0) {
    console.error(`❌ ${f}: ${stillMissing.length} task(s) still declare no impacts after the rewrite; refusing to write`);
    process.exit(1);
  }

  changedTasks += missing.length;
  changedPlans++;
  if (dryRun) {
    console.log(`would rewrite ${f}: ${missing.length} task(s)`);
  } else {
    // Atomic write with a backup, same helper the rest of the tooling uses.
    const { writeFileAtomic } = await import('./lib/atomic-write.mjs');
    writeFileAtomic(full, next, { keepBackup: true });
    console.log(`✅ ${f}: ${missing.length} task(s) given impacts`);
  }
}

console.log(`\n${changedTasks} task(s) across ${changedPlans} plan(s) ${dryRun ? 'would change' : 'changed'}.`);