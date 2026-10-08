#!/usr/bin/env bun
// scripts/install-skill-links.mjs
//
// Makes every skill in vivera/skills/ visible to the OpenCode skill tool.
//
// The skill tool reads only ~/.config/opencode/skills/. A phase skill that lives
// in vivera/skills/ but has no entry there fails to load with "Unable to load
// skill", even though its file is present. Each entry in that directory must be
// a symlink to the vivera source, or a real directory whose files are symlinks.
//
// Rules, so the script never destroys state it did not create:
//   - A missing entry is linked.
//   - A symlink that is broken, or that already points into vivera/skills/, is
//     repointed at the current source.
//   - A real file or a foreign symlink is reported and left alone.
//   - A real directory (for example super-ultra-code-plan, which holds symlinked
//     files) is merged file by file under the same rules.
//
// Usage:
//   bun scripts/install-skill-links.mjs            apply
//   bun scripts/install-skill-links.mjs --dry-run  print actions, change nothing
//   bun scripts/install-skill-links.mjs --check    exit 1 if any link is missing or stale
//   bun scripts/install-skill-links.mjs --target <dir>  use another registry dir

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCE = path.resolve(here, "..", "skills");
export const DEFAULT_TARGET = path.join(os.homedir(), ".config", "opencode", "skills");

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isBroken(p) {
  return !fs.existsSync(p);
}

// Decide what to do with one destination entry that should point at `desired`.
// Returns { action, reason, from? } where action is one of:
// "ok" | "link" | "relink" | "skip".
export function decideLink(dest, desired, source) {
  const st = lstatOrNull(dest);
  if (!st) return { action: "link" };
  if (!st.isSymbolicLink()) return { action: "skip", reason: "real file or directory, left alone" };
  const current = fs.readlinkSync(dest);
  const resolved = path.resolve(path.dirname(dest), current);
  if (resolved === desired) return { action: "ok" };
  if (isBroken(dest) || resolved.startsWith(source + path.sep)) {
    return { action: "relink", from: current };
  }
  return { action: "skip", reason: `foreign symlink -> ${current}, left alone` };
}

// Plan every change without touching the filesystem.
export function planLinks(source = DEFAULT_SOURCE, target = DEFAULT_TARGET) {
  const actions = [];
  if (!fs.existsSync(source)) return actions;
  for (const name of fs.readdirSync(source).sort()) {
    const src = path.join(source, name);
    if (!fs.statSync(src).isDirectory()) continue;
    if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
    const dest = path.join(target, name);
    const st = lstatOrNull(dest);
    if (!st || st.isSymbolicLink()) {
      actions.push({ name, dest, desired: src, ...decideLink(dest, src, source) });
      continue;
    }
    if (st.isDirectory()) {
      for (const file of fs.readdirSync(src).sort()) {
        const fileDesired = path.join(src, file);
        const fileDest = path.join(dest, file);
        actions.push({ name: `${name}/${file}`, dest: fileDest, desired: fileDesired, ...decideLink(fileDest, fileDesired, source) });
      }
      continue;
    }
    actions.push({ name, dest, desired: src, action: "skip", reason: "real file, left alone" });
  }
  return actions;
}

export function applyActions(actions) {
  for (const a of actions) {
    if (a.action === "link" || a.action === "relink") {
      if (a.action === "relink") fs.unlinkSync(a.dest);
      fs.mkdirSync(path.dirname(a.dest), { recursive: true });
      fs.symlinkSync(a.desired, a.dest);
    }
  }
}

function describe(a) {
  if (a.action === "ok") return `ok       ${a.name}`;
  if (a.action === "link") return `link     ${a.name} -> ${a.desired}`;
  if (a.action === "relink") return `relink   ${a.name} (was ${a.from}) -> ${a.desired}`;
  return `skip     ${a.name}: ${a.reason}`;
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const check = argv.includes("--check");
  const tIndex = argv.indexOf("--target");
  const target = tIndex >= 0 ? path.resolve(argv[tIndex + 1]) : DEFAULT_TARGET;
  const actions = planLinks(DEFAULT_SOURCE, target);
  for (const a of actions) console.log(describe(a));
  const pending = actions.filter((a) => a.action === "link" || a.action === "relink");
  if (check) {
    console.log(pending.length === 0 ? "check: CURRENT" : `check: ${pending.length} link(s) missing or stale`);
    process.exit(pending.length === 0 ? 0 : 1);
  }
  if (dryRun) {
    console.log(`dry-run: ${pending.length} change(s) pending, nothing written`);
    return;
  }
  applyActions(actions);
  console.log(`applied: ${pending.length} change(s)`);
}

if (import.meta.main) main(process.argv.slice(2));
