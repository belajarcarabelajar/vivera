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
// Pinned from the Claude Code docs of 2026-10-10. Names are camelCase and case-sensitive.
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

function listMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
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
    if (!fs.existsSync(path.join(skillsDir, skill, 'SKILL.md'))) {
      errors.push(`${label}: skill "${skill}" not found, expected ${path.join(skillsDir, skill, 'SKILL.md')}`);
    }
  }
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

  const seen = new Map();
  for (const file of files) {
    const label = path.relative(agentsDir, file);
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
