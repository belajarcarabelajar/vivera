#!/usr/bin/env bun
// .claude/hooks/block-git-writes.mjs
//
// PreToolUse hook for the Bash tool: subagents never write git state.
// Exit 2 blocks the call and shows stderr to the model; exit 0 allows it.
// Every parse failure exits 0, because a crashing guard would block all Bash calls.
//
// defer: first-token match only, upgrade when a bypass such as sh -c / bash -c, an absolute path to git, aliases and functions, or $( ) and backtick substitution is observed

const ALWAYS_WRITE = new Set([
  "add", "commit", "push", "checkout", "switch", "merge", "rebase", "reset",
  "restore", "cherry-pick", "revert", "pull", "rm", "mv", "am", "init", "clone",
  "submodule", "gc", "prune", "repack", "notes", "update-ref", "update-index",
  "filter-branch", "bisect", "replace", "maintenance",
]);

// Global options that take a separate value when written without "=".
const VALUE_GLOBALS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
  "--config-env", "--exec-path",
]);

const LEADING_WORDS = new Set([
  "(", "{", "!", "if", "then", "else", "elif", "do", "while", "until",
  "time", "nohup", "exec", "command", "env", "sudo", "xargs",
]);
const WRAPPERS = new Set(["time", "nohup", "exec", "command", "env", "sudo", "xargs"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Splits a command line into commands (arrays of words). Handles quotes,
// backslash escapes, backslash-newline, comments, and heredoc bodies, which
// are skipped so text inside them is never mistaken for a command.
function tokenize(src) {
  const commands = [];
  let cur = [];
  let word = "";
  let inWord = false;
  const heredocs = [];
  const n = src.length;

  const pushWord = () => {
    if (inWord) cur.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    pushWord();
    if (cur.length) commands.push(cur);
    cur = [];
  };
  const append = (s) => {
    word += s;
    inWord = true;
  };
  const skipBodies = (from) => {
    let i = from;
    for (const { delim, strip } of heredocs) {
      while (i < n) {
        let eol = src.indexOf("\n", i);
        if (eol < 0) eol = n;
        const line = src.slice(i, eol);
        i = Math.min(eol + 1, n);
        if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
      }
    }
    heredocs.length = 0;
    return i;
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") i += 2;
      else if (i + 1 < n) {
        append(src[i + 1]);
        i += 2;
      } else i++;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      append(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) {
          const d = src[i + 1];
          if (d === "\n") {
            i += 2;
            continue;
          }
          if ('$`"\\'.includes(d)) {
            word += d;
            i += 2;
            continue;
          }
        }
        word += src[i++];
      }
      i++;
    } else if (c === " " || c === "\t") {
      pushWord();
      i++;
    } else if (c === "\n") {
      endCommand();
      i = heredocs.length ? skipBodies(i + 1) : i + 1;
    } else if (c === "#" && !inWord) {
      while (i < n && src[i] !== "\n") i++;
    } else if (src.startsWith("<<<", i)) {
      append("<<<");
      i += 3;
    } else if (c === "<" && src[i + 1] === "<") {
      pushWord();
      i += 2;
      const strip = src[i] === "-";
      if (strip) i++;
      while (src[i] === " " || src[i] === "\t") i++;
      let delim = "";
      while (i < n && !/[\s;&|()<>]/.test(src[i])) {
        if (src[i] === "'" || src[i] === '"') {
          const j = src.indexOf(src[i], i + 1);
          const end = j < 0 ? n : j;
          delim += src.slice(i + 1, end);
          i = end + 1;
        } else if (src[i] === "\\" && i + 1 < n) {
          delim += src[i + 1];
          i += 2;
        } else delim += src[i++];
      }
      if (delim) heredocs.push({ delim, strip });
    } else if (c === "&") {
      if (src[i + 1] === "&") {
        endCommand();
        i += 2;
      } else if (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">") {
        append("&");
        i++;
      } else {
        endCommand();
        i++;
      }
    } else if (c === "|") {
      if (src[i + 1] === "|" || src[i + 1] === "&") {
        endCommand();
        i += 2;
      } else if (src[i - 1] === ">") {
        append("|");
        i++;
      } else {
        endCommand();
        i++;
      }
    } else if (c === ";") {
      endCommand();
      i++;
    } else if (c === "(" || c === ")") {
      pushWord();
      cur.push(c);
      i++;
    } else {
      append(c);
      i++;
    }
  }
  endCommand();
  return commands;
}

function stripLeading(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (ASSIGNMENT.test(t)) i++;
    else if (LEADING_WORDS.has(t)) {
      i++;
      if (WRAPPERS.has(t)) while (i < tokens.length && tokens[i].startsWith("-")) i++;
    } else break;
  }
  return tokens.slice(i);
}

function splitArgs(args) {
  const flags = [];
  const pos = [];
  let afterDashes = false;
  for (const a of args) {
    if (afterDashes) pos.push(a);
    else if (a === "--") afterDashes = true;
    else if (a.startsWith("-") && a.length > 1) flags.push(a);
    else pos.push(a);
  }
  return { flags, pos };
}

// Long flags match by name (before "="); single-dash clusters match by letter.
function hasFlag(flags, longs, shorts = "") {
  return flags.some((f) =>
    f.startsWith("--") ? longs.includes(f.split("=")[0]) : [...f.slice(1)].some((ch) => shorts.includes(ch)),
  );
}

function gitWrites(sub, rest) {
  if (ALWAYS_WRITE.has(sub)) return true;
  const { flags, pos } = splitArgs(rest);
  switch (sub) {
    case "stash":
      return rest[0] !== "list" && rest[0] !== "show";
    case "tag":
      return pos.length > 0 &&
        !hasFlag(flags, ["--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column"], "ln");
    case "branch":
      if (hasFlag(flags, ["--delete", "--move", "--copy", "--set-upstream-to", "--set-upstream", "--unset-upstream", "--edit-description"], "dDmMcCu")) return true;
      return pos.length > 0 &&
        !hasFlag(flags, ["--list", "--all", "--remotes", "--verbose", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format"], "lavr");
    case "remote":
      return ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"].includes(pos[0]);
    case "config": {
      const kept = [];
      for (let k = 0; k < rest.length; k++) {
        kept.push(rest[k]);
        if (["-f", "--file", "--blob", "--default", "--type"].includes(rest[k])) k++;
      }
      const c = splitArgs(kept);
      if (hasFlag(c.flags, ["--add", "--unset", "--unset-all", "--replace-all", "--edit", "--rename-section", "--remove-section"], "e")) return true;
      if (["set", "unset", "edit", "rename-section", "remove-section"].includes(c.pos[0])) return true;
      if (c.pos[0] === "get" || c.pos[0] === "list") return false;
      if (hasFlag(c.flags, ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "--list"], "l")) return false;
      return c.pos.length >= 2;
    }
    case "worktree":
    case "sparse-checkout":
      return rest[0] !== "list";
    case "apply":
      return flags.includes("--apply") || !hasFlag(flags, ["--check", "--stat", "--numstat", "--summary"]);
    case "clean":
      return !flags.some((f) => f === "--dry-run" || /^-[fdxXnqi]*n[fdxXnqi]*$/.test(f));
    case "fetch":
      return !flags.includes("--dry-run");
    case "reflog":
      return pos[0] === "expire" || pos[0] === "delete";
    case "symbolic-ref":
      return pos.length >= 2 || hasFlag(flags, ["--delete"], "d");
    default:
      return false;
  }
}

function blockedLabel(tokens) {
  const t = stripLeading(tokens);
  if (t[0] === "gh") return "gh";
  if (t[0] !== "git") return null;

  let i = 1;
  while (i < t.length && t[i].startsWith("-")) {
    i += VALUE_GLOBALS.has(t[i]) ? 2 : 1;
  }
  const sub = t[i];
  if (!sub) return null;
  return gitWrites(sub, t.slice(i + 1)) ? `git ${sub}` : null;
}

let command;
try {
  command = JSON.parse(await Bun.stdin.text())?.tool_input?.command;
} catch {
  process.exit(0);
}
if (typeof command !== "string") process.exit(0);

for (const tokens of tokenize(command)) {
  const label = blockedLabel(tokens);
  if (label) {
    console.error(
      `Blocked: subagents never write git state (${label}). Report the change to the parent, which stages and commits.`,
    );
    process.exit(2);
  }
}
process.exit(0);
