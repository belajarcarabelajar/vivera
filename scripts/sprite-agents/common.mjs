// What every target renderer needs from a role template, so each one starts
// from the same checked view of it instead of its own copy of the parsing.
import { capitalize, splitFrontmatter } from './crew.mjs';

// The tools that change files. A role whose tools list has none of them is read-only.
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

// `allowedKeys` are the template keys this target can translate. Any other key
// throws instead of being dropped, so a field cannot vanish from one harness silently.
export function readTemplate(template, member, { allowedKeys, target, templateLabel = `agents/roles/${member.role}.md` }) {
  const { head, body } = splitFrontmatter(template, templateLabel);
  const fm = Bun.YAML.parse(head.join('\n')) ?? {};
  for (const key of Object.keys(fm)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${templateLabel}: "${key}" has no ${target} translation in scripts/sprite-agents/targets/${target}.mjs; add one before using it`);
    }
  }
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    throw new Error(`${templateLabel}: "description" is required`);
  }

  // Not a positive integer would be dropped or emitted as is, depending on the target.
  if ('maxTurns' in fm && !(Number.isInteger(fm.maxTurns) && fm.maxTurns > 0)) {
    throw new Error(`${templateLabel}: "maxTurns" must be a positive integer`);
  }

  let tools;
  if (typeof fm.tools === 'string') tools = fm.tools.split(',').map((t) => t.trim());
  else if (Array.isArray(fm.tools)) tools = fm.tools.map((t) => String(t).trim());

  return {
    fm,
    body,
    description: `${capitalize(member.sprite)}, a Harvest Sprite on the ${member.role} crew. ${fm.description.trim()}`,
    tools,
    readOnly: Array.isArray(tools) && !tools.some((t) => EDIT_TOOLS.includes(t)),
    skills: readSkills(fm.skills, templateLabel),
  };
}

// One name is a list of one; anything else that is not a list of names throws
// instead of vanishing from the output.
function readSkills(value, templateLabel) {
  if (value === undefined || value === null) return [];
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || s.trim() === '')) {
    throw new Error(`${templateLabel}: "skills" must be a skill name or a list of skill names`);
  }
  return list;
}

// The one command every role template uses for the git guard, as written in agents/roles/*.md.
const GUARD_COMMAND = 'bun "$CLAUDE_PROJECT_DIR"/.claude/hooks/block-git-writes.mjs';

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A target without hooks can only translate the git guard (into permission
// rules or into prose). Any other hook would be dropped, so it throws instead.
// A command counts as the guard only when it is exactly GUARD_COMMAND: a
// substring match would accept `rm -rf ~ # block-git-writes.mjs`. Returns whether
// the guard is there, so a target emits its rules only for a guarded role.
export function assertGitGuardHooks(fm, { templateLabel, target }) {
  const badShape = () => new Error(`${templateLabel}: "hooks" must map each event to a list of entries that each hold a list of hooks`);
  if (fm.hooks === undefined || fm.hooks === null) return false;
  if (!isMapping(fm.hooks)) throw badShape();
  let guarded = false;
  for (const entries of Object.values(fm.hooks)) {
    if (!Array.isArray(entries)) throw badShape();
    for (const entry of entries) {
      if (!isMapping(entry) || (entry.hooks !== undefined && !Array.isArray(entry.hooks))) throw badShape();
      for (const hook of entry.hooks ?? []) {
        if (!isMapping(hook)) throw badShape();
        if (hook.command !== GUARD_COMMAND) {
          throw new Error(`${templateLabel}: ${target} has no hooks and only the git guard has a translation, not ${hook.command}`);
        }
        guarded = true;
      }
    }
  }
  return guarded;
}

// `how` completes "Load the ... skill <how> before anything else".
export function skillLine(skills, how) {
  if (skills.length === 0) return '';
  const names = skills.map((s) => `\`${s}\``).join(', ');
  return `Load the ${names} skill ${how} before anything else; it holds the rules of your phase.`;
}

// A TOML basic string. JSON escapes the quote, the backslash and the control
// characters below U+0020 in forms TOML accepts; DEL is the one control it leaves raw.
export function tomlString(s) {
  if (typeof s !== 'string') throw new TypeError(`tomlString needs a string (got ${typeof s})`);
  return JSON.stringify(s).replaceAll('\u007f', '\\u007f');
}
