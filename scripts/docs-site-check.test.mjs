import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The checker reads build output, never the docs crate, so every test drives the
// CLI entry point on a fixture dist tree or a local server (repo rule L12: a green
// suite that never runs the CLI once proved nothing).

const SCRIPT = path.join(import.meta.dir, 'docs-site-check.mjs');
const SITE = 'https://vivera.belajarcarabelajar.com';
const EM = '\u2014';

const tmpDirs = [];
const servers = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  for (const s of servers) s.stop(true);
});

async function run(args, env = {}) {
  // Async spawn on purpose: the live tests serve from this same process, so a
  // blocking spawnSync would starve the server and hang the crawl.
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr, lines: stdout.split('\n').filter(Boolean) };
}

function hreflangTags(alt) {
  return Object.entries(alt)
    .map(([lang, href]) => `<link rel="alternate" hreflang="${lang}" href="${href}">`)
    .join('\n    ');
}

function defaultHreflang(route) {
  return { en: `${SITE}/${route}`, id: `${SITE}/id/${route}`, 'x-default': `${SITE}/${route}` };
}

function renderPage({ lang, route, body, hreflang }) {
  return [
    '<!doctype html>',
    `<html lang="${lang}">`,
    '  <head>',
    '    <meta charset="utf-8">',
    '    <title>Vivera docs</title>',
    `    ${hreflangTags(hreflang ?? defaultHreflang(route))}`,
    '    <script type="module" src="/docs/pagefind/pagefind.js"></script>',
    '  </head>',
    '  <body>',
    ...body.map((line) => `    ${line}`),
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

function pageBody(lang, sub) {
  const p = lang === 'id' ? '/id/docs' : '/docs';
  const other = lang === 'id' ? '/docs' : '/id/docs';
  if (sub === '') {
    return [
      `<nav><a href="${p}/guides/">Guides</a> <a href="${other}/">Other language</a></nav>`,
      '<p>Welcome to the farm - a short tour.</p>',
      '<p><a href="https://example.com/elsewhere">Elsewhere</a> <a href="mailto:farmer@example.com">Mail</a> <a href="#top">Top</a></p>',
    ];
  }
  if (sub === 'guides/') {
    return [
      '<p><a href="install/?ref=guides#step-2">Install</a> <a href="../">Back</a></p>',
      `<p><a href="${SITE}${p}/">Home</a></p>`,
    ];
  }
  return [
    '<img src="/docs/generated/diagram.svg" alt="Diagram">',
    `<p><a href="${p}/guides/install/?q=1#step-2">Step 2</a> <a href="//vivera.belajarcarabelajar.com${p}/guides/">Up</a></p>`,
  ];
}

function baseTree() {
  const pages = {};
  for (const lang of ['en', 'id']) {
    for (const sub of ['', 'guides/', 'guides/install/']) {
      const rel = `${lang === 'id' ? 'id/' : ''}docs/${sub}index.html`;
      pages[rel] = { lang, route: `docs/${sub}`, body: pageBody(lang, sub) };
    }
  }
  const files = {
    'docs/pagefind/pagefind.js': 'export const search = () => [];\n',
    'docs/generated/diagram.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
  };
  return { pages, files };
}

function makeDist(mutate) {
  const tree = baseTree();
  mutate?.(tree);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-check-'));
  tmpDirs.push(dir);
  const write = (rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  for (const [rel, page] of Object.entries(tree.pages)) write(rel, renderPage(page));
  for (const [rel, content] of Object.entries(tree.files)) write(rel, content);
  return dir;
}

function lineOf(dir, rel, needle) {
  return fs.readFileSync(path.join(dir, rel), 'utf8').split('\n').findIndex((l) => l.includes(needle)) + 1;
}

describe('local mode', () => {
  test('passes a complete bilingual tree with query, fragment, relative, and external links', async () => {
    const r = await run([makeDist()]);
    expect(r.stdout).toContain('6 pages');
    expect(r.code).toBe(0);
  });

  test('reports an English page whose Indonesian twin is missing', async () => {
    const dist = makeDist((t) => delete t.pages['id/docs/guides/install/index.html']);
    const r = await run([dist]);
    expect(r.lines).toContain('docs/guides/install/index.html: missing Indonesian twin id/docs/guides/install/index.html');
    expect(r.code).toBe(1);
  });

  test('reports an Indonesian page whose English twin is missing', async () => {
    const dist = makeDist((t) => delete t.pages['docs/guides/install/index.html']);
    const r = await run([dist]);
    expect(r.lines).toContain('id/docs/guides/install/index.html: missing English twin docs/guides/install/index.html');
    expect(r.code).toBe(1);
  });

  test('reports an internal href that resolves to no file, after stripping query and fragment', async () => {
    const dist = makeDist((t) => t.pages['docs/index.html'].body.push('<a href="/docs/nope/?x=1#y">Nope</a>'));
    const r = await run([dist]);
    expect(r.lines).toContain('docs/index.html: broken link /docs/nope/?x=1#y (no file docs/nope/index.html)');
    expect(r.code).toBe(1);
  });

  test('reports an internal src that resolves to no file', async () => {
    const dist = makeDist((t) => t.pages['id/docs/index.html'].body.push(`<img src="${SITE}/docs/generated/missing.png" alt="x">`));
    const r = await run([dist]);
    expect(r.lines).toContain(`id/docs/index.html: broken link ${SITE}/docs/generated/missing.png (no file docs/generated/missing.png)`);
    expect(r.code).toBe(1);
  });

  test('reports a page without an hreflang id link', async () => {
    const dist = makeDist((t) => {
      t.pages['docs/guides/index.html'].hreflang = { en: `${SITE}/docs/guides/`, 'x-default': `${SITE}/docs/guides/` };
    });
    const r = await run([dist]);
    expect(r.lines).toContain('docs/guides/index.html: missing hreflang id');
    expect(r.code).toBe(1);
  });

  test('reports an hreflang target that does not exist in dist, once', async () => {
    const ghost = `${SITE}/id/docs/ghost/`;
    const dist = makeDist((t) => {
      t.pages['docs/guides/index.html'].hreflang = { en: `${SITE}/docs/guides/`, id: ghost };
    });
    const r = await run([dist]);
    const hits = r.lines.filter((l) => l.includes(ghost));
    expect(hits).toEqual([`docs/guides/index.html: hreflang id target ${ghost} does not exist (id/docs/ghost/index.html)`]);
    expect(r.code).toBe(1);
  });

  test('reports a missing pagefind.js', async () => {
    const dist = makeDist((t) => delete t.files['docs/pagefind/pagefind.js']);
    const r = await run([dist]);
    expect(r.lines).toContain('docs/pagefind/pagefind.js: missing');
    expect(r.code).toBe(1);
  });

  test('reports a dist without docs/index.html instead of passing vacuously', async () => {
    const dist = makeDist((t) => {
      t.pages = {};
    });
    const r = await run([dist]);
    expect(r.lines).toContain('docs/index.html: missing');
    expect(r.code).toBe(1);
  });

  test('reports an em dash in paragraph text with its line', async () => {
    const dist = makeDist((t) => t.pages['docs/guides/index.html'].body.push(`<p>Plant seeds ${EM} then water them.</p>`));
    const r = await run([dist]);
    const line = lineOf(dist, 'docs/guides/index.html', 'Plant seeds');
    expect(r.lines).toContain(`docs/guides/index.html:${line}: em dash in visible text`);
    expect(r.code).toBe(1);
  });

  test('reports an em dash written as an HTML entity', async () => {
    const dist = makeDist((t) => t.pages['id/docs/index.html'].body.push('<p>Tanam benih &mdash; lalu siram.</p>'));
    const r = await run([dist]);
    const line = lineOf(dist, 'id/docs/index.html', 'Tanam benih');
    expect(r.lines).toContain(`id/docs/index.html:${line}: em dash in visible text`);
    expect(r.code).toBe(1);
  });

  test('allows an em dash inside pre', async () => {
    const dist = makeDist((t) => t.pages['docs/index.html'].body.push(`<pre>$ vivera ship ${EM} done\n  next ${EM} line</pre>`));
    const r = await run([dist]);
    expect(r.code).toBe(0);
  });

  test('allows an em dash inside code, script, and style', async () => {
    const dist = makeDist((t) => {
      t.pages['docs/index.html'].body.push(
        `<p>Run <code>echo "${EM}"</code> once.</p>`,
        `<script>const dash = "${EM}";</script>`,
        `<style>.x::after { content: "${EM}"; }</style>`,
      );
    });
    const r = await run([dist]);
    expect(r.code).toBe(0);
  });
});

describe('usage', () => {
  test('exits 2 without arguments', async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
  });

  test('exits 2 for --live without a URL', async () => {
    const r = await run(['--live']);
    expect(r.code).toBe(2);
  });

  test('exits 2 when the dist directory does not exist', async () => {
    const r = await run([path.join(os.tmpdir(), 'docs-site-check-does-not-exist')]);
    expect(r.code).toBe(2);
  });

  test('exits 2 for a cap override that is not a positive integer', async () => {
    const r = await run(['--live', 'http://127.0.0.1:9/docs/'], { DOCS_SITE_CHECK_MAX_PAGES: 'abc' });
    expect(r.code).toBe(2);
  });
});

function livePage({ lang, route, links = [], hreflang }) {
  return renderPage({
    lang,
    route,
    hreflang,
    body: links.map((href) => `<a href="${href}">link</a>`),
  });
}

function liveRoutes(externalOrigin) {
  // /docs/ never links /id/docs/, so a pass that counts 4 pages proves the twin seed.
  return {
    '/docs/': livePage({ lang: 'en', route: 'docs/', links: ['/docs/guides/', `${externalOrigin}/docs/`, '/about/'] }),
    '/docs/guides/': livePage({ lang: 'en', route: 'docs/guides/', links: ['/docs/guides/?tab=2#x', '/docs/'] }),
    '/id/docs/': livePage({ lang: 'id', route: 'docs/', links: ['/id/docs/guides/'] }),
    '/id/docs/guides/': livePage({ lang: 'id', route: 'docs/guides/', links: ['/id/docs/'] }),
    '/docs/pagefind/pagefind.js': 'export const search = () => [];\n',
  };
}

function serve(routes) {
  const hits = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url);
      hits.push(u.pathname);
      const body = routes[u.pathname];
      if (body === undefined) return new Response('not found', { status: 404 });
      const type = u.pathname.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
      return new Response(body, { headers: { 'content-type': type } });
    },
  });
  servers.push(server);
  return { hits, origin: `http://127.0.0.1:${server.port}` };
}

describe('live mode', () => {
  test('passes a crawl of both language trees and stays on origin and under /docs', async () => {
    const external = serve({ '/docs/': 'elsewhere' });
    const site = serve(liveRoutes(external.origin));
    const r = await run(['--live', `${site.origin}/docs/`]);
    expect(r.stdout).toContain('4 pages');
    expect(r.code).toBe(0);
    expect(external.hits).toEqual([]);
    expect(site.hits).not.toContain('/about/');
  });

  test('reports a linked page that answers 404', async () => {
    const external = serve({});
    const routes = liveRoutes(external.origin);
    routes['/docs/guides/'] = livePage({ lang: 'en', route: 'docs/guides/', links: ['/docs/missing/'] });
    const site = serve(routes);
    const r = await run(['--live', `${site.origin}/docs/`]);
    expect(r.lines).toContain(`${site.origin}/docs/missing/: HTTP 404 (linked from ${site.origin}/docs/guides/)`);
    expect(r.code).toBe(1);
  });

  test('reports a page without an hreflang en link', async () => {
    const external = serve({});
    const routes = liveRoutes(external.origin);
    routes['/id/docs/guides/'] = livePage({
      lang: 'id',
      route: 'docs/guides/',
      hreflang: { id: `${SITE}/id/docs/guides/` },
    });
    const site = serve(routes);
    const r = await run(['--live', `${site.origin}/docs/`]);
    expect(r.lines).toContain(`${site.origin}/id/docs/guides/: missing hreflang en`);
    expect(r.code).toBe(1);
  });

  test('reports a pagefind.js that does not answer 200', async () => {
    const external = serve({});
    const routes = liveRoutes(external.origin);
    delete routes['/docs/pagefind/pagefind.js'];
    const site = serve(routes);
    const r = await run(['--live', `${site.origin}/docs/`]);
    expect(r.lines).toContain(`${site.origin}/docs/pagefind/pagefind.js: HTTP 404`);
    expect(r.code).toBe(1);
  });

  test('fails when the crawl reaches the page cap with pages left unchecked', async () => {
    const external = serve({});
    const site = serve(liveRoutes(external.origin));
    const r = await run(['--live', `${site.origin}/docs/`], { DOCS_SITE_CHECK_MAX_PAGES: '2' });
    expect(r.lines.some((l) => l.includes('crawl cap of 2 pages reached'))).toBe(true);
    expect(r.code).toBe(1);
    const pageHits = site.hits.filter((h) => !h.endsWith('.js'));
    expect(pageHits.length).toBe(2);
  });
});
