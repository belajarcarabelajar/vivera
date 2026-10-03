// scripts/export-opencode-history.e2e.test.mjs
//
// THE ACCEPTANCE LAYER. WHAT IS DIFFERENT ABOUT THIS FILE
//
// `export-opencode-history.test.mjs` (T8) tests the CLI as a program: flags,
// exit codes, usage errors, argument parsing, the shape of the summary. Each of
// its assertions would still pass if the notes it looked at were empty files
// with the right names. This file does not look at the program. It looks at the
// RESULT — a fixture database built from the real schema goes in one end, and
// real markdown that a person could read comes out the other, and the questions
// asked here are the questions the acceptance criteria (AC-1..AC-8) actually ask:
//
//   AC-1  parity with the TABLE          -> countSessions(db) vs files on disk
//   AC-2  a name per session              -> the filename contract, parsed back
//   AC-3  never the real vault or DB      -> mtime/size of the fixture DB, and
//                                           an INSERT that must be refused
//   AC-4/5 secrets never land on disk     -> every written FILE scanned, not
//                                           just the note
//   AC-6  full fidelity, not a stub       -> the tool NAME and its INPUT survive
//   AC-7  no base64 anywhere              -> long-blob scan + a real PNG file
//   AC-8  idempotency                     -> aged mtimes, byte-identical after
//
// WHAT IS DELIBERATELY NOT HERE
//
// No argv parsing, no `--help`, no unknown-flag, no missing-`--db`, no
// `projectSlug()` unit assertions. Those are T8's job and duplicating them would
// make two files disagree the moment one of them is wrong.
//
// NEVER THE REAL VAULT, NEVER THE REAL DATABASE. Hard rule, and it is why:
//   * every database here is built by `buildFixtureDb()` into a fresh
//     `mkdtempSync()` under `os.tmpdir()`;
//   * every `main()` call gets an explicit `--db` AND an explicit `--vault`;
//   * every `main()` call gets an EMPTY env, never `process.env`, so a stray
//     `OPENCODE_EXPORT_VAULT` in the developer's shell cannot redirect a test
//     into the configured real vault;
//   * `RUNS` below records every (db, vault) this file ever asked for, and
//     test 13 asserts that no recorded path is the real one. The discipline is
//     therefore checked, not just asserted in a comment.
//
// Revert: delete this file. Nothing imports it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';

import {
  main, conversationsRoot, attachmentsRoot, projectSlug, defaultVaultRoot, CONVERSATIONS_DIR,
} from './export-opencode-history.mjs';
import { DEFAULT_OPENCODE_DB_PATH, countSessions, openReadonly } from './lib/opencode-db.mjs';
import {
  buildFixtureDb, FIXTURE_SESSION_IDS, FIXTURE_PNG_BASE64, FIXTURE_PROJECT_WORKTREE,
} from './lib/test-fixture-db.mjs';

// ---------- the import-safety snapshot ----------
//
// Taken at MODULE LOAD, which in ESM is after every `import` above has been
// evaluated and before a single test body runs. So this is a photograph of the
// filesystem as it stood immediately after the exporter was imported: if
// importing it had executed an export, the directory it would have created is
// already in this snapshot and every test below would be reading an artefact of
// the import rather than of its own runs.

// The real vault, resolved exactly the way a user of this script resolves it:
// the env var, else local.config.json. Null when this machine configures none,
// in which case there is no real path to guard and test 13 leans on its tmpdir
// rule, which subsumes the real-vault comparisons.
const REAL_VAULT = (() => {
  try {
    return defaultVaultRoot();
  } catch {
    return null;
  }
})();

const REAL_VAULT_CONVERSATIONS = REAL_VAULT === null ? null : path.join(REAL_VAULT, CONVERSATIONS_DIR);
const vaultEntriesAtImport = REAL_VAULT !== null && existsSync(REAL_VAULT)
  ? readdirSync(REAL_VAULT).sort()
  : null;

// A fixed old date, chosen here rather than read off a clock, so "the mtime
// moved" is a comparison against a number this file decided. 2001-01-01 is far
// enough from any plausible run time that a rewrite is impossible to miss.
const OLD_MTIME = new Date('2001-01-01T00:00:00.000Z');

/** Every (db, vault) this file ever handed to `main()`. Read by test 13. */
const RUNS = [];

/** Temp roots registered for the module-level `after()` backstop. */
const ROOTS = [];

// ---------- fixtures ----------

/**
 * A fresh temp tree with a fixture database and a vault that does NOT exist yet.
 *
 * @param {string} tag a label for the temp prefix, so a leaked directory is
 *   identifiable by name if something ever goes wrong
 * @param {{sessionIds?: string[], epochMs?: number}} [opts] passed through to
 *   `buildFixtureDb`
 */
function fixture(tag, opts = {}) {
  const root = mkdtempSync(path.join(tmpdir(), `e2e-export-${tag}-`));
  ROOTS.push(root);
  const fx = buildFixtureDb(path.join(root, 'opencode.db'), opts);
  const vault = path.join(root, 'vault');
  return {
    root,
    fx,
    vault,
    conversations: conversationsRoot(vault),
    attachments: attachmentsRoot(vault),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Run the CLI and capture both streams. Env is `{}` unless a test needs otherwise. */
async function run(argv, env = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, env, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  RUNS.push({ argv: argv.slice(), code, vault: out.find((l) => l.startsWith('vault: ')) ?? null, db: out.find((l) => l.startsWith('database: ')) ?? null });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** The standard full export: every session in the fixture, into a temp vault. */
function exportAll(f) {
  return run(['--db', f.fx.path, '--vault', f.vault]);
}

/** Every `.md` file under a directory, recursively. A missing directory -> []. */
function mdFiles(dir) {
  return allFiles(dir).filter((p) => p.endsWith('.md'));
}

/** Every regular file under a directory, recursively. A missing directory -> []. */
function allFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) found.push(p);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * The `id:` out of a note's frontmatter.
 *
 * Hand-rolled ON PURPOSE. `render-session.mjs` exports its own
 * `parseFrontmatter()`, and using it here would mean the thing that writes the
 * frontmatter is also the thing that decides whether it was written correctly —
 * a shared blind spot that passes when both are wrong. Four lines of independent
 * parsing is the whole price of not having one.
 *
 * @returns {string|null} the unquoted id, or null when there is no frontmatter
 */
function frontmatterId(markdown) {
  const lines = markdown.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  for (const line of lines.slice(1, end)) {
    const m = /^id:\s*(.+)$/.exec(line);
    if (m === null) continue;
    const raw = m[1].trim();
    return raw.startsWith('"') ? JSON.parse(raw) : raw;
  }
  return null;
}

/** The `label: value` number out of a summary line, or null. */
function numberFrom(stdout, label) {
  const m = new RegExp(`^${label}: (\\d+)$`, 'm').exec(stdout);
  return m === null ? null : Number(m[1]);
}

/**
 * Structural markdown checks that do not need a YAML or CommonMark dependency.
 *
 * "The note exists" and "the note is a document" are different claims, and only
 * the first one is easy. Balanced fences are the load-bearing part: an odd
 * number of ``` lines means one code block swallowed the rest of the session,
 * which renders in Obsidian as one very long grey box.
 */
function assertParsesAsMarkdown(note, body, label) {
  assert.equal(body.split('\n')[0], '---', `${label}: no frontmatter fence on the first line`);
  const fences = (body.match(/^```/gm) ?? []).length;
  assert.equal(fences % 2, 0, `${label}: ${fences} code fences — an unbalanced count swallows the rest of the note`);
  assert.match(body, /^# \S/m, `${label}: no level-1 heading`);
  assert.ok((body.match(/^## /gm) ?? []).length > 0, `${label}: no level-2 message sections`);
  assert.ok(note.endsWith('.md'));
}

// ---------- 1. the whole pipeline: fixture database -> readable notes ----------

test('a fixture database becomes readable notes under 05 - Conversations/<project-slug>/', async () => {
  const f = fixture('pipeline');
  try {
    const r = await exportAll(f);
    assert.equal(r.code, 0, `the export failed: ${r.stderr}`);

    // The layout is part of the contract, so it is asserted by name rather than
    // as "some .md file exists somewhere under the vault".
    const slugDir = path.join(f.conversations, projectSlug(FIXTURE_PROJECT_WORKTREE));
    assert.ok(existsSync(slugDir), `no project folder was created at ${slugDir}; got ${readdirSync(f.conversations).join(', ')}`);
    assert.equal(projectSlug(FIXTURE_PROJECT_WORKTREE), 'fixture-project-a');

    const notes = mdFiles(f.conversations);
    assert.ok(notes.length > 0, 'the export reported success and wrote nothing');

    // Every session in the fixture must be accounted for by NAME, not by count
    // alone: a run could write three notes and name none of them correctly.
    for (const id of f.fx.sessionIds) {
      const hit = notes.find((p) => path.basename(p).includes(`[${id}]`));
      assert.ok(hit, `no note names session ${id}; got ${notes.map((p) => path.basename(p)).join(' | ')}`);
      const body = readFileSync(hit, 'utf8');
      assertParsesAsMarkdown(hit, body, id);
      assert.equal(
        frontmatterId(body),
        id,
        `${id}: the frontmatter id does not match the session id the fixture put in the database`,
      );
    }
  } finally {
    f.cleanup();
  }
});

// ---------- 2. AC-1: parity with the table, not with an array ----------

test('the note count equals countSessions(db) — parity with the table (AC-1)', async () => {
  const f = fixture('parity');
  try {
    const r = await exportAll(f);
    assert.equal(r.code, 0, r.stderr);

    // Straight from the engine, not from an array this file built. Counting what
    // we just produced would make the parity unfalsifiable.
    const handle = openReadonly(f.fx.path);
    let expected;
    try {
      expected = countSessions(handle.db);
    } finally {
      handle.close();
    }
    assert.equal(expected, f.fx.sessionIds.length, 'the fixture itself is not self-consistent');

    const onDisk = mdFiles(f.conversations);
    assert.equal(onDisk.length, expected, `expected ${expected} notes, found ${onDisk.length}`);
    // The summary has to agree with the filesystem, or the run's own report
    // cannot be used to check the run.
    assert.equal(numberFrom(r.stdout, 'notes created'), expected);
    assert.equal(numberFrom(r.stdout, 'db sessions'), expected);
    assert.equal(numberFrom(r.stdout, 'sessions processed'), expected);
    assert.equal(numberFrom(r.stdout, 'sessions failed'), 0);
  } finally {
    f.cleanup();
  }
});

// ---------- 3. AC-2/AC-3 shape: the filename contract ----------

test('every filename is `YYYY-MM-DD - <slug> [<session-id>].md` and agrees with its frontmatter', async () => {
  // TWO projects, not one. With every session in one worktree, a `projectSlug()`
  // that returned a constant would satisfy every filename assertion — the names
  // would be perfect and all of them filed in the same folder, which is the
  // mirror quietly merging two projects into one. Moving one session to a second
  // worktree post-build is what makes "the folder is a function of the
  // directory" an assertion rather than an assumption. The two expected folder
  // names are written out as literals rather than produced by calling
  // `projectSlug()`: asking the function under test what its own output should be
  // is the circular assertion this file exists to avoid.
  const PROJECT_A = '/fixture/project-a';
  const PROJECT_B = '/fixture/project-b';
  const MOVED = FIXTURE_SESSION_IDS[1];
  const f = fixture('names');
  try {
    const db = new Database(f.fx.path);
    try {
      db.run('UPDATE session_v2 SET directory = ? WHERE id = ?', [PROJECT_B, MOVED]);
    } finally {
      db.close();
    }

    const r = await exportAll(f);
    assert.equal(r.code, 0, r.stderr);
    const notes = mdFiles(f.conversations);
    assert.equal(notes.length, f.fx.sessionIds.length);

    // Exactly two project folders, and they are the ones the fixture implies.
    // `.attachments` is excluded because it is a sibling of the project folders,
    // not a project.
    const projectFolders = readdirSync(f.conversations).filter((n) => n !== '.attachments').sort();
    assert.deepEqual(projectFolders, ['fixture-project-a', 'fixture-project-b']);

    const seen = new Set();
    for (const note of notes) {
      // Each note is filed under ITS OWN session's project, not merely under one.
      const expectedFolder = note.includes(`[${MOVED}]`) ? 'fixture-project-b' : 'fixture-project-a';
      assert.equal(path.basename(path.dirname(note)), expectedFolder, `${path.basename(note)} is filed under the wrong project`);

      const name = path.basename(note);
      const m = /^(\d{4}-\d{2}-\d{2}) - (.+) \[([^\]]+)\]\.md$/.exec(name);
      assert.ok(m !== null, `filename does not match the contract: ${JSON.stringify(name)}`);
      const [, date, slug, idInName] = m;

      // The date is the session's own creation day, in UTC — not the day the
      // export happened. A re-run tomorrow must not rename anything.
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(slug.length > 0, `${name}: the slug is empty`);
      assert.equal(frontmatterId(readFileSync(note, 'utf8')), idInName, `${name}: the bracketed id is not the note's id`);

      // A filename is about to be joined onto a directory, so it must not carry
      // a separator or a parent reference. `path.basename` cannot contain `/`,
      // but the assertion is written out anyway: the claim is the contract, and
      // a contract nobody checks is a comment.
      assert.equal(name.includes('/'), false, `${name} contains a path separator`);
      assert.equal(name.includes('\\'), false, `${name} contains a backslash`);
      assert.equal(name.includes('..'), false, `${name} contains a parent reference`);
      assert.equal(name.includes('\0'), false, `${name} contains a NUL byte`);

      // And the resolved path really is inside the vault, three levels down.
      const rel = path.relative(f.vault, path.resolve(note));
      assert.equal(rel.split(path.sep).length, 3, `${rel} is not <vault>/${CONVERSATIONS_DIR}/<slug>/<note>`);
      assert.ok(path.resolve(note).startsWith(f.vault + path.sep), `${note} escaped the vault`);

      assert.equal(seen.has(name), false, `two sessions landed on the same filename: ${name}`);
      seen.add(name);
    }

    // Every fixture id reached a filename, and only those.
    for (const id of f.fx.sessionIds) {
      assert.ok([...seen].some((n) => n.includes(`[${id}]`)), `no filename carries ${id}`);
    }
  } finally {
    f.cleanup();
  }
});

// ---------- 4. a note is a conversation, not a stub ----------

test('a written note carries the real user prompt and the real assistant answer', async () => {
  const f = fixture('readable');
  try {
    const r = await exportAll(f);
    assert.equal(r.code, 0, r.stderr);
    const note = mdFiles(f.conversations).find((p) => path.basename(p).includes(`[${FIXTURE_SESSION_IDS[0]}]`));
    assert.ok(note, 'the titled session produced no note');
    const body = readFileSync(note, 'utf8');
    assertParsesAsMarkdown(note, body, FIXTURE_SESSION_IDS[0]);

    // A stub with the right filename would satisfy every assertion in T8.
    // These are the strings the fixture put INTO the database, so they can only
    // be here if the rows were read, parsed and rendered.
    assert.match(body, /^## \[seq 0\] user$/m, 'no user message section');
    assert.match(body, /^### prompt$/m, 'the user section has no prompt subheading');
    assert.ok(body.includes('Summarise the fixture project.'), 'the user prompt from the database is not in the note');

    assert.match(body, /^## \[seq 1\] assistant$/m, 'no assistant message section');
    assert.match(body, /^### assistant text$/m, 'the assistant section has no text subheading');
    assert.ok(body.includes('Here is what the fixture project contains.'), 'the assistant answer is not in the note');

    // The non-user message types are rendered as labelled events, not dropped.
    assert.match(body, /^## \[seq 2\] session-event: idle$/m, 'the idle event is missing');
    assert.match(body, /^## \[seq 3\] session-event: synthetic$/m, 'the synthetic event is missing');
    assert.ok(body.includes('bun test scripts/lib/'), 'the synthetic shell event lost its command');

    // And the frontmatter counts the rows it claims to have.
    assert.match(body, /^message_count: 4$/m, 'message_count does not match the four seeded messages');
    assert.ok(body.length > 1500, `the note is only ${body.length} bytes — that is a stub, not a transcript`);
  } finally {
    f.cleanup();
  }
});

// ---------- 5. AC-6: full fidelity — a tool call survives end to end ----------

test('a tool call survives the whole pipeline with its name and its input (AC-6)', async () => {
  const f = fixture('tool');
  try {
    const r = await exportAll(f);
    assert.equal(r.code, 0, r.stderr);
    const note = mdFiles(f.conversations).find((p) => path.basename(p).includes(`[${FIXTURE_SESSION_IDS[0]}]`));
    assert.ok(note, 'the session carrying the tool call produced no note');
    const body = readFileSync(note, 'utf8');

    // The tool NAME, as a heading — the reader needs it to know what happened.
    assert.match(body, /^### tool · read$/m, 'the tool name did not reach the note');
    // The tool ID and execution state.
    assert.match(body, /^- `id`: call_fixture_0001$/m, 'the tool call id is missing');
    assert.match(body, /^- `executed`: true$/m, 'the executed flag is missing');
    assert.match(body, /^- `status`: completed$/m, 'the tool status is missing');
    // The INPUT, verbatim, as JSON. This is the part that would be lost by a
    // renderer that summarised instead of rendering.
    assert.match(body, /^#### input$/m, 'the tool has no input section');
    assert.ok(
      body.includes('"path": "/fixture/project-a/notes.md"'),
      'the tool input did not survive; a renderer that summarised the call would pass every other test in this file',
    );
    // And the OUTPUT section exists, even where the spill was refused — the note
    // must say why rather than silently show nothing.
    assert.match(body, /^#### output$/m, 'the tool has no output section');
    assert.ok(body.includes('[SPILL REFUSED'), 'the refused spill is not explained in the note');
  } finally {
    f.cleanup();
  }
});

// ---------- 6. AC-8: idempotency, proven with timestamps ----------

test('a second run over an unchanged database moves no mtime at all (AC-8)', async () => {
  const f = fixture('idempotent');
  try {
    const first = await exportAll(f);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(numberFrom(first.stdout, 'notes created'), f.fx.sessionIds.length);

    // Age EVERY file the run wrote, attachments included. Attachment files are
    // written by `extract-attachments.mjs`, which the exporter does not own, so
    // they are where "wrote zero files" is most likely to be quietly false.
    const notes = mdFiles(f.conversations);
    const attachments = allFiles(f.attachments);
    assert.equal(notes.length, f.fx.sessionIds.length);
    assert.equal(attachments.length, 1, 'the fixture carries one inline attachment; it did not produce one file');
    const aged = [...notes, ...attachments];
    const old = OLD_MTIME.getTime() / 1000;
    for (const p of aged) utimesSync(p, old, old);

    // Positive control: if the aging did not take, this test below would pass
    // for the wrong reason, so the aged value is asserted as fact first.
    const mtimesBefore = aged.map((p) => statSync(p).mtimeMs);
    assert.deepEqual(mtimesBefore, new Array(aged.length).fill(OLD_MTIME.getTime()), 'the aging did not take; the assertions below would be vacuous');

    const second = await exportAll(f);
    const mtimesAfter = aged.map((p) => statSync(p).mtimeMs);

    // Timestamps BEFORE counts, deliberately: a count is a claim the exporter
    // makes about itself, an mtime is a fact about the filesystem — and mtime is
    // what `git status` reads, on a vault where obsidian-git pushes every 10
    // minutes with nobody watching.
    assert.deepEqual(mtimesAfter, mtimesBefore, 'the second run rewrote a file with identical bytes');
    assert.deepEqual(aged.map((p) => readFileSync(p).length), aged.map((p) => readFileSync(p).length));

    assert.equal(second.code, 0, second.stderr);
    assert.equal(numberFrom(second.stdout, 'notes created'), 0, 'the second run created a note');
    assert.equal(numberFrom(second.stdout, 'notes written'), 0, 'the second run rewrote a note');
    assert.equal(numberFrom(second.stdout, 'notes unchanged'), f.fx.sessionIds.length, 'not every note was reported unchanged');
    assert.equal(numberFrom(second.stdout, 'attachments created'), 0, 'an attachment was rewritten from scratch');
    assert.match(second.stdout, /nothing to write/, 'the run did not report that there was nothing to write');
  } finally {
    f.cleanup();
  }
});

// ---------- 7. AC-4/AC-5: redaction survives the pipeline ----------

test('a planted secret is absent from EVERY file the run wrote, and is counted (AC-4/AC-5)', async () => {
  const f = fixture('redact');
  try {
    // Assembled from fragments at runtime so this source file contains no
    // literal a secret scanner would flag, and so a failure has to be a
    // redaction failure rather than "the fixture already contained it".
    // 36 characters after the underscore, which is the real GitHub PAT length;
    // `redact.mjs` requires 20 or more.
    const secret = ['gh', 'p', '_', 'Q7wZ2mK9', 'Lp4Rt6Vn', 'Bz8Hx3Wq', 'Jm5Tc1Rf'].join('');
    assert.match(secret, /^ghp_[A-Za-z0-9]{20,}$/, 'the planted value does not match the github-token pattern');

    // The only injection seam the fixture builder offers is its two build
    // options; it takes no message payloads. So the row is rewritten in place
    // with bun:sqlite after the build, before the exporter ever sees the file.
    const db = new Database(f.fx.path);
    try {
      const rows = db.query("SELECT id, data FROM session_message WHERE session_id = ? AND type = 'user'").all(FIXTURE_SESSION_IDS[0]);
      assert.equal(rows.length, 1, 'the fixture should have exactly one user message to plant into');
      for (const row of rows) {
        const data = JSON.parse(row.data);
        data.text = `${data.text}\n\ndeploy with ${secret} when you get a chance`;
        db.run('UPDATE session_message SET data = ? WHERE id = ?', [JSON.stringify(data), row.id]);
      }
    } finally {
      db.close();
    }

    // Positive control, and the reason for it: prove the secret really IS in
    // the database before claiming it was kept out of the notes. Without this,
    // "the secret is absent from the note" is also what a test that never
    // planted anything would report.
    const check = new Database(f.fx.path);
    try {
      const stored = check.query('SELECT data FROM session_message WHERE session_id = ? AND type = ?').get(FIXTURE_SESSION_IDS[0], 'user');
      assert.ok(stored.data.includes(secret), 'the secret never made it into the fixture; this test would prove nothing');
    } finally {
      check.close();
    }

    const r = await exportAll(f);
    assert.equal(r.code, 0, r.stderr);

    // EVERY written file, attachments included — not only the note that carried
    // the secret. Binary read as a Buffer, because a UTF-8 decode of a PNG
    // could in principle mangle the very bytes being searched for.
    const written = allFiles(f.vault);
    assert.ok(written.length > f.fx.sessionIds.length, `expected notes and an attachment, got ${written.length} files`);
    for (const p of written) {
      const bytes = readFileSync(p);
      assert.equal(bytes.includes(secret), false, `the secret reached ${path.relative(f.vault, p)}`);
    }

    // The marker is visible, so a reader can see that something was scrubbed
    // rather than wondering whether the message was simply short.
    const note = mdFiles(f.conversations).find((p) => path.basename(p).includes(`[${FIXTURE_SESSION_IDS[0]}]`));
    const body = readFileSync(note, 'utf8');
    assert.ok(body.includes('[REDACTED:github-token]'), 'the redaction marker is not in the note');
    assert.ok(body.includes('deploy with'), 'the surrounding sentence was dropped instead of the secret');

    // A redactor that fires but reports nothing has told the operator nothing.
    const n = numberFrom(r.stdout, 'redacted github-token');
    assert.ok(n !== null && n >= 1, `the summary reports github-token: ${n}`);
  } finally {
    f.cleanup();
  }
});

// ---------- 8. AC-7: no base64 anywhere, a real PNG on disk ----------

test('no written file carries a base64 blob and the PNG is a real file (AC-7)', async () => {
  const f = fixture('base64');
  try {
    const r = await exportAll(f);
    assert.equal(r.code, 0, r.stderr);

    // A run of base64 alphabet characters long enough that no legitimate text
    // produces one: an id, a hash, a path and a JSON blob are all far shorter.
    const BLOB = /[A-Za-z0-9+/]{100,}={0,2}/;
    for (const note of mdFiles(f.conversations)) {
      const text = readFileSync(note, 'utf8');
      assert.equal(BLOB.test(text), false, `${path.basename(note)} carries a base64 blob (AC-7)`);
      // The payload magic specifically, so the check cannot pass by being run at
      // a threshold this particular fixture happens not to reach.
      assert.equal(text.includes('iVBORw0KGgo'), false, `${path.basename(note)} carries the inline PNG payload verbatim`);
      assert.equal(text.includes(FIXTURE_PNG_BASE64), false, `${path.basename(note)} carries the fixture's base64 attachment`);
    }

    // And it became a FILE, under the attachments directory, with the extension
    // sniffed from the magic bytes rather than copied from the log name.
    const attachments = allFiles(f.attachments);
    assert.equal(attachments.length, 1, `expected one attachment file, got ${attachments.map((p) => path.basename(p)).join(', ')}`);
    const png = attachments[0];
    assert.ok(png.endsWith('.png'), `the extension was not sniffed from the magic bytes: ${path.basename(png)}`);
    const bytes = readFileSync(png);
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the attachment is not a PNG');
    assert.equal(bytes.length, 70, 'the attachment is not the decoded payload');
    // The decoded file must not itself be base64 — it is the bytes, not the text.
    assert.equal(BLOB.test(bytes.toString('latin1')), false, 'the attachment file still contains a base64 blob');

    // And the note links to that file by vault-relative path, so Obsidian
    // renders it instead of showing a dead embed.
    const note = mdFiles(f.conversations).find((p) => path.basename(p).includes(`[${FIXTURE_SESSION_IDS[2]}]`));
    assert.ok(note, 'the session carrying the attachment produced no note');
    const body = readFileSync(note, 'utf8');
    assert.ok(
      body.includes(`![[${CONVERSATIONS_DIR}/.attachments/${path.basename(png)}]]`),
      `the note does not embed the written attachment:\n${body.slice(0, 600)}`,
    );
    assert.equal(numberFrom(r.stdout, 'attachments created'), 1);
  } finally {
    f.cleanup();
  }
});

// ---------- 9. a vault path containing a space, end to end ----------

test('a vault whose whole path contains spaces exports in full and re-exports cleanly', async () => {
  // The real vault is `Dokumen/Obsidian Vault`. Any argv handling that split on
  // whitespace would shred this, and the failure would look like a missing note
  // rather than a mis-parsed flag.
  const root = mkdtempSync(path.join(tmpdir(), 'e2e vault with spaces-'));
  ROOTS.push(root);
  try {
    const fx = buildFixtureDb(path.join(root, 'open code.db'));
    const vault = path.join(root, 'My Obsidian Vault');
    assert.ok(root.includes(' '), 'the temp root must contain a space for this test to mean anything');
    assert.ok(fx.path.includes(' '), 'the database path must contain a space too');

    const first = await run(['--db', fx.path, '--vault', vault]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^vault: .*My Obsidian Vault$/m, 'the reported vault does not match what was passed');

    const conversations = conversationsRoot(vault);
    const notes = mdFiles(conversations);
    const handle = openReadonly(fx.path);
    let expected;
    try {
      expected = countSessions(handle.db);
    } finally {
      handle.close();
    }
    assert.equal(notes.length, expected, 'a spaced path lost sessions');
    for (const note of notes) {
      assert.ok(note.startsWith(vault + path.sep), `${note} escaped the vault`);
      assertParsesAsMarkdown(note, readFileSync(note, 'utf8'), path.basename(note));
    }
    assert.equal(allFiles(attachmentsRoot(vault)).length, 1, 'the attachment did not land inside the spaced vault');

    // And the idempotency guarantee holds under a spaced path too, which is the
    // combination that matters: this is the shape of the real destination.
    const aged = [...notes, ...allFiles(attachmentsRoot(vault))];
    const old = OLD_MTIME.getTime() / 1000;
    for (const p of aged) utimesSync(p, old, old);
    const before = aged.map((p) => statSync(p).mtimeMs);

    const second = await run(['--db', fx.path, '--vault', vault]);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(aged.map((p) => statSync(p).mtimeMs), before, 'a re-run under a spaced path rewrote a file');
    assert.equal(numberFrom(second.stdout, 'notes unchanged'), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 10. AC-3: read-only against the database ----------

test('the export leaves the database untouched and refuses writes (AC-3)', async () => {
  const f = fixture('readonly');
  try {
    const before = statSync(f.fx.path);

    const r = await exportAll(f);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mdFiles(f.conversations).length, f.fx.sessionIds.length, 'nothing was exported, so nothing was proved read-only');

    const after = statSync(f.fx.path);
    // mtime is the claim that matters: a read that dirtied the file would show
    // up here, and `size` catches a truncate-and-rewrite.
    assert.equal(after.mtimeMs, before.mtimeMs, 'the database mtime moved; something wrote to it');
    assert.equal(after.size, before.size, 'the database changed size');

    // The stronger half: the connection this pipeline uses REFUSES an INSERT.
    // The real database has a `credential` table with real secrets in it; a
    // reader that can write is a reader that can corrupt them. The fixture is
    // the only database this file opens.
    const handle = openReadonly(f.fx.path);
    try {
      assert.equal(countSessions(handle.db), f.fx.sessionIds.length, 'the read-only handle cannot even read');
      let refused = null;
      try {
        handle.db.run(
          `INSERT INTO session_v2
             (id, project_id, slug, directory, path, version, cost, tokens_input,
              tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
              time_created, time_updated)
           VALUES ('ses_written_by_a_test', 'prj_fixture', 's', '/fixture/project-a',
                   '', '0.1.0', 0, 0, 0, 0, 0, 0, 1, 1)`,
        );
      } catch (err) {
        refused = err;
      }
      assert.notEqual(refused, null, 'an INSERT through the pipeline\'s own handle succeeded; the database is not read-only');
      assert.match(String(refused.message), /readonly/i, `unexpected refusal message: ${refused && refused.message}`);
    } finally {
      handle.close();
    }

    // And the attempt above changed nothing on disk either.
    assert.equal(statSync(f.fx.path).size, before.size);
    const handle2 = openReadonly(f.fx.path);
    try {
      const ids = handle2.db.query('SELECT id FROM session_v2').all().map((r) => r.id);
      assert.equal(ids.includes('ses_written_by_a_test'), false, 'the rejected INSERT is still in the table');
      assert.equal(ids.length, f.fx.sessionIds.length);
    } finally {
      handle2.close();
    }
  } finally {
    f.cleanup();
  }
});

// ---------- 11. an isolated failure does not abort the run ----------

test('one unnameable session is skipped, reported, and every other note is still written', async () => {
  // Five sessions rather than the fixture's three, so "fewer than half" is a
  // margin and not a tie: 1 of 5 failing must not come near the abort rule.
  const ids = ['ses_e2e_ok_1', 'ses_e2e_ok_2', 'ses_e2e_ok_3', 'ses_e2e_bad', 'ses_e2e_ok_4'];
  const f = fixture('isolated-failure', { sessionIds: ids });
  try {
    // `time_created` is NOT NULL, so a corrupt value cannot be NULL: it is a
    // non-numeric string, which SQLite stores happily in an INTEGER column
    // because of type affinity — the realistic shape, a row some earlier tool
    // wrote. Written after the build, since the fixture builder has no seam for
    // a bad timestamp.
    const db = new Database(f.fx.path);
    try {
      db.run('UPDATE session_v2 SET time_created = ? WHERE id = ?', ['not-a-timestamp', 'ses_e2e_bad']);
    } finally {
      db.close();
    }

    const r = await exportAll(f);
    assert.equal(r.code, 0, `one bad session must not fail the whole run: ${r.stderr}`);

    assert.equal(numberFrom(r.stdout, 'sessions selected'), ids.length);
    assert.equal(numberFrom(r.stdout, 'sessions failed'), 1, 'the corrupt session was not counted as a failure');
    assert.equal(numberFrom(r.stdout, 'sessions processed'), ids.length - 1);

    // The four good sessions are on disk, by name, and readable.
    const notes = mdFiles(f.conversations);
    assert.equal(notes.length, ids.length - 1, 'a single corrupt row cost more than one note');
    for (const id of ids.filter((i) => i !== 'ses_e2e_bad')) {
      const note = notes.find((p) => path.basename(p).includes(`[${id}]`));
      assert.ok(note, `no note for the good session ${id}`);
      const body = readFileSync(note, 'utf8');
      assert.equal(frontmatterId(body), id);
      assertParsesAsMarkdown(note, body, id);
      // The fixture gives one of its sessions a different assistant answer (the
      // one carrying the attachment), so the check is "an assistant answer was
      // rendered", not one hardcoded sentence.
      assert.match(body, /^### assistant text$/m, `${id} was written but has no assistant text section`);
      assert.ok(
        /The screenshot shows a fixture row\.|Here is what the fixture project contains\./.test(body),
        `${id} was written but not rendered`,
      );
      assert.match(body, /^### tool · read$/m, `${id} was written but its tool call is missing`);
    }

    // The bad one is named in the error, so an operator can go and look at it.
    assert.match(r.stderr, /ses_e2e_bad/, 'the failing session is not named in the report');
    assert.match(r.stderr, /timeCreated is required/, `the failure has no reason: ${r.stderr}`);
    // And the vault exists — this is the opposite of the abort rule, which is
    // what makes this test different from "two of three failing writes nothing".
    assert.ok(existsSync(f.conversations), 'a run that skipped 1 of 5 wrote nothing at all');
  } finally {
    f.cleanup();
  }
});

// ---------- 12. --dry-run writes nothing ----------

test('--dry-run over a fresh destination leaves no directory behind', async () => {
  const f = fixture('dry-run');
  // A destination that is a SIBLING of the database, not a child of the same
  // temp tree the fixture builder wrote into. The claim under test is about what
  // the exporter did or did not create under `--vault`; it has nothing to say
  // about what SQLite's own bookkeeping leaves in the database's directory, so
  // the two must not share a directory that gets enumerated wholesale. The
  // previous form of this test listed the temp tree and named the `-shm`/`-wal`
  // sidecars explicitly, which tied "a dry run writes nothing" to the fixture's
  // journal mode: change `journal_mode`, or have SQLite checkpoint and drop the
  // sidecars on close, and the assertion breaks without the exporter having done
  // anything wrong. Asserting on the destination alone cannot break that way.
  const scratch = mkdtempSync(path.join(tmpdir(), 'e2e-export-dryrun-dest-'));
  ROOTS.push(scratch);
  // Two destinations, so that neither half of "creates nothing" is asserted
  // vacuously: `absent` does not exist at all when the run starts, and `empty`
  // does exist and is empty. One dry run cannot cover both, and asserting only
  // one of them leaves the other untested for no reason.
  const absent = path.join(scratch, 'absent');
  const empty = path.join(scratch, 'empty');
  mkdirSync(empty);
  try {
    assert.equal(existsSync(absent), false, 'the absent destination exists before the run');
    assert.deepEqual(readdirSync(empty), [], 'the empty destination is not empty before the run');

    const r = await run(['--db', f.fx.path, '--vault', absent, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);

    // Destination did not exist -> must still not exist. An implementation that
    // `mkdir -p`s the vault before checking `--dry-run` fails here.
    assert.equal(existsSync(absent), false, `a dry run created ${absent}`);
    assert.deepEqual(allFiles(scratch), [], `a dry run left a file under ${scratch}`);

    // And it must still have done the WORK, not short-circuited: a dry run that
    // skips rendering cannot tell you whether the export would succeed.
    assert.equal(numberFrom(r.stdout, 'db sessions'), f.fx.sessionIds.length);
    assert.equal(numberFrom(r.stdout, 'sessions processed'), f.fx.sessionIds.length);
    assert.equal(numberFrom(r.stdout, 'sessions failed'), 0);
    assert.match(r.stdout, /^dry run: yes$/m);
    assert.equal(numberFrom(r.stdout, 'notes created'), 0);

    // Destination existed and was empty -> must be untouched: no new entries, no
    // files. An implementation that creates the vault but skips the write fails
    // here rather than being waved through.
    const second = await run(['--db', f.fx.path, '--vault', empty, '--dry-run']);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(readdirSync(empty), [], `a dry run created entries under an empty destination`);
    assert.deepEqual(allFiles(empty), [], `a dry run wrote files under an empty destination`);

    // Named explicitly in both cases, because "the vault directory holds no
    // files" and "the two directories the exporter creates for itself are
    // absent" are different claims, and only the first is implied by the second
    // run above when the exporter happened to create nothing at all.
    for (const dest of [absent, empty]) {
      assert.equal(existsSync(conversationsRoot(dest)), false, `a dry run created ${CONVERSATIONS_DIR}/ under ${dest}`);
      assert.equal(existsSync(attachmentsRoot(dest)), false, `a dry run created the attachments directory under ${dest}`);
    }
  } finally {
    f.cleanup();
  }
});

// ---------- 13. no import side effects, and no real path ever used ----------

test('importing the exporter created nothing, and no run in this file touched a real path', () => {
  // The snapshot was taken at MODULE LOAD — after the import of
  // `export-opencode-history.mjs` was evaluated, before any test body ran. If
  // the module had run an export on import, it would have written into the
  // configured real vault and created `05 - Conversations/` there, which this
  // assertion would then see. When this machine configures no real vault the
  // check cannot be made and is skipped; the RUNS assertions below always stay.
  //
  // This asserts the DELTA, not absolute absence. Asserting
  // `existsSync(...) === false` conflated "this file never writes to the real
  // vault" with "the real vault contains no export output" — two different
  // claims. A real, authorised `bun run export:history` makes the second false
  // while the first stays true, so the old form failed for a correct build.
  // The snapshot comparison below is the claim this test actually means, and it
  // holds whether or not a real export has ever been run.
  if (REAL_VAULT !== null && vaultEntriesAtImport !== null) {
    const presentNow = readdirSync(REAL_VAULT).includes(CONVERSATIONS_DIR);
    const presentAtImport = vaultEntriesAtImport.includes(CONVERSATIONS_DIR);
    assert.equal(
      presentNow,
      presentAtImport,
      'the real vault gained or lost the conversations directory during this test run',
    );
    if (!presentAtImport) {
      assert.equal(
        existsSync(REAL_VAULT_CONVERSATIONS),
        false,
        `${REAL_VAULT_CONVERSATIONS} was absent at import time but exists now, so this test created it`,
      );
    }
  }

  // The positive half: this file made real runs, so the check above is not
  // vacuously true because nothing happened at all.
  assert.ok(RUNS.length >= 12, `expected this file to have run the exporter repeatedly, it ran it ${RUNS.length} time(s)`);

  // Every single one of them named a temp database and a temp vault. This is the
  // assertion that makes the discipline above checkable rather than a promise.
  for (const rec of RUNS) {
    assert.ok(rec.db !== null, `a run printed no database line: ${JSON.stringify(rec.argv)}`);
    const dbPath = rec.db.slice('database: '.length);
    assert.notEqual(dbPath, DEFAULT_OPENCODE_DB_PATH, `a run opened the REAL database: ${dbPath}`);
    assert.ok(dbPath.startsWith(tmpdir()), `a run opened a database outside the temp tree: ${dbPath}`);
    assert.ok(rec.vault !== null, `a run printed no vault line: ${JSON.stringify(rec.argv)}`);
    const vaultPath = rec.vault.slice('vault: '.length);
    if (REAL_VAULT !== null) {
      assert.notEqual(vaultPath, REAL_VAULT, `a run wrote to the REAL vault: ${vaultPath}`);
      assert.ok(!vaultPath.startsWith(REAL_VAULT + path.sep), `a run wrote inside the REAL vault: ${vaultPath}`);
    }
    assert.ok(vaultPath.startsWith(tmpdir()), `a run wrote outside the temp tree: ${vaultPath}`);
  }
});

// Backstop. Every test removes its own tree in a `finally`; this exists so a
// test that throws before its cleanup was registered cannot leave a directory
// behind, and so `ROOTS` is not dead weight.
after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
  ROOTS.length = 0;
});