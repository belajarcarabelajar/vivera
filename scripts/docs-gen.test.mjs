import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dir, 'docs-gen.mjs');
const REAL_ROOT = path.resolve(import.meta.dir, '..');
const GH = 'https://github.com/belajarcarabelajar/vivera';
const EM = '\u2014';

const made = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix = 'docs-gen-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

async function run(args, { cwd } = {}) {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err, all: out + err };
}

const FENCE = '```';

const README_LINES = [
  '# Fixture Farm',
  '',
  'Welcome to the farm. Read [the guide](docs/guide.md).',
  '',
  '## Getting Started',
  '',
  'Run the tool:',
  '',
  `${FENCE}bash`,
  '## Not A Section',
  'echo "[raw](docs/guide.md)"',
  FENCE,
  '',
  '### Install Steps',
  '',
  '- same section: [steps](#install-steps)',
  '- other section: [refs](#reference--links)',
  '- other subheading: [tables](#link-tables)',
  '- web: [site](https://example.com/page#top)',
  '- mail: [mail](mailto:farm@example.com)',
  '- script: [tool](scripts/tool.mjs)',
  '- script line: [tool line](scripts/tool.mjs#L3)',
  '- folder: [examples](examples/)',
  '- page with sub-anchor: [deep](docs/guide.md#deep-part)',
  '- page via readme: [readme refs](README.md#reference--links)',
  '- inline code: `[code](docs/guide.md)`',
  '- image: ![flow](diagrams/flow.svg)',
  '',
  '#### Deep Level',
  '',
  'Deep text.',
  '',
  '## Reference & Links',
  '',
  '<picture>',
  '  <source media="(prefers-color-scheme: dark)" srcset="diagrams/flow-dark.svg">',
  '  <img alt="Flow" src="diagrams/flow.svg" width="400">',
  '</picture>',
  '',
  '<a href="docs/guide.md">guide</a> and <a href="LICENSE">license</a>.',
  '',
  '### Link Tables',
  '',
  'Text ![pic](docs/images/pic.png) <img alt="Pic" src="docs/images/pic.png" width="10"> [pic file](docs/images/pic.png).',
  '',
  '## License',
  '',
  'MIT.',
  '',
];

const GUIDE_LINES = [
  '# Guide',
  '',
  'Back to [start](../README.md#getting-started), [the farm](../README.md), and [license file](../LICENSE).',
  '',
  '## Deep Part',
  '',
  'Jump [up](#deep-part).',
  '',
];

const PAGES = [
  { category: 'start', slug: 'intro', order: 1, title: 'Introduction', description: 'Farm intro', source: { file: 'README.md', heading: '' } },
  { category: 'start', slug: 'getting-started', order: 2, title: 'Getting Started', description: 'How to start', source: { file: 'README.md', heading: 'Getting Started' } },
  { category: 'start', slug: 'reference', order: 3, title: 'Reference & Links', description: 'Links: all kinds', source: { file: 'README.md', heading: 'Reference & Links' } },
  { category: 'start', slug: 'license', order: 4, title: 'License', description: 'License terms', source: { file: 'README.md', heading: 'License' } },
  { category: 'guides', slug: 'guide', order: 1, title: 'Guide', description: 'The guide', source: { file: 'docs/guide.md' } },
];

function makeRepo({ readme = README_LINES.join('\n'), guide = GUIDE_LINES.join('\n'), pages = PAGES, extra = {}, omit = [] } = {}) {
  const root = tmp();
  const files = {
    'README.md': readme,
    'docs/guide.md': guide,
    'docs/skip-notes.md': '# Skipped\n',
    'docs/private/secret.md': '# Secret\n',
    'scripts/tool.mjs': 'export {};\n',
    'examples/demo.md': '# Demo\n',
    'LICENSE': 'MIT\n',
    'diagrams/flow.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    'diagrams/flow-dark.svg': '<svg xmlns="http://www.w3.org/2000/svg" class="dark"></svg>\n',
    'docs/images/pic.png': 'not really a png\n',
    'docs/code-plan/plans/p.md': '# Local plan\n',
    'apps/docs/pages.json': JSON.stringify({ pages, exclude: ['docs/skip-*.md', 'docs/private/**', 'docs/code-plan/**'] }, null, 2),
    ...extra,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (omit.includes(rel) || content === null) continue;
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function readPage(root, name) {
  return readFileSync(path.join(root, 'apps/docs/content/en', name), 'utf8');
}

function bodyOf(file) {
  const m = file.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/);
  return m ? m[1] : null;
}

async function writeIdTwins(root) {
  const { out } = await run(['--root', root, '--hashes']);
  const hashes = JSON.parse(out);
  const idDir = path.join(root, 'apps/docs/content/id');
  mkdirSync(idDir, { recursive: true });
  for (const [key, hash] of Object.entries(hashes)) {
    writeFileSync(path.join(idDir, `${key}.md`), `---\ntitle: Halaman\nsource_hash: "${hash}"\n---\n\n# Halaman\n\nIsi.\n`);
  }
  return { idDir, hashes };
}

// Usage

test('no mode flag is a usage error with exit 2', async () => {
  const r = await run(['--root', makeRepo()]);
  expect(r.code).toBe(2);
  expect(r.err).toContain('usage: bun scripts/docs-gen.mjs');
});

test('an unknown flag is a usage error with exit 2', async () => {
  const r = await run(['--root', makeRepo(), '--write', '--bogus']);
  expect(r.code).toBe(2);
  expect(r.err).toContain('unknown argument: --bogus');
});

test('an invalid scope is a usage error with exit 2', async () => {
  const r = await run(['--root', makeRepo(), '--check', '--scope', 'fr']);
  expect(r.code).toBe(2);
  expect(r.err).toContain('--scope must be en, id, or all');
});

test('two modes at once is a usage error with exit 2', async () => {
  const r = await run(['--root', makeRepo(), '--write', '--hashes']);
  expect(r.code).toBe(2);
  expect(r.err).toContain('exactly one of');
});

// Write and mapping

test('--write writes one page per map entry named category-slug.md', async () => {
  const root = makeRepo();
  const r = await run(['--root', root, '--write']);
  expect(r.code).toBe(0);
  const names = readdirSync(path.join(root, 'apps/docs/content/en')).sort();
  expect(names).toEqual(['guides-guide.md', 'start-getting-started.md', 'start-intro.md', 'start-license.md', 'start-reference.md']);
});

test('--root defaults to the working directory', async () => {
  const root = makeRepo();
  const r = await run(['--write'], { cwd: root });
  expect(r.code).toBe(0);
  expect(existsSync(path.join(root, 'apps/docs/content/en/start-license.md'))).toBe(true);
});

test('frontmatter carries title, description, category, slug, order, source, source_hash in order', async () => {
  const root = makeRepo();
  await run(['--root', root, '--write']);
  const file = readPage(root, 'start-reference.md');
  const fm = file.split('\n---\n')[0].replace(/^---\n/, '');
  const keys = fm.split('\n').map((l) => l.split(':')[0]);
  expect(keys).toEqual(['title', 'description', 'category', 'slug', 'order', 'source', 'source_hash']);
  expect(fm).toContain('source: README.md#Reference & Links');
  expect(fm).toContain('description: "Links: all kinds"');
  expect(readPage(root, 'guides-guide.md')).toContain('\nsource: docs/guide.md\n');
});

test('the preamble page drops the title line and keeps the text before the first section', async () => {
  const root = makeRepo();
  await run(['--root', root, '--write']);
  const body = bodyOf(readPage(root, 'start-intro.md'));
  expect(body).toBe('Welcome to the farm. Read [the guide](/docs/guides/guide/).\n');
});

test('a section heading becomes level 1 and deeper headings shift up one level', async () => {
  const root = makeRepo();
  await run(['--root', root, '--write']);
  const body = bodyOf(readPage(root, 'start-getting-started.md'));
  expect(body.startsWith('# Getting Started\n')).toBe(true);
  expect(body).toContain('\n## Install Steps\n');
  expect(body).toContain('\n### Deep Level\n');
  expect(body).not.toContain('#### Deep Level');
});

test('a heading inside a fenced code block is neither a section nor shifted', async () => {
  const root = makeRepo();
  const r = await run(['--root', root, '--write']);
  expect(r.code).toBe(0);
  expect(r.all).not.toContain('Not A Section');
  const body = bodyOf(readPage(root, 'start-getting-started.md'));
  expect(body).toContain(`${FENCE}bash\n## Not A Section\necho "[raw](docs/guide.md)"\n${FENCE}\n`);
});

test('an unmapped README section is an error naming its line', async () => {
  const pages = PAGES.filter((p) => p.slug !== 'license');
  const r = await run(['--root', makeRepo({ pages }), '--write']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('README.md:46: section "License" is not mapped to a page');
});

test('an unmapped published docs file is an error and an excluded one is not', async () => {
  const root = makeRepo({ extra: { 'docs/extra.md': '# Extra\n' } });
  const r = await run(['--root', root, '--check', '--scope', 'en']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('docs/extra.md: published docs file is not mapped to a page');
  expect(r.all).not.toContain('skip-notes');
  expect(r.all).not.toContain('secret.md');
});

test('a duplicate section heading is an error naming both lines', async () => {
  const readme = [...README_LINES, '## License', '', 'Again.', ''].join('\n');
  const r = await run(['--root', makeRepo({ readme }), '--write']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('README.md:46 and README.md:50: duplicate section heading "License"');
});

test('a page whose heading no longer exists is an error', async () => {
  const pages = [...PAGES, { category: 'start', slug: 'gone', order: 9, title: 'Gone', description: 'x', source: { file: 'README.md', heading: 'Old Heading' } }];
  const r = await run(['--root', makeRepo({ pages }), '--write']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('page start-gone: README.md heading "Old Heading" does not exist');
});

test('a page whose source file is missing is an error', async () => {
  const pages = [...PAGES, { category: 'guides', slug: 'lost', order: 2, title: 'Lost', description: 'x', source: { file: 'docs/lost.md' } }];
  const r = await run(['--root', makeRepo({ pages }), '--write']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('page guides-lost: source file docs/lost.md does not exist');
});

test('--write with a mapping error writes nothing', async () => {
  const root = makeRepo({ pages: PAGES.filter((p) => p.slug !== 'license') });
  await run(['--root', root, '--write']);
  expect(existsSync(path.join(root, 'apps/docs/content/en'))).toBe(false);
});

test('--write removes stale generated pages from --out first', async () => {
  const root = makeRepo();
  const out = tmp('docs-gen-out-');
  writeFileSync(path.join(out, 'start-old.md'), 'stale\n');
  writeFileSync(path.join(out, 'keep.txt'), 'not markdown\n');
  const r = await run(['--root', root, '--write', '--out', out]);
  expect(r.code).toBe(0);
  const names = readdirSync(out).sort();
  expect(names).toContain('keep.txt');
  expect(names).not.toContain('start-old.md');
  expect(names).toContain('start-license.md');
});

// Link rewriting

async function gettingStarted() {
  const root = makeRepo();
  await run(['--root', root, '--write']);
  return { root, body: bodyOf(readPage(root, 'start-getting-started.md')) };
}

test('an anchor inside the same section stays', async () => {
  const { body } = await gettingStarted();
  expect(body).toContain('[steps](#install-steps)');
});

test('an anchor naming another README section becomes that page', async () => {
  const { body } = await gettingStarted();
  expect(body).toContain('[refs](/docs/start/reference/)');
});

test('an anchor naming a subheading of another section keeps the sub-anchor', async () => {
  const { body } = await gettingStarted();
  expect(body).toContain('[tables](/docs/start/reference/#link-tables)');
});

test('http and mailto links stay as written', async () => {
  const { body } = await gettingStarted();
  expect(body).toContain('[site](https://example.com/page#top)');
  expect(body).toContain('[mail](mailto:farm@example.com)');
});

test('a repository file without a page becomes a GitHub blob link keeping its anchor', async () => {
  const { body } = await gettingStarted();
  expect(body).toContain(`[tool](${GH}/blob/main/scripts/tool.mjs)`);
  expect(body).toContain(`[tool line](${GH}/blob/main/scripts/tool.mjs#L3)`);
});

test('a repository directory becomes a GitHub tree link', async () => {
  const { body } = await gettingStarted();
  expect(body).toContain(`[examples](${GH}/tree/main/examples)`);
});

test('a repository path with a page becomes the page URL keeping a sub-anchor', async () => {
  const { body } = await gettingStarted();
  expect(body).toContain('[deep](/docs/guides/guide/#deep-part)');
});

test('a README.md link with a section anchor becomes that section page', async () => {
  const { body } = await gettingStarted();
  expect(body).toContain('[readme refs](/docs/start/reference/)');
});

test('links inside inline code are left alone', async () => {
  const { body } = await gettingStarted();
  expect(body).toContain('`[code](docs/guide.md)`');
});

test('a link whose text is inline code is still rewritten', async () => {
  const root = makeRepo({ readme: README_LINES.join('\n').replace('Deep text.', 'Run [`tool`](scripts/tool.mjs).') });
  await run(['--root', root, '--write']);
  const body = bodyOf(readPage(root, 'start-getting-started.md'));
  expect(body).toContain(`Run [\`tool\`](${GH}/blob/main/scripts/tool.mjs).`);
});

test('HTML href attributes are rewritten', async () => {
  const root = makeRepo();
  await run(['--root', root, '--write']);
  const body = bodyOf(readPage(root, 'start-reference.md'));
  expect(body).toContain('<a href="/docs/guides/guide/">guide</a>');
  expect(body).toContain(`<a href="${GH}/blob/main/LICENSE">license</a>`);
});

test('links in a docs file resolve relative to that file', async () => {
  const root = makeRepo();
  await run(['--root', root, '--write']);
  const body = bodyOf(readPage(root, 'guides-guide.md'));
  expect(body).toContain('[start](/docs/start/getting-started/)');
  expect(body).toContain('[the farm](/docs/start/intro/)');
  expect(body).toContain(`[license file](${GH}/blob/main/LICENSE)`);
  expect(body).toContain('[up](#deep-part)');
});

test('diagram images are copied and rewritten in markdown, src, and srcset', async () => {
  const root = makeRepo();
  await run(['--root', root, '--write']);
  const gen = path.join(root, 'apps/docs/static/generated');
  expect(readdirSync(gen).sort()).toEqual(['flow-dark.svg', 'flow.svg']);
  expect(readFileSync(path.join(gen, 'flow-dark.svg'), 'utf8')).toContain('class="dark"');
  const ref = bodyOf(readPage(root, 'start-reference.md'));
  expect(ref).toContain('srcset="/docs/generated/flow-dark.svg"');
  expect(ref).toContain('src="/docs/generated/flow.svg"');
  const gs = bodyOf(readPage(root, 'start-getting-started.md'));
  expect(gs).toContain('![flow](/docs/generated/flow.svg)');
});

const RAW = 'https://raw.githubusercontent.com/belajarcarabelajar/vivera/main';

test('an image outside diagrams/ becomes a raw GitHub URL and is not copied', async () => {
  const root = makeRepo();
  await run(['--root', root, '--write']);
  const ref = bodyOf(readPage(root, 'start-reference.md'));
  expect(ref).toContain(`![pic](${RAW}/docs/images/pic.png)`);
  expect(ref).toContain(`src="${RAW}/docs/images/pic.png"`);
  expect(existsSync(path.join(root, 'apps/docs/static/generated/pic.png'))).toBe(false);
});

test('a plain link to an image file outside diagrams/ stays a blob link', async () => {
  const root = makeRepo();
  await run(['--root', root, '--write']);
  const ref = bodyOf(readPage(root, 'start-reference.md'));
  expect(ref).toContain(`[pic file](${GH}/blob/main/docs/images/pic.png)`);
});

// Trailing thematic breaks

async function licenseHashWith(tail) {
  const readme = README_LINES.join('\n').replace('MIT.', `MIT.${tail}`);
  const r = await run(['--root', makeRepo({ readme }), '--hashes']);
  return JSON.parse(r.out)['start-license'];
}

test('a trailing --- with its blank lines is dropped from a section body', async () => {
  expect(await licenseHashWith('\n\n---\n')).toBe('6419418e6221');
});

test('a trailing *** or ___ is dropped from a section body', async () => {
  expect(await licenseHashWith('\n\n***\n')).toBe('6419418e6221');
  expect(await licenseHashWith('\n\n___\n\n')).toBe('6419418e6221');
});

test('a thematic break in the middle of a section body stays', async () => {
  const root = makeRepo({ readme: README_LINES.join('\n').replace('MIT.', 'MIT.\n\n---\n\nMore.') });
  await run(['--root', root, '--write']);
  expect(bodyOf(readPage(root, 'start-license.md'))).toBe('# License\n\nMIT.\n\n---\n\nMore.\n');
});

test('a dashed line right under text is a setext heading and stays', async () => {
  const root = makeRepo({ readme: README_LINES.join('\n').replace('MIT.', 'MIT.\n---') });
  await run(['--root', root, '--write']);
  expect(bodyOf(readPage(root, 'start-license.md'))).toBe('# License\n\nMIT.\n---\n');
});

// Dead links and unknown anchors (line 31 is "Deep text." in the fixture README)

const DEAD = 'Deep text with [plans](docs/code-plan/plans/) and [ghost](scripts/ghost.mjs) and <a href="nope.md">nope</a>.';

test('a link to a missing or docs/code-plan path is written as its plain text', async () => {
  const root = makeRepo({ readme: README_LINES.join('\n').replace('Deep text.', DEAD) });
  const r = await run(['--root', root, '--write']);
  expect(r.code).toBe(0);
  const body = bodyOf(readPage(root, 'start-getting-started.md'));
  expect(body).toContain('Deep text with plans and ghost and nope.\n');
});

test('--check --scope en reports each dead link with its source line', async () => {
  const root = makeRepo({ readme: README_LINES.join('\n').replace('Deep text.', DEAD) });
  const r = await run(['--root', root, '--check', '--scope', 'en']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('README.md:31: dead link "docs/code-plan/plans/" (target is missing or gitignored)');
  expect(r.all).toContain('README.md:31: dead link "scripts/ghost.mjs" (target is missing or gitignored)');
  expect(r.all).toContain('README.md:31: dead link "nope.md" (target is missing or gitignored)');
});

const LOST = 'See [nowhere](#no-such-heading) and [readme nowhere](README.md#also-missing).';

test('--check --scope en reports an anchor that matches no heading', async () => {
  const root = makeRepo({ readme: README_LINES.join('\n').replace('Deep text.', LOST) });
  const r = await run(['--root', root, '--check', '--scope', 'en']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('README.md:31: unknown anchor "#no-such-heading" (no heading in any mapped page)');
  expect(r.all).toContain('README.md:31: unknown anchor "README.md#also-missing" (no heading in any mapped page)');
});

test('an unknown anchor keeps the current fallback in the written page', async () => {
  const root = makeRepo({ readme: README_LINES.join('\n').replace('Deep text.', LOST) });
  const r = await run(['--root', root, '--write']);
  expect(r.code).toBe(0);
  const body = bodyOf(readPage(root, 'start-getting-started.md'));
  expect(body).toContain('[nowhere](#no-such-heading)');
  expect(body).toContain('[readme nowhere](/docs/start/intro/)');
});

// The docs crate serves getting-started/introduction at /docs/ itself.
const INTRO_PAGES = [
  { ...PAGES[0], category: 'getting-started', slug: 'introduction' },
  ...PAGES.slice(1),
];

test('a link to the introduction page becomes /docs/ keeping its anchor', async () => {
  const readme = README_LINES.join('\n')
    .replace('Read [the guide](docs/guide.md).', 'Read [the guide](docs/guide.md).\n\n### Farm Notes\n\nNotes.')
    .replace('Deep text.', 'Deep text. [home](README.md) [notes](#farm-notes) [notes file](README.md#farm-notes)');
  const root = makeRepo({ readme, pages: INTRO_PAGES });
  const r = await run(['--root', root, '--write']);
  expect(r.code).toBe(0);
  const gs = bodyOf(readPage(root, 'start-getting-started.md'));
  expect(gs).toContain('[home](/docs/)');
  expect(gs).toContain('[notes](/docs/#farm-notes)');
  expect(gs).toContain('[notes file](/docs/#farm-notes)');
  expect(gs).toContain('[refs](/docs/start/reference/)');
  const guide = bodyOf(readPage(root, 'guides-guide.md'));
  expect(guide).toContain('[the farm](/docs/)');
  expect(guide).not.toContain('/docs/getting-started/introduction/');
});

// Hashes

test('the hash of a known body equals the sha256sum literal', async () => {
  const r = await run(['--root', makeRepo(), '--hashes']);
  expect(r.code).toBe(0);
  // printf '# License\n\nMIT.\n' | sha256sum | cut -c1-12
  expect(JSON.parse(r.out)['start-license']).toBe('6419418e6221');
});

test('the same input hashes the same twice', async () => {
  const root = makeRepo();
  const a = await run(['--root', root, '--hashes']);
  const b = await run(['--root', makeRepo(), '--hashes']);
  expect(a.out).toBe(b.out);
});

test('one changed character changes the hash', async () => {
  const readme = README_LINES.join('\n').replace('MIT.', 'MIT!');
  const r = await run(['--root', makeRepo({ readme }), '--hashes']);
  // printf '# License\n\nMIT!\n' | sha256sum | cut -c1-12
  expect(JSON.parse(r.out)['start-license']).toBe('74234b1e732c');
});

test('--hashes prints JSON sorted by key', async () => {
  const r = await run(['--root', makeRepo(), '--hashes']);
  const keys = Object.keys(JSON.parse(r.out));
  expect(keys).toEqual(['guides-guide', 'start-getting-started', 'start-intro', 'start-license', 'start-reference']);
});

test('the written source_hash equals the --hashes value', async () => {
  const root = makeRepo();
  await run(['--root', root, '--write']);
  expect(readPage(root, 'start-license.md')).toContain('\nsource_hash: "6419418e6221"\n');
});

test('an unquoted ID source_hash that YAML would read as a number still compares as text', async () => {
  const root = makeRepo();
  const { idDir } = await writeIdTwins(root);
  writeFileSync(path.join(idDir, 'start-license.md'), '---\nsource_hash: 6419418e6221\n---\n\n# Lisensi\n');
  const r = await run(['--root', root, '--check', '--scope', 'id']);
  expect(r.code).toBe(0);
});

// Check scopes

test('--check --scope en passes a clean repository and writes nothing', async () => {
  const root = makeRepo();
  const r = await run(['--root', root, '--check', '--scope', 'en']);
  expect(r.code).toBe(0);
  expect(existsSync(path.join(root, 'apps/docs/content'))).toBe(false);
});

test('--check --scope en reports an em dash in a generated page', async () => {
  const readme = README_LINES.join('\n').replace('Deep text.', `Deep ${EM} text.`);
  const r = await run(['--root', makeRepo({ readme }), '--check', '--scope', 'en']);
  expect(r.code).toBe(1);
  expect(r.all).toMatch(/start-getting-started\.md:\d+: em dash \(U\+2014\)/);
});

test('--check --scope id passes when every EN page has a current ID twin', async () => {
  const root = makeRepo();
  await writeIdTwins(root);
  const r = await run(['--root', root, '--check', '--scope', 'id']);
  expect(r.code).toBe(0);
});

test('--check --scope id reports a missing ID page', async () => {
  const root = makeRepo();
  const { idDir } = await writeIdTwins(root);
  unlinkSync(path.join(idDir, 'start-license.md'));
  const r = await run(['--root', root, '--check', '--scope', 'id']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('apps/docs/content/id/start-license.md: missing ID page');
});

test('--check --scope id reports an ID page whose source_hash is stale', async () => {
  const root = makeRepo();
  const { idDir } = await writeIdTwins(root);
  writeFileSync(path.join(idDir, 'start-license.md'), '---\ntitle: Lisensi\nsource_hash: "000000000000"\n---\n\n# Lisensi\n');
  const r = await run(['--root', root, '--check', '--scope', 'id']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('apps/docs/content/id/start-license.md: stale ID page (source_hash 000000000000, EN 6419418e6221)');
});

test('--check --scope id reports an ID page without an EN page', async () => {
  const root = makeRepo();
  const { idDir } = await writeIdTwins(root);
  writeFileSync(path.join(idDir, 'start-ghost.md'), '---\nsource_hash: "abc"\n---\n\n# Hantu\n');
  const r = await run(['--root', root, '--check', '--scope', 'id']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('apps/docs/content/id/start-ghost.md: ID page has no EN page');
});

test('--check --scope id reports an em dash in an ID page', async () => {
  const root = makeRepo();
  const { idDir, hashes } = await writeIdTwins(root);
  writeFileSync(path.join(idDir, 'start-license.md'), `---\nsource_hash: "${hashes['start-license']}"\n---\n\n# Lisensi\n\nMIT ${EM} bebas.\n`);
  const r = await run(['--root', root, '--check', '--scope', 'id']);
  expect(r.code).toBe(1);
  expect(r.all).toMatch(/apps\/docs\/content\/id\/start-license\.md:\d+: em dash \(U\+2014\)/);
});

test('--check --scope en ignores missing ID pages', async () => {
  const r = await run(['--root', makeRepo(), '--check', '--scope', 'en']);
  expect(r.code).toBe(0);
  expect(r.all).not.toContain('missing ID page');
});

test('--check without --scope checks both EN and ID', async () => {
  const pages = PAGES.filter((p) => p.slug !== 'license');
  const r = await run(['--root', makeRepo({ pages }), '--check']);
  expect(r.code).toBe(1);
  expect(r.all).toContain('section "License" is not mapped to a page');
  expect(r.all).toContain('apps/docs/content/id/start-intro.md: missing ID page');
});

test('--warn prints the findings and exits 0', async () => {
  const pages = PAGES.filter((p) => p.slug !== 'license');
  const r = await run(['--root', makeRepo({ pages }), '--warn']);
  expect(r.code).toBe(0);
  expect(r.all).toContain('section "License" is not mapped to a page');
  expect(r.all).toContain('missing ID page');
});

// Real worktree

const realMap = path.join(REAL_ROOT, 'apps/docs/pages.json');
const haveRealMap = existsSync(realMap);
if (!haveRealMap) console.log(`skipping the real-repo --write test: ${realMap} does not exist yet`);

test.skipIf(!haveRealMap)('--write against the real worktree exits 0', async () => {
  const out = tmp('docs-gen-real-');
  const r = await run(['--root', REAL_ROOT, '--write', '--out', out]);
  if (r.code !== 0) console.log(r.all);
  expect(r.code).toBe(0);
  expect(readdirSync(out).filter((n) => n.endsWith('.md')).length).toBeGreaterThan(0);
});
