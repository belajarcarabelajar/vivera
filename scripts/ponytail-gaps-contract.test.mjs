import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSkillText } from './skill-corpus.mjs';

const ROOT = path.join(import.meta.dir, '..');
const TMP_PREFIX = 'ponytail-gaps-';

function readRepoFile(rel, root = ROOT) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`missing repository file: ${rel}`);
  return fs.readFileSync(abs, 'utf8');
}

function assertFileContains(rel, needle, root = ROOT) {
  if (!readRepoFile(rel, root).includes(needle)) {
    throw new Error(`${rel} does not contain ${JSON.stringify(needle)}`);
  }
}

// Markdown allows single or double backticks around inline code; the lookbehind keeps fence runs out.
function extractGrepCommand(text) {
  for (const match of text.matchAll(/(?<!`)(`{1,2})(?!`)([^`\n]+?)\1(?!`)/g)) {
    const span = match[2].trim();
    if (span.startsWith('git grep') && span.includes('defer:')) return span;
  }
  return undefined;
}

function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout;
}

const SWEEP = 'skills/sucp-debt-sweep/SKILL.md';
const LITERAL_COMMAND = "git grep -nE '(#|//|/[*]) ?defer:'";
// The marker word is kept apart from any comment prefix so the sweep command does not count this file's fixture text.
const MARK = 'defer:';

describe('T0 contract', () => {
  let helperRoot;

  beforeAll(() => {
    helperRoot = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX + 'helpers-'));
    fs.writeFileSync(path.join(helperRoot, 'note.md'), 'alpha beta\n');
  });

  afterAll(() => {
    fs.rmSync(helperRoot, { recursive: true, force: true });
  });

  test('readRepoFile returns the text of a file under the given root', () => {
    expect(readRepoFile('note.md', helperRoot)).toBe('alpha beta\n');
  });

  test('readRepoFile names the missing path in its error', () => {
    expect(() => readRepoFile('no/such/file.md', helperRoot)).toThrow('no/such/file.md');
  });

  test('assertFileContains passes when the needle is present', () => {
    expect(() => assertFileContains('note.md', 'beta', helperRoot)).not.toThrow();
  });

  test('assertFileContains names the file and the needle when the needle is absent', () => {
    expect(() => assertFileContains('note.md', 'gamma', helperRoot)).toThrow('note.md does not contain "gamma"');
  });

  test('extractGrepCommand returns a single-backtick git grep span', () => {
    const text = "Run `git grep -nE '(#|//|/[*]) ?defer:'` in the repository.";
    expect(extractGrepCommand(text)).toBe(LITERAL_COMMAND);
  });

  test('extractGrepCommand returns a double-backtick git grep span', () => {
    const text = "Run ``git grep -nE '(#|//|/[*]) ?defer:'`` in the repository.";
    expect(extractGrepCommand(text)).toBe(LITERAL_COMMAND);
  });

  test('extractGrepCommand skips earlier spans that do not qualify', () => {
    const text = "Mark with `defer: <ceiling>, <trigger>`, list `git grep -n TODO`, then `git grep -nE 'x defer:'`.";
    expect(extractGrepCommand(text)).toBe("git grep -nE 'x defer:'");
  });

  test('extractGrepCommand returns undefined when no span is a git grep', () => {
    expect(extractGrepCommand('Only `defer: <ceiling>, <trigger>` is named here.')).toBeUndefined();
  });

  test('extractGrepCommand returns undefined for a git grep span without the defer marker', () => {
    expect(extractGrepCommand('List with `git grep -n TODO` only.')).toBeUndefined();
  });

  test('extractGrepCommand ignores a git grep inside a code fence', () => {
    const text = "```\ngit grep -nE 'defer:'\n```\n";
    expect(extractGrepCommand(text)).toBeUndefined();
  });
});

describe('T1 debt-sweep', () => {
  let tmpRepo;

  beforeAll(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX + 'repo-'));
    git(tmpRepo, 'init', '-q');
    // Local config only, so a global signing key or hooks path cannot leak into the fixture commit.
    git(tmpRepo, 'config', 'user.name', 'Fixture');
    git(tmpRepo, 'config', 'user.email', 'fixture@example.invalid');
    git(tmpRepo, 'config', 'commit.gpgsign', 'false');
    git(tmpRepo, 'config', 'core.hooksPath', '/dev/null');
    fs.writeFileSync(path.join(tmpRepo, 'a.mjs'), `// ${MARK} ceiling, upgrade when X\nexport const a = 1;\n`);
    fs.writeFileSync(path.join(tmpRepo, 'b.py'), `# ${MARK} only the ceiling\nb = 2\n`);
    fs.writeFileSync(
      path.join(tmpRepo, 'c.md'),
      [
        'A shortcut is recorded with the defer: marker in a comment.',
        'Write it as `(defer: <ceiling>, <upgrade-trigger>)` next to the code.',
        '',
      ].join('\n'),
    );
    git(tmpRepo, 'add', '.');
    git(tmpRepo, 'commit', '-q', '-m', 'fixtures');
  });

  afterAll(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('the sweep text names the literal git grep command', () => {
    assertFileContains(SWEEP, '`' + LITERAL_COMMAND + '`');
  });

  test('the sweep text names the no-trigger tag', () => {
    assertFileContains(SWEEP, 'no-trigger');
  });

  test('this test file holds no comment-prefixed marker of its own', () => {
    const marker = new RegExp(`(#|//|/[*]) ?${MARK}`);
    const own = readRepoFile('scripts/ponytail-gaps-contract.test.mjs')
      .split('\n')
      .flatMap((line, index) => (marker.test(line) ? [`${index + 1}: ${line.trim()}`] : []));
    expect(own).toEqual([]);
  });

  test('the extracted command reports only files with a comment-prefixed marker', () => {
    const cmd = extractGrepCommand(readRepoFile(SWEEP));
    if (cmd === undefined) throw new Error(`${SWEEP} has no backticked git grep command containing "defer:"`);
    const run = spawnSync('bash', ['-c', cmd], { cwd: tmpRepo, encoding: 'utf8' });
    expect(run.status).toBe(0);
    const reported = [...new Set(run.stdout.split('\n').filter(Boolean).map((line) => line.split(':')[0]))].sort();
    expect(reported).toEqual(['a.mjs', 'b.py']);
  });
});

describe('T2 review-template', () => {
  const TEMPLATE = 'templates/code-review-template.md';
  const phrases = [
    'Assumed load',
    'Scale lens',
    'check-then-write',
    'grows without a bound',
    'query per item',
    'per-process state',
  ];

  for (const phrase of phrases) {
    test(`the template contains "${phrase}"`, () => {
      assertFileContains(TEMPLATE, phrase);
    });
  }

  test('the template keeps the 8-point filter heading', () => {
    assertFileContains(TEMPLATE, 'all 8 must hold');
  });
});

describe('T5 wiring', () => {
  const SCRIPT = 'check-duplicate-defs.mjs';

  test('package.json defines the dups:check script', () => {
    const pkg = JSON.parse(readRepoFile('package.json'));
    expect(pkg.scripts['dups:check']).toBe('bun scripts/check-duplicate-defs.mjs');
  });

  test('the reviewer role names the script', () => {
    assertFileContains('agents/roles/reviewer.md', SCRIPT);
  });

  test('the generated staid sprite names the script', () => {
    assertFileContains('.claude/agents/staid.md', SCRIPT);
  });

  test('the README names dups:check', () => {
    assertFileContains('README.md', 'dups:check');
  });

  test('sucp-rules names dups:check on the Simplicity Ladder bullet', () => {
    const lines = readSkillText(ROOT, 'skills/sucp-rules/SKILL.md').split('\n');
    const sameLine = lines.some((line) => line.includes('The Simplicity Ladder') && line.includes('dups:check'));
    expect(sameLine).toBe(true);
  });

  test('backfill-plan-impacts lists the script by path', () => {
    assertFileContains('scripts/backfill-plan-impacts.mjs', 'scripts/check-duplicate-defs.mjs');
  });
});

describe('F4 reviewer', () => {
  const REPORT_BY_TURN = 'write the report by your 25th tool call';

  test('the reviewer role tells the reviewer to write the report by its 25th tool call', () => {
    assertFileContains('agents/roles/reviewer.md', REPORT_BY_TURN);
  });

  test('the generated staid sprite carries the same instruction', () => {
    assertFileContains('.claude/agents/staid.md', REPORT_BY_TURN);
  });

  // The 25th-call budget only makes sense against this limit, so a change to either must change both.
  test('the reviewer role keeps maxTurns: 30', () => {
    assertFileContains('agents/roles/reviewer.md', 'maxTurns: 30');
  });
});
