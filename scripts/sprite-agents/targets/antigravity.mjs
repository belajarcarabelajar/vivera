// Antigravity custom subagents: one Markdown file with YAML frontmatter per
// sprite. The subagents and /agents pages (read 2026-10-11) document name,
// description, tools, mainAgent, subagent, model, commandExecutionPolicy,
// mcpServers, skills and plugins. The CLI page shows only the directory form
// ~/.gemini/config/agents/<name>/agent.md, so that is the form written.
import { assertGitGuardHooks, readTemplate, skillLine, tomlString } from '../common.mjs';
import { proseGuard } from '../guard.mjs';
import { MARKER } from '../sync.mjs';

const TEMPLATE_KEYS = ['description', 'tools', 'skills', 'maxTurns', 'hooks'];

// The three names the subagents page uses in its example and its tools table.
const TOOL_MAP = { Read: 'view_file', Grep: 'grep_search', Glob: 'grep_search', Bash: 'run_command' };

function translateTools(tools, templateLabel) {
  const names = [];
  for (const tool of tools) {
    // A role's MCP servers are not configured on this harness, so naming one would only break the list.
    if (tool.startsWith('mcp__')) continue;
    // The page documents that an unmapped or misspelled name can hang the subagent, so it is refused, not passed on.
    if (!Object.hasOwn(TOOL_MAP, tool)) {
      throw new Error(`${templateLabel}: tool "${tool}" has no Antigravity translation in scripts/sprite-agents/targets/antigravity.mjs`);
    }
    if (!names.includes(TOOL_MAP[tool])) names.push(TOOL_MAP[tool]);
  }
  return names;
}

export function renderAntigravityAgent(template, member, { templateLabel = `agents/roles/${member.role}.md` } = {}) {
  const { fm, body, description, tools, skills } = readTemplate(template, member, { allowedKeys: TEMPLATE_KEYS, target: 'antigravity', templateLabel });
  // The agent file has no hooks, so the git guard can only be asked for in prose.
  assertGitGuardHooks(fm, { templateLabel, target: 'antigravity' });
  // maxTurns is dropped: the documented frontmatter has no such key.

  const guard = proseGuard();
  const skill = skillLine(skills, 'from your skills');
  return [
    '---',
    `name: ${member.sprite}`,
    // A JSON string is a valid YAML double-quoted scalar, so the colon and quotes in a description are safe.
    `description: ${tomlString(description)}`,
    'mainAgent: false',
    'subagent: true',
    'model: inherit',
    'commandExecutionPolicy: sandbox',
    // A role without `tools` gets no key. What an omitted list means here is unverified (the documented default is an empty list).
    ...(tools !== undefined ? [`tools: ${JSON.stringify(translateTools(tools, templateLabel))}`] : []),
    // Antigravity accepting a YAML comment inside frontmatter is unverified (Claude Code and OpenCode accept it).
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
  id: 'antigravity',
  ext: '.md',
  outName: (sprite) => `${sprite}/agent.md`,
  // Nothing of Antigravity's is committed here, so there is no safe default directory.
  requiresOut: true,
  render: (template, member, ctx) => renderAntigravityAgent(template, member, ctx),
};
