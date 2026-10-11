// OpenCode v2 agent files, which skip a Claude Code file without a message.
import { assertGitGuardHooks, readTemplate, skillLine } from '../common.mjs';
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

const OPENCODE_TEMPLATE_KEYS = ['description', 'tools', 'skills', 'maxTurns', 'hooks'];

// OpenCode has no hooks, so the git guard becomes shell permission rules. The
// last matching rule wins and each command of a chain is matched on its own
// (both measured on v2.0.24). The rtk plugin rewrites `git x` to `rtk git x`
// before the match, so every rule also has an rtk form. Matching arguments the
// way the hook does would take hundreds of globs, so this is an allowlist: git
// and gh are denied in the forms below (bare, by path, and their rtk rewrites),
// then common read-only forms are allowed again. It is best effort for those
// forms only. Every glob names git or gh as the first word, so a command that
// puts another word first (`env git commit`, `command git push`,
// `FOO=1 git push`) or runs git in a nested shell (`bash -c "git push"`) looks
// unmatched, and OpenCode's matcher was not run on those forms. An allowed
// pattern only ends in a wildcard, because a wildcard in the middle
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
  const { fm, body, description, readOnly, skills } = readTemplate(template, member, { allowedKeys: OPENCODE_TEMPLATE_KEYS, target: 'opencode', templateLabel });
  const guarded = assertGitGuardHooks(fm, { templateLabel, target: 'opencode' });

  const permissions = guarded ? openCodeShellRules() : [];
  if (readOnly) permissions.push({ action: 'edit', resource: '*', effect: 'deny' });

  const lines = ['---', `description: ${JSON.stringify(description)}`, 'mode: subagent', `color: "${OPENCODE_COLORS[member.color]}"`];
  if (Number.isInteger(fm.maxTurns)) lines.push(`steps: ${fm.maxTurns}`);
  if (permissions.length > 0) {
    lines.push('permissions:');
    for (const p of permissions) lines.push(`  - { action: ${p.action}, resource: ${JSON.stringify(p.resource)}, effect: ${p.effect} }`);
  }
  lines.push(`${MARKER} from ${templateLabel} and agents/crew.json; edit those, then run ./install.sh.`, '---');

  const preface = [];
  if (skills.length > 0) preface.push('', skillLine(skills, 'with the skill tool'));
  if (guarded) {
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
