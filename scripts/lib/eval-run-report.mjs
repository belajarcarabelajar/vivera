// scripts/lib/eval-run-report.mjs
//
// Output side of scripts/eval-run.mjs: one console line per scenario record, the
// end-of-run summary, the out file, and the baseline comparison. Split out of
// eval-run.mjs, which is the only caller.

import fs from 'node:fs';
import path from 'node:path';
import { FLAKY_MIN_ATTEMPTS, compareBaseline, isFlaky } from './eval-repeat.mjs';
import { passK, wilson } from './eval-stats.mjs';

function money(n) {
  return String(Math.round(n * 10000) / 10000);
}

function contextTokens(usage) {
  if (!usage) return 0;
  return ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
    .reduce((sum, k) => sum + (Number(usage[k]) || 0), 0);
}

export function line(r, width) {
  const id = r.id.padEnd(width);
  if (r.skipped) return `${id}  SKIP  total budget reached`;
  const failed = r.results.find((x) => !x.pass);
  const why = failed ? `  ${failed.type}: ${failed.detail}` : '';
  const ci = r.attempts > 1 && wilson(r.passes, r.attempts);
  const tally = (ci ? `  passes=${r.passes}/${r.attempts} (95% CI ${ci.low.toFixed(2)}-${ci.high.toFixed(2)})` : '') + (r.flaky ? '  flaky' : '') + (r.confirmed === false ? '  unconfirmed' : '');
  const bytes = typeof r.usage?.tool_result_bytes === 'number' ? `  tool_result_bytes=${r.usage.tool_result_bytes}` : '';
  const sub = r.usage?.advisor_subagents ? ` advisor_subagents=${r.usage.advisor_subagents}` : '';
  const adv = r.advisor || r.usage?.advisor_calls || sub ? `  advisor_calls=${r.usage?.advisor_calls ?? 0}${sub}` : '';
  return `${id}  ${r.pass ? 'PASS' : 'FAIL'}${why}${tally}  turns=${r.turns ?? '-'}  ${r.cost == null ? 'cost unknown' : `$${money(r.cost)}`}${bytes}${adv}  ${r.seconds}s${r.fixture ? `  fixture=${r.fixture}` : ''}${r.stream ? `  stream=${r.stream}` : ''}`;
}

// Prints the totals line and, after a full-length run, the flaky list; returns the counts the exit code needs.
export function printSummary(done, spent) {
  const passed = done.filter((r) => r.pass).length;
  const skipped = done.filter((r) => r.skipped).length;
  const unconfirmed = done.filter((r) => r.confirmed === false).length;
  const tokens = done.reduce((sum, r) => sum + contextTokens(r.usage), 0);
  const bytes = done.reduce((sum, r) => sum + (Number(r.usage?.tool_result_bytes) || 0), 0);
  console.log(`${passed}/${done.length} passed${skipped ? `, ${skipped} skipped` : ''}${unconfirmed ? `, ${unconfirmed} unconfirmed` : ''}, total cost $${money(spent)}, context tokens ${tokens}, tool-result bytes ${bytes}`);
  // A pass rate from fewer runs is too coarse to call flaky, so the list needs every run scenario at full length.
  const ran = done.filter((r) => !r.skipped);
  if (ran.length && ran.every((r) => r.attempts >= FLAKY_MIN_ATTEMPTS)) {
    for (const r of ran.filter(isFlaky)) console.log(`flaky: ${r.id} (pass rate ${Math.round(r.pass_rate * 100) / 100})`);
  }
  for (const r of ran.filter((x) => x.attempts >= FLAKY_MIN_ATTEMPTS)) console.log(`pass^${r.attempts}: ${r.id} ${passK(r.passes / r.attempts, r.attempts).toFixed(2)}`);
  return { passed, skipped, unconfirmed };
}

export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function writeReport(out, data) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

// Prints each regression and improvement against the baseline; returns whether any regressed.
export function printComparison(baseline, done) {
  const { regressions, improvements } = compareBaseline(baseline, done);
  for (const id of regressions) console.log(`regression: ${id}`);
  for (const id of improvements) console.log(`improvement: ${id}`);
  return regressions.length > 0;
}
