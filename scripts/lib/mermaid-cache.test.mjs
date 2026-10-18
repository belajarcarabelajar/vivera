import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CACHE_REL,
  cacheKey,
  loadCache,
  saveCache,
  partition,
  recordResults,
  rendererVersion,
} from './mermaid-cache.mjs';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-cache-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const base = { block: 'graph TD\n  A --> B', config: '{"theme":"base"}', rendererVersion: '11.4.2' };

test('cacheKey is a 64-char sha256 hex digest and stable for equal inputs', () => {
  const k = cacheKey(base);
  expect(k).toMatch(/^[0-9a-f]{64}$/);
  expect(cacheKey({ ...base })).toBe(k);
});

test('cacheKey changes when the block changes', () => {
  expect(cacheKey({ ...base, block: 'graph TD\n  A --> C' })).not.toBe(cacheKey(base));
});

test('cacheKey changes when the config changes', () => {
  expect(cacheKey({ ...base, config: '{"theme":"dark"}' })).not.toBe(cacheKey(base));
});

test('cacheKey changes when the renderer version changes', () => {
  expect(cacheKey({ ...base, rendererVersion: '11.4.3' })).not.toBe(cacheKey(base));
});

test('cacheKey keeps field boundaries, so moving text between fields changes the key', () => {
  const a = cacheKey({ block: 'ab', config: 'c', rendererVersion: 'v' });
  const b = cacheKey({ block: 'a', config: 'bc', rendererVersion: 'v' });
  expect(a).not.toBe(b);
});

test('cacheKey with an unknown renderer version is still stable', () => {
  const u = { ...base, rendererVersion: 'unknown' };
  expect(cacheKey(u)).toBe(cacheKey({ ...u }));
});

test('loadCache returns an empty map for a missing file', () => {
  expect(loadCache(path.join(dir, 'nope', 'mermaid-ok.json'))).toEqual({});
});

test('loadCache returns an empty map for a corrupt file', () => {
  const p = path.join(dir, 'mermaid-ok.json');
  fs.writeFileSync(p, '{"abc": {"ok": tru');
  expect(loadCache(p)).toEqual({});
});

test('loadCache returns an empty map when the JSON is not an object map', () => {
  const p = path.join(dir, 'mermaid-ok.json');
  fs.writeFileSync(p, '[1,2,3]');
  expect(loadCache(p)).toEqual({});
  fs.writeFileSync(p, 'null');
  expect(loadCache(p)).toEqual({});
});

test('saveCache then loadCache round-trips, creating missing parent directories', () => {
  const p = path.join(dir, 'node_modules', '.cache', 'vivera', 'mermaid-ok.json');
  const cache = { k1: { ok: true, at: '2026-10-19T00:00:00.000Z' } };
  saveCache(p, cache);
  expect(loadCache(p)).toEqual(cache);
  expect(fs.readdirSync(path.dirname(p))).toEqual(['mermaid-ok.json']);
});

test('partition splits blocks into cached and toRender by key, keeping order', () => {
  const blocks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const cache = { a: { ok: true, at: 'x' }, c: { ok: true, at: 'x' } };
  const { cached, toRender } = partition(blocks, cache, (b) => b.id);
  expect(cached).toEqual([{ id: 'a' }, { id: 'c' }]);
  expect(toRender).toEqual([{ id: 'b' }]);
});

test('partition does not treat an entry without ok:true as cached', () => {
  const { cached, toRender } = partition([{ id: 'a' }], { a: { ok: false } }, (b) => b.id);
  expect(cached).toEqual([]);
  expect(toRender).toEqual([{ id: 'a' }]);
});

test('recordResults stores rendered-OK results and never caches a failed render', () => {
  const cache = {};
  recordResults(cache, [
    { key: 'good', ok: true },
    { key: 'bad', ok: false, error: 'Parse error on line 2' },
  ]);
  expect(Object.keys(cache)).toEqual(['good']);
  expect(cache.good.ok).toBe(true);
  expect(Number.isNaN(Date.parse(cache.good.at))).toBe(false);
});

test('recordResults removes a stale entry when the same key now fails', () => {
  const cache = { k: { ok: true, at: '2026-01-01T00:00:00.000Z' } };
  recordResults(cache, [{ key: 'k', ok: false, error: 'boom' }]);
  expect(cache).toEqual({});
});

test('rendererVersion reads the mermaid-cli package version', () => {
  const pkgDir = path.join(dir, 'node_modules', '@mermaid-js', 'mermaid-cli');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@mermaid-js/mermaid-cli', version: '11.4.2' }));
  expect(rendererVersion(dir)).toBe('11.4.2');
});

test('rendererVersion is unknown when the package is missing or unreadable', () => {
  expect(rendererVersion(dir)).toBe('unknown');
  const pkgDir = path.join(dir, 'node_modules', '@mermaid-js', 'mermaid-cli');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), 'not json');
  expect(rendererVersion(dir)).toBe('unknown');
});

test('DEFAULT_CACHE_REL points inside node_modules/.cache', () => {
  expect(DEFAULT_CACHE_REL).toBe(path.join('node_modules', '.cache', 'vivera', 'mermaid-ok.json'));
});
