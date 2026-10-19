// scripts/lib/eval-sandbox.mjs
//
// What the micro-eval lets a headless `claude -p` run touch: the scratch root its
// fixtures live under, the environment it inherits, and its tool allow and deny
// lists. Split out of scripts/eval-run.mjs, which is the only caller.

import os from 'node:os';
import path from 'node:path';

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
