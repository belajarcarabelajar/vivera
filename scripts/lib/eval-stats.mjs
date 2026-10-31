// scripts/lib/eval-stats.mjs
//
// Report-only statistics for scripts/eval-run.mjs, plus the failed-stream files
// it keeps. Nothing here changes a verdict or the exit code.

import fs from 'node:fs';
import path from 'node:path';

// Wilson score interval: the normal approximation collapses to a zero width at 0/n and n/n,
// and eval scenarios run only 1 to 5 times.
export function wilson(passes, n, z = 1.96) {
  if (!n) return { low: 0, high: 1 };
  const p = passes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

// The chance that k runs in a row all pass, given a per-run pass rate.
export function passK(rate, k) {
  return rate ** k;
}

export function failedStreamPath(evalsDir, runId, id, nth) {
  return path.join(evalsDir, 'streams', runId, `${id}${nth}.stream.jsonl`);
}

// Returns the written path, or undefined after one warning: a lost stream must not fail the run.
export function keepFailedStream(evalsDir, runId, id, nth, stdout) {
  const file = failedStreamPath(evalsDir, runId, id, nth);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stdout);
    return file;
  } catch (err) {
    console.error(`warning: could not keep the failed stream ${file}: ${err.message}`);
    return undefined;
  }
}

// The runId shape from eval-run.mjs; any other dir may belong to someone else, since --out picks the parent.
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/;

// Run ids start with an ISO timestamp, so the newest dirs sort last by name.
export function pruneStreamRuns(dir, keep = 5) {
  try {
    if (!fs.existsSync(dir)) return;
    const runs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && RUN_ID.test(d.name)).map((d) => d.name).sort();
    for (const name of runs.slice(0, Math.max(0, runs.length - keep))) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  } catch (err) {
    console.error(`warning: could not prune ${dir}: ${err.message}`);
  }
}
