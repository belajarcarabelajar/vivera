// Codex custom agents: one TOML file per sprite in ~/.codex/agents. The subagents
// page (read 2026-10-11) requires name, description, and developer_instructions,
// and accepts other config.toml keys such as model and sandbox_mode.
import { assertGitGuardHooks, readTemplate, skillLine, tomlString } from '../common.mjs';
import { proseGuard } from '../guard.mjs';
import { MARKER } from '../sync.mjs';

const TEMPLATE_KEYS = ['description', 'tools', 'skills', 'maxTurns', 'hooks'];
// A TOML multi-line literal string cannot hold these, and has no escape for them.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Written above a read-only sprite's sandbox_mode. The role.rs and role_tests.rs claims were read
// in the source at the tag named; the two issues are user reports, read but not reproduced here.
const SANDBOX_NOTE = [
  '# sandbox_mode below is a request: Codex may not enforce sandbox_mode for a custom agent.',
  '# In openai/codex at rust-v0.162.1 (read 2026-10-11), core/src/agent/role.rs gives',
  '# AgentRoleOverrides no sandbox field, and role_tests.rs asserts that the role layer carries no',
  "# sandbox_mode and that config.permissions equals the parent's.",
  '# Reported, not verified here: issues #45482 and #40130 show a read-only agent writing under',
  '# a workspace-write parent.',
  '# The only controls are the prose guard in developer_instructions (instruction only) and the',
  "# parent session's sandbox.",
];

export function renderCodexAgent(template, member, { templateLabel = `agents/roles/${member.role}.md` } = {}) {
  const { fm, body, description, readOnly, skills } = readTemplate(template, member, { allowedKeys: TEMPLATE_KEYS, target: 'codex', templateLabel });
  // Codex has no hooks in an agent file, so the git guard can only be asked for in prose.
  assertGitGuardHooks(fm, { templateLabel, target: 'codex' });
  // maxTurns is dropped: the subagents page lists no turn limit key.

  const guard = proseGuard();
  const parts = [];
  // skills/src/selection.rs (rust-v0.162.1) collects $ mentions from UserInput::Text and
  // UserInput::Skill only, so this text cannot preload a skill. It asks for a best-effort load.
  const skill = skillLine(skills, 'if it is available to you (the user can also name it with a $ mention)');
  if (skill !== '') parts.push(skill, '');
  parts.push(guard.paragraph, '', body.replace(/^\n+/, ''));
  const instructions = parts.join('\n');
  // A literal string (single quotes) takes backslashes as they are, so the body needs no escaping.
  if (instructions.includes("'''")) {
    throw new Error(`${templateLabel}: the text contains three single quotes ('''), which would end the TOML literal string of developer_instructions`);
  }
  // splitFrontmatter has already turned every CRLF into LF, so a carriage return left here is a bare one.
  // TOML rejects it in a string, and CONTROL lets it through.
  if (instructions.includes('\r')) {
    throw new Error(`${templateLabel}: the text contains a bare carriage return, which TOML rejects in a string`);
  }
  if (CONTROL.test(instructions)) {
    throw new Error(`${templateLabel}: the text contains a control character, which a TOML literal string cannot hold`);
  }

  return [
    `${MARKER} from ${templateLabel} and agents/crew.json; edit those, then run ./install.sh.`,
    guard.comment,
    `name = ${tomlString(member.sprite)}`,
    `description = ${tomlString(description)}`,
    // A writer leaves sandbox_mode out and inherits the parent's. The page also says
    // the parent's live overrides (/permissions, --yolo) win over this file. The line stays for a
    // read-only role because the page documents it; SANDBOX_NOTE says it may not be enforced.
    ...(readOnly ? [...SANDBOX_NOTE, 'sandbox_mode = "read-only"'] : []),
    "developer_instructions = '''",
    `${instructions.endsWith('\n') ? instructions : `${instructions}\n`}'''`,
    '',
  ].join('\n');
}

export default {
  id: 'codex',
  ext: '.toml',
  outName: (sprite) => `${sprite}.toml`,
  // Nothing of Codex's is committed here, so there is no safe default directory.
  requiresOut: true,
  render: (template, member, ctx) => renderCodexAgent(template, member, ctx),
};
