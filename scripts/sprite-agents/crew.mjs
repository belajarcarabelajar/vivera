// The crew roster and the role templates it points at, plus the small helpers
// every renderer shares. Nothing here knows about a target harness.
import fs from 'node:fs';
import path from 'node:path';
import { ENUMS } from '../validate-agents.mjs';

const SPRITE_NAME = /^[a-z][a-z0-9-]*$/;
// A key outside this list is a typo or a field no renderer reads, so it throws instead of being ignored.
const CREW_KEYS = ['sprite', 'role', 'color'];

export function splitFrontmatter(text, label) {
  // A CRLF template would otherwise fail the "---" comparison and report no frontmatter.
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end === -1) throw new Error(`${label}: no frontmatter between two "---" lines`);
  return { head: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function checkHookRoot(hookRoot) {
  // The root lands inside a double-quoted YAML string that the hook runner hands
  // to a shell, so a quote, a backslash, or an expansion character would change
  // the command instead of naming a directory. Control characters (C0 and DEL)
  // are refused as a class: Bun.YAML fails to parse a CR, an LF, or a NUL inside
  // the string and drops a DEL without a message, so the hook would name another
  // directory. A tab, an ESC and the rest parse but never belong in a path here.
  if (!path.isAbsolute(hookRoot) || /["\\$`\u0000-\u001f\u007f]/.test(hookRoot)) {
    throw new Error(`hook root must be an absolute path without quotes, backslashes, "$", backticks, or control characters (got ${JSON.stringify(hookRoot)})`);
  }
}

export function parseCrew(json) {
  const crew = JSON.parse(json);
  if (!Array.isArray(crew)) throw new Error('crew must be a JSON array');
  if (crew.length === 0) throw new Error('crew must not be empty');
  const seen = new Set();
  crew.forEach((m, i) => {
    const at = `crew[${i}]`;
    if (typeof m?.sprite !== 'string' || !SPRITE_NAME.test(m.sprite)) {
      throw new Error(`${at}: "sprite" must be lowercase letters, digits, and hyphens`);
    }
    if (seen.has(m.sprite)) throw new Error(`${at}: duplicate sprite "${m.sprite}"`);
    seen.add(m.sprite);
    if (typeof m.role !== 'string' || !SPRITE_NAME.test(m.role)) throw new Error(`${at}: "role" must name a template in agents/roles`);
    if (!ENUMS.color.includes(m.color)) throw new Error(`${at}: "color" must be one of ${ENUMS.color.join(', ')}`);
    for (const key of Object.keys(m)) {
      if (!CREW_KEYS.includes(key)) throw new Error(`crew: unknown key "${key}" for sprite "${m.sprite}"`);
    }
  });
  return crew;
}

// Repository-relative paths that the templates' hooks run under $CLAUDE_PROJECT_DIR.
export function hookScripts(template) {
  const found = new Set();
  for (const m of template.matchAll(/\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR\b)(?:\\?")?(\/[^\s"\\]+)/g)) found.add(m[1]);
  return [...found];
}

// Every sprite paired with its role template, in roster order. A sprite whose
// role has no template, or a template no sprite uses, is an error, so a role
// cannot vanish from the output silently.
export function loadCrewPlan({ rolesDir, crewFile }) {
  const crew = parseCrew(fs.readFileSync(crewFile, 'utf8'));
  const roles = fs
    .readdirSync(rolesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
  for (const m of crew) {
    if (!roles.includes(m.role)) throw new Error(`crew: sprite "${m.sprite}" names role "${m.role}", which has no ${path.join(rolesDir, `${m.role}.md`)}`);
  }
  const idle = roles.filter((r) => !crew.some((m) => m.role === r));
  if (idle.length > 0) throw new Error(`crew: no sprite is assigned to role(s) ${idle.join(', ')}`);

  return crew.map((member) => ({ member, template: fs.readFileSync(path.join(rolesDir, `${member.role}.md`), 'utf8') }));
}
