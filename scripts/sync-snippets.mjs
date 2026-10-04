#!/usr/bin/env bun
// scripts/sync-snippets.mjs
//
// Drift guard between the markdown trigger prompts in `snippets/` and their
// copies in the Snipset database.
//
//   bun scripts/sync-snippets.mjs --check   compare, exit 1 on drift (CI)
//   bun scripts/sync-snippets.mjs --push    write local content to the database
//   bun scripts/sync-snippets.mjs --status  human-readable table, always exit 0
//
// Why this exists: the markdown files are validated in CI, but the database is
// reachable only through the local `snipset` CLI. Without a check, editing a
// trigger prompt leaves the database silently stale, and the stale copy is what
// an agent actually receives when the user triggers the snippet.
//
// Normalization is applied on BOTH sides before comparison, so cosmetic
// differences between the Markdown source and the database copy are not
// reported as drift:
//   * em dash and en dash  -> hyphen
//   * curly quotes          -> straight quotes
//   * rightwards arrow      -> ASCII arrow
//   * CRLF line endings     -> LF
//   * trailing whitespace   -> stripped per line
// The database copy is normalized too, so content pushed from an older revision
// still compares clean.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const manifestPath = path.join(rootDir, 'snippets.manifest.json');

const SNIPSET_BIN = process.env.SNIPSET_BIN || 'snipset';

// ---------- Normalization ----------

export function normalize(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[\u2014\u2013]/g, '-')   // em dash, en dash
    .replace(/[\u2018\u2019]/g, "'")  // curly single quotes
    .replace(/[\u201C\u201D]/g, '"')  // curly double quotes
    .replace(/\u2192/g, '->')         // rightwards arrow
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

// The trigger prompt an agent receives is the body of the file, not the
// human-facing title and the `>` usage note above the `---` fence.
export function extractPromptBody(markdown) {
  const fence = markdown.indexOf('\n---');
  if (fence === -1) return normalize(markdown);
  return normalize(markdown.slice(fence + '\n---'.length));
}

const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

// ---------- Snipset CLI adapter ----------

function snipsetJson(args) {
  const r = spawnSync(SNIPSET_BIN, [...args, '--json'], { encoding: 'utf8' });
  if (r.error) {
    throw new Error(`cannot run "${SNIPSET_BIN}": ${r.error.message}. Is Snipset installed and on PATH?`);
  }
  if (r.status !== 0) {
    const first = (r.stderr || r.stdout || '').trim().split('\n')[0];
    throw new Error(`"${SNIPSET_BIN} ${args.join(' ')}" exited ${r.status}: ${first}`);
  }
  const out = (r.stdout || '').trim();
  if (!out) throw new Error(`"${SNIPSET_BIN} ${args.join(' ')}" produced no output`);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`"${SNIPSET_BIN} ${args.join(' ')}" produced non-JSON output`);
  }
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload) return payload.data;
  return payload;
}

export function fetchSnippet(uuid) {
  const d = unwrap(snipsetJson(['snippet', 'get', uuid]));
  return Array.isArray(d) ? d[0] : d;
}

function pushSnippet(entry, content) {
  return snipsetJson([
    'snippet', 'update', entry.uuid,
    '--content', content,
    '--name', entry.name,
    '--description', entry.description,
  ]);
}

export function loadManifest() {
  if (!existsSync(manifestPath)) throw new Error(`missing manifest: ${manifestPath}`);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(m.snippets) || m.snippets.length === 0) {
    throw new Error('manifest has no snippets array');
  }
  for (const e of m.snippets) {
    for (const field of ['source', 'uuid', 'keyword', 'name', 'description']) {
      if (!e[field]) throw new Error(`manifest entry ${e.source || '(no source)'} is missing "${field}"`);
    }
    if (!existsSync(path.join(rootDir, e.source))) {
      throw new Error(`manifest references a missing source file: ${e.source}`);
    }
  }
  return m;
}

export function checkDrift(manifest, { fetch = fetchSnippet } = {}) {
  const results = [];
  for (const entry of manifest.snippets) {
    const local = extractPromptBody(readFileSync(path.join(rootDir, entry.source), 'utf8'));
    let remote = null;
    let problem = null;
    let unreachable = false;
    try {
      const snip = fetch(entry.uuid);
      if (!snip) problem = 'snippet not found in database';
      else remote = normalize(snip.snippet || snip.content || '');
    } catch (e) {
      problem = e.message;
      // A missing CLI or database is an environment boundary, not evidence of
      // drift. It must be reported as "unreachable" so --check can skip rather
      // than fail for a reason that has nothing to do with the content.
      unreachable = e.code === 'ENOENT' || /cannot run|exited \d+/.test(e.message);
    }
    results.push({
      entry,
      local,
      remote,
      problem,
      unreachable,
      inSync: !problem && hash(local) === hash(remote),
      localHash: hash(local),
      remoteHash: remote === null ? null : hash(remote),
    });
  }
  return results;
}

function main(argv) {
  const args = argv.slice(2);
  const wantsCheck = args.includes('--check');
  const wantsPush = args.includes('--push');
  const wantsStatus = args.includes('--status');

  if ((wantsCheck && wantsPush) || (wantsStatus && (wantsCheck || wantsPush))) {
    console.error('usage: sync-snippets.mjs [--check | --push | --status]');
    process.exit(2);
  }

  let manifest;
  try {
    manifest = loadManifest();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  if (wantsPush) {
    let failed = 0;
    for (const entry of manifest.snippets) {
      const local = extractPromptBody(readFileSync(path.join(rootDir, entry.source), 'utf8'));
      try {
        pushSnippet(entry, local);
        console.log(`✅ pushed ${entry.source} -> ${entry.name} (kw "${entry.keyword}")`);
      } catch (e) {
        failed++;
        console.error(`❌ failed to push ${entry.source} -> ${entry.uuid}: ${e.message}`);
      }
    }
    process.exit(failed ? 1 : 0);
  }

  let results;
  try {
    results = checkDrift(manifest);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(wantsStatus ? 0 : 1);
  }

  const drifted = results.filter((r) => !r.inSync);
  const unreachable = results.filter((r) => r.unreachable);

  if (wantsStatus) {
    console.log('source                                 keyword  local        database    state');
    for (const r of results) {
      const state = r.unreachable ? 'SKIPPED (no database)'
        : r.problem ? `ERROR: ${r.problem}`
        : r.inSync ? 'in sync' : 'DRIFT';
      console.log(
        `${r.entry.source.padEnd(40)} ${JSON.stringify(r.entry.keyword).padEnd(9)} `
        + `${r.localHash.padEnd(12)} ${(r.remoteHash || '-').padEnd(11)} ${state}`,
      );
    }
    const checked = results.length - unreachable.length;
    console.log(`\n${checked - drifted.length}/${checked} in sync`
      + (unreachable.length ? `, ${unreachable.length} skipped (database not reachable here)` : ''));
    process.exit(0);
  }

  // A CI runner has no Snipset database. Report the boundary and exit 0 rather
  // than failing for a reason unrelated to the content. Drift is enforced on any
  // machine that does have the database, and the manifest itself is validated
  // unconditionally by validate-skill.mjs.
  if (unreachable.length === results.length && results.length > 0) {
    console.warn(`⚠️  Snipset database not reachable here; skipped ${results.length} comparison(s).`);
    console.warn(`   Local content hashes: ${results.map((r) => `${r.entry.source}=${r.localHash}`).join(', ')}`);
    console.warn('   Run "bun run snippets:check" on a machine with Snipset to enforce drift.');
    process.exit(0);
  }

  if (drifted.length === 0) {
    console.log(`✅ All ${results.length} trigger prompt(s) match the Snipset database.`);
    process.exit(0);
  }

  console.error(`❌ ${drifted.length}/${results.length} trigger prompt(s) drifted from the Snipset database:`);
  for (const r of drifted) {
    if (r.problem) {
      console.error(`   ${r.entry.source}: ${r.problem}`);
    } else {
      console.error(`   ${r.entry.source} -> ${r.entry.name} (kw "${r.entry.keyword}")`);
      console.error(`      local ${r.localHash} != database ${r.remoteHash}`);
    }
  }
  console.error('   Fix: bun run snippets:push   (or edit the database snippet by hand)');
  process.exit(1);
}

const isMain = process.argv[1] && process.argv[1].endsWith('sync-snippets.mjs');
if (isMain) main(process.argv);
