import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SELF = path.resolve(import.meta.path);

// Families with no live caller, retired on 2026-10-19 (plan 2026-10-19-pipeline-efficiency, T1).
const RETIRED = [
  'scripts/export-opencode-history.mjs',
  'scripts/lib/opencode-db.mjs',
  'scripts/lib/render-session.mjs',
  'scripts/lib/extract-attachments.mjs',
  'scripts/lib/inline-spills.mjs',
  'scripts/lib/test-fixture-db.mjs',
  'scripts/bayesian-confidence.mjs',
  'scripts/formal-invariants.mjs',
  'scripts/queueing-batch.mjs',
  'scripts/spike-jev-client.mjs',
  'scripts/spike-calibration.mjs',
  'scripts/spike-skipif-probe.mjs',
  'scripts/spike-alt-corpus.mjs',
  'scripts/spike-skipif-corpus.mjs',
  'scripts/make-graph-demo.py',
  'scripts/vault-index-batch.mjs',
  'scripts/vault-index-cluster.mjs',
  'scripts/vault-index-cluster.py',
  'scripts/vault-index-narration.py',
  'scripts/vault-index-fold-rationale.mjs',
  'scripts/vault-index-resolve-chunk.mjs',
  'scripts/vault-index-verify.mjs',
  'scripts/vault-index-ids.mjs',
  'scripts/check-anchors.mjs',
  'scripts/repair-anchors.mjs',
  'scripts/accept-chunks.sh',
  'scripts/verify-chunk.sh',
  'templates/vault-index-subagent-contract.md',
];

const SCRIPT_RETIRED = RETIRED.filter((p) => p.startsWith('scripts/'));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|cjs|js|ts|sh|py|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usagePatterns(rel) {
  const file = escape(path.basename(rel));
  const scriptPath = escape(rel);
  return [
    new RegExp(`\\bfrom\\s+['"][^'"]*/${file}['"]`),
    new RegExp(`\\bimport\\s*\\(\\s*['"][^'"]*/${file}['"]`),
    new RegExp(`\\brequire\\s*\\(\\s*['"][^'"]*/${file}['"]`),
    new RegExp(`\\b(?:bun|node|python3?|bash|sh)\\s+(?:\\./)?${scriptPath}\\b`),
  ];
}

test('no retired path exists on disk', () => {
  const present = RETIRED.filter((p) => fs.existsSync(path.join(ROOT, p)));
  expect(present).toEqual([]);
});

test('no file under scripts/ imports, requires, or invokes a retired script', () => {
  const hits = [];
  for (const file of walk(path.join(ROOT, 'scripts'))) {
    if (path.resolve(file) === SELF) continue;
    const rel = path.relative(ROOT, file);
    if (RETIRED.includes(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const retired of SCRIPT_RETIRED) {
      if (usagePatterns(retired).some((re) => re.test(src))) hits.push(`${rel} -> ${retired}`);
    }
  }
  expect(hits).toEqual([]);
});

test('every scripts/ path named in package.json "scripts" exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const m of String(cmd).matchAll(/(?:^|[\s'"=])(?:\.\/)?(scripts\/[\w./-]+\.\w+)/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(`${name}: ${m[1]}`);
    }
  }
  expect(missing).toEqual([]);
});
