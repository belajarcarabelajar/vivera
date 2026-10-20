// scripts/lib/plan-size-warn.mjs
//
// Plan-time warning for the pre-commit size gate (scripts/check-file-size.mjs):
// a task that modifies a file already near its limit meets the gate at commit
// unless the split or a size-raise line is planned now (MEMORY.md L79).

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { LIMIT_BYTES } from '../check-file-size.mjs';

// Same path check-file-size.mjs reads; it keeps that constant private and sits
// within a few bytes of its own limit, so exporting it would trip the gate.
const BASELINE_REL = 'scripts/file-size-baseline.json';
const SHARE = 0.9;

function readCeilings(dir) {
  try {
    const obj = JSON.parse(readFileSync(path.join(dir, BASELINE_REL), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    // A missing or broken baseline is the gate's error to report, not the plan's.
    return {};
  }
}

function sizeOf(file) {
  try {
    const s = statSync(file);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

// One message per files.modify path at or above 90% of its limit; paths resolve
// against `dir` the way the runner resolves `files`.
export function sizeGateWarnings(plan, dir = process.cwd()) {
  const ceilings = readCeilings(dir);
  const out = [];
  for (const t of plan?.tasks || []) {
    for (const f of t?.files?.modify || []) {
      if (typeof f !== 'string' || f === '') continue;
      const bytes = sizeOf(path.resolve(dir, f));
      if (bytes === null) continue;
      const rel = path.relative(dir, path.resolve(dir, f)).split(path.sep).join('/');
      const ceiling = Number.isInteger(ceilings[rel]) ? ceilings[rel] : null;
      const limit = ceiling ?? LIMIT_BYTES;
      if (bytes < limit * SHARE) continue;
      // A rounded-down percentage reads "100%" for a file the gate already blocks.
      const share = bytes > limit ? 'over' : `${Math.floor((bytes * 100) / limit)}% of`;
      const what = ceiling === null ? `the default limit ${limit} bytes` : `its ceiling ${limit} bytes in ${BASELINE_REL}`;
      out.push(`task ${t.id} modifies ${f}: ${bytes} bytes, ${share} ${what}; `
        + 'plan the split or a size-raise line now, not at commit (MEMORY.md L79)');
    }
  }
  return out;
}
