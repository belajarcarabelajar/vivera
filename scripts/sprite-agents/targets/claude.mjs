// Claude Code subagent files. Claude Code labels a running subagent with its
// agent name, so each sprite is a named copy of one role template.
import { capitalize, checkHookRoot, splitFrontmatter } from '../crew.mjs';
import { MARKER } from '../sync.mjs';

const PROJECT_DIR = /\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR\b)/g;

// Only the description line is moved, so a value that goes on over the next
// lines (plain or quoted) would leave its continuation behind, after `color:`.
// The line read alone must give the whole value.
function readsAsOneLine(line, whole) {
  try {
    return Bun.YAML.parse(line)?.description === whole;
  } catch {
    return false;
  }
}

export function renderAgent(template, member, { hookRoot, templateLabel = `agents/roles/${member.role}.md` } = {}) {
  if (hookRoot !== undefined) checkHookRoot(hookRoot);
  const { head, body } = splitFrontmatter(template, templateLabel);
  const fm = Bun.YAML.parse(head.join('\n')) ?? {};
  for (const key of ['name', 'color']) {
    if (key in fm) throw new Error(`${templateLabel}: a role template must not set "${key}"; the crew roster sets it per sprite`);
  }
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    throw new Error(`${templateLabel}: "description" is required`);
  }
  const descLine = head.findIndex((l) => l.startsWith('description:'));
  if (descLine === -1 || /^description:\s*[|>]/.test(head[descLine]) || !readsAsOneLine(head[descLine], fm.description)) {
    throw new Error(`${templateLabel}: "description" must be a single line`);
  }

  const description = `${capitalize(member.sprite)}, a Harvest Sprite on the ${member.role} crew. ${fm.description.trim()}`;
  const rest = head.filter((_, i) => i !== descLine).map((l) => (hookRoot === undefined ? l : l.replace(PROJECT_DIR, hookRoot)));
  return [
    '---',
    `name: ${member.sprite}`,
    `description: ${JSON.stringify(description)}`,
    `color: ${member.color}`,
    ...rest,
    // A hook root marks the user-level render, which agents:gen does not rewrite; only ./install.sh does.
    `${MARKER} from ${templateLabel} and agents/crew.json; edit those, then run ${hookRoot === undefined ? 'bun run agents:gen' : './install.sh'}.`,
    '---',
    body,
  ].join('\n');
}

export default {
  id: 'claude',
  ext: '.md',
  outName: (sprite) => `${sprite}.md`,
  // The repository commits .claude/agents, so the default directory is safe.
  requiresOut: false,
  render: (template, member, ctx) => renderAgent(template, member, ctx),
};
