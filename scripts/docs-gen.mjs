#!/usr/bin/env bun
// scripts/docs-gen.mjs
//
// Generates the docs site pages from README.md sections and the published
// Markdown files under docs/, following the page map in apps/docs/pages.json.
// README.md stays the single source: the site, GitHub, and the README show the
// same text, and --check fails when a source change leaves the map or the
// Indonesian twins behind.
//
//   bun scripts/docs-gen.mjs [--root <dir>] --write [--out <dir>]
//   bun scripts/docs-gen.mjs [--root <dir>] --check [--scope en|id|all]
//   bun scripts/docs-gen.mjs [--root <dir>] --warn
//   bun scripts/docs-gen.mjs [--root <dir>] --hashes
//
// Exit 0 ok, 1 findings, 2 usage error.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { rewriteLine } from './lib/docs-gen-links.mjs';
import { sourceFiles, joinParts } from './lib/docs-gen-files.mjs';
import { idFindings } from './lib/docs-gen-id.mjs';

export { rewriteLine };

export const GITHUB = 'https://github.com/belajarcarabelajar/vivera';
export const RAW = 'https://raw.githubusercontent.com/belajarcarabelajar/vivera/main';
export const USAGE = 'usage: bun scripts/docs-gen.mjs [--root <dir>] (--write [--out <dir>] | --check [--scope en|id|all] | --warn | --hashes)';
const EM_DASH = '\u2014';
const MAP_FILE = 'apps/docs/pages.json';
const EN_DIR = 'apps/docs/content/en';
const STATIC_DIR = 'apps/docs/static/generated';
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { root: process.cwd(), out: null, scope: null, modes: [] };
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write' || a === '--check' || a === '--warn' || a === '--hashes') opts.modes.push(a.slice(2));
    else if (a === '--root') opts.root = value(i++, a);
    else if (a === '--out') opts.out = value(i++, a);
    else if (a === '--scope') opts.scope = value(i++, a);
    else throw new UsageError(`unknown argument: ${a}`);
  }
  if (opts.modes.length !== 1) throw new UsageError('exactly one of --write, --check, --warn, --hashes is required');
  const mode = opts.modes[0];
  if (opts.scope !== null && mode !== 'check') throw new UsageError('--scope is only valid with --check');
  if (opts.scope !== null && !['en', 'id', 'all'].includes(opts.scope)) throw new UsageError('--scope must be en, id, or all');
  if (opts.out !== null && mode !== 'write') throw new UsageError('--out is only valid with --write');
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError(`--root ${opts.root} is not a directory`);
  return {
    mode,
    root,
    scope: opts.scope ?? 'all',
    out: opts.out === null ? path.join(root, EN_DIR) : path.resolve(opts.out),
  };
}

// Markdown structure

export function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      mask[i] = true;
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === open[0] && close[1].length >= open.length) open = null;
      continue;
    }
    const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    // A backtick info string cannot contain a backtick, so such a line is inline code.
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      open = m[1];
      mask[i] = true;
    }
  }
  return mask;
}

function plainHeading(text) {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
}

export function slugBase(text) {
  return plainHeading(text).toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}

// Mirrors github-slugger: repeats get -1, -2, ... in document order.
export class Slugger {
  constructor() { this.seen = new Map(); }
  slug(text) {
    const base = slugBase(text);
    let result = base;
    while (this.seen.has(result)) {
      const n = this.seen.get(base) + 1;
      this.seen.set(base, n);
      result = `${base}-${n}`;
    }
    this.seen.set(result, 0);
    return result;
  }
}

function headingsOf(lines, mask) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const m = HEADING.exec(lines[i]);
    if (m) out.push({ idx: i, level: m[1].length, text: m[2] });
  }
  return out;
}

function readText(abs) {
  return fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n');
}

export function parseReadme(text) {
  const lines = text.split('\n');
  const mask = fenceMask(lines);
  const headings = headingsOf(lines, mask);
  const seconds = headings.filter((h) => h.level === 2);
  const preambleEnd = seconds.length ? seconds[0].idx : lines.length;
  const title = headings.find((h) => h.level === 1 && h.idx < preambleEnd);
  const titleIdx = title ? title.idx : -1;
  const sections = [];
  const errors = [];
  const preambleHasText = lines.slice(0, preambleEnd).some((l, i) => i !== titleIdx && l.trim() !== '');
  if (preambleHasText) {
    const first = lines.findIndex((l, i) => i < preambleEnd && i !== titleIdx && l.trim() !== '');
    sections.push({ key: '', line: first + 1, start: 0, end: preambleEnd });
  }
  const byKey = new Map();
  seconds.forEach((h, k) => {
    const section = { key: h.text, line: h.idx + 1, start: h.idx, end: k + 1 < seconds.length ? seconds[k + 1].idx : lines.length };
    if (byKey.has(h.text)) {
      errors.push(`README.md:${byKey.get(h.text).line} and README.md:${section.line}: duplicate section heading "${h.text}"`);
      return;
    }
    byKey.set(h.text, section);
    sections.push(section);
  });
  if (preambleHasText) byKey.set('', sections[0]);

  const anchors = new Map();
  const global = new Slugger();
  const locals = new Map(sections.map((s) => [s.key, new Slugger()]));
  const sectionOf = (idx) => {
    let found = null;
    for (const s of sections) if (idx >= s.start && idx < s.end) found = s;
    return found;
  };
  for (const h of headings) {
    const g = global.slug(h.text);
    const s = sectionOf(h.idx);
    if (h.idx === titleIdx) {
      anchors.set(g, { sectionKey: '', localSlug: null, isTop: true });
      continue;
    }
    if (!s) continue;
    const local = locals.get(s.key).slug(h.text);
    anchors.set(g, { sectionKey: s.key, localSlug: local, isTop: h.idx === s.start && h.level === 2 });
  }
  return { lines, mask, titleIdx, sections, byKey, anchors, errors };
}

function fileAnchors(lines, mask) {
  const anchors = new Map();
  const slugger = new Slugger();
  let topSeen = false;
  for (const h of headingsOf(lines, mask)) {
    const s = slugger.slug(h.text);
    const isTop = !topSeen && h.level === 1;
    if (isTop) topSeen = true;
    anchors.set(s, { localSlug: s, isTop });
  }
  return anchors;
}

// Globs and the docs walk

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walkDocs(root, exclude) {
  const res = exclude.map(globToRegExp);
  const excluded = (rel) => res.some((r) => r.test(rel));
  const found = [];
  const seen = new Set();
  const walk = (relDir) => {
    const abs = path.join(root, relDir);
    let real;
    try { real = fs.realpathSync(abs); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    for (const name of fs.readdirSync(abs).sort()) {
      const rel = `${relDir}/${name}`;
      let st;
      try { st = fs.statSync(path.join(root, rel)); } catch { continue; }
      if (st.isDirectory()) {
        if (!excluded(`${rel}/`)) walk(rel);
      } else if (name.endsWith('.md') && !excluded(rel)) found.push(rel);
    }
  };
  if (fs.existsSync(path.join(root, 'docs'))) walk('docs');
  return found;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

// Model

function pageUrl(page) {
  // The docs crate serves the introduction page at /docs/ and has no route under its category.
  if (page.category === 'getting-started' && page.slug === 'introduction') return '/docs/';
  return `/docs/${page.category}/${page.slug}/`;
}

function loadMap(root, errors) {
  const abs = path.join(root, MAP_FILE);
  let map;
  try {
    map = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    errors.push(`${MAP_FILE}: cannot read the page map (${e.code === 'ENOENT' ? 'file does not exist' : e.message})`);
    return { pages: [], exclude: [] };
  }
  const pages = Array.isArray(map.pages) ? map.pages : [];
  if (!Array.isArray(map.pages)) errors.push(`${MAP_FILE}: "pages" must be an array`);
  const exclude = Array.isArray(map.exclude) ? map.exclude.filter((g) => typeof g === 'string') : [];
  return { pages, exclude };
}

export function buildModel(root) {
  const errors = [];
  const map = loadMap(root, errors);
  const readmeAbs = path.join(root, 'README.md');
  const readme = parseReadme(fs.existsSync(readmeAbs) ? readText(readmeAbs) : '');
  if (!fs.existsSync(readmeAbs)) errors.push('README.md: file does not exist');
  errors.push(...readme.errors);

  const valid = [];
  const keys = new Map();
  const bySection = new Map();
  const byFile = new Map();
  map.pages.forEach((p, i) => {
    const missing = ['category', 'slug', 'title', 'description'].filter((f) => typeof p?.[f] !== 'string' || p[f] === '');
    if (typeof p?.order !== 'number') missing.push('order');
    const src = sourceFiles(p?.source);
    if (!src) missing.push('source.file');
    if (missing.length) {
      errors.push(`${MAP_FILE}: page ${i + 1} is missing ${missing.join(', ')}`);
      return;
    }
    const key = `${p.category}-${p.slug}`;
    if (keys.has(key)) {
      errors.push(`${MAP_FILE}: page ${key} is listed twice`);
      return;
    }
    keys.set(key, p);
    if (src.error) {
      errors.push(`page ${key}: ${src.error}`);
      return;
    }
    const file = p.source.file;
    const hasHeading = Object.prototype.hasOwnProperty.call(p.source, 'heading');
    if (file === 'README.md') {
      if (!hasHeading || typeof p.source.heading !== 'string') {
        errors.push(`page ${key}: a README.md page needs a heading ("" for the preamble)`);
        return;
      }
      const heading = p.source.heading;
      if (!readme.byKey.has(heading)) {
        errors.push(`page ${key}: README.md heading "${heading}" does not exist`);
        return;
      }
      if (bySection.has(heading)) {
        errors.push(`page ${key}: README.md section "${heading}" is already mapped by page ${bySection.get(heading).key}`);
        return;
      }
      const entry = { key, page: p, kind: 'section', section: readme.byKey.get(heading) };
      bySection.set(heading, entry);
      valid.push(entry);
      return;
    }
    if (hasHeading) {
      errors.push(`page ${key}: heading is only valid for README.md`);
      return;
    }
    const gone = src.files.find((f) => !fs.existsSync(path.join(root, f)) || !fs.statSync(path.join(root, f)).isFile());
    const taken = src.files.find((f) => byFile.has(f));
    if (gone || taken) {
      errors.push(gone ? `page ${key}: source file ${gone} does not exist` : `page ${key}: ${taken} is already mapped by page ${byFile.get(taken).key}`);
      return;
    }
    const joined = joinParts(src.files.map((f) => ({ file: f, text: readText(path.join(root, f)) })), fenceMask);
    const entry = { key, page: p, kind: 'file', file: src.files[0], ...joined, anchors: fileAnchors(joined.lines, joined.mask) };
    for (const f of src.files) byFile.set(f, entry);
    valid.push(entry);
  });

  for (const s of readme.sections) {
    if (bySection.has(s.key)) continue;
    errors.push(s.key === ''
      ? `README.md:${s.line}: the preamble is not mapped to a page (heading "")`
      : `README.md:${s.line}: section "${s.key}" is not mapped to a page`);
  }
  for (const rel of walkDocs(root, map.exclude)) {
    if (!byFile.has(rel)) errors.push(`${rel}: published docs file is not mapped to a page`);
  }

  const images = new Set();
  const ctxBase = { root, readme, bySection, byFile, images };
  const pages = valid.map((entry) => renderPage(entry, ctxBase));
  pages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { errors, pages, images: [...images].sort() };
}

function findReadmeAnchor(anchor, ctx) {
  const a = safeDecode(anchor);
  return ctx.readme.anchors.get(a) ?? ctx.readme.anchors.get(a.toLowerCase()) ?? null;
}

function sectionUrl(target, hit) {
  return pageUrl(target.page) + (hit.isTop || !hit.localSlug ? '' : `#${hit.localSlug}`);
}

function isDeadTarget(root, rel) {
  // docs/code-plan is gitignored local state, so it exists on disk but not on GitHub.
  return rel === 'docs/code-plan' || rel.startsWith('docs/code-plan/') || !fs.existsSync(path.join(root, rel));
}

function makeRewriter(entry, ctx, state) {
  const at = () => `${state.file ?? 'README.md'}:${state.line}`;
  const note = (what, url) => state.findings.push(what === 'dead'
    ? `${at()}: dead link "${url}" (target is missing or gitignored)`
    : `${at()}: unknown anchor "${url}" (no heading in any mapped page)`);
  return (url, kind = 'link') => {
    const keep = { url, dead: false };
    if (url === '' || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return keep;
    const hashAt = url.indexOf('#');
    let pathPart = hashAt === -1 ? url : url.slice(0, hashAt);
    const anchor = hashAt === -1 || hashAt === url.length - 1 ? null : url.slice(hashAt + 1);
    if (pathPart === '') {
      if (anchor === null) return keep;
      if (entry.kind === 'file') {
        if (!entry.anchors.has(safeDecode(anchor))) note('anchor', url);
        return keep;
      }
      const hit = findReadmeAnchor(anchor, ctx);
      const target = hit && ctx.bySection.get(hit.sectionKey);
      if (!target) {
        note('anchor', url);
        return keep;
      }
      if (hit.sectionKey === entry.section.key) return { url: hit.localSlug ? `#${hit.localSlug}` : url, dead: false };
      return { url: sectionUrl(target, hit), dead: false };
    }
    const queryAt = pathPart.indexOf('?');
    const query = queryAt === -1 ? '' : pathPart.slice(queryAt);
    if (queryAt !== -1) pathPart = pathPart.slice(0, queryAt);
    const decoded = safeDecode(pathPart);
    const dirHint = decoded.endsWith('/');
    const base = decoded.startsWith('/') ? '.' : path.posix.dirname(state.file ?? 'README.md');
    let rel = path.posix.normalize(path.posix.join(base, decoded.replace(/^\/+/, ''))).replace(/\/+$/, '');
    if (rel === '.') rel = '';
    if (rel === '..' || rel.startsWith('../')) return keep;
    if (isDeadTarget(ctx.root, rel)) {
      note('dead', url);
      return { url, dead: true };
    }
    const abs = path.join(ctx.root, rel);
    const isDir = dirHint || rel === '' || fs.statSync(abs).isDirectory();
    if (rel.startsWith('diagrams/') && !isDir) {
      ctx.images.add(rel);
      return { url: `/docs/generated/${rel.slice('diagrams/'.length)}`, dead: false };
    }
    // Served from GitHub rather than copied: the images outside diagrams/ are not MIT licensed.
    if (kind === 'image' && !isDir) return { url: `${RAW}/${encodePath(rel)}`, dead: false };
    if (rel === 'README.md') {
      if (anchor !== null) {
        const hit = findReadmeAnchor(anchor, ctx);
        const target = hit && ctx.bySection.get(hit.sectionKey);
        if (target) return { url: sectionUrl(target, hit), dead: false };
        note('anchor', url);
      }
      const preamble = ctx.bySection.get('');
      if (preamble) return { url: pageUrl(preamble.page), dead: false };
    }
    const filePage = ctx.byFile.get(rel);
    if (filePage) {
      const hit = anchor === null ? null : filePage.anchors.get(safeDecode(anchor));
      // Another part of this same page: the anchor is on the page already.
      if (filePage === entry && rel !== state.file && hit) return { url: `#${hit.localSlug}`, dead: false };
      return { url: pageUrl(filePage.page) + (hit && !hit.isTop ? `#${hit.localSlug}` : ''), dead: false };
    }
    const tail = anchor === null ? '' : `#${anchor}`;
    return { url: `${GITHUB}/${isDir ? 'tree' : 'blob'}/main${rel ? `/${encodePath(rel)}` : ''}${isDir ? '' : query}${tail}`, dead: false };
  };
}

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

function renderPage(entry, ctx) {
  const { page } = entry;
  const state = { line: 0, findings: [] };
  const rewrite = makeRewriter(entry, ctx, state);
  let lines;
  let mask;
  let start;
  let end;
  let skip = -1;
  if (entry.kind === 'section') {
    ({ lines, mask } = ctx.readme);
    ({ start, end } = entry.section);
    skip = ctx.readme.titleIdx;
  } else {
    ({ lines, mask } = entry);
    start = 0;
    end = lines.length;
  }
  const out = [];
  const src = [];
  const fenced = [];
  for (let i = start; i < end; i++) {
    if (i === skip) continue;
    let line = lines[i];
    state.line = entry.lineOf ? entry.lineOf[i] : i + 1;
    state.file = entry.fileOf?.[i];
    if (!mask[i]) {
      const h = HEADING.exec(line);
      if (entry.kind === 'section' && h && h[1].length >= 2) line = line.slice(1);
      line = rewriteLine(line, rewrite);
    }
    out.push(line);
    src.push(`${state.file ?? 'README.md'}:${state.line}`);
    fenced.push(mask[i]);
  }
  const drop = () => { out.pop(); src.pop(); fenced.pop(); };
  while (out.length && out[0].trim() === '') { out.shift(); src.shift(); fenced.shift(); }
  for (;;) {
    while (out.length && out[out.length - 1].trim() === '') drop();
    const last = out.length - 1;
    if (last < 0 || fenced[last] || !THEMATIC_BREAK.test(out[last])) break;
    // A dashed line right under text is a setext heading underline, not a break.
    if (out[last].trim()[0] === '-' && last > 0 && out[last - 1].trim() !== '') break;
    drop();
  }
  const body = `${out.join('\n')}\n`;
  const hash = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
  const sourceLabel = entry.kind === 'section'
    ? (entry.section.key === '' ? 'README.md' : `README.md#${entry.section.key}`)
    : entry.file;
  const fm = YAML.stringify({
    title: page.title,
    description: page.description,
    category: page.category,
    slug: page.slug,
    order: page.order,
    source: sourceLabel,
  }, { lineWidth: 0 });
  // Always quoted: an unquoted hex hash such as 6419418e6221 is a YAML float.
  const head = `---\n${fm}source_hash: "${hash}"\n---\n\n`;
  return {
    key: entry.key,
    name: `${entry.key}.md`,
    body,
    hash,
    text: head + body,
    bodyOffset: head.split('\n').length - 1,
    srcAt: src,
    linkFindings: state.findings,
  };
}

// Checks

function rel(root, abs) {
  const r = path.relative(root, abs);
  return r.startsWith('..') || path.isAbsolute(r) ? abs : r.split(path.sep).join('/');
}

function enFindings(model) {
  const findings = [...model.errors];
  for (const p of model.pages) {
    p.body.split('\n').forEach((line, i) => {
      if (line.includes(EM_DASH)) {
        findings.push(`${EN_DIR}/${p.name}:${p.bodyOffset + i + 1}: em dash (U+2014), from ${p.srcAt[i]}`);
      }
    });
    findings.push(...p.linkFindings);
  }
  return findings;
}

function findingsFor(model, root, scope) {
  return [
    ...(scope === 'en' || scope === 'all' ? enFindings(model) : []),
    ...(scope === 'id' || scope === 'all' ? idFindings(model, root) : []),
  ];
}

function writePages(model, root, out) {
  fs.mkdirSync(out, { recursive: true });
  const names = new Set(model.pages.map((p) => p.name));
  for (const name of fs.readdirSync(out)) {
    if (name.endsWith('.md') && !names.has(name)) fs.unlinkSync(path.join(out, name));
  }
  for (const p of model.pages) fs.writeFileSync(path.join(out, p.name), p.text);
  const staticAbs = path.join(root, STATIC_DIR);
  for (const img of model.images) {
    const dest = path.join(staticAbs, img.slice('diagrams/'.length));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, img), dest);
  }
}

export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`docs-gen: ${e.message}`);
    console.error(USAGE);
    return 2;
  }
  const { root, mode } = opts;
  const model = buildModel(root);
  if (mode === 'hashes') {
    for (const e of model.errors) console.error(e);
    const hashes = Object.fromEntries(model.pages.map((p) => [p.key, p.hash]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    console.log(JSON.stringify(hashes, null, 2));
    return model.errors.length ? 1 : 0;
  }
  if (mode === 'write') {
    if (model.errors.length) {
      for (const e of model.errors) console.log(e);
      console.log(`docs-gen: ${model.errors.length} mapping error(s), nothing written`);
      return 1;
    }
    writePages(model, root, opts.out);
    console.log(`docs-gen: wrote ${model.pages.length} pages to ${rel(root, opts.out)}, copied ${model.images.length} image(s) to ${STATIC_DIR}`);
    return 0;
  }
  const scope = mode === 'warn' ? 'all' : opts.scope;
  const findings = findingsFor(model, root, scope);
  for (const f of findings) console.log(f);
  console.log(`docs-gen: ${findings.length} finding(s), scope ${scope}, ${model.pages.length} pages`);
  if (mode === 'warn') return 0;
  return findings.length ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
