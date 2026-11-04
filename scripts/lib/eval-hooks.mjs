// scripts/lib/eval-hooks.mjs
//
// Fixture extras for scripts/eval-run.mjs: a scenario's `generate` map writes large
// deterministic files at run time instead of committing them.
//
//   generateProblem(spec)            null, or why a scenario's `generate` is malformed
//   generateFixtures(dest, spec)     {"<relpath>": {"lines": N, "template": "text {i}"}},
//                                    {i} counted from 1; no spec writes nothing
//   safeRelative, RefusedError       shared with eval-run.mjs overlays

import fs from 'node:fs';
import path from 'node:path';

export class RefusedError extends Error {}

export function safeRelative(p) {
  const norm = path.normalize(String(p));
  if (path.isAbsolute(norm) || norm === '..' || norm.startsWith(`..${path.sep}`) || norm === '.') {
    throw new RefusedError(`refused: overlay path escapes the fixture: ${p}`);
  }
  return norm;
}

export function generateProblem(spec) {
  if (spec === undefined) return null;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return 'generate must be a map of path to {lines, template}';
  for (const [rel, f] of Object.entries(spec)) {
    try {
      safeRelative(rel);
    } catch {
      return `generate path escapes the fixture: ${rel}`;
    }
    if (!Number.isInteger(f?.lines) || f.lines < 1) return `generate ${rel}: lines must be a positive integer`;
    if (typeof f.template !== 'string') return `generate ${rel}: template must be a string`;
  }
  return null;
}

export function generateFixtures(dest, spec) {
  for (const [rel, { lines, template }] of Object.entries(spec ?? {})) {
    const target = path.join(dest, safeRelative(rel));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = [];
    for (let i = 1; i <= lines; i++) out.push(`${template.replaceAll('{i}', String(i))}\n`);
    fs.writeFileSync(target, out.join(''));
  }
}
