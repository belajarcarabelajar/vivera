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

// Found by an independent review of the first, regex-split version of the hook.
const BLOCKED_BYPASS = [
  "sleep 1 & git commit -m x",
  "nohup git push &",
  "git status |& git commit",
  'git -C "/path with space" commit -m x',
  'git -c "a b=c" commit',
  'FOO="a b" git commit',
  "git --git-dir /x commit -m a",
  "git --work-tree /x add .",
  "git \\\ncommit -m x",
  "(git commit -m x)",
  "{ git commit -m x; }",
  "if true; then git commit -m x; fi",
  "! git commit -m x",
  "time git commit -m x",
  "xargs git add",
  'git "commit" -m x',
  "git 'push' origin",
  "git branch -D x",
  "git branch -m old new",
  "git branch newname",
  "git update-ref -d refs/heads/x",
  "git init",
  "git clone url",
  "git submodule update",
  "git gc",
  "git notes add",
  "git reflog expire --all",
  "git update-index --add f",
  "git filter-branch",
  "git symbolic-ref HEAD refs/heads/x",
  "git bisect start",
  "git sparse-checkout set a",
  "git remote add x url",
  "git config user.name x",
  // beyond the review: wrappers with flags, sub-argument writes, heredoc control
  "env -i git commit -m x",
  "env FOO=1 git commit -m x",
  "xargs -n1 git add",
  "sudo git commit -m x",
  "echo hi; git commit -m x",
  "git commit -m x 2>&1",
  "git stash push",
  "git stash pop",
  "git stash drop",
  "git stash apply",
  "git stash clear",
  "git worktree add ../x",
  "git apply p.diff",
  "git clean -fd",
  "git fetch origin",
  "git tag v1",
  "git tag -d v1",
  "git tag -a v1 -m msg",
  "git branch --delete x",
  "git remote remove x",
  "git config --unset user.name",
  "git config set user.name x",
  "git reflog delete x",
  "git sparse-checkout",
  "cat <<EOF\nhello\nEOF\ngit commit -m x",
  "cat <<EOF && git commit -m x\nbody\nEOF",
  "gh api -X POST /repos/x/y/issues",
];

const ALLOWED_BYPASS = [
  "git stash list",
  "git stash show -p",
  "git tag -l",
  "git worktree list",
  "git apply --check p.diff",
  "git clean -n",
  "git fetch --dry-run",
  'echo "done; git push origin"',
  'echo "a && git add ."',
  'git log --grep="fix; git push origin"',
  "rg -n 'foo|git add .' README.md",
  "cat <<'EOF' > notes.md\ngit commit -m x\nEOF",
  "cat <<-EOF\n\tgit commit -m x\n\tEOF",
  "cat <<EOF\ngit push\nEOF\necho done",
  "git branch --show-current",
  "git branch -a",
  "git branch --list 'x*'",
  "git branch -vv",
  "git branch --contains HEAD",
  "git remote -v",
  "git remote show origin",
  "git config --get user.name",
  "git config --list",
  "git config user.name",
  "git config --global --get user.name",
  "git config -f x.ini --get a.b",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git tag",
  "git tag --contains HEAD",
  "git reflog",
  "git reflog show",
  "git symbolic-ref HEAD",
  "git sparse-checkout list",
  "git --no-pager log",
  "git diff 2>&1 | head",
  "echo hi # git commit",
  "command -v git",
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

  for (const command of BLOCKED_BYPASS) {
    test(`blocks: ${JSON.stringify(command)}`, () => {
      const { code, stderr } = runCommand(command);
      expect(code).toBe(2);
      expect(stderr).toMatch(/^Blocked: subagents never write git state \(.+\)\. Report the change to the parent/);
    });
  }

  for (const command of ALLOWED_BYPASS) {
    test(`allows: ${JSON.stringify(command)}`, () => {
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
