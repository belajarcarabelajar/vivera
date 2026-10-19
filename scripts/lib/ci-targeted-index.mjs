// scripts/lib/ci-targeted-index.mjs
//
// The repository facts the targeted gate plans from: script sources, markdown
// files whose mermaid blocks changed, and a package.json edit limited to scripts.
// Split out of scripts/ci-targeted.mjs, which re-exports the public names.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const INDEX_EXT = /\.(?:mjs|cjs|js|sh|py|ps1|tsv|json|md|txt|ya?ml)$/;

/** Two package.json texts differ only inside `scripts` (an unparsable side never does). */
export function scriptsOnlyChange(before, after) {
  try {
    const a = JSON.parse(before);
    const b = JSON.parse(after);
    delete a.scripts;
    delete b.scripts;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Fenced mermaid blocks, delimited the way render-diagrams.sh extracts them. */
export function mermaidBlocks(text) {
  const blocks = [];
  let buf = null;
  for (const line of text.split('\n')) {
    if (buf === null && /^```mermaid[ \t]*$/.test(line)) buf = '';
    else if (buf !== null && /^```[ \t]*$/.test(line)) { blocks.push(buf); buf = null; }
    else if (buf !== null) buf += `${line}\n`;
  }
  return blocks;
}

function readSources(root) {
  const sources = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(child);
      } else if (e.isFile() && INDEX_EXT.test(e.name)) {
        sources[child] = fs.readFileSync(path.join(root, child), 'utf8');
      }
    }
  };
  if (fs.existsSync(path.join(root, 'scripts'))) walk('scripts');
  return sources;
}

function mermaidChangedFiles(root, files, mergeBase) {
  const out = [];
  for (const p of files) {
    if (!p.endsWith('.md') || p.startsWith('graphify-out/')) continue;
    const abs = path.join(root, p);
    const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const before = spawnSync('git', ['-C', root, 'show', `${mergeBase}:${p}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const old = before.status === 0 ? before.stdout : '';
    if (JSON.stringify(mermaidBlocks(now)) !== JSON.stringify(mermaidBlocks(old))) out.push(p);
  }
  return out;
}

function packageScriptsOnlyFiles(root, files, mergeBase) {
  return files.filter((p) => p === 'package.json').filter((p) => {
    const abs = path.join(root, p);
    const before = spawnSync('git', ['-C', root, 'show', `${mergeBase}:${p}`], { encoding: 'utf8' });
    return before.status === 0 && fs.existsSync(abs) && scriptsOnlyChange(before.stdout, fs.readFileSync(abs, 'utf8'));
  });
}

export function buildIndex(root, files, mergeBase, untracked = []) {
  return {
    sources: readSources(root),
    mermaidChanged: mermaidChangedFiles(root, files, mergeBase),
    untracked,
    packageScriptsOnly: packageScriptsOnlyFiles(root, files, mergeBase),
  };
}
