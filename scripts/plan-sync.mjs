#!/usr/bin/env bun
// scripts/plan-sync.mjs
//
//   bun scripts/plan-sync.mjs <plan.md> [--project <key>]
//
// Runs the vault publish (plan-publish.mjs) and then the GitHub issue sync
// (plan-issue-sync.mjs) for one plan. Both CLIs are spawned rather than
// imported so each keeps its own exit-code contract and stays callable alone.
// Each step prints `publish: exit N` and `issue-sync: exit M`, because the two
// mirrors fail for different reasons and one shared code would not say which.
// The issue sync runs even when the publish fails: the steps are independent
// and the caller gets both verdicts from one run.
//
// Exit: first non-zero step exit, 0 when both pass, 2 on a usage error.
// PLAN_SYNC_PUBLISH_CMD and PLAN_SYNC_ISSUE_CMD replace the two script paths
// so tests can point at stubs and never touch the vault or GitHub.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: bun scripts/plan-sync.mjs <plan.md> [--project <key>]';

function parseArgs(argv) {
  let plan = null;
  let project = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') {
      project = argv[++i];
      if (!project || project.startsWith('-')) throw new Error('--project needs a value');
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag "${a}"`);
    } else if (plan) {
      throw new Error('exactly one plan file');
    } else {
      plan = a;
    }
  }
  if (!plan) throw new Error('a plan file is required');
  return { plan, project };
}

function step(label, script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  const code = r.status ?? 1;
  console.log(`${label}: exit ${code}`);
  return code;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const publish = process.env.PLAN_SYNC_PUBLISH_CMD || path.join(HERE, 'plan-publish.mjs');
  const issue = process.env.PLAN_SYNC_ISSUE_CMD || path.join(HERE, 'plan-issue-sync.mjs');
  const codes = [
    step('publish', publish, [opts.plan]),
    step('issue-sync', issue, [...(opts.project ? ['--project', opts.project] : []), opts.plan]),
  ];
  return codes.find((c) => c !== 0) ?? 0;
}

process.exit(main(process.argv.slice(2)));
