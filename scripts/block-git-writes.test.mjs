// scripts/block-git-writes.test.mjs
//
// Spawns the PreToolUse hook with a Bash payload on stdin. The commands below
// are only ever STRING-MATCHED by the hook, never executed.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", ".claude", "hooks", "block-git-writes.mjs");

function run(stdin) {
  const r = Bun.spawnSync(["bun", HOOK], { stdin: Buffer.from(stdin) });
  return { code: r.exitCode, stderr: r.stderr.toString() };
}

function runCommand(command) {
  return run(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
}

const BLOCKED = [
  ["git commit -m x", "git commit"],
  ["git add .", "git add"],
  ["git push origin main", "git push"],
  ["git checkout main", "git checkout"],
  ["git switch -c x", "git switch"],
  ["git merge x", "git merge"],
  ["git rebase main", "git rebase"],
  ["git stash", "git stash"],
  ["git reset --soft HEAD~1", "git reset"],
  ["gh pr create", "gh"],
  ["echo ok && git commit -m x", "git commit"],
  ["git -C /tmp/repo commit -m x", "git commit"],
  ["GIT_AUTHOR_NAME=a git commit -m x", "git commit"],
  ["ls | git add -A", "git add"],
];

const ALLOWED = [
  "git status",
  "git diff -- scripts",
  "git log --oneline -5",
  "git show HEAD",
  "git -C /tmp/repo status",
  "bun test scripts/",
  "rg -n 'git commit' README.md",
  "echo hello",
];

describe("block-git-writes hook", () => {
  for (const [command, label] of BLOCKED) {
    test(`blocks: ${command}`, () => {
      const { code, stderr } = runCommand(command);
      expect(code).toBe(2);
      expect(stderr).toContain(
        `Blocked: subagents never write git state (${label}). Report the change to the parent, which stages and commits.`,
      );
    });
  }

  for (const command of ALLOWED) {
    test(`allows: ${command}`, () => {
      const { code, stderr } = runCommand(command);
      expect(code).toBe(0);
      expect(stderr).toBe("");
    });
  }

  test("invalid JSON stdin fails open", () => {
    expect(run("not json {").code).toBe(0);
  });

  test("payload without tool_input fails open", () => {
    expect(run(JSON.stringify({ tool_name: "Bash" })).code).toBe(0);
  });

  test("non-string command fails open", () => {
    expect(run(JSON.stringify({ tool_input: { command: 42 } })).code).toBe(0);
  });
});
