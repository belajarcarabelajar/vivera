// scripts/lib/mermaid-cache.mjs
//
// Remembers which Mermaid blocks already rendered OK, so validate-skill.mjs can
// skip mmdc for a block whose source, mermaid config, and renderer version are
// all unchanged. Only successes are stored: a failed render is always retried.
//
// The cache lives under node_modules/.cache (gitignored), so deleting it is
// always safe and just costs one full render on the next run.

import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

export const DEFAULT_CACHE_REL = path.join('node_modules', '.cache', 'vivera', 'mermaid-ok.json');

/**
 * sha256 hex over the block source, the mermaid config file contents, and the
 * mmdc version. JSON-encoding the triple keeps field boundaries, so text that
 * moves from one field to the next cannot produce the same key.
 */
export function cacheKey({ block, config, rendererVersion: version }) {
  return createHash('sha256')
    .update(JSON.stringify([String(block), String(config ?? ''), String(version)]))
    .digest('hex');
}

/** Read the cache map. A missing, unreadable, or malformed file loads as {}. */
export function loadCache(cachePath) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/** Write the cache map atomically, creating parent directories as needed. */
export function saveCache(cachePath, cache) {
  mkdirSync(path.dirname(path.resolve(cachePath)), { recursive: true });
  writeFileAtomic(cachePath, JSON.stringify(cache, null, 2) + '\n');
}

/** Split blocks into those with an ok:true entry and those that must render. */
export function partition(blocks, cache, keyOf) {
  const cached = [];
  const toRender = [];
  for (const block of blocks) {
    if (cache[keyOf(block)]?.ok === true) cached.push(block);
    else toRender.push(block);
  }
  return { cached, toRender };
}

/**
 * Store results shaped { key, ok }. ok:true is recorded with a timestamp; any
 * other result deletes its key, so an entry that now fails is not served later.
 */
export function recordResults(cache, results) {
  const at = new Date().toISOString();
  for (const { key, ok } of results) {
    if (ok === true) cache[key] = { ok: true, at };
    else delete cache[key];
  }
  return cache;
}

/** Version of the installed @mermaid-js/mermaid-cli, or 'unknown'. */
export function rendererVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'node_modules', '@mermaid-js', 'mermaid-cli', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
