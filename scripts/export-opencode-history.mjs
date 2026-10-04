#!/usr/bin/env bun
// scripts/export-opencode-history.mjs
//
// The exporter. Everything before this file is a library; this is the part a
// person types.
//
//   bun scripts/export-opencode-history.mjs --dry-run --limit 1
//
// WHAT IT OWNS, AND WHY IT IS THE SMALLEST FILE IN THE PLAN
//
// `opencode-db.mjs` reads rows, `render-session.mjs` turns a session into a
// note, `note-name.mjs` names it, `extract-attachments.mjs` unpacks its images,
// `sync-writer.mjs` decides whether the bytes on disk need to move. Every one of
// those owns a decision that is hard to get right, and none of them owns the
// only decision that cannot be delegated: what happens when one of 1023 sessions
// goes wrong.
//
// FOUR THINGS THIS FILE IS CAREFUL ABOUT
//
//   1. THE VAULT PATH CONTAINS A SPACE. The real vault is named `Dokumen/
//      Obsidian Vault`. A value is taken as ONE argv element, never as a
//      fragment of a line someone split, and every path is built with
//      `node:path`. `--vault=PATH` and `--vault PATH` both work; nothing here
//      ever does `argv.join(' ')` and hopes.
//
//   2. A SINGLE BAD SESSION IS SKIPPED, AND A MOSTLY-BROKEN RUN IS NOT. 1023
//      sessions is a long enough loop that one corrupt row will happen. Skipping
//      it and reporting it is right; continuing after 700 failures and reporting
//      "exported 323 notes" is not — that is a partial mirror presented as a
//      complete one, and it is worse than no export because the summary looks
//      like a success. So the writes are BUFFERED: nothing reaches the vault
//      until the run knows how much of it worked, and more than half failing
//      exits non-zero having written nothing.
//
//   3. THE ATTACHMENT FILES ARE NOT MINE. `extract-attachments.mjs` writes
//      them with `writeFileSync` on a path derived from a content hash, so a
//      re-run over an unchanged database rewrites them with identical bytes.
//      Identical bytes with a fresh mtime is still a dirty file to `git status`,
//      and this vault has `obsidian-git` pushing on a timer. `snapshotAttachments`
//      + `restoreUnchangedAttachmentTimes` bring those files under the same rule
//      `sync-writer.mjs` applies to notes: content decided, not dates.
//
//   4. READ-ONLY, ALWAYS. The database is opened through `openReadonly()`
//      (`readonly: true, create: false`), and no query in this file names the
//      `credential` table. There is no code path here that can open it for
//      writing: `openReadonly` is the only way this file reaches a Database.
//
// Revert: delete this file and scripts/export-opencode-history.test.mjs. No
// library module imports it, so nothing else in scripts/ changes.

import {
  existsSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, utimesSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_OPENCODE_DB_PATH, countSessions, listSessions, messagesForSession, openReadonly,
} from './lib/opencode-db.mjs';
import { noteName } from './lib/note-name.mjs';
import { renderSession } from './lib/render-session.mjs';
import { planWrites } from './lib/sync-writer.mjs';
import { PATTERN_NAMES } from './lib/redact.mjs';
import { DEFAULT_ALLOWED_ROOT } from './lib/inline-spills.mjs';
import { resolveConfiguredPath } from './lib/local-config.mjs';

// ---------- the destination ----------

/** The vault folder conversations are mirrored into. */
export const CONVERSATIONS_DIR = '05 - Conversations';

/** Sibling of the per-project folders; holds the unpacked inline attachments. */
export const ATTACHMENTS_DIRNAME = '.attachments';

/** Env fallback for `--vault`, so a shell alias can carry it. */
export const VAULT_ENV_VAR = 'OPENCODE_EXPORT_VAULT';

/**
 * The vault used when the flag and the environment say nothing.
 *
 * Resolved per call, never at import, so importing this module reads nothing
 * and cannot throw, and a changed env var is picked up on the next call. The
 * config key "vaultRoot" is deliberately shared with `vault-index-rebuild.mjs`:
 * both tools operate on the same vault.
 *
 * There is no default path. A silent wrong guess would write exports into the
 * wrong tree, so an unconfigured call throws naming the env var and
 * local.config.example.json instead.
 *
 * @param {string} [configPath] test-only config file override; defaults to
 *   <repo root>/local.config.json
 * @returns {string} the vault root
 * @throws {Error} when neither the env var nor the config file answers
 */
export function defaultVaultRoot(configPath = undefined) {
  return resolveConfiguredPath({
    envVar: VAULT_ENV_VAR,
    configKey: 'vaultRoot',
    label: 'export target vault',
    configPath,
  });
}

const USAGE = `usage:
  bun scripts/export-opencode-history.mjs [options]

  --dry-run            resolve and render every selected session, write nothing
  --limit N            process at most N sessions, oldest first (0 processes none)
  --vault PATH         destination vault root
                       (default: $${VAULT_ENV_VAR}, else "vaultRoot" in
                       local.config.json -- see local.config.example.json)
  --db PATH            OpenCode database, opened read-only
                       (default: ${DEFAULT_OPENCODE_DB_PATH})
  --project-dir PATH   export only sessions whose directory is PATH or below it
  --help, -h           print this and exit 0

Exit 0 on success, 1 on a real failure or when more than half the sessions
failed, 2 on a usage error. Re-running against an unchanged database writes
zero files: every write is gated on the bytes actually differing.`;

/** Exit codes, named so the return value is not a bare integer at the call site. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

// ---------- the io seam ----------

/**
 * Where output goes. The third parameter of `main()` and the reason a test can
 * read a summary without a pty: production gets the console, a test passes an
 * object with `out`/`err` functions and gets strings back.
 */
const defaultIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Flags that take a value. A bare `a.startsWith('--')` is not enough: a typo'd
 *  `--limt 3` must not be read as a positional. */
const VALUE_FLAGS = new Map([
  ['--limit', 'limit'],
  ['--vault', 'vault'],
  ['--db', 'db'],
  ['--project-dir', 'projectDir'],
]);

const BOOLEAN_FLAGS = new Map([
  ['--dry-run', 'dryRun'],
  ['--help', 'help'],
  ['-h', 'help'],
]);

/**
 * Parse argv (already sliced past the script name).
 *
 * @param {string[]} argv
 * @returns {{dryRun: boolean, help: boolean, limit: number|null, vault: string|null,
 *            db: string|null, projectDir: string|null}}
 * @throws {Error} on an unknown flag, a missing value, or a bad `--limit`.
 *   Every message names the offending token, because "unknown flag" with no
 *   token sends the reader to the source instead of to their own command line.
 */
export function parseArgs(argv) {
  const opts = {
    dryRun: false, help: false, limit: null, vault: null, db: null, projectDir: null,
  };
  const list = Array.isArray(argv) ? argv : [];

  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (typeof arg !== 'string') throw new Error(`expected an argument string, got ${typeof arg}`);

    // `--vault=PATH` and `--vault PATH` are the same flag. The value is taken
    // verbatim after the first `=`, so a vault path containing `=` survives.
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

    const booleanKey = BOOLEAN_FLAGS.get(flag);
    if (booleanKey !== undefined) {
      if (inlineValue !== null) throw new Error(`${flag} is a switch and takes no value, got "${inlineValue}"`);
      opts[booleanKey] = true;
      continue;
    }

    const valueKey = VALUE_FLAGS.get(flag);
    if (valueKey !== undefined) {
      // The whole NEXT element is the value. That is the whole reason a vault
      // path with a space in it works: nothing splits this element again.
      const value = inlineValue !== null ? inlineValue : list[++i];
      if (typeof value !== 'string' || value === '') {
        throw new Error(`${flag} needs a value, and the next argument is not one`);
      }
      opts[valueKey] = value;
      continue;
    }

    throw new Error(`unknown flag ${JSON.stringify(arg)}. Run with --help for the flag list.`);
  }

  if (opts.limit !== null) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`--limit must be a non-negative integer, got ${JSON.stringify(opts.limit)}`);
    }
    opts.limit = n;
  }
  if (opts.vault !== null && opts.vault.trim() === '') {
    throw new Error('--vault must be a non-empty path');
  }
  return opts;
}

/**
 * Flag, then environment, then the configured default.
 *
 * `env` is passed in rather than read from `process.env` so a test cannot be
 * redirected by the shell it happens to run in; when it says nothing, the
 * decision falls to `defaultVaultRoot()`, which does read `process.env` and
 * local.config.json. A blank environment variable is treated as absent.
 * Falling through to the REAL vault because someone's shell exported an empty
 * string is the kind of surprise that ends up in a git remote nobody was
 * watching.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string|null} flagValue the `--vault` value
 * @param {string} [configPath] test-only config file override, passed through
 *   to `defaultVaultRoot()`
 * @returns {string} the vault root
 */
export function resolveVaultRoot(env = {}, flagValue = null, configPath = undefined) {
  if (typeof flagValue === 'string' && flagValue.trim() !== '') return path.resolve(flagValue);
  const fromEnv = env && typeof env === 'object' ? env[VAULT_ENV_VAR] : undefined;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv);
  return defaultVaultRoot(configPath);
}

// ---------- destination layout ----------

/**
 * Anything that is not `[A-Za-z0-9_-]` becomes a hyphen, then the ends are trimmed.
 *
 * Dot is deliberately NOT in the allowlist, even though a folder name is not a
 * filename. `/a/../../etc` slugs to `a-etc` rather than `a-..-..-etc`, because a
 * segment containing `..` reads as a traversal to anyone auditing the vault
 * afterwards, and the cost of excluding the dot is one lost character in a name
 * nobody types by hand. Same rule, same reason as `note-name.mjs`.
 */
const UNSAFE_SEGMENT = /[^A-Za-z0-9_-]+/g;
const SEGMENT_EDGES = /^-+|-+$/g;

/**
 * One safe directory name for a worktree path.
 *
 * `/Users/alice` -> `users-alice`.
 *
 * The result is joined onto the vault, so it must be a single segment with no
 * separator and no `..` in it — which the same allowlist that produces hyphens
 * guarantees, exactly as it does for a note title in `note-name.mjs`.
 */
export function projectSlug(directory) {
  if (typeof directory !== 'string' || directory.trim() === '') return 'unknown-project';
  const segments = directory.split(/[\\/]+/).filter((s) => s !== '');
  const raw = segments.length === 0 ? 'root' : segments.join('-');
  const slug = raw
    .toLowerCase()
    .replace(UNSAFE_SEGMENT, '-')
    .replace(SEGMENT_EDGES, '')
    .slice(0, 80)
    .replace(SEGMENT_EDGES, '');
  return slug === '' ? 'unknown-project' : slug;
}

/**
 * True when `directory` is `projectDir` or sits below it.
 *
 * Path-aware on purpose. `/fixture/project-ab` STARTS WITH the string
 * `/fixture/project-a` and is a different worktree, so a string-prefix filter
 * would export the wrong project and file it under the wrong folder.
 *
 * @param {string|null} directory the session's `directory` column
 * @param {string|null} projectDir the `--project-dir` value; null means "no filter"
 */
export function matchesProjectDir(directory, projectDir) {
  if (projectDir === null || projectDir === undefined) return true;
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return true;
  if (typeof directory !== 'string' || directory === '') return false;
  const root = path.resolve(projectDir);
  const target = path.resolve(directory);
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** `<vault>/05 - Conversations` and `<vault>/05 - Conversations/.attachments`. */
export function conversationsRoot(vaultRoot) {
  return path.join(vaultRoot, CONVERSATIONS_DIR);
}

export function attachmentsRoot(vaultRoot) {
  return path.join(conversationsRoot(vaultRoot), ATTACHMENTS_DIRNAME);
}

/** The vault-relative path of one note. Always posix, because it is a relPath. */
export function noteRelPath(session, filename) {
  return path.posix.join(CONVERSATIONS_DIR, projectSlug(session.directory), filename);
}

// ---------- the attachment mtime guard ----------

/**
 * One attachment file as it is on disk: its bytes AND its two timestamps.
 *
 * The timestamps are here, not read back later, for a measured reason. A
 * restore that reads `statSync()` after the rewrite is restoring the mtime the
 * rewrite just set, which is a no-op that still reports "unchanged" — verified
 * against the probe before this was fixed. To put the mtime back, the old mtime
 * has to have been kept.
 *
 * @typedef {{ bytes: Buffer, atimeMs: number, mtimeMs: number }} AttachmentSnapshot
 */

/**
 * Read every attachment currently on disk, keyed by filename.
 *
 * Returns an empty map when the directory does not exist, and deliberately does
 * not create it: a dry run, and a run with no attachments, must leave no trace.
 *
 * @param {string} dir
 * @returns {Map<string, AttachmentSnapshot>}
 */
export function snapshotAttachments(dir) {
  const snapshot = new Map();
  if (!existsSync(dir)) return snapshot;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      snapshot.set(name, { bytes: readFileSync(p), atimeMs: st.atimeMs, mtimeMs: st.mtimeMs });
    } catch {
      // A file that vanished between readdir and read is not this script's
      // problem, and it will simply be reported as new on the next pass.
    }
  }
  return snapshot;
}

/**
 * Put back the mtime of every attachment whose bytes did not change.
 *
 * `extract-attachments.mjs` is frozen and writes unconditionally, so this is the
 * only way "a re-run writes zero files" can be true of the attachments as well
 * as the notes — and mtime is what `git status` reads.
 *
 * @param {string} dir
 * @param {Map<string, AttachmentSnapshot>} snapshot as taken before rendering
 * @returns {{ created: number, written: number, unchanged: number }}
 */
export function restoreUnchangedAttachmentTimes(dir, snapshot) {
  const counts = { created: 0, written: 0, unchanged: 0 };
  if (!existsSync(dir)) return counts;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!statSync(p).isFile()) continue;
    const before = snapshot.get(name);
    if (before === undefined) {
      counts.created += 1;
      continue;
    }
    if (!before.bytes.equals(readFileSync(p))) {
      counts.written += 1;
      continue;
    }
    counts.unchanged += 1;
    try {
      utimesSync(p, before.atimeMs / 1000, before.mtimeMs / 1000);
    } catch {
      // A filesystem that refuses utimes still got correct content; reporting
      // the file as unchanged would be a lie, so leave the count where it is and
      // let the note counts carry the run's meaning.
    }
  }
  return counts;
}

/**
 * Roll the attachments back to the pre-run state after a run was aborted.
 *
 * The notes are buffered until the failure ratio is known, but the ATTACHMENTS
 * are not: `extract-attachments.mjs` unpacks them while the session is being
 * rendered, which happens before the exporter can know that 2 of 3 sessions
 * failed. Claiming "a mostly-failed run writes nothing" while leaving its
 * attachments on disk would be a claim the filesystem contradicts, so the files
 * this run created are removed and the ones it merely rewrote get their mtime
 * back.
 *
 * Only files that were NOT in `snapshot` are removed, so anything that predates
 * this run is never deleted, and only regular files directly inside `dir` are
 * considered. Fails loudly rather than silently: a rollback that could not
 * complete must not leave the caller believing the vault is clean.
 *
 * @param {string} dir
 * @param {Map<string, AttachmentSnapshot>} snapshot as taken before rendering
 * @returns {{ removed: number, restored: number }}
 */
export function discardAttachments(dir, snapshot) {
  const removed = { removed: 0, restored: 0 };
  if (!existsSync(dir)) return removed;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const before = snapshot.get(name);
    if (before === undefined) {
      unlinkSync(p);
      removed.removed += 1;
      continue;
    }
    try {
      utimesSync(p, before.atimeMs / 1000, before.mtimeMs / 1000);
      removed.restored += 1;
    } catch (err) {
      const e = new Error(
        `cannot restore the mtime of attachment ${p} after an aborted run: ${err.message}`,
      );
      e.code = 'ERR_ATTACHMENT_ROLLBACK';
      throw e;
    }
  }
  return removed;
}

/**
 * The deepest of `vault` and its two subdirectories that exists right now.
 *
 * Used as the rollback boundary: a run may remove a directory it created, and
 * never one that was already there. Purely `existsSync` checks, no filesystem
 * writes.
 *
 * @param {string} vault
 * @returns {string|null} the path, or null when the vault does not exist yet
 */
export function deepestExistingDir(vault) {
  const candidates = [attachmentsRoot(vault), conversationsRoot(vault), vault];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      // does not exist yet
    }
  }
  return null;
}

/**
 * The directories this run could have created, deepest first.
 *
 * `boundary` is the deepest directory that existed before the run (null when the
 * vault did not exist at all). The answer is the suffix of the vault's own
 * directory chain below that boundary — which is exactly the set of directories
 * that were absent before and may have been created during the run. Listing them
 * statically instead would be a list that is right only for one of the three
 * possible starting states.
 *
 * @param {string|null} boundary from `deepestExistingDir()`
 * @param {string} vault
 * @returns {string[]} deepest first
 */
export function dirsDeeperThan(boundary, vault) {
  const chain = [attachmentsRoot(vault), conversationsRoot(vault), vault];
  const at = boundary === null ? -1 : chain.indexOf(boundary);
  // An unknown boundary means "no idea what pre-existed", so nothing is a
  // candidate. Removing a directory on a guess is not a risk worth taking.
  if (boundary !== null && at === -1) return [];
  return at === -1 ? chain : chain.slice(0, at);
}

/**
 * Remove each candidate directory that is empty, deepest first.
 *
 * Two rules, both load-bearing:
 *
 *   * ONLY WHEN EMPTY. `rmdirSync` on a non-empty directory throws, and that
 *     throw is the check doing the work. A vault with real notes in it is never
 *     a candidate for removal, however many times the export runs.
 *   * ONLY UP TO A BOUNDARY. `extractAttachments` creates its destination with
 *     `mkdirSync(dest, { recursive: true })`, which materialises the vault ROOT
 *     as well, so a run that reported writing nothing can still leave four new
 *     directories behind. The caller supplies the deepest directory that existed
 *     before the run, and nothing above it is ever a candidate.
 *
 * @param {string[]} candidates deepest first; the pre-run boundary LAST, since a
 *   directory above it must not be removed even when empty
 * @returns {number} how many directories were removed
 */
export function pruneEmptyDirs(candidates) {
  let removed = 0;
  for (const d of candidates) {
    if (d === null || d === undefined || d === '') continue;
    try {
      if (statSync(d).isDirectory() && readdirSync(d).length === 0) {
        rmdirSync(d);
        removed += 1;
      }
    } catch (err) {
      // ENOENT: already gone, which is the desired end state. ENOTEMPTY: someone
      // else's files are in there, which means the directory is legitimately
      // part of the vault and must stay.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') throw err;
    }
  }
  return removed;
}

// ---------- one session ----------

/**
 * The first user prompt, for the untitled-session filename fallback.
 *
 * 36 of the 1009 real sessions have `title IS NULL`, so this is a normal path.
 * A row whose `data` is not JSON contributes nothing rather than throwing.
 */
export function firstUserText(messages) {
  for (const row of messages) {
    if (row === null || typeof row !== 'object' || row.type !== 'user') continue;
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (data !== null && typeof data === 'object' && typeof data.text === 'string' && data.text.trim() !== '') {
      return data.text;
    }
  }
  return '';
}

/**
 * Render one session into `{ relPath, content }`.
 *
 * Throws on a session it cannot name, which is what makes "one bad session is
 * skipped" a policy the loop can implement instead of a hope.
 *
 * @param {object} session a row from `listSessions()`
 * @param {Array<object>} messages rows from `messagesForSession()`
 * @param {object} opts `vault`, `attachmentsDir`, `onRedact`
 * @returns {{ relPath: string, content: string }}
 */
export function renderOne(session, messages, opts) {
  const filename = noteName(session, { firstUserText: firstUserText(messages) });
  const content = renderSession(session, messages, {
    // Left undefined on a dry run: without a destination directory the renderer
    // prints `[ATTACHMENTS OMITTED]` instead of unpacking anything, and there is
    // nothing in the note either way (AC-7).
    attachmentsDir: opts.attachmentsDir,
    vaultRoot: opts.vault,
    allowedSpillRoot: opts.allowedSpillRoot,
    onRedact: opts.onRedact,
  });
  return { relPath: noteRelPath(session, filename), content };
}

// ---------- the run ----------

/**
 * Do the export.
 *
 * @param {ReturnType<parseArgs>} opts
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<object>} the summary object, which is also what `formatSummary`
 *   prints. Returned rather than only printed so a caller can assert on it.
 */
export async function runExport(opts, env = {}) {
  const vault = resolveVaultRoot(env, opts.vault);
  const dbPath = opts.db ?? DEFAULT_OPENCODE_DB_PATH;

  // `openReadonly` is the only way into a Database in this file: it passes
  // `readonly: true, create: false`, so a mistyped --db is an error rather than
  // a brand new empty database that reports "0 sessions" like a real answer.
  let handle;
  try {
    handle = openReadonly(dbPath);
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    const err2 = new Error(`cannot open the OpenCode database at ${dbPath}: ${reason}`);
    err2.code = 'ERR_DB_OPEN';
    throw err2;
  }

  const summary = {
    dbPath,
    vault,
    dryRun: opts.dryRun === true,
    limit: opts.limit ?? null,
    projectDir: opts.projectDir ?? null,
    dbSessions: 0,
    discovered: 0,
    matched: 0,
    selected: 0,
    processed: 0,
    failed: 0,
    created: 0,
    written: 0,
    unchanged: 0,
    attachments: { created: 0, written: 0, unchanged: 0 },
    attachmentsDiscarded: null,
    prunedDirs: 0,
    aborted: false,
    redactions: {},
    changedPaths: [],
    failures: [],
  };

  try {
    const db = handle.db;
    const all = listSessions(db);
    // Straight from the engine, not `all.length`: AC-1 is parity with the TABLE,
    // and counting an array we just built would make the parity unfalsifiable.
    summary.dbSessions = countSessions(db);
    summary.discovered = all.length;
    const matching = all.filter((s) => matchesProjectDir(s.directory, opts.projectDir ?? null));
    summary.matched = matching.length;
    // `listSessions` already orders by time_created ASC, so slicing takes the
    // OLDEST N. Slicing an unsorted list would make --limit pick a random subset
    // that changes between runs, which would look like data churn.
    const selected = opts.limit === null ? matching : matching.slice(0, opts.limit);
    summary.selected = selected.length;

    const attachmentsDir = summary.dryRun ? undefined : attachmentsRoot(vault);
    const before = summary.dryRun ? new Map() : snapshotAttachments(attachmentsDir);

    // The deepest directory that exists right now is the boundary for any
    // rollback: nothing that predates this run may be removed. Computed BEFORE
    // any rendering, because rendering is what creates directories.
    const preExisting = deepestExistingDir(vault);

    // Per-pattern counts are aggregated across the WHOLE run, not per note: the
    // operator's question is "did this export scrub anything", and one number
    // per pattern is the only answer that answers it.
    const entries = [];
    for (const session of selected) {
      try {
        const messages = messagesForSession(db, session.id);
        const entry = renderOne(session, messages, {
          vault,
          attachmentsDir,
          allowedSpillRoot: DEFAULT_ALLOWED_ROOT,
          onRedact: (counts) => {
            for (const [name, n] of Object.entries(counts)) {
              summary.redactions[name] = (summary.redactions[name] ?? 0) + n;
            }
          },
        });
        entries.push(entry);
        summary.processed += 1;
      } catch (err) {
        // Reported and skipped. The run continues; whether it is allowed to
        // SUCCEED is decided below, by the failure ratio.
        summary.failed += 1;
        const reason = err && err.message ? err.message : String(err);
        summary.failures.push({ id: session.id, reason });
      }
    }

    // More than half failing means the remaining notes are not "the history",
    // they are "the part of the history that happened to parse". Writing them
    // and reporting success would be a misleading partial mirror, so this run
    // writes NOTHING and exits non-zero.
    if (summary.selected > 0 && summary.failed * 2 > summary.selected) {
      summary.aborted = true;
      if (!summary.dryRun) {
        // The attachments were unpacked while rendering, i.e. before the ratio
        // was known, so they have to be taken back out for the promise below to
        // be true rather than merely intended.
        summary.attachmentsDiscarded = discardAttachments(attachmentsDir, before);
        // Deepest first, and `preExisting` last: everything above the point the
        // run started from is off limits even when it is empty.
        summary.prunedDirs = pruneEmptyDirs(dirsDeeperThan(preExisting, vault));
      }
      return summary;
    }

    if (!summary.dryRun && entries.length > 0) {
      const planned = planWrites(vault, entries);
      summary.created = planned.created;
      summary.written = planned.written;
      summary.unchanged = planned.unchanged;
      summary.changedPaths = planned.changedPaths;
      summary.attachments = restoreUnchangedAttachmentTimes(attachmentsDir, before);
    }
  } finally {
    handle.close();
  }

  return summary;
}

/**
 * Render the summary as the lines this script prints.
 *
 * Flat `label: value` lines, one number each, so the output is greppable and a
 * shell can read one field without parsing prose. Every pattern in
 * `PATTERN_NAMES` is listed even at zero, because a report that omits the
 * patterns which found nothing is indistinguishable from a report that did not
 * run them.
 */
export function formatSummary(summary) {
  const lines = [
    'opencode-history export',
    `database: ${summary.dbPath}`,
    `vault: ${summary.vault}`,
    `dry run: ${summary.dryRun ? 'yes' : 'no'}`,
    `limit: ${summary.limit === null ? 'all' : summary.limit}`,
    `project-dir: ${summary.projectDir === null ? '(none)' : summary.projectDir}`,
    `db sessions: ${summary.dbSessions}`,
    `sessions discovered: ${summary.discovered}`,
    `sessions matched: ${summary.matched}`,
    `sessions selected: ${summary.selected}`,
    `sessions processed: ${summary.processed}`,
    `sessions failed: ${summary.failed}`,
    `notes created: ${summary.created}`,
    `notes written: ${summary.written}`,
    `notes unchanged: ${summary.unchanged}`,
    `attachments created: ${summary.attachments.created}`,
    `attachments written: ${summary.attachments.written}`,
    `attachments unchanged: ${summary.attachments.unchanged}`,
  ];
  // Only on an aborted run, where the answer is "none of them, they were taken
  // back out". A permanent line reading zero would imply a check that did not
  // happen.
  if (summary.aborted && summary.attachmentsDiscarded !== null) {
    lines.push(`attachments discarded: ${summary.attachmentsDiscarded.removed}`);
  }
  for (const name of PATTERN_NAMES) {
    lines.push(`redacted ${name}: ${summary.redactions[name] ?? 0}`);
  }
  return lines;
}

/**
 * The CLI entry point.
 *
 * @param {string[]} argv arguments AFTER the script name
 * @param {Record<string, string|undefined>} [env] environment; passed in rather
 *   than read from `process.env` so a test cannot be redirected by the shell it
 *   happens to run in
 * @param {{out: (s: string) => void, err: (s: string) => void}} [io]
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv = [], env = process.env, io = defaultIo) {
  const { out, err } = io && typeof io.out === 'function' && typeof io.err === 'function'
    ? io
    : defaultIo;

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`❌ ${e.message}`);
    err('');
    err(USAGE);
    return EXIT_USAGE;
  }

  if (opts.help) {
    out(USAGE);
    return EXIT_OK;
  }

  let summary;
  try {
    summary = await runExport(opts, env ?? {});
  } catch (e) {
    err(`❌ ${e.message}`);
    return EXIT_FAILED;
  }

  for (const line of formatSummary(summary)) out(line);

  for (const failure of summary.failures) {
    err(`❌ session ${JSON.stringify(failure.id)} skipped: ${failure.reason}`);
  }

  if (summary.aborted) {
    err(
      `❌ ${summary.failed} of ${summary.selected} session(s) failed, which is more than half. `
      + 'Nothing was written: a partial mirror reported as a successful export is worse than no export.',
    );
    return EXIT_FAILED;
  }

  if (summary.failed > 0) {
    err(`⚠️  ${summary.failed} session(s) were skipped; every other session was written.`);
  }

  const changed = summary.created + summary.written;
  // A dry run reports created/written/unchanged as 0 because it writes
  // nothing at all, so `changed === 0` alone would claim "every note was
  // already up to date" — a statement that is false, because the notes were
  // never compared against anything. Say what actually happened instead.
  if (opts.dryRun) {
    out(`✅ dry run: ${summary.processed} session(s) rendered, nothing written.`);
  } else {
    out(changed === 0 && summary.processed > 0
      ? '✅ nothing to write: every note was already up to date.'
      : `✅ ${changed} note(s) written, ${summary.unchanged} unchanged.`);
  }
  return EXIT_OK;
}

// Guarded so importing this file from a test exports nothing and opens no
// database. Compared as resolved paths rather than by `endsWith`, because a
// suffix test also matches a DIFFERENT file that merely ends the same way.
const isMain = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // `process.exitCode` rather than `process.exit()`: exiting immediately can
  // truncate a piped summary, and the whole point of the summary is that it is
  // read.
  main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
