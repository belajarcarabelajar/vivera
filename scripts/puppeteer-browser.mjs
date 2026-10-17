#!/usr/bin/env bun
// scripts/puppeteer-browser.mjs
//
// Picks the browser mmdc should launch, shared by render-diagrams.sh (through
// the CLI) and validate-skill.mjs (through the import). Without
// ~/.cache/puppeteer the bundled Chrome is missing and every render fails
// (rule A33 in ~/AGENTS.md), so a system browser on PATH is used instead.
//
// Usage: bun scripts/puppeteer-browser.mjs
//   stdout: the absolute browser path to export as PUPPETEER_EXECUTABLE_PATH,
//   or nothing when the environment should stay as it is. Exit: always 0.

import fs from 'fs';
import os from 'os';
import path from 'path';

export const SYSTEM_BROWSERS = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'];

/**
 * Returns the path to inject as PUPPETEER_EXECUTABLE_PATH, or null to change nothing.
 * @param {{ env: Record<string, string | undefined>, exists: (p: string) => boolean, which: (name: string) => string | null }} deps
 */
export function resolvePuppeteerBrowser({ env, exists, which }) {
  if (env.PUPPETEER_EXECUTABLE_PATH) return null;
  const cacheDir = env.PUPPETEER_CACHE_DIR || path.join(env.HOME || os.homedir(), '.cache', 'puppeteer');
  if (exists(cacheDir)) return null;
  for (const name of SYSTEM_BROWSERS) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

/** Absolute path of an executable named `name` on `searchPath`, or null. */
export function whichOnPath(name, searchPath = process.env.PATH ?? '') {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.resolve(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/** The browser for the real process environment, or null. */
export function systemPuppeteerBrowser(env = process.env) {
  return resolvePuppeteerBrowser({
    env,
    exists: (p) => fs.existsSync(p),
    which: (name) => whichOnPath(name, env.PATH ?? ''),
  });
}

if (import.meta.main) {
  const browser = systemPuppeteerBrowser();
  if (browser) process.stdout.write(`${browser}\n`);
}
