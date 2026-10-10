#!/usr/bin/env bun
// scripts/validate-agents.mjs
//
// Validates Claude Code project subagent files (.claude/agents/*.md).
//
// Claude Code fails silently on both things this checks: it ignores frontmatter
// fields it does not recognise (so `maxTurn:` is accepted and does nothing), and
// it skips a file whose first line is not `---` (the file is treated as
// documentation). Neither produces a warning, so only a gate can catch them.
//
// Usage: bun scripts/validate-agents.mjs [agentsDir] [skillsDir]
// Exit: 0 clean, 1 errors found.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// defer: pinned field list, re-check against the docs when Claude Code adds a field the validator rejects
// Pinned from the Claude Code docs of 2026-10-10: the field names, the enum values
// (permissionMode, color, memory, effort, isolation) and the value types below.
// Names are camelCase and case-sensitive.
export const ALLOWED_FIELDS = [
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'maxTurns',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'omitClaudeMd',
  'effort',
  'isolation',
  'color',
  'initialPrompt',
  'experimental',
];

const NAME_MAX = 256;

export const ENUMS = {
  permissionMode: ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan', 'manual'],
  color: ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'],
  memory: ['user', 'project', 'local'],
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  isolation: ['worktree'],
};

// Returns [{ file, dangling }] sorted by path. A symlink to a file is scanned like
// a file; a symlink to a directory is not followed, which also rules out cycles.
function listMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdown(full));
      continue;
    }
    // Claude Code treats README.md as documentation, not an agent.
    if (!entry.name.endsWith('.md') || /^readme\.md$/i.test(entry.name)) continue;
    if (entry.isFile()) {
      out.push({ file: full, dangling: false });
    } else if (entry.isSymbolicLink()) {
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        out.push({ file: full, dangling: true });
        continue;
      }
      if (stat.isFile()) out.push({ file: full, dangling: false });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function extractFrontmatter(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== '---') return { problem: 'first line is not "---", so Claude Code treats the file as documentation and skips it' };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { problem: 'frontmatter is not closed by a second "---" line' };
  return { yaml: lines.slice(1, end).join('\n') };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkName(name, label, errors) {
  if (name === undefined) return errors.push(`${label}: "name" is required`);
  if (typeof name !== 'string' || name === '') return errors.push(`${label}: "name" must be a non-empty string`);
  if (name.startsWith('-')) errors.push(`${label}: "name" must not start with "-" (got "${name}")`);
  if (name.includes(':')) errors.push(`${label}: "name" must not contain ":" (got "${name}")`);
  if (name.length > NAME_MAX) errors.push(`${label}: "name" is ${name.length} characters, max is ${NAME_MAX}`);
}

function checkSkills(skills, label, skillsDir, errors) {
  if (!Array.isArray(skills) || !skills.every((s) => typeof s === 'string')) {
    return errors.push(`${label}: "skills" must be a YAML list of strings`);
  }
  for (const skill of skills) {
    if (skill === '' || skill.includes('/') || skill.includes('\\') || skill.includes('..')) {
      errors.push(`${label}: "skills" entry "${skill}" must be a bare skill name and must not contain "/", "\\" or ".."`);
    } else if (!fs.existsSync(path.join(skillsDir, skill, 'SKILL.md'))) {
      errors.push(
        `${label}: skill "${skill}" has no skills/${skill}/SKILL.md in this repository (Claude Code resolves skills from installed locations; run ./install.sh)`,
      );
    }
  }
}

// $CLAUDE_PROJECT_DIR is the repository root, and the agents live in
// <root>/.claude/agents. A caller may pass an agents dir that is not under a
// .claude folder, so fall back to the parent of its parent instead of guessing.
function repoRootFor(agentsDir) {
  let dir = path.resolve(agentsDir);
  while (path.dirname(dir) !== dir) {
    if (path.basename(dir) === '.claude') return path.dirname(dir);
    dir = path.dirname(dir);
  }
  return path.dirname(path.dirname(path.resolve(agentsDir)));
}

// defer: only $CLAUDE_PROJECT_DIR references are resolved, upgrade when agents use relative or absolute script paths
function projectDirPaths(command) {
  const found = [];
  for (const m of command.matchAll(/\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR\b)/g)) {
    const before = command.slice(0, m.index);
    let rest = command.slice(m.index + m[0].length);
    // An odd number of quotes before the variable means it sits inside an open
    // quote, so the path runs to the matching quote instead of to whitespace.
    let quote = null;
    if ((before.match(/["']/g) ?? []).length % 2 === 1) {
      quote = before.match(/["'](?=[^"']*$)/)[0];
      if (rest.startsWith(quote)) {
        rest = rest.slice(1);
        quote = null;
      }
    }
    let end = 0;
    while (end < rest.length) {
      const c = rest[end];
      if (quote ? c === quote : /[\s"']/.test(c)) break;
      end++;
    }
    const rel = rest.slice(0, end);
    if (rel !== '') found.push(rel);
  }
  return found;
}

function checkHookScript(command, at, label, root, errors) {
  for (const rel of projectDirPaths(command)) {
    const resolved = path.join(root, rel);
    let stat = null;
    try {
      stat = fs.statSync(resolved);
    } catch {}
    if (!stat) errors.push(`${label}: ${at}.command runs ${resolved}, which does not exist`);
    else if (!stat.isFile()) errors.push(`${label}: ${at}.command runs ${resolved}, which is not a regular file`);
  }
}

function checkHooks(hooks, label, root, errors) {
  if (!isPlainObject(hooks)) return errors.push(`${label}: "hooks" must be a mapping of event name to a list`);
  for (const [event, entries] of Object.entries(hooks)) {
    const at = `hooks.${event}`;
    if (!/^[A-Z][A-Za-z]+$/.test(event)) {
      errors.push(`${label}: ${at} is not a valid event name (PascalCase, for example PreToolUse)`);
    }
    if (!Array.isArray(entries)) {
      errors.push(`${label}: ${at} must be an array`);
      continue;
    }
    entries.forEach((entry, i) => {
      const ep = `${at}[${i}]`;
      if (!isPlainObject(entry)) return errors.push(`${label}: ${ep} must be an object`);
      if ('matcher' in entry && typeof entry.matcher !== 'string') {
        errors.push(`${label}: ${ep}.matcher must be a string`);
      }
      if (!Array.isArray(entry.hooks)) return errors.push(`${label}: ${ep}.hooks must be an array`);
      entry.hooks.forEach((hook, j) => {
        const hp = `${ep}.hooks[${j}]`;
        if (!isPlainObject(hook)) return errors.push(`${label}: ${hp} must be an object`);
        if (typeof hook.type !== 'string' || hook.type === '') {
          return errors.push(`${label}: ${hp}.type must be a string`);
        }
        if (hook.type === 'command' && (typeof hook.command !== 'string' || hook.command.trim() === '')) {
          errors.push(`${label}: ${hp}.command must be a non-empty string when type is "command"`);
        } else if (hook.type === 'command') {
          checkHookScript(hook.command, hp, label, root, errors);
        }
      });
    });
  }
}

function checkValueTypes(fm, label, errors) {
  const bad = (key, want) => errors.push(`${label}: "${key}" must be ${want}`);
  for (const key of ['tools', 'disallowedTools']) {
    if (!(key in fm)) continue;
    const v = fm[key];
    if (typeof v !== 'string' && !(Array.isArray(v) && v.every((s) => typeof s === 'string'))) {
      bad(key, 'a string or a list of strings');
    }
  }
  if ('model' in fm && (typeof fm.model !== 'string' || fm.model.trim() === '')) bad('model', 'a non-empty string');
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (key in fm && !allowed.includes(fm[key])) bad(key, `one of ${allowed.join(', ')}`);
  }
  for (const key of ['background', 'omitClaudeMd']) {
    if (key in fm && typeof fm[key] !== 'boolean') bad(key, 'a boolean');
  }
  if ('initialPrompt' in fm && typeof fm.initialPrompt !== 'string') bad('initialPrompt', 'a string');
  if ('mcpServers' in fm && !Array.isArray(fm.mcpServers) && !isPlainObject(fm.mcpServers)) {
    bad('mcpServers', 'a list or a mapping');
  }
  if ('experimental' in fm && !isPlainObject(fm.experimental)) bad('experimental', 'a mapping');
}

export function validateAgentsDir(agentsDir, skillsDir) {
  const errors = [];
  const agents = [];

  if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    return { errors: [`${agentsDir}: agents directory does not exist`], agents };
  }

  const files = listMarkdown(agentsDir);
  if (files.length === 0) {
    return { errors: [`${agentsDir}: no agent files found`], agents };
  }

  const root = repoRootFor(agentsDir);
  const seen = new Map();
  for (const { file, dangling } of files) {
    const label = path.relative(agentsDir, file);
    if (dangling) {
      errors.push(`${label}: dangling symlink, its target does not exist`);
      continue;
    }
    const { yaml, problem } = extractFrontmatter(fs.readFileSync(file, 'utf8'));
    if (problem) {
      errors.push(`${label}: ${problem}`);
      continue;
    }

    let fm;
    try {
      fm = Bun.YAML.parse(yaml);
    } catch (e) {
      errors.push(`${label}: frontmatter is not valid YAML (${String(e.message).split('\n')[0]})`);
      continue;
    }
    if (!isPlainObject(fm)) {
      errors.push(`${label}: frontmatter must be a YAML mapping`);
      continue;
    }

    const before = errors.length;

    for (const key of Object.keys(fm)) {
      if (!ALLOWED_FIELDS.includes(key)) {
        errors.push(`${label}: unknown frontmatter field "${key}" (Claude Code ignores it silently; field names are camelCase and case-sensitive)`);
      }
    }

    checkName(fm.name, label, errors);
    if (typeof fm.description !== 'string' || fm.description.trim() === '') {
      errors.push(`${label}: "description" is required and must be a non-empty string`);
    }
    if ('skills' in fm) checkSkills(fm.skills, label, skillsDir, errors);
    if ('hooks' in fm) checkHooks(fm.hooks, label, root, errors);
    checkValueTypes(fm, label, errors);
    if ('maxTurns' in fm && !(Number.isInteger(fm.maxTurns) && fm.maxTurns > 0)) {
      errors.push(`${label}: "maxTurns" must be a positive integer`);
    }

    if (typeof fm.name === 'string' && fm.name !== '') {
      if (seen.has(fm.name)) {
        errors.push(`${label}: duplicate agent name "${fm.name}", already used by ${seen.get(fm.name)}`);
      } else {
        seen.set(fm.name, label);
        if (errors.length === before) agents.push(fm.name);
      }
    }
  }

  return { errors, agents };
}

if (import.meta.main) {
  const agentsDir = path.resolve(process.argv[2] ?? path.join(ROOT, '.claude', 'agents'));
  const skillsDir = path.resolve(process.argv[3] ?? path.join(ROOT, 'skills'));
  const { errors, agents } = validateAgentsDir(agentsDir, skillsDir);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  console.log(`agents OK: ${agents.length} agent(s)`);
}
