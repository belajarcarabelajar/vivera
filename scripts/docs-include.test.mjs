import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { checkIncludes } from './lib/docs-include.mjs';
import { buildIndex } from './lib/ci-targeted-index.mjs';
import { planChecks } from './ci-targeted.mjs';

const CLI = path.join(import.meta.dir, 'docs-include.mjs');
const DOCS_GEN = path.join(import.meta.dir, 'docs-gen.mjs');
const SCRATCH = path.join(process.env.HOME, '.cache/tmp/vivera-scratch/include');
const F = '```';

const made = [];
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRoot(files) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH, 'fixture-'));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function run(script, args) {
  const r = Bun.spawnSync([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const SOURCES = {
  'src/a.js': [
    'const top = 1;',
    'function demo() {',
    '  // docs-include:start body',
    '  const x = 1;',
    '    return x;',
    '',
    '  // docs-include:end body',
    '}',
    '',
    '',
  ].join('\n'),
  'src/b.sh': '# docs-include:start run\necho hi\n# docs-include:end run\n',
  'src/c.html': '<!-- docs-include:start part -->\n<p>hi</p>\n<!-- docs-include:end part -->\n',
  'src/dup.js': '// docs-include:start r\na\n// docs-include:end r\n// docs-include:start r\nb\n// docs-include:end r\n',
  'src/open.js': '// docs-include:start r\na\n',
  'src/backwards.js': '// docs-include:end r\na\n// docs-include:start r\n',
  'src/fence.md': `intro\n${F}\ncode\n${F}\n`,
};
const read = (rel) => (Object.hasOwn(SOURCES, rel) ? SOURCES[rel] : null);
const md = (...lines) => `${lines.join('\n')}\n`;
const check = (text) => checkIncludes('doc.md', text, read);

describe('resolving the included content', () => {
  test('a whole file without a region matches its text minus trailing blank lines', () => {
    const text = md('# Doc', '<!-- include: src/b.sh -->', `${F}sh`, '# docs-include:start run', 'echo hi', '# docs-include:end run', F, '<!-- /include -->');
    expect(check(text).findings).toEqual([]);
  });

  test('a region drops its marker lines, removes the common indent, and trims trailing blanks', () => {
    const text = md('<!-- include: src/a.js#body -->', `${F}js`, 'const x = 1;', '  return x;', F, '<!-- /include -->');
    expect(check(text).findings).toEqual([]);
  });

  test('regions work in hash and HTML comment syntax', () => {
    const text = md(
      '<!-- include: src/b.sh#run -->', `${F}sh`, 'echo hi', F, '<!-- /include -->',
      '<!-- include: src/c.html#part -->', `${F}html`, '<p>hi</p>', F, '<!-- /include -->',
    );
    expect(check(text).findings).toEqual([]);
  });
});

describe('findings', () => {
  test('drift names the file, line, and source', () => {
    const text = md('# Doc', '', '<!-- include: src/a.js#body -->', `${F}js`, 'const x = 2;', F, '<!-- /include -->');
    expect(check(text).findings).toEqual(['doc.md:3: block differs from src/a.js#body (run bun scripts/docs-include.mjs --write)']);
  });

  test('a missing source file is a finding', () => {
    const text = md('<!-- include: src/none.js -->', F, 'x', F, '<!-- /include -->');
    expect(check(text).findings).toEqual(['doc.md:1: source src/none.js does not exist']);
  });

  test('a missing region is a finding', () => {
    const text = md('<!-- include: src/a.js#nope -->', F, 'x', F, '<!-- /include -->');
    expect(check(text).findings).toEqual(['doc.md:1: region nope not found in src/a.js']);
  });

  test('a duplicated region is a finding', () => {
    const text = md('<!-- include: src/dup.js#r -->', F, 'a', F, '<!-- /include -->');
    expect(check(text).findings).toEqual(['doc.md:1: region r in src/dup.js needs one start and one end marker, found 2 start, 2 end']);
  });

  test('an unclosed or backwards region is a finding', () => {
    const open = md('<!-- include: src/open.js#r -->', F, 'a', F, '<!-- /include -->');
    const back = md('<!-- include: src/backwards.js#r -->', F, 'a', F, '<!-- /include -->');
    expect(check(open).findings).toEqual(['doc.md:1: region r in src/open.js needs one start and one end marker, found 1 start, 0 end']);
    expect(check(back).findings).toEqual(['doc.md:1: region r in src/backwards.js ends before it starts']);
  });

  test('an absolute path or one leaving the repository is refused', () => {
    const abs = md('<!-- include: /etc/passwd -->', F, 'x', F, '<!-- /include -->');
    const up = md('<!-- include: src/../../secret.txt -->', F, 'x', F, '<!-- /include -->');
    expect(check(abs).findings).toEqual(['doc.md:1: include path /etc/passwd must be relative to the repository root']);
    expect(check(up).findings).toEqual(['doc.md:1: include path src/../../secret.txt leaves the repository']);
  });

  test('an include without its closing marker is a finding', () => {
    const text = md('<!-- include: src/b.sh#run -->', `${F}sh`, 'echo hi', F, 'more text');
    expect(check(text).findings).toEqual(['doc.md:1: include is not closed with <!-- /include -->']);
  });

  test('a closing marker without an include is a finding', () => {
    expect(check(md('text', '<!-- /include -->')).findings).toEqual(['doc.md:2: <!-- /include --> without an open include']);
  });

  test('zero or two fenced blocks between the markers is a finding', () => {
    const none = md('<!-- include: src/b.sh#run -->', 'echo hi', '<!-- /include -->');
    const two = md('<!-- include: src/b.sh#run -->', F, 'echo hi', F, F, 'echo hi', F, '<!-- /include -->');
    expect(check(none).findings).toEqual(['doc.md:1: include needs exactly one fenced block, found 0']);
    expect(check(two).findings).toEqual(['doc.md:1: include needs exactly one fenced block, found 2']);
  });

  test('an include inside an include is a finding', () => {
    const text = md('<!-- include: src/b.sh#run -->', '<!-- include: src/c.html#part -->', F, 'x', F, '<!-- /include -->');
    expect(check(text).findings).toContain('doc.md:2: include inside the include opened at line 1');
  });

  test('a fence that the content would close is a finding', () => {
    const text = md('<!-- include: src/fence.md -->', `${F}markdown`, 'old', F, '<!-- /include -->');
    expect(check(text).findings).toContain('doc.md:1: content of src/fence.md would close the 3-character fence, it needs 4');
  });

  test('a fenced block whose content matches passes with no findings', () => {
    const text = md('<!-- include: src/fence.md -->', '````markdown', 'intro', F, 'code', F, '````', '<!-- /include -->');
    expect(check(text)).toEqual({ findings: [], blocked: false, output: text, changes: [] });
  });
});

describe('markers inside a fenced example', () => {
  test('an example in a 3-backtick, a 4-backtick, or a tilde fence is ignored and a real include after it still works', () => {
    const text = md(
      `${F}markdown`, '<!-- include: src/none.js -->', '<!-- /include -->', F,
      '````markdown', '<!-- include: src/none.js#gone -->', `${F}js`, 'x', F, '<!-- /include -->', '````',
      '~~~markdown', '<!-- include: /abs -->', '~~~',
      '<!-- include: src/b.sh#run -->', `${F}sh`, 'echo stale', F, '<!-- /include -->',
    );
    expect(check(text).findings).toEqual(['doc.md:15: block differs from src/b.sh#run (run bun scripts/docs-include.mjs --write)']);
  });
});

describe('rewriting', () => {
  test('drift is rewritten in place keeping the fence language and length', () => {
    const text = md('# Doc', '<!-- include: src/a.js#body -->', '~~~~js', 'old', '~~~~', '<!-- /include -->', 'after');
    const r = check(text);
    expect(r.blocked).toBe(false);
    expect(r.changes).toEqual(['doc.md:2: updated include of src/a.js#body']);
    expect(r.output).toBe(md('# Doc', '<!-- include: src/a.js#body -->', '~~~~js', 'const x = 1;', '  return x;', '~~~~', '<!-- /include -->', 'after'));
  });

  test('a fence too short for the content is lengthened', () => {
    const text = md('<!-- include: src/fence.md -->', `${F}markdown`, 'old', F, '<!-- /include -->');
    expect(check(text).output).toBe(md('<!-- include: src/fence.md -->', '````markdown', 'intro', F, 'code', F, '````', '<!-- /include -->'));
  });

  test('a file with a structural error is blocked from rewriting', () => {
    const text = md('<!-- include: src/a.js#body -->', F, 'old', F, '<!-- /include -->', '<!-- include: src/none.js -->', F, 'x', F, '<!-- /include -->');
    const r = check(text);
    expect([r.blocked, r.output === text]).toEqual([true, true]);
  });
});

describe('CLI', () => {
  const PAGE = md('# Page', '<!-- include: src/b.sh#run -->', `${F}sh`, 'echo stale', F, '<!-- /include -->');
  const repo = (extra = {}) => makeRoot({
    'src/b.sh': SOURCES['src/b.sh'],
    'README.md': '# Readme\n',
    'docs/page.md': PAGE,
    'apps/docs/pages.json': JSON.stringify({ pages: [{ source: { file: 'README.md', heading: '' } }, { source: { files: ['docs/page.md'] } }] }),
    'apps/docs/content/id/x.md': md('<!-- include: src/b.sh#run -->', `${F}sh`, 'echo hi', F, '<!-- /include -->'),
    ...extra,
  });

  test('no mode is a usage error with exit 2', () => {
    const r = run(CLI, ['--root', repo()]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('usage: bun scripts/docs-include.mjs');
  });

  test('--check over the default files reports drift with exit 1', () => {
    const r = run(CLI, ['--root', repo(), '--check']);
    expect([r.code, r.out]).toEqual([1, 'docs/page.md:2: block differs from src/b.sh#run (run bun scripts/docs-include.mjs --write)\ndocs-include: 1 finding(s) in 3 file(s)\n']);
  });

  test('--write fixes the drift and a second --check passes', () => {
    const root = repo();
    const w = run(CLI, ['--root', root, '--write']);
    expect(w.code).toBe(0);
    expect(w.out).toContain('docs/page.md:2: updated include of src/b.sh#run');
    expect(fs.readFileSync(path.join(root, 'docs/page.md'), 'utf8')).toBe(md('# Page', '<!-- include: src/b.sh#run -->', `${F}sh`, 'echo hi', F, '<!-- /include -->'));
    expect(run(CLI, ['--root', root, '--check']).code).toBe(0);
  });

  test('--write leaves a file with a structural error untouched', () => {
    const broken = `${PAGE}<!-- /include -->\n`;
    const root = repo({ 'docs/page.md': broken });
    expect(run(CLI, ['--root', root, '--write']).code).toBe(1);
    expect(fs.readFileSync(path.join(root, 'docs/page.md'), 'utf8')).toBe(broken);
  });

  test('named files limit the check to them', () => {
    expect(run(CLI, ['--root', repo(), '--check', 'README.md']).code).toBe(0);
  });

  test('--write keeps CRLF line endings everywhere and changes only the block', () => {
    const crlf = (...lines) => `${lines.join('\r\n')}\r\n`;
    const root = repo({ 'docs/page.md': crlf('# Page', '<!-- include: src/b.sh#run -->', `${F}sh`, 'echo stale', F, '<!-- /include -->', 'after') });
    expect(run(CLI, ['--root', root, '--write']).code).toBe(0);
    expect(fs.readFileSync(path.join(root, 'docs/page.md'), 'utf8'))
      .toBe(crlf('# Page', '<!-- include: src/b.sh#run -->', `${F}sh`, 'echo hi', F, '<!-- /include -->', 'after'));
  });

  test('a symlink to a file outside the root is a finding and nothing is written', () => {
    const outside = makeRoot({ 'secret.sh': '# docs-include:start run\nSECRET\n# docs-include:end run\n' });
    const root = repo();
    fs.symlinkSync(path.join(outside, 'secret.sh'), path.join(root, 'src/link.sh'));
    const page = md('<!-- include: src/link.sh#run -->', `${F}sh`, 'stale', F, '<!-- /include -->');
    fs.writeFileSync(path.join(root, 'docs/page.md'), page);
    const w = run(CLI, ['--root', root, '--write', 'docs/page.md']);
    expect([w.code, w.out]).toEqual([1, 'docs/page.md:1: include path src/link.sh escapes the repository through a symlink\ndocs-include: updated 0 block(s), 1 finding(s) left in 1 file(s)\n']);
    expect(fs.readFileSync(path.join(root, 'docs/page.md'), 'utf8')).toBe(page);
  });

  test('a symlinked page outside the root is a finding and is never written through', () => {
    const stale = md('<!-- include: src/b.sh#run -->', `${F}sh`, 'echo stale', F, '<!-- /include -->');
    const outside = makeRoot({ 'page.md': stale });
    const root = repo();
    fs.symlinkSync(path.join(outside, 'page.md'), path.join(root, 'docs/linked.md'));
    const w = run(CLI, ['--root', root, '--write', 'docs/linked.md']);
    expect([w.code, w.out.split('\n')[0].startsWith('docs/linked.md: ')]).toEqual([1, true]);
    expect(fs.readFileSync(path.join(outside, 'page.md'), 'utf8')).toBe(stale);
  });

  test('a symlink that stays inside the root keeps working', () => {
    const root = repo();
    fs.symlinkSync('b.sh', path.join(root, 'src/inside.sh'));
    fs.writeFileSync(path.join(root, 'docs/page.md'), md('<!-- include: src/inside.sh#run -->', `${F}sh`, 'echo hi', F, '<!-- /include -->'));
    expect(run(CLI, ['--root', root, '--check', 'docs/page.md']).code).toBe(0);
  });
});

describe('docs-gen --check', () => {
  const docsRepo = () => makeRoot({
    'src/b.sh': SOURCES['src/b.sh'],
    'README.md': md('# Readme', '', 'Intro.', '', '<!-- include: src/b.sh#run -->', `${F}sh`, 'echo stale', F, '<!-- /include -->'),
    'apps/docs/pages.json': JSON.stringify({ pages: [{ category: 'a', slug: 'b', order: 1, title: 'T', description: 'D', source: { file: 'README.md', heading: '' } }] }),
    'apps/docs/content/id/a-b.md': md('---', 'source_hash: "x"', '---', '<!-- include: src/b.sh -->', F, 'stale', F, '<!-- /include -->'),
  });

  test('the EN scope reports include drift in README and page sources', () => {
    const r = run(DOCS_GEN, ['--root', docsRepo(), '--check', '--scope', 'en']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('README.md:5: block differs from src/b.sh#run (run bun scripts/docs-include.mjs --write)');
    expect(r.out).not.toContain('apps/docs/content/id/a-b.md:4');
  });

  test('the ID scope reports include drift in the ID twins', () => {
    const r = run(DOCS_GEN, ['--root', docsRepo(), '--check', '--scope', 'id']);
    expect(r.out).toContain('apps/docs/content/id/a-b.md:4: block differs from src/b.sh (run bun scripts/docs-include.mjs --write)');
    expect(r.out).not.toContain('README.md:5');
  });
});

describe('ci-targeted', () => {
  const SRC = {
    'scripts/lib/demo.mjs': 'export const demo = 1;\n',
    'scripts/demo.test.mjs': "import { demo } from './lib/demo.mjs';\n",
  };
  const docsGen = (plan) => plan.suites.filter((s) => s.name === 'docs-gen');

  test('a change to a file named by an include plans the docs checks', () => {
    const plan = planChecks(['scripts/lib/demo.mjs'], { sources: SRC, includedSources: ['scripts/lib/demo.mjs'] });
    expect([plan.full, docsGen(plan)[0]?.reasons]).toEqual([false, ['scripts/lib/demo.mjs: source included by a docs page changed']]);
  });

  test('the same change without an include plans no docs check', () => {
    expect(docsGen(planChecks(['scripts/lib/demo.mjs'], { sources: SRC }))).toEqual([]);
  });

  test('buildIndex lists the files the docs pages include', () => {
    const root = makeRoot({
      'README.md': md('<!-- include: src/b.sh#run -->', F, 'x', F, '<!-- /include -->'),
      'apps/docs/content/id/x.md': md('<!-- include: ./scripts/x.mjs -->', F, 'x', F, '<!-- /include -->'),
    });
    expect(buildIndex(root, [], 'HEAD').includedSources).toEqual(['scripts/x.mjs', 'src/b.sh']);
  });
});
