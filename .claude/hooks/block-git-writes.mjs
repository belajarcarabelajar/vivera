#!/usr/bin/env bun
// .claude/hooks/block-git-writes.mjs
//
// PreToolUse hook for the Bash tool: subagents never write git state.
// Exit 2 blocks the call and shows stderr to the model; exit 0 allows it.
// Every parse failure exits 0, because a crashing guard would block all Bash calls.
//
// It tokenizes the command line and checks the command word of each command, not only the first
// one. Matches: a git write subcommand (plumbing writes included) or any gh call after && || ; |
// or a newline, behind a leading VAR=value or the wrappers in WRAPPERS (env, sudo, doas, xargs,
// timeout, nice, ionice, stdbuf, flock, setsid, taskset, chrt and others, by basename, with their
// option values and operands), behind a path (/usr/bin/git), with git global options (-C dir,
// -c a=b), through one inline -c alias.NAME=VALUE (a !shell alias always blocks), written as
// $'git' or $"git", as $NAME or ${NAME} set by an earlier standalone NAME=value, inside one
// sh/bash/zsh/dash -c string, and inside the value of an assignment such as x=$(git commit).
// A << inside $(( )) or (( )) is arithmetic, not a heredoc.
// Does not catch: an alias from git config, a function, eval, a backtick or $( ) that is not an
// assignment, text piped into a shell (echo ... | sh), a second nested sh -c, env -S or flock -c
// strings, a wrapper option missing from WRAPPERS that takes a separate value, or a write by
// redirection.
//
// defer: no config alias, eval, substitution, piped-shell or nested sh -c handling, upgrade when one of those bypasses is observed

const ALWAYS_WRITE = new Set([
  "add", "commit", "push", "checkout", "switch", "merge", "rebase", "reset",
  "restore", "cherry-pick", "revert", "pull", "rm", "mv", "am", "init", "clone",
  "submodule", "gc", "prune", "repack", "notes", "update-ref", "update-index",
  "filter-branch", "bisect", "replace", "maintenance", "read-tree", "commit-tree",
  "checkout-index", "fast-import", "merge-file", "mktree", "mktag", "write-tree",
  "unpack-objects",
]);

// Global options that take a separate value when written without "=".
const VALUE_GLOBALS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
  "--config-env", "--exec-path",
]);

const LEADING_WORDS = new Set(["(", "{", "!", "if", "then", "else", "elif", "do", "while", "until"]);
// Commands that run the rest of their arguments as a command, matched by basename: the options
// that take a separate value, and how many operands (timeout's duration, flock's lock file,
// taskset's mask, chrt's priority) come before the command. Without these, an option value
// such as the 5 in "nice -n 5 git push" would be read as the command word.
const WRAPPERS = new Map([
  ["time", ["-f -o --format --output", 0]],
  ["nohup", ["", 0]],
  ["exec", ["-a", 0]],
  ["command", ["", 0]],
  ["env", ["-u --unset -C --chdir -S --split-string", 0]],
  ["sudo", ["-u --user -g --group -h --host -p --prompt -C --close-from -D --chdir -r --role -t --type -U --other-user -T --command-timeout", 0]],
  ["doas", ["-u -C", 0]],
  ["xargs", ["-n --max-args -L --max-lines -P --max-procs -I -d --delimiter -E -s --max-chars -a --arg-file", 0]],
  ["timeout", ["-s --signal -k --kill-after", 1]],
  ["nice", ["-n --adjustment", 0]],
  ["ionice", ["-c --class -n --classdata -p --pid -P --pgid -u --uid", 0]],
  ["stdbuf", ["-i --input -o --output -e --error", 0]],
  ["flock", ["-w --wait --timeout -E --conflict-exit-code", 1]],
  ["setsid", ["", 0]],
  ["taskset", ["", 1]],
  ["chrt", ["-T --sched-runtime -P --sched-period -D --sched-deadline", 1]],
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const TARGETS = new Set(["git", "gh", ...SHELLS]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const VARIABLE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
const ANSI_ESCAPES = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };

const base = (word) => word.split("/").pop();

// Index of the "))" that closes the "((" at start, or -1 when the parens do not close as one
// "))" pair, in which case bash reads them as nested subshells.
function arithEnd(src, start) {
  let depth = 0;
  let inner = -1;
  for (let j = start; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")") {
      depth--;
      if (depth === 1) inner = j;
      if (depth === 0) return inner === j - 1 ? j : -1;
    }
  }
  return -1;
}

// Decodes the body of $'...' (ANSI-C quoting); returns [text, index after the closing quote].
function ansiQuoted(src, from) {
  let out = "";
  let i = from;
  while (i < src.length && src[i] !== "'") {
    if (src[i] !== "\\" || i + 1 >= src.length) {
      out += src[i++];
      continue;
    }
    const rest = src.slice(i + 1);
    const hex = /^x([0-9A-Fa-f]{1,2})/.exec(rest);
    const oct = /^([0-7]{1,3})/.exec(rest);
    if (hex) {
      out += String.fromCharCode(parseInt(hex[1], 16));
      i += 1 + hex[0].length;
    } else if (oct) {
      out += String.fromCharCode(parseInt(oct[1], 8));
      i += 1 + oct[0].length;
    } else {
      out += ANSI_ESCAPES[rest[0]] ?? rest[0];
      i += 2;
    }
  }
  return [out, i + 1];
}

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
  let end;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") i += 2;
      else if (i + 1 < n) {
        append(src[i + 1]);
        i += 2;
      } else i++;
    } else if (c === "$" && src[i + 1] === "'") {
      const [text, next] = ansiQuoted(src, i + 2);
      append(text);
      i = next;
    } else if (c === "$" && src[i + 1] === '"') {
      i++;
    } else if (c === "$" && src.startsWith("((", i + 1) && (end = arithEnd(src, i + 1)) > 0) {
      // Arithmetic: a << inside it is a shift, not a heredoc that would swallow the next lines.
      append(src.slice(i, end + 1));
      i = end + 1;
    } else if (c === "(" && src[i + 1] === "(" && !inWord && (end = arithEnd(src, i)) > 0) {
      cur.push(src.slice(i, end + 1));
      i = end + 1;
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

// Unknown options and operands pass: the first word that is neither is the wrapped command.
function skipWrapperArgs(tokens, i, [values, operands]) {
  const takesValue = values.split(" ");
  let options = true;
  while (i < tokens.length) {
    const t = tokens[i];
    if (options && t === "--") {
      options = false;
      i++;
    } else if (options && t.startsWith("-") && t.length > 1) i += takesValue.includes(t) ? 2 : 1;
    else if (ASSIGNMENT.test(t)) i++;
    else if (TARGETS.has(base(t)) || operands === 0) break;
    else {
      operands--;
      i++;
    }
  }
  return i;
}

function stripLeading(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const wrapper = WRAPPERS.get(base(t));
    if (ASSIGNMENT.test(t) || LEADING_WORDS.has(t)) i++;
    else if (wrapper) i = skipWrapperArgs(tokens, i + 1, wrapper);
    else break;
  }
  return tokens.slice(i);
}

// Substitutes $NAME and ${NAME} set by an earlier standalone assignment; unknown names stay.
function expand(tokens, vars) {
  return tokens.flatMap((t) => {
    const m = VARIABLE.exec(t);
    const name = m && (m[1] ?? m[2]);
    return name && vars.has(name) ? vars.get(name).split(/\s+/).filter(Boolean) : [t];
  });
}

function firstBlocked(commands, depth) {
  const vars = new Map();
  for (const tokens of commands) {
    if (tokens.every((t) => ASSIGNMENT.test(t))) {
      for (const t of tokens) vars.set(t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1));
    }
    const label = blockedLabel(expand(tokens, vars), depth);
    if (label) return label;
  }
  return null;
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

function blockedLabel(tokens, depth = 0) {
  const t = stripLeading(tokens);
  const word = t[0]?.split("/").pop();

  // defer: one level of -c recursion, upgrade when nested -c strings are observed
  if (SHELLS.has(word) && depth === 0) {
    const flag = t.findIndex((x, k) => k > 0 && /^-[A-Za-z]*c$/.test(x));
    const script = flag < 0 ? undefined : t[flag + 1];
    if (script === undefined) return null;
    return firstBlocked(tokenize(script), depth + 1);
  }

  if (word === "gh") return "gh";
  if (word !== "git") return null;

  const aliases = new Map();
  let i = 1;
  while (i < t.length && t[i].startsWith("-")) {
    const config = t[i] === "-c" ? t[i + 1] : t[i].startsWith("-c") ? t[i].slice(2) : "";
    const alias = /^alias\.([^=]+)=(.*)$/s.exec(config ?? "");
    if (alias) aliases.set(alias[1].toLowerCase(), alias[2]);
    i += VALUE_GLOBALS.has(t[i]) ? 2 : 1;
  }
  let sub = t[i];
  if (!sub) return null;
  let rest = t.slice(i + 1);
  // defer: one level of inline alias, upgrade when an alias of an alias is observed
  const alias = aliases.get(sub.toLowerCase());
  if (alias !== undefined) {
    if (alias.trimStart().startsWith("!")) return `git ${sub}`;
    const words = tokenize(alias)[0] ?? [];
    if (!words.length) return null;
    rest = [...words.slice(1), ...rest];
    sub = words[0];
  }
  if (sub === "hash-object") return hasFlag(splitArgs(rest).flags, [], "w") ? "git hash-object" : null;
  return gitWrites(sub, rest) ? `git ${sub}` : null;
}

let command;
try {
  command = JSON.parse(await Bun.stdin.text())?.tool_input?.command;
} catch {
  process.exit(0);
}
if (typeof command !== "string") process.exit(0);

let label;
try {
  label = firstBlocked(tokenize(command), 0);
} catch {
  process.exit(0);
}
if (label) {
  console.error(
    `Blocked: subagents never write git state (${label}). Report the change to the parent, which stages and commits.`,
  );
  process.exit(2);
}
process.exit(0);
