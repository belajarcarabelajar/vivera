// Cursor custom subagents: one Markdown file with YAML frontmatter per sprite in
// ~/.cursor/agents. The subagents page (read 2026-10-11) documents name,
// description, model, readonly, and is_background, none required, and no
// per-agent tool list. Files stay flat, because Cursor is reported to scan the
// directory recursively and to take any nested Markdown with frontmatter as an agent.
import { assertGitGuardHooks, readTemplate, skillLine, tomlString } from '../common.mjs';
import { proseGuard } from '../guard.mjs';
import { MARKER } from '../sync.mjs';

const TEMPLATE_KEYS = ['description', 'tools', 'skills', 'maxTurns', 'hooks'];

export function renderCursorAgent(template, member, { templateLabel = `agents/roles/${member.role}.md` } = {}) {
  // `tools` only decides readOnly here, since Cursor has no per-agent tool list.
  const { fm, body, description, readOnly, skills } = readTemplate(template, member, { allowedKeys: TEMPLATE_KEYS, target: 'cursor', templateLabel });
  // Cursor has no hooks in an agent file, so the git guard can only be asked for in prose.
  assertGitGuardHooks(fm, { templateLabel, target: 'cursor' });
  // maxTurns is dropped: Cursor has no such key.

  const guard = proseGuard();
  const skill = skillLine(skills, 'from your skills');
  return [
    '---',
    `name: ${member.sprite}`,
    // A JSON string is a valid YAML double-quoted scalar, so the colon and quotes in a description are safe.
    `description: ${tomlString(description)}`,
    'model: inherit',
    // readonly also bars state-changing shell commands, which the page lists as part of it.
    ...(readOnly ? ['readonly: true'] : []),
    // Cursor accepting a YAML comment inside frontmatter is unverified (Claude Code and OpenCode accept it).
    `${MARKER} from ${templateLabel} and agents/crew.json; edit those, then run ./install.sh.`,
    guard.comment,
    '---',
    '',
    ...(skill !== '' ? [skill, ''] : []),
    guard.paragraph,
    '',
    `${body.replace(/^\n+/, '').replace(/\n+$/, '')}\n`,
  ].join('\n');
}

export default {
  id: 'cursor',
  ext: '.md',
  outName: (sprite) => `${sprite}.md`,
  // Nothing of Cursor's is committed here, so there is no safe default directory.
  requiresOut: true,
  render: (template, member, ctx) => renderCursorAgent(template, member, ctx),
};
