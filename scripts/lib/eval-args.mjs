// scripts/lib/eval-args.mjs
//
// Command-line parsing for scripts/eval-run.mjs, split out to keep the runner under the
// file size limit. A UsageError makes the runner print USAGE and exit 2.

import path from 'node:path';
import { parseCount } from './eval-repeat.mjs';

export const USAGE = 'usage: eval-run.mjs [--list] [--only <id,id>] [--budget-usd <total>] [--out <file.json>] [--baseline <file.json>] [--keep] [--no-invoke] [--no-sandbox] [--scenarios <dir>] [--repeat <odd n>] [--confirm-flips <even k>] [--no-early-stop] [--model <m>] [--advisor <m>]';

export class UsageError extends Error {}

export function parseArgs(argv, root) {
  const opts = { list: false, noInvoke: false, noSandbox: false, only: null, budget: 15, out: null, baseline: null, keep: false, repeat: 3, confirmFlips: 0, noEarlyStop: false, model: null, advisor: null, scenarios: path.join(root, 'evals', 'scenarios') };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--no-invoke') opts.noInvoke = true;
    else if (a === '--no-sandbox') opts.noSandbox = true;
    else if (a === '--no-early-stop') opts.noEarlyStop = true;
    else if (a === '--model' || a === '--advisor') opts[a.slice(2)] = value(i++, a);
    else if (a === '--only') opts.only = value(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--budget-usd') {
      opts.budget = Number(value(i++, a));
      if (!Number.isFinite(opts.budget) || opts.budget <= 0) throw new UsageError('--budget-usd needs a positive number');
    } else if (a === '--out') opts.out = path.resolve(value(i++, a));
    else if (a === '--baseline') opts.baseline = path.resolve(value(i++, a));
    else if (a === '--repeat' || a === '--confirm-flips') {
      const r = a === '--repeat';
      const n = parseCount(value(i++, a), r ? 1 : 0, r ? 1 : 0);
      if (Number.isNaN(n)) throw new UsageError(`${a} needs ${r ? 'an odd' : 'an even'} whole number, at least ${r ? 1 : 0}`);
      opts[r ? 'repeat' : 'confirmFlips'] = n;
    } else if (a === '--scenarios') opts.scenarios = path.resolve(value(i++, a));
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return opts;
}
