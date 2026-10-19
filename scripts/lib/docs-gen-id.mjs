// scripts/lib/docs-gen-id.mjs
//
// The Indonesian twin checks behind `docs-gen --check --scope id`. Each EN page
// has one ID page, apps/docs/content/id/<category>-<slug>.md, whose frontmatter
// carries the source_hash of the EN text it translates. A page too long for one
// file under the size gate goes on in continuation parts, `<name>.2.md`,
// `<name>.3.md`, ..., with no frontmatter, split at a heading, preferably the
// same ones as the EN source parts (docs/guide/<name>-1.md, -2.md). The docs
// site joins them the way docs-gen joins EN parts (apps/docs/src/parts.rs).

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const ID_DIR = 'apps/docs/content/id';
const EM_DASH = '—';

/** `x.2.md` is part 2 of `x.md`; anything else is not a part. Mirrors content.rs `part_of`. */
export function partOf(name) {
  const m = /^(.+)\.(\d+)\.md$/.exec(name);
  return m ? { base: `${m[1]}.md`, n: Number(m[2]) } : null;
}

export function readSourceHash(text) {
  const m = text.replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) return null;
  try {
    const fm = YAML.parse(m[1], { schema: 'failsafe' });
    return fm && typeof fm.source_hash === 'string' ? fm.source_hash : null;
  } catch {
    return null;
  }
}

/** Findings for the ID twins of `model.pages` (each `{ name, hash }`) under `root`. */
export function idFindings(model, root) {
  const findings = [];
  const idAbs = path.join(root, ID_DIR);
  const names = fs.existsSync(idAbs) ? fs.readdirSync(idAbs).filter((n) => n.endsWith('.md')).sort() : [];
  const bases = names.filter((n) => !partOf(n));
  const enNames = new Set(model.pages.map((p) => p.name));
  for (const p of model.pages) {
    const where = `${ID_DIR}/${p.name}`;
    if (!bases.includes(p.name)) {
      findings.push(`${where}: missing ID page`);
      continue;
    }
    const hash = readSourceHash(fs.readFileSync(path.join(idAbs, p.name), 'utf8'));
    if (hash === null) findings.push(`${where}: ID page has no source_hash in its frontmatter`);
    else if (hash !== p.hash) findings.push(`${where}: stale ID page (source_hash ${hash}, EN ${p.hash})`);
  }
  const partsOf = new Map();
  for (const name of names) {
    const where = `${ID_DIR}/${name}`;
    const text = fs.readFileSync(path.join(idAbs, name), 'utf8');
    const part = partOf(name);
    if (part) {
      if (!partsOf.has(part.base)) partsOf.set(part.base, []);
      partsOf.get(part.base).push(part.n);
      if (!bases.includes(part.base)) findings.push(`${where}: continuation part has no base page ${part.base}`);
      if (text.startsWith('---')) findings.push(`${where}: continuation part has frontmatter; it belongs to the base page`);
    } else if (!enNames.has(name)) {
      findings.push(`${where}: ID page has no EN page`);
    }
    text.split('\n').forEach((line, i) => {
      if (line.includes(EM_DASH)) findings.push(`${where}:${i + 1}: em dash (U+2014)`);
    });
  }
  for (const [base, ns] of partsOf) {
    const sorted = ns.sort((a, b) => a - b);
    const i = sorted.findIndex((n, k) => n !== k + 2);
    if (i >= 0) {
      findings.push(`${ID_DIR}/${base.replace(/\.md$/, `.${sorted[i]}.md`)}: is part ${sorted[i]}, but part ${i + 2} of ${base} is missing`);
    }
  }
  return findings;
}
