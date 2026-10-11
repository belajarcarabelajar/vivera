// Every module in targets/ that is not a test is a render target. A new target
// is one new file there; nothing in this file or in the CLI lists them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TARGETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'targets');
const TARGET_ID = /^[a-z][a-z0-9-]*$/;

function check(file, target) {
  const bad = (field) => {
    throw new Error(`${file}: a target must default-export { id, ext, outName, requiresOut, render }; "${field}" is missing or the wrong type`);
  };
  if (target === null || typeof target !== 'object') bad('default export');
  if (typeof target.id !== 'string' || !TARGET_ID.test(target.id)) bad('id');
  if (typeof target.ext !== 'string' || !target.ext.startsWith('.')) bad('ext');
  if (typeof target.outName !== 'function') bad('outName');
  if (typeof target.requiresOut !== 'boolean') bad('requiresOut');
  if (typeof target.render !== 'function') bad('render');
}

export async function loadTargets(dir = TARGETS_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .sort();
  const targets = {};
  for (const file of files) {
    const target = (await import(pathToFileURL(path.join(dir, file)).href)).default;
    check(file, target);
    if (Object.hasOwn(targets, target.id)) throw new Error(`${file}: duplicate target id "${target.id}"`);
    targets[target.id] = target;
  }
  return targets;
}

export const TARGETS = await loadTargets();

export function targetIds() {
  return Object.keys(TARGETS);
}
