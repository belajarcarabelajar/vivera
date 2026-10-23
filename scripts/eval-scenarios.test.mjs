import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ASSERTION_TYPES } from './eval-score.mjs';

const ROOT = join(import.meta.dir, '..');
const SCENARIO_DIR = join(ROOT, 'evals', 'scenarios');
const FIXTURE_DIR = join(ROOT, 'evals', 'fixtures');
// bypassPermissions is refused: it also drops the user's safety hooks.
const PERMISSION_MODES = ['dontAsk', 'default', 'acceptEdits', 'plan'];
// An allowed_tools entry may never widen the runner's lock to deleting, pushing, or gh.
const FORBIDDEN_TOOL = /\brm\b|\bpush\b|\bgh\b/;
const UNRESTRICTED_BASH = /^Bash(\(\s*\*\s*\))?$/;
const SCOPES = ['main', 'sub', 'all'];
const MAX_FIXTURE_FILE_BYTES = 2048;

const SKILL_DIR = join(ROOT, 'skills');
const SKILLS = readdirSync(SKILL_DIR).filter((name) => statSync(join(SKILL_DIR, name)).isDirectory());
// invoke, when present, names the skill the runner prefixes as /<skill>, or is false for a bare prompt.
const invokeOk = (value) => value === undefined || value === false || (isNamed(value) && SKILLS.includes(value));
function isNamed(value) {
  return typeof value === 'string' && value.length > 0;
}

const scenarioFiles = existsSync(SCENARIO_DIR)
  ? readdirSync(SCENARIO_DIR).filter((name) => name.endsWith('.json')).sort()
  : [];

function load(file) {
  return JSON.parse(readFileSync(join(SCENARIO_DIR, file), 'utf8'));
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? [full, ...walk(full)] : [full];
  });
}

// The scorer strips a leading PCRE-style (?i) and sets the i flag instead.
function compiles(pattern) {
  try {
    new RegExp(pattern.startsWith('(?i)') ? pattern.slice(4) : pattern);
    return true;
  } catch {
    return false;
  }
}

const isScope = (value) => SCOPES.includes(value);
const isString = (value) => typeof value === 'string' && value.length > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;

// Returns the problems with one assertion's fields, so a failure names them.
function assertionProblems(a) {
  const problems = [];
  const need = (ok, what) => { if (!ok) problems.push(`${a.type}: ${what}`); };
  switch (a.type) {
    case 'final_options':
      need(isCount(a.min) && a.min >= 1, 'min must be a positive integer');
      break;
    case 'gate_count':
      need(a.min !== undefined || a.max !== undefined, 'needs min or max');
      if (a.min !== undefined) need(isCount(a.min), 'min must be a count');
      if (a.max !== undefined) need(isCount(a.max), 'max must be a count');
      break;
    case 'tool_count':
      need(isString(a.tool), 'tool must be a string');
      need(isScope(a.scope), 'scope must be main, sub, or all');
      need(a.min !== undefined || a.max !== undefined, 'needs min or max');
      if (a.min !== undefined) need(isCount(a.min), 'min must be a count');
      if (a.max !== undefined) need(isCount(a.max), 'max must be a count');
      if (isCount(a.min) && isCount(a.max)) need(a.min <= a.max, 'min must not exceed max');
      break;
    case 'skill_loaded':
      need(isString(a.skill) && SKILLS.includes(a.skill), 'skill must name a directory under skills/');
      need(isScope(a.scope), 'scope must be main, sub, or all');
      if (a.before !== undefined) need(isString(a.before) && compiles(a.before), 'before must be a valid RegExp');
      break;
    case 'bash_never':
    case 'bash_some':
      need(isString(a.pattern) && compiles(a.pattern), 'pattern must be a valid RegExp');
      need(isScope(a.scope), 'scope must be main, sub, or all');
      break;
    case 'file_exists':
    case 'file_missing':
    case 'file_unchanged':
      need(isString(a.path), 'path must be a string');
      break;
    case 'file_lacks':
      need(isString(a.path), 'path must be a string');
      need(isString(a.pattern) && compiles(a.pattern), 'pattern must be a valid RegExp');
      break;
    case 'final_matches':
    case 'commits_lack':
      need(isString(a.pattern) && compiles(a.pattern), 'pattern must be a valid RegExp');
      break;
    case 'final_mentions':
      need(Array.isArray(a.patterns) && a.patterns.length > 0
        && a.patterns.every((p) => isString(p) && compiles(p)), 'patterns must be valid RegExps');
      need(isCount(a.min) && a.min >= 1 && a.min <= (a.patterns?.length ?? 0), 'min must be 1..patterns.length');
      break;
  }
  return problems;
}

describe('eval scenarios', () => {
  test('the scenario directory holds about twenty scenarios', () => {
    expect(scenarioFiles.length).toBeGreaterThanOrEqual(15);
  });

  test('ids are unique and match their file names', () => {
    const ids = scenarioFiles.map((file) => load(file).id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const file of scenarioFiles) expect(load(file).id).toBe(basename(file, '.json'));
  });

  for (const file of scenarioFiles) {
    describe(file, () => {
      const s = load(file);

      test('top-level fields have the right types and caps', () => {
        expect(isString(s.behaviour)).toBe(true);
        expect(s.behaviour.includes('\n')).toBe(false);
        // Exactly one of a prompt (one turn) or turns (two or more, each with a prompt).
        expect(isString(s.prompt)).toBe(s.turns === undefined);
        if (s.turns !== undefined) {
          expect(Array.isArray(s.turns) && s.turns.length >= 2).toBe(true);
          expect(s.turns.every((t) => isString(t.prompt) && (t.assertions === undefined || Array.isArray(t.assertions)))).toBe(true);
        }
        expect(isString(s.fixture)).toBe(true);
        expect(Number.isInteger(s.max_turns)).toBe(true);
        expect(s.max_turns).toBeGreaterThanOrEqual(1);
        expect(s.max_turns).toBeLessThanOrEqual(16);
        expect(PERMISSION_MODES).toContain(s.permission_mode);
        // The runner applies one uniform ceiling; a per-scenario budget is ignored, and
        // when the model could see it, it skipped fan-out to stay inside it.
        expect(s.budget_usd).toBeUndefined();
        expect(Array.isArray(s.assertions)).toBe(true);
        expect(s.assertions.length).toBeGreaterThan(0);
      });

      test('invoke, when present, is false or names a directory under skills/', () => {
        expect(invokeOk(s.invoke)).toBe(true);
      });

      test('allowed_tools, when present, lists strings that never allow rm, push, or gh', () => {
        if (s.allowed_tools === undefined) return;
        expect(Array.isArray(s.allowed_tools)).toBe(true);
        expect(s.allowed_tools.every(isString)).toBe(true);
        expect(s.allowed_tools.filter((t) => FORBIDDEN_TOOL.test(t) || UNRESTRICTED_BASH.test(t))).toEqual([]);
      });

      test('the overlay, when present, maps relative paths to strings', () => {
        if (s.overlay === undefined) return;
        expect(typeof s.overlay).toBe('object');
        for (const [path, content] of Object.entries(s.overlay)) {
          expect(path.startsWith('/') || path.split('/').includes('..')).toBe(false);
          expect(path.startsWith('.claude') || path === '.mcp.json').toBe(false);
          expect(typeof content).toBe('string');
        }
      });

      test('the fixture exists and carries no settings, hooks, or MCP config', () => {
        const dir = join(FIXTURE_DIR, s.fixture);
        expect(existsSync(dir) && statSync(dir).isDirectory()).toBe(true);
        const files = walk(dir).map((full) => full.slice(dir.length + 1));
        expect(files.filter((f) => f === '.claude' || f.startsWith('.claude/'))).toEqual([]);
        expect(files.filter((f) => basename(f) === '.mcp.json')).toEqual([]);
      });

      test('every assertion type is one the scorer knows, with valid fields', () => {
        const all = [...s.assertions, ...(s.turns ?? []).flatMap((t) => t.assertions ?? [])];
        for (const a of all) expect(ASSERTION_TYPES).toContain(a.type);
        expect(all.flatMap(assertionProblems)).toEqual([]);
      });
    });
  }
});

describe('eval fixtures', () => {
  test('the invoke check accepts false or a skill directory and rejects anything else', () => {
    expect([undefined, false, 'super-ultra-code-plan', 'sucp-rules'].every(invokeOk)).toBe(true);
    expect(['no-such-skill', '', 3, true, null].some(invokeOk)).toBe(false);
  });

  test('every fixture file stays under 2 KB', () => {
    const big = existsSync(FIXTURE_DIR)
      ? walk(FIXTURE_DIR)
        .filter((full) => !full.includes('/streams/') && statSync(full).isFile())
        .filter((full) => statSync(full).size >= MAX_FIXTURE_FILE_BYTES)
      : ['evals/fixtures is missing'];
    expect(big).toEqual([]);
  });
});
