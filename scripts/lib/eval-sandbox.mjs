// scripts/lib/eval-sandbox.mjs
//
// What the micro-eval lets a headless `claude -p` run touch: the scratch root its
// fixtures live under, the environment it inherits, and its tool allow and deny
// lists. Split out of scripts/eval-run.mjs, which is the only caller.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Literal /tmp, not $TMPDIR: here TMPDIR points into $HOME, and a run under $HOME
// loads the user's home CLAUDE.md (a probe quoted it; the same probe under /tmp did not).
export const DEFAULT_SCRATCH_ROOT = '/tmp/vivera-eval';

/** The scratch root to use, or an error message when it sits inside the home directory. */
export function scratchRoot(env = process.env, home = os.homedir()) {
  const root = path.resolve(env.EVAL_TMP_ROOT || DEFAULT_SCRATCH_ROOT);
  const rel = path.relative(path.resolve(home), root);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return { error: `scratch root ${root} is inside the home directory ${home}; home rules would leak into the run` };
  }
  return { root };
}

const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'XDG_RUNTIME_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'];

/** Only what claude needs: no cloud tokens or API keys of other services reach the agent under test. */
export function childEnv(root, env = process.env) {
  const out = {};
  for (const k of PASSED_ENV) if (env[k] !== undefined) out[k] = env[k];
  return { ...out, TMPDIR: root, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
}

// --setting-sources project,local also drops the user's PreToolUse hooks (rm-tmp-guard),
// so these lists are the only fence between an agent under test and this machine.
const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Skill', 'TodoWrite',
  'Bash(bun test*)', 'Bash(bun add *)', 'Bash(bun install*)', 'Bash(bun run test*)',
  'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git add *)', 'Bash(git commit *)',
  'Bash(git switch *)', 'Bash(git checkout -b *)', 'Bash(git branch*)', 'Bash(git rev-parse*)',
  'Bash(ls*)', 'Bash(cat *)', 'Bash(rg *)', 'Bash(wc *)', 'Bash(head *)', 'Bash(tail *)',
  // Seen denied in the 2026-10-19 run: an `echo "exit=$?"` tail or `bun --version` denied a whole chain.
  'Bash(echo *)', 'Bash(printf *)', 'Bash(sed -n *)', 'Bash(grep *)', 'Bash(pwd*)', 'Bash(which *)', 'Bash(bun --version*)',
];
// One entry per subcommand, so a second -C or `git -C <dir> config` cannot match.
const GIT_C_SUBCOMMANDS = ['add', 'commit', 'status', 'diff', 'log', 'show', 'switch', 'branch', 'rev-parse'];
// `Bash(git push*)` misses `git -C <dir> push`.
export const DISALLOWED_TOOLS = ['Bash(rm *)', 'Bash(git push*)', 'Bash(git -C * push*)', 'Bash(gh *)', 'Bash(curl *)', 'Bash(wget *)'];

/** A scenario's own list replaces the default, including the per-fixture `git -C` entries. */
export function allowedTools(scenario, fixtureDir) {
  return scenario.allowed_tools
    ?? [...DEFAULT_ALLOWED_TOOLS, ...GIT_C_SUBCOMMANDS.map((sub) => `Bash(git -C ${fixtureDir} ${sub}*)`)];
}

// How long a run may keep its pipes open after its process group is killed or its
// leader exits: a descendant in another session can hold them open indefinitely.
const PIPE_GRACE_MS = 2000;

/**
 * Runs cmd in its own process group and resolves with its stdout. On timeout, and
 * again once the leader exits, the whole group gets SIGKILL, so no descendant
 * outlives the run.
 */
export function runInGroup(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const chunks = [];
    let timedOut = false;
    let settled = false;
    let grace = null;
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(result);
    };
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ESRCH: the group is already empty.
      }
      grace ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, PIPE_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.resume();
    child.on('error', (err) => finish({ stdout: '', status: null, timedOut: false, spawnError: err }));
    child.on('exit', () => killGroup());
    child.on('close', (status) => finish({ stdout: Buffer.concat(chunks).toString('utf8'), status, timedOut, spawnError: null }));
  });
}

// Writable because claude writes its session and config state there.
const CLAUDE_STATE = ['.claude', '.claude.json'];
// Home paths holding credentials or personal data the agent under test has no reason to read.
const SECRET_DIRS = ['cloudflare', '.config/tinyfish', '.ssh', '.local/share/bmp-cli', '.config/amo',
  'iwan-kurniawan', 'Dokumen', '.mozilla', '.config/mozilla'];

/**
 * bwrap options that put a run on a read-only host with a private /tmp: only the
 * run dir and claude's own state are writable, secret dirs are empty, and the
 * pid namespace is private so killing bwrap kills every process of the run. The
 * network stays shared because claude needs the API.
 */
export function bwrapArgs({ runDir, home = os.homedir(), exists = fs.existsSync }) {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--bind', runDir, runDir];
  for (const rel of CLAUDE_STATE) {
    const p = path.join(home, rel);
    if (exists(p)) args.push('--bind', p, p);
  }
  for (const rel of SECRET_DIRS) {
    const p = path.join(home, rel);
    if (exists(p)) args.push('--tmpfs', p);
  }
  args.push('--unshare-pid', '--die-with-parent', '--');
  return args;
}
