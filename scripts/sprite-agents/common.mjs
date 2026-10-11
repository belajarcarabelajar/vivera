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

  let tools;
  if (typeof fm.tools === 'string') tools = fm.tools.split(',').map((t) => t.trim());
  else if (Array.isArray(fm.tools)) tools = fm.tools.map((t) => String(t).trim());

  return {
    fm,
    body,
    description: `${capitalize(member.sprite)}, a Harvest Sprite on the ${member.role} crew. ${fm.description.trim()}`,
    tools,
    readOnly: Array.isArray(tools) && !tools.some((t) => EDIT_TOOLS.includes(t)),
    skills: Array.isArray(fm.skills) ? fm.skills : [],
  };
}

const GUARD_SCRIPT = 'block-git-writes.mjs';

// A target without hooks can only translate the git guard (into permission
// rules or into prose). Any other hook would be dropped, so it throws instead.
export function assertGitGuardHooks(fm, { templateLabel, target }) {
  for (const entries of Object.values(fm.hooks ?? {})) {
    for (const hook of entries.flatMap((e) => e.hooks ?? [])) {
      if (!String(hook.command ?? '').includes(GUARD_SCRIPT)) {
        throw new Error(`${templateLabel}: ${target} has no hooks and only the git guard has a translation, not ${hook.command}`);
      }
    }
  }
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
