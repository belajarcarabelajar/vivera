// scripts/hooks/worktree-create.mjs
//
// Claude Code WorktreeCreate command hook. It reads the event JSON on stdin
// (`name`, `cwd`; other fields ignored), runs
// `wt-new worktree-<name> <name> --from HEAD` in `cwd`, and prints the new
// worktree's absolute path `<root>/<repo>-wt/<name>` as the only stdout line,
// so native worktrees land on the external disk like every other session
// worktree. `<repo>` is the basename of the MAIN checkout, found through the
// git common dir, because wt-new names the folder after it even when `cwd` is
// itself a linked worktree.
//
// Fail-closed (L98): any problem exits 1 with a message on stderr and nothing
// on stdout. Claude Code then refuses only this worktree creation; no other
// tool call is affected. wt-new's own stdout and stderr both go to stderr,
// because Claude Code reads stdout as the path.
//
// Env seams: WT_NEW (wt-new executable, default ~/.local/bin/wt-new) and
// VIVERA_WT_ROOT (worktree root, default /mnt/belajarcarabelajar).
//
// Revert: remove the WorktreeCreate entry from ~/.claude/settings.json, or
// restore ~/.claude/settings.json.bak-20261108-worktree-overnight-hooks.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

function fail(msg) {
  process.stderr.write(`worktree-create: ${msg}\n`);
  process.exit(1);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  fail('stdin is not JSON');
}
const name = input?.name;
if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..') {
  fail(`invalid worktree name ${JSON.stringify(name)}`);
}
const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();

const common = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
  encoding: 'utf8',
});
if (common.status !== 0) fail(`not a git repository: ${cwd}: ${common.stderr.trim()}`);
const repo = path.basename(path.dirname(common.stdout.trim()));

const root = process.env.VIVERA_WT_ROOT || '/mnt/belajarcarabelajar';
const dest = path.join(root, `${repo}-wt`, name);

// Absolute default: a hook's PATH may lack ~/.local/bin.
const wtNew = process.env.WT_NEW || path.join(os.homedir(), '.local/bin/wt-new');
const r = spawnSync(wtNew, [`worktree-${name}`, name, '--from', 'HEAD'], {
  cwd,
  stdio: ['ignore', process.stderr.fd, process.stderr.fd],
});
if (r.error) fail(`cannot run ${wtNew}: ${r.error.message}`);
if (r.status !== 0) fail(`${wtNew} exited ${r.status ?? r.signal}`);
if (!existsSync(dest) || !statSync(dest).isDirectory()) fail(`${wtNew} succeeded but ${dest} does not exist`);

process.stdout.write(`${dest}\n`);
