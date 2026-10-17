#!/usr/bin/env bun
// scripts/docs-site-check.mjs
//
// Checks the built docs site: a local dist tree before deploy, or the deployed
// site after. It reads output only, so it holds whatever the docs crate does
// internally.
//
// Usage:
//   bun scripts/docs-site-check.mjs <distDir>
//   bun scripts/docs-site-check.mjs --live <baseUrl>
// Exit 0 pass, 1 findings (one per line on stdout), 2 usage or internal error.
//
// LOCAL MODE reads <distDir>, laid out as docs/**/index.html with twins under
// id/docs/**/index.html, Pagefind at docs/pagefind/pagefind.js.
//   - docs/index.html exists, so a wrong dist path cannot pass on an empty tree.
//   - every docs/**/index.html has its id/docs/**/index.html twin, and back.
//   - every page carries <link rel="alternate" hreflang="en"> and hreflang="id";
//     every hreflang target (x-default too) exists in dist.
//   - every internal href and src resolves to a file. Internal means it resolves
//     (relative, root-relative, protocol-relative, or absolute) onto SITE_ORIGIN.
//     Query and fragment are stripped; a path ending in / means index.html; an
//     extensionless path also passes when <path>/index.html exists, because the
//     static host redirects it there. External links are never fetched.
//   - docs/pagefind/pagefind.js exists.
//   - no U+2014 em dash (raw or as &mdash; / &#8212; / &#x2014;) in visible text,
//     meaning text outside tags, comments, <pre>, <code>, <script>, <style>.
//
// LIVE MODE crawls breadth first from <baseUrl> and its twin (/docs/... pairs
// with /id/docs/...; a base outside both trees seeds /docs/ and /id/docs/).
// It follows <a href> and hreflang links on the same origin whose path is under
// /docs or /id/docs, has no file extension or ends in .html, and is not under
// /docs/pagefind/. Query and fragment are dropped before dedupe. Each page must
// answer 200 and carry hreflang en and id; <origin>/docs/pagefind/pagefind.js
// must answer 200. Every request has a 15 s timeout.
//
// The crawl checks at most 500 pages. Stopping at the cap with pages still
// queued is a finding, because a silent cap would pass a site it never read.
// DOCS_SITE_CHECK_MAX_PAGES (a positive integer) overrides the cap; the tests
// use it to reach the cap on a four-page site.

import fs from 'node:fs';
import path from 'node:path';

export const SITE_ORIGIN = 'https://vivera.belajarcarabelajar.com';
const DEFAULT_MAX_PAGES = 500;
const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;
const USAGE = 'usage: bun scripts/docs-site-check.mjs <distDir>\n       bun scripts/docs-site-check.mjs --live <baseUrl>';

class UsageError extends Error {}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in NAMED_ENTITIES) return NAMED_ENTITIES[k];
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : k.startsWith('#') ? parseInt(k.slice(1), 10) : NaN;
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return m;
    return String.fromCodePoint(code);
  });
}

// Blanking keeps every newline, so offsets in the blanked text still map to the
// original line numbers.
function blank(s) {
  return s.replace(/[^\n]/g, ' ');
}

const TAG = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR = /([^\s=>\/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

function parseAttrs(s) {
  const attrs = {};
  for (const m of s.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function tagsOf(html) {
  // Script and style bodies are emptied so a string such as '<a href="/x">' in
  // inline JS is not read as a link; their opening tags stay so src is checked.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (m, open, _n, inner, close) => open + blank(inner) + close);
  const tags = [];
  for (const m of cleaned.matchAll(TAG)) tags.push({ name: m[1].toLowerCase(), attrs: parseAttrs(m[2]) });
  return tags;
}

function isHreflangLink(tag) {
  return tag.name === 'link' && 'hreflang' in tag.attrs && (tag.attrs.rel ?? '').toLowerCase().split(/\s+/).includes('alternate');
}

const EM_DASH = /\u2014|&mdash;|&#0*8212;|&#x0*2014;/gi;

export function emDashLines(html) {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blank)
    .replace(/<[!?][^>]*>/g, blank)
    .replace(/<\/?[a-zA-Z](?:"[^"]*"|'[^']*'|[^'">])*>/g, blank);
  const lines = new Set();
  let line = 1;
  let pos = 0;
  for (const m of text.matchAll(EM_DASH)) {
    for (; pos < m.index; pos++) if (text.charCodeAt(pos) === 10) line++;
    lines.add(line);
  }
  return [...lines];
}

function isFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function isDir(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function listIndexPages(dist, sub) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dist, rel);
    if (!isDir(abs)) return;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(childRel);
      else if (ent.isFile() && ent.name === 'index.html') out.push(childRel);
    }
  };
  walk(sub);
  return out.sort();
}

function internalTarget(raw, base) {
  const v = raw.trim();
  if (v === '') return null;
  let u;
  try {
    u = new URL(v, base);
  } catch {
    return null;
  }
  return u.origin === SITE_ORIGIN ? u : null;
}

function distPathFor(url) {
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    p = url.pathname;
  }
  if (p.endsWith('/')) p += 'index.html';
  return path.posix.normalize(p).replace(/^\/+/, '');
}

function resolvesInDist(dist, rel) {
  if (isFile(path.join(dist, rel))) return true;
  return path.posix.extname(rel) === '' && isFile(path.join(dist, rel, 'index.html'));
}

function checkPage(dist, rel) {
  const html = fs.readFileSync(path.join(dist, rel), 'utf8');
  const pageUrl = new URL(`/${rel.replace(/index\.html$/, '')}`, SITE_ORIGIN);
  const out = [];
  const hreflang = new Map();
  const seen = new Set();
  for (const tag of tagsOf(html)) {
    if (isHreflangLink(tag)) {
      const lang = tag.attrs.hreflang.toLowerCase();
      if (!hreflang.has(lang)) hreflang.set(lang, tag.attrs.href ?? '');
      continue;
    }
    for (const attr of ['href', 'src']) {
      const raw = tag.attrs[attr];
      if (raw === undefined || seen.has(raw)) continue;
      seen.add(raw);
      const target = internalTarget(raw, pageUrl);
      if (!target) continue;
      const distRel = distPathFor(target);
      if (!resolvesInDist(dist, distRel)) out.push(`${rel}: broken link ${raw} (no file ${distRel})`);
    }
  }
  for (const lang of ['en', 'id']) if (!hreflang.has(lang)) out.push(`${rel}: missing hreflang ${lang}`);
  for (const [lang, raw] of hreflang) {
    const target = internalTarget(raw, pageUrl);
    if (!target) {
      out.push(`${rel}: hreflang ${lang} target ${raw} is not on ${SITE_ORIGIN}`);
      continue;
    }
    const distRel = distPathFor(target);
    if (!resolvesInDist(dist, distRel)) out.push(`${rel}: hreflang ${lang} target ${raw} does not exist (${distRel})`);
  }
  for (const line of emDashLines(html)) out.push(`${rel}:${line}: em dash in visible text`);
  return out;
}

export function checkDist(dist) {
  const findings = [];
  const pages = [...listIndexPages(dist, 'docs'), ...listIndexPages(dist, 'id/docs')];
  const pageSet = new Set(pages);
  if (!pageSet.has('docs/index.html')) findings.push('docs/index.html: missing');
  for (const p of pages) {
    if (p.startsWith('docs/')) {
      const twin = `id/${p}`;
      if (!pageSet.has(twin)) findings.push(`${p}: missing Indonesian twin ${twin}`);
    } else {
      const twin = p.slice('id/'.length);
      if (!pageSet.has(twin)) findings.push(`${p}: missing English twin ${twin}`);
    }
  }
  if (!isFile(path.join(dist, 'docs/pagefind/pagefind.js'))) findings.push('docs/pagefind/pagefind.js: missing');
  for (const p of pages) findings.push(...checkPage(dist, p));
  return { findings, pages: pages.length };
}

function isDocsPath(p) {
  return p === '/docs' || p.startsWith('/docs/') || p === '/id/docs' || p.startsWith('/id/docs/');
}

function isCrawlable(u, origin) {
  if (u.origin !== origin || !isDocsPath(u.pathname) || u.pathname.startsWith('/docs/pagefind/')) return false;
  const ext = path.posix.extname(u.pathname.split('/').pop());
  return ext === '' || ext === '.html' || ext === '.htm';
}

function liveSeeds(base) {
  const p = base.pathname;
  const at = (pathname) => new URL(pathname, base.origin);
  if (p === '/docs' || p.startsWith('/docs/')) return [at(p), at(`/id${p}`)];
  if (p === '/id/docs' || p.startsWith('/id/docs/')) return [at(p), at(p.slice('/id'.length))];
  return [at('/docs/'), at('/id/docs/')];
}

async function fetchPage(url, { wantBody }) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (res.status !== 200 || !wantBody) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, url: res.url };
    }
    return { status: 200, url: res.url, body: await res.text() };
  } catch (err) {
    return { error: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}` };
  }
}

export async function checkLive(baseUrl, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const base = new URL(baseUrl);
  const origin = base.origin;
  const findings = [];
  const queue = [];
  const seen = new Set();
  const referrer = new Map();
  const enqueue = (u, from) => {
    const key = origin + u.pathname;
    if (seen.has(key)) return;
    seen.add(key);
    referrer.set(key, from);
    queue.push(key);
  };
  for (const seed of liveSeeds(base)) enqueue(seed, null);

  let checked = 0;
  while (queue.length > 0 && checked < maxPages) {
    const batch = queue.splice(0, Math.min(CONCURRENCY, maxPages - checked));
    checked += batch.length;
    const results = await Promise.all(batch.map((url) => fetchPage(url, { wantBody: true })));
    batch.forEach((url, i) => {
      const r = results[i];
      const from = referrer.get(url);
      const suffix = from ? ` (linked from ${from})` : '';
      if (r.error) return findings.push(`${url}: fetch failed (${r.error})${suffix}`);
      if (r.status !== 200) return findings.push(`${url}: HTTP ${r.status}${suffix}`);
      const pageBase = new URL(r.url || url);
      const langs = new Set();
      for (const tag of tagsOf(r.body)) {
        let raw;
        if (isHreflangLink(tag)) {
          langs.add(tag.attrs.hreflang.toLowerCase());
          raw = tag.attrs.href;
        } else if (tag.name === 'a') {
          raw = tag.attrs.href;
        }
        if (raw === undefined) continue;
        let u;
        try {
          u = new URL(raw.trim(), pageBase);
        } catch {
          continue;
        }
        if (isCrawlable(u, origin)) enqueue(u, url);
      }
      for (const lang of ['en', 'id']) if (!langs.has(lang)) findings.push(`${url}: missing hreflang ${lang}`);
    });
  }
  if (queue.length > 0) {
    findings.push(`${base.href}: crawl cap of ${maxPages} pages reached with at least ${queue.length} pages unchecked`);
  }

  const pagefind = `${origin}/docs/pagefind/pagefind.js`;
  const pf = await fetchPage(pagefind, { wantBody: false });
  if (pf.error) findings.push(`${pagefind}: fetch failed (${pf.error})`);
  else if (pf.status !== 200) findings.push(`${pagefind}: HTTP ${pf.status}`);
  return { findings, pages: checked };
}

function parseMaxPages(env) {
  const raw = env.DOCS_SITE_CHECK_MAX_PAGES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_PAGES;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new UsageError(`DOCS_SITE_CHECK_MAX_PAGES must be a positive integer, got "${raw}"`);
  return Number(raw);
}

function report({ findings, pages }, noun) {
  if (findings.length === 0) {
    console.log(`docs-site-check: ok, ${pages} pages ${noun}`);
    return 0;
  }
  for (const f of findings) console.log(f);
  console.error(`docs-site-check: ${findings.length} findings, ${pages} pages ${noun}`);
  return 1;
}

export async function main(args, env = process.env) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args[0] === '--live') {
    if (args.length !== 2) throw new UsageError('--live takes exactly one base URL');
    let base;
    try {
      base = new URL(args[1]);
    } catch {
      throw new UsageError(`not a URL: ${args[1]}`);
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new UsageError(`not an http(s) URL: ${args[1]}`);
    const maxPages = parseMaxPages(env);
    return report(await checkLive(base.href, { maxPages }), 'crawled');
  }
  if (args.length !== 1 || args[0].startsWith('-')) throw new UsageError('expected one dist directory or --live <baseUrl>');
  const dist = path.resolve(args[0]);
  if (!isDir(dist)) throw new UsageError(`not a directory: ${args[0]}`);
  return report(checkDist(dist), 'checked');
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof UsageError) console.error(`docs-site-check: ${err.message}\n${USAGE}`);
      else console.error(`docs-site-check: internal error: ${err?.stack ?? err}`);
      process.exit(2);
    },
  );
}
