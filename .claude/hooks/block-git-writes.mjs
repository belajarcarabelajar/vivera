#!/usr/bin/env bun
// .claude/hooks/block-git-writes.mjs
//
// PreToolUse hook for the Bash tool: subagents never write git state.
// Exit 2 blocks the call and shows stderr to the model; exit 0 allows it.
// Every parse failure exits 0, because a crashing guard would block all Bash calls.
//
// defer: first-token match only, upgrade when a bypass such as env, sh -c or an alias is observed

const WRITE_SUBCOMMANDS = new Set([
  "add", "commit", "push", "checkout", "switch", "merge", "rebase", "stash",
  "reset", "restore", "cherry-pick", "revert", "pull", "clean", "rm", "mv",
  "apply", "am", "tag", "worktree", "fetch",
]);

function blockedLabel(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();

  if (tokens[0] === "gh") return "gh";
  if (tokens[0] !== "git") return null;

  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    i += tokens[i] === "-C" || tokens[i] === "-c" ? 2 : 1;
  }
  const sub = tokens[i];
  return sub && WRITE_SUBCOMMANDS.has(sub) ? `git ${sub}` : null;
}

let command;
try {
  command = JSON.parse(await Bun.stdin.text())?.tool_input?.command;
} catch {
  process.exit(0);
}
if (typeof command !== "string") process.exit(0);

for (const segment of command.split(/&&|\|\||;|\||\n/)) {
  const label = blockedLabel(segment);
  if (label) {
    console.error(
      `Blocked: subagents never write git state (${label}). Report the change to the parent, which stages and commits.`,
    );
    process.exit(2);
  }
}
process.exit(0);
