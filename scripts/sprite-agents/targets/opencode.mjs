// OpenCode v2 agent files, which skip a Claude Code file without a message.
import { capitalize, splitFrontmatter } from '../crew.mjs';
import { MARKER } from '../sync.mjs';

// OpenCode v2 takes a six-digit hex color and skips the whole agent, without a
// message, when it gets a color name (measured on v2.0.24).
export const OPENCODE_COLORS = {
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#ffc53d',
  green: '#46a758',
  blue: '#0090ff',
  purple: '#8e4ec6',
  pink: '#d6409f',
  cyan: '#00a2c7',
};

const GUARD_SCRIPT = 'block-git-writes.mjs';
const OPENCODE_TEMPLATE_KEYS = ['description', 'tools', 'skills', 'maxTurns', 'hooks'];

// OpenCode has no hooks, so the git guard becomes shell permission rules. The
// last matching rule wins and each command of a chain is matched on its own
// (both measured on v2.0.24). The rtk plugin rewrites `git x` to `rtk git x`
// before the match, so every rule also has an rtk form. Matching arguments the
// way the hook does would take hundreds of globs, so this is an allowlist: all
// of git and gh is denied, then common read-only forms are allowed again. An
// allowed pattern only ends in a wildcard, because a wildcard in the middle
// (`git -C * diff*`) also matches `git -C x commit -m "fix diff"`.
const GIT_READS = [
  'status', 'diff', 'log', 'show', 'blame', 'grep', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree',
  'cat-file', 'describe', 'shortlog', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref',
  'count-objects', 'reflog show', 'stash list', 'stash show', 'worktree list', 'remote -v',
  'remote get-url', 'branch --show-current', 'branch --list', 'tag --list', 'config --get', 'config --list',
];
const GIT_BARE_READS = ['branch', 'tag', 'reflog', 'remote', 'version', '--version'];

function openCodeShellRules() {
  const deny = ['git *', 'rtk git *', 'gh', 'gh *', 'rtk gh *', '*/git *', '*/gh *'];
  const allow = [];
  for (const prefix of ['git', 'rtk git']) {
    for (const sub of GIT_READS) allow.push(`${prefix} ${sub}*`);
    for (const sub of GIT_BARE_READS) allow.push(`${prefix} ${sub}`);
  }
  return [
    ...deny.map((resource) => ({ action: 'shell', resource, effect: 'deny' })),
    ...allow.map((resource) => ({ action: 'shell', resource, effect: 'allow' })),
  ];
}

export function renderOpenCodeAgent(template, member, { templateLabel = `agents/roles/${member.role}.md` } = {}) {
  const { head, body } = splitFrontmatter(template, templateLabel);
  const fm = Bun.YAML.parse(head.join('\n')) ?? {};
  for (const key of Object.keys(fm)) {
    if (!OPENCODE_TEMPLATE_KEYS.includes(key)) {
      throw new Error(`${templateLabel}: "${key}" has no OpenCode translation in scripts/sprite-agents/targets/opencode.mjs; add one before using it`);
    }
  }
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    throw new Error(`${templateLabel}: "description" is required`);
  }
  for (const entries of Object.values(fm.hooks ?? {})) {
    for (const hook of entries.flatMap((e) => e.hooks ?? [])) {
      if (!String(hook.command ?? '').includes(GUARD_SCRIPT)) {
        throw new Error(`${templateLabel}: OpenCode has no hooks and only the git guard has a permission translation, not ${hook.command}`);
      }
    }
  }

  const permissions = fm.hooks ? openCodeShellRules() : [];
  const tools = typeof fm.tools === 'string' ? fm.tools.split(',').map((t) => t.trim()) : fm.tools;
  if (Array.isArray(tools) && !tools.some((t) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(t))) {
    permissions.push({ action: 'edit', resource: '*', effect: 'deny' });
  }

  const description = `${capitalize(member.sprite)}, a Harvest Sprite on the ${member.role} crew. ${fm.description.trim()}`;
  const lines = ['---', `description: ${JSON.stringify(description)}`, 'mode: subagent', `color: "${OPENCODE_COLORS[member.color]}"`];
  if (Number.isInteger(fm.maxTurns)) lines.push(`steps: ${fm.maxTurns}`);
  if (permissions.length > 0) {
    lines.push('permissions:');
    for (const p of permissions) lines.push(`  - { action: ${p.action}, resource: ${JSON.stringify(p.resource)}, effect: ${p.effect} }`);
  }
  lines.push(`${MARKER} from ${templateLabel} and agents/crew.json; edit those, then run ./install.sh.`, '---');

  const preface = [];
  if (Array.isArray(fm.skills) && fm.skills.length > 0) {
    const names = fm.skills.map((s) => `\`${s}\``).join(', ');
    preface.push('', `Load the ${names} skill with the skill tool before anything else; it holds the rules of your phase.`);
  }
  if (fm.hooks) {
    preface.push('', 'In this harness the guard allows only common read-only git forms and blocks `git -C`; run `cd <dir> && git <command>` instead.');
  }
  return [...lines, ...preface, body].join('\n');
}

export default {
  id: 'opencode',
  ext: '.md',
  outName: (sprite) => `${sprite}.md`,
  // Nothing of OpenCode's is committed here, so there is no safe default directory.
  requiresOut: true,
  render: (template, member, ctx) => renderOpenCodeAgent(template, member, ctx),
};
