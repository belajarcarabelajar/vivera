// Copilot CLI custom agents: one Markdown file with YAML frontmatter per sprite
// in ~/.copilot/agents. The configuration page (read 2026-10-11) requires only
// `description`, takes `tools` as a list with case-insensitive aliases, and caps
// the prompt at 30,000 characters.
import { assertGitGuardHooks, readTemplate, skillLine, tomlString } from '../common.mjs';
import { proseGuard } from '../guard.mjs';
import { MARKER } from '../sync.mjs';

const TEMPLATE_KEYS = ['description', 'tools', 'skills', 'maxTurns', 'hooks'];
const MAX_PROMPT = 30000;

// Claude Code tool name to the Copilot alias that covers it.
const TOOL_MAP = {
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  Bash: 'execute',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
};

function translateTools(tools, templateLabel) {
  const out = [];
  for (const name of tools) {
    // Copilot MCP tools are addressed as `server/tool` and need a configured server.
    if (name.startsWith('mcp__')) continue;
    if (!Object.hasOwn(TOOL_MAP, name)) {
      throw new Error(`${templateLabel}: tool "${name}" has no Copilot translation in scripts/sprite-agents/targets/copilot.mjs`);
    }
    if (!out.includes(TOOL_MAP[name])) out.push(TOOL_MAP[name]);
  }
  return out;
}

export function renderCopilotAgent(template, member, { templateLabel = `agents/roles/${member.role}.md` } = {}) {
  const { fm, body, description, tools, skills } = readTemplate(template, member, { allowedKeys: TEMPLATE_KEYS, target: 'copilot', templateLabel });
  assertGitGuardHooks(fm, { templateLabel, target: 'copilot' });
  // maxTurns is dropped: Copilot has no such key.

  const guard = proseGuard();
  const skill = skillLine(skills, 'from your skills');
  // The shell tool is all-or-nothing in frontmatter, so the prose guard is the only git rule here.
  const prompt = ['', ...(skill !== '' ? [skill, ''] : []), guard.paragraph, '', `${body.replace(/^\n+/, '').replace(/\n+$/, '')}\n`].join('\n');
  if (prompt.length > MAX_PROMPT) {
    throw new Error(`${templateLabel}: the prompt is ${prompt.length} characters, over the ${MAX_PROMPT} that Copilot allows`);
  }

  return [
    '---',
    `name: ${member.sprite}`,
    // A JSON string is a valid YAML double-quoted scalar, so the colon and quotes in a description are safe.
    `description: ${tomlString(description)}`,
    // No tools key means all tools. A list that translates to nothing, such as only MCP tools, becomes [] (none), the stricter side.
    ...(tools !== undefined ? [`tools: ${JSON.stringify(translateTools(tools, templateLabel))}`] : []),
    // Copilot accepting a YAML comment inside frontmatter is unverified (Claude Code and OpenCode accept it).
    `${MARKER} from ${templateLabel} and agents/crew.json; edit those, then run ./install.sh.`,
    guard.comment,
    '---',
    prompt,
  ].join('\n');
}

export default {
  id: 'copilot',
  // The file is <sprite>.agent.md, which still ends in .md, so syncDir's listing finds it.
  ext: '.md',
  outName: (sprite) => `${sprite}.agent.md`,
  // Nothing of Copilot's is committed here, so there is no safe default directory.
  requiresOut: true,
  render: (template, member, ctx) => renderCopilotAgent(template, member, ctx),
};
