// scripts/export-opencode-history.test.mjs
//
// WHY THE MONEY ASSERTION HERE IS AN mTIME
//
// The vault this exporter writes into is a git repository with `obsidian-git`
// installed, which commits and pushes on a 10-minute timer with nobody watching.
// "The exporter returned `unchanged`" is a claim the exporter makes about itself;
// "the file's mtime did not move" is a fact about the filesystem, and mtime is
// what `git status` looks at. So the idempotency test below ages every file to a
// fixed 2001 date before the second run and asserts the age survived — asserted
// BEFORE the return values, so the timestamp is what fails when a write sneaks
// in. The same discipline covers the attachment files, which are written by
// `extract-attachments.mjs` on a path this script does not control.
//
// NOTHING HERE TOUCHES THE REAL VAULT OR THE REAL DATABASE. Every fixture
// database is built by `buildFixtureDb()` into a fresh `mkdtempSync` under
// `os.tmpdir()`, every vault is a subdirectory of that same temp tree, and every
// `main()` call is given an explicit `--db` and `--vault`. `main(argv, {})` is
// called with an empty env rather than `process.env`, so a stray
// `OPENCODE_EXPORT_VAULT` in the developer's shell cannot redirect a test into
// the real vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';

import {
  main, parseArgs, projectSlug, matchesProjectDir, resolveVaultRoot, defaultVaultRoot,
  VAULT_ENV_VAR, CONVERSATIONS_DIR, ATTACHMENTS_DIRNAME,
} from './export-opencode-history.mjs';
import { buildFixtureDb, FIXTURE_SESSION_IDS, FIXTURE_PROJECT_WORKTREE } from './lib/test-fixture-db.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fixed old date, chosen here in advance rather than read off a clock, so
// "the mtime changed" is a comparison against a number this file decided.
const OLD_MTIME = new Date('2001-01-01T00:00:00.000Z');

// ---------- fixtures ----------

function fixture(tag, opts = {}) {
  const root = mkdtempSync(path.join(tmpdir(), `export-history-${tag}-`));
  const fx = buildFixtureDb(path.join(root, 'opencode.db'), opts);
  return {
    root,
    fx,
    // The destination does NOT exist yet. Several tests assert exactly that
    // after a dry run, so a fixture that pre-created it could not fail.
    vault: path.join(root, 'vault'),
    conversations: path.join(root, 'vault', CONVERSATIONS_DIR),
    attachments: path.join(root, 'vault', CONVERSATIONS_DIR, ATTACHMENTS_DIRNAME),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const cleanup = (f) => f.cleanup();

/** Collect output without touching the real console. */
async function run(argv, env = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, env, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** Every `.md` file under a directory, recursively. Missing directory -> []. */
function mdFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) found.push(p);
    }
  };
  walk(dir);
  return found.sort();
}

/** Every file under a directory, recursively. */
function allFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else found.push(p);
    }
  };
  walk(dir);
  return found.sort();
}

/** The `label: value` number out of a summary line, or null. */
function numberFrom(stdout, label) {
  const m = new RegExp(`^${label}: (\\d+)$`, 'm').exec(stdout);
  return m === null ? null : Number(m[1]);
}

// ---------- 1. end to end ----------

test('a fixture database becomes notes on disk under 05 - Conversations/', async () => {
  const f = fixture('e2e');
  try {
    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--limit', '2']);

    assert.equal(r.code, 0, `export failed: ${r.stderr}`);

    const notes = mdFiles(f.conversations);
    assert.equal(notes.length, 2, `expected 2 notes, got ${notes.length}: ${notes.join(', ')}`);

    // The directory layout is part of the contract, so it is asserted by name
    // rather than merely "a .md file exists somewhere under the vault".
    for (const note of notes) {
      assert.ok(
        path.relative(f.vault, note).startsWith(`${CONVERSATIONS_DIR}/`),
        `${note} is not under ${CONVERSATIONS_DIR}/`,
      );
      assert.ok(note.endsWith('.md'), 'a note without a .md extension is not one Obsidian will index');
    }

    // The two sessions `--limit 2` selected, in `time_created ASC` order.
    for (const id of FIXTURE_SESSION_IDS.slice(0, 2)) {
      const hit = notes.find((p) => p.includes(id));
      assert.ok(hit, `no note for session ${id}; got ${notes.join(', ')}`);
      const body = readFileSync(hit, 'utf8');
      assert.ok(body.length > 0, `the note for ${id} is empty`);
      assert.ok(body.includes(id), `the note for ${id} does not name it; AC-1/AC-2 depend on that`);
      assert.ok(body.startsWith('---\n'), 'a note without frontmatter cannot carry its session id');
      assert.ok(body.includes('# '), 'the rendered note has no heading at all');
    }

    assert.equal(numberFrom(r.stdout, 'sessions discovered'), 3);
    assert.equal(numberFrom(r.stdout, 'sessions selected'), 2);
    assert.equal(numberFrom(r.stdout, 'sessions processed'), 2);
    assert.equal(numberFrom(r.stdout, 'notes created'), 2);
  } finally {
    cleanup(f);
  }
});

test('the note filename carries the date, a slug and the bracketed session id', async () => {
  const f = fixture('filename');
  try {
    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--limit', '1']);
    assert.equal(r.code, 0, r.stderr);

    const [name] = mdFiles(f.conversations).map((p) => path.basename(p));
    assert.ok(name, 'no note was written');
    assert.match(name, /^\d{4}-\d{2}-\d{2} - .+ \[ses_fixture_titled\]\.md$/, `unexpected filename: ${name}`);
    // Under a project slug derived from the session's `directory`, not the repo.
    const dir = path.basename(path.dirname(mdFiles(f.conversations)[0]));
    assert.equal(dir, projectSlug(FIXTURE_PROJECT_WORKTREE));
    assert.equal(dir, 'fixture-project-a');
  } finally {
    cleanup(f);
  }
});

test('an untitled session falls back to its first prompt and still gets a unique filename', async () => {
  const f = fixture('untitled');
  try {
    const r = await run(['--db', f.fx.path, '--vault', f.vault]);
    assert.equal(r.code, 0, r.stderr);
    const notes = mdFiles(f.conversations);
    assert.equal(notes.length, 3, 'every session must produce a note (AC-1)');

    // FIXTURE_SESSION_IDS[1] is the `title IS NULL` row. 36 of the 1009 real
    // sessions are untitled, so this is a normal path, not an error path.
    const untitled = notes.find((p) => p.includes(FIXTURE_SESSION_IDS[1]));
    assert.ok(untitled, `no note for the untitled session: ${notes.join(', ')}`);
    const body = readFileSync(untitled, 'utf8');
    assert.ok(body.includes('Summarise the fixture project.'), 'the first user prompt was not used as the fallback title');

    // No two notes may land on one path: two sessions with identical titles
    // would otherwise eat each other on the next run.
    assert.equal(new Set(notes).size, notes.length);
  } finally {
    cleanup(f);
  }
});

// ---------- 2. AC-7: attachments become files, base64 never reaches a note ----------

test('an inline base64 attachment becomes a real file and no note carries the payload', async () => {
  const f = fixture('attachments');
  try {
    const r = await run(['--db', f.fx.path, '--vault', f.vault]);
    assert.equal(r.code, 0, r.stderr);

    const written = allFiles(f.attachments);
    assert.equal(written.length, 1, `expected one attachment file, got ${written.map((p) => path.basename(p)).join(', ')}`);
    assert.ok(written[0].endsWith('.png'), 'the extension must come from the magic bytes, not the log name');
    // A real 1x1 PNG: the PNG magic, so the sniff did not fall through to .bin.
    assert.ok(readFileSync(written[0]).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));

    const withAttachment = mdFiles(f.conversations).find((p) => p.includes(FIXTURE_SESSION_IDS[2]));
    assert.ok(withAttachment, 'the session carrying the attachment produced no note');
    const body = readFileSync(withAttachment, 'utf8');
    assert.ok(body.includes(`![[${CONVERSATIONS_DIR}/${ATTACHMENTS_DIRNAME}/`), `the note does not embed the file: ${body.slice(0, 400)}`);

    // AC-7. The payload magic is the string to look for, because the real one is
    // megabytes long and this fixture's is one base64 line.
    for (const note of mdFiles(f.conversations)) {
      const text = readFileSync(note, 'utf8');
      assert.ok(!text.includes('iVBORw0KGgo'), `${note} carries an inline base64 blob (AC-7)`);
    }
  } finally {
    cleanup(f);
  }
});

// ---------- 3. --dry-run writes nothing at all ----------

test('--dry-run prints the counts and creates no directory and no file', async () => {
  const f = fixture('dry-run');
  try {
    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--dry-run']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(f.vault), false, 'the vault directory was created by a dry run');
    assert.equal(existsSync(f.conversations), false, `${CONVERSATIONS_DIR}/ was created by a dry run`);
    assert.equal(existsSync(f.attachments), false, `${ATTACHMENTS_DIRNAME}/ was created by a dry run`);
    assert.deepEqual(mdFiles(f.vault), []);

    // The dry run is what keeps T9/T10 cheap, so it must still do the work of
    // resolving sessions and redacting — only the writes are skipped.
    assert.equal(numberFrom(r.stdout, 'sessions discovered'), 3);
    assert.equal(numberFrom(r.stdout, 'sessions selected'), 3);
    assert.equal(numberFrom(r.stdout, 'sessions processed'), 3);
    assert.match(r.stdout, /^dry run: yes$/m);
    // Every pattern is reported, including the ones that found nothing, so a
    // report cannot be read as "no patterns ran".
    assert.match(r.stdout, /^redacted github-token: 0$/m);
  } finally {
    cleanup(f);
  }
});

test('--dry-run over a vault that already exists still leaves it byte-identical', async () => {
  const f = fixture('dry-run-existing');
  try {
    await run(['--db', f.fx.path, '--vault', f.vault]);
    const notes = mdFiles(f.conversations);
    assert.equal(notes.length, 3);
    const aged = notes.map(() => OLD_MTIME);
    notes.forEach((p, i) => utimesSync(p, aged[i], aged[i]));
    const before = notes.map((p) => statSync(p).mtimeMs);

    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(notes.map((p) => statSync(p).mtimeMs), before, 'a dry run touched the vault');
  } finally {
    cleanup(f);
  }
});

// ---------- 3b. the completion line must tell the truth about a dry run ----------
//
// WHY THESE FOUR EXIST
//
// A dry run used to end with `✅ nothing to write: every note was already up to
// date.` That sentence was FALSE, and false in the specific way a summary is
// worst at: it described a check that never happened. A dry run writes nothing,
// so created/written/unchanged are all 0 by construction — 0 because nothing was
// compared, not because everything matched. Keying the completion line off that
// zero printed a confident claim on top of an absence of evidence.
//
// The message is now `✅ dry run: N session(s) rendered, nothing written.`, and
// nothing was checking that it stayed that way. These tests are the check.

test('a dry run never claims the notes were already up to date', async () => {
  const f = fixture('dry-run-claim');
  try {
    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);

    // Both halves of the old sentence, asserted separately so the failure says
    // which one came back.
    const said = `${r.stdout}\n${r.stderr}`;
    assert.equal(said.includes('already up to date'), false, `a dry run claimed the notes were up to date:\n${said}`);
    assert.equal(said.includes('nothing to write'), false, `a dry run used the "nothing to write" wording:\n${said}`);

    // What it says instead: the one thing a dry run actually knows, which is how
    // much it rendered.
    assert.match(said, /^✅ dry run: \d+ session\(s\) rendered, nothing written\.$/m, `the dry run completion line is missing:\n${said}`);
    assert.equal(numberFrom(r.stdout, 'sessions processed'), 3, 'the dry run rendered nothing, so the line above is hollow');
  } finally {
    cleanup(f);
  }
});

test('a dry run writes nothing, which is why it must not claim the notes matched', async () => {
  const f = fixture('dry-run-writes-nothing');
  try {
    assert.equal(existsSync(f.vault), false, 'the fixture must start with no vault at all');

    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);

    // The behaviour the message describes. Asserted next to the message assertion
    // above so the two cannot drift apart: if a future change made the dry run
    // write something, "nothing written" would be the false claim instead.
    assert.equal(existsSync(f.vault), false, 'the dry run created the vault');
    assert.deepEqual(allFiles(f.vault), [], 'the dry run left files in the vault');
    assert.equal(numberFrom(r.stdout, 'notes created'), 0);
    assert.equal(numberFrom(r.stdout, 'notes written'), 0);
    // Zero for the trivial reason, not the reported one: `unchanged` is what a
    // real comparison produces, and this run compared nothing.
    assert.equal(numberFrom(r.stdout, 'notes unchanged'), 0);
    assert.match(r.stdout, /^dry run: yes$/m, 'and it admits to being the reason');
  } finally {
    cleanup(f);
  }
});

test('a real second run over an unchanged vault DOES say every note was up to date', async () => {
  const f = fixture('uptodate-real');
  try {
    const first = await run(['--db', f.fx.path, '--vault', f.vault]);
    assert.equal(first.code, 0, first.stderr);

    // The first run wrote, so it must not be the run that says nothing changed.
    const firstSaid = `${first.stdout}\n${first.stderr}`;
    assert.equal(firstSaid.includes('already up to date'), false, `the first run claimed the notes were up to date:\n${firstSaid}`);
    assert.match(firstSaid, /^✅ 3 note\(s\) written, 0 unchanged\.$/m, `the first run did not report writing:\n${firstSaid}`);

    const second = await run(['--db', f.fx.path, '--vault', f.vault]);
    assert.equal(second.code, 0, second.stderr);

    // Here the claim is earned: 3 notes were really compared against the 3 on
    // disk and 0 of them differed. This test exists so the dry-run fix cannot be
    // satisfied by deleting the message — the honest summary of an unchanged
    // vault is still the one worth printing.
    const secondSaid = `${second.stdout}\n${second.stderr}`;
    assert.match(secondSaid, /^✅ nothing to write: every note was already up to date\.$/m, `the second run did not report the notes as up to date:\n${secondSaid}`);
    assert.equal(numberFrom(second.stdout, 'notes written'), 0, 'a second run reported a write over unchanged bytes');
    assert.equal(numberFrom(second.stdout, 'notes created'), 0);
    assert.equal(numberFrom(second.stdout, 'notes unchanged'), 3, 'the zero written must come from 3 real comparisons, not from skipping them');
  } finally {
    cleanup(f);
  }
});

test('a real first run reports writing, and never claims the notes were up to date', async () => {
  const f = fixture('first-run-not-uptodate');
  try {
    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--limit', '1']);
    assert.equal(r.code, 0, r.stderr);

    const said = `${r.stdout}\n${r.stderr}`;
    assert.match(said, /^✅ 1 note\(s\) written, 0 unchanged\.$/m, `the first run did not report the write:\n${said}`);
    assert.equal(said.includes('already up to date'), false, `a run that wrote a note claimed the notes were up to date:\n${said}`);
    // Same wording guard as the dry run, for the same reason: `nothing to write`
    // is the other way this false claim can be spelled.
    assert.equal(said.includes('nothing to write'), false, `a run that wrote a note said there was nothing to write:\n${said}`);
  } finally {
    cleanup(f);
  }
});

// ---------- 4. --limit ----------

test('--limit 0 processes nothing and writes nothing', async () => {
  const f = fixture('limit-zero');
  try {
    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--limit', '0']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(numberFrom(r.stdout, 'sessions discovered'), 3, 'the row count is still reported');
    assert.equal(numberFrom(r.stdout, 'sessions selected'), 0);
    assert.equal(numberFrom(r.stdout, 'sessions processed'), 0);
    assert.equal(numberFrom(r.stdout, 'notes created'), 0);
    assert.equal(existsSync(f.vault), false, '--limit 0 still created the vault directory');
  } finally {
    cleanup(f);
  }
});

test('--limit 2 on a three-session fixture writes at most two notes', async () => {
  const f = fixture('limit-two');
  try {
    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--limit', '2']);
    assert.equal(r.code, 0, r.stderr);

    const notes = mdFiles(f.conversations);
    assert.equal(notes.length, 2);
    // The limit takes the OLDEST sessions, because `listSessions` already orders
    // by time_created and slicing an unsorted list would export a random subset.
    assert.ok(notes.some((p) => p.includes(FIXTURE_SESSION_IDS[0])));
    assert.ok(notes.some((p) => p.includes(FIXTURE_SESSION_IDS[1])));
    assert.equal(notes.some((p) => p.includes(FIXTURE_SESSION_IDS[2])), false, 'the third session slipped past --limit 2');
  } finally {
    cleanup(f);
  }
});

// ---------- 5. AC-8: idempotency, proven with timestamps ----------

test('re-running over an unchanged database writes zero files (AC-8)', async () => {
  const f = fixture('idempotent');
  try {
    const first = await run(['--db', f.fx.path, '--vault', f.vault]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(numberFrom(first.stdout, 'notes created'), 3);

    // Age every note AND every attachment. Attachment files are written by
    // extract-attachments.mjs, which this script does not own, so they are the
    // place a "zero files written" claim is most likely to be quietly false.
    const notes = mdFiles(f.conversations);
    const attachments = allFiles(f.attachments);
    assert.equal(notes.length, 3);
    assert.equal(attachments.length, 1);
    const aged = [OLD_MTIME.getTime() / 1000, OLD_MTIME.getTime() / 1000];
    for (const p of [...notes, ...attachments]) utimesSync(p, aged[0], aged[1]);

    const mtimesBefore = [...notes, ...attachments].map((p) => statSync(p).mtimeMs);
    assert.deepEqual(mtimesBefore, new Array(4).fill(OLD_MTIME.getTime()), 'the fixture aging did not take');

    const second = await run(['--db', f.fx.path, '--vault', f.vault]);
    const mtimesAfter = [...notes, ...attachments].map((p) => statSync(p).mtimeMs);

    // Timestamps asserted BEFORE the counts, for the same reason as in
    // sync-writer.test.mjs: a count is a claim, an mtime is the evidence.
    assert.deepEqual(mtimesAfter, mtimesBefore, 'the second run rewrote a file with identical bytes');
    assert.equal(numberFrom(second.stdout, 'notes created'), 0);
    assert.equal(numberFrom(second.stdout, 'notes written'), 0);
    assert.equal(numberFrom(second.stdout, 'notes unchanged'), 3);
    assert.equal(numberFrom(second.stdout, 'attachments created'), 0, 'an attachment was rewritten from scratch');
  } finally {
    cleanup(f);
  }
});

test('a genuine edit is still written, so "unchanged" is not just a constant', async () => {
  const f = fixture('idempotent-control');
  try {
    await run(['--db', f.fx.path, '--vault', f.vault, '--limit', '1']);
    const [note] = mdFiles(f.conversations);
    assert.ok(note);
    writeFileSync(note, '# hand-edited by the user\n');

    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--limit', '1']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(numberFrom(r.stdout, 'notes written'), 1, 'a user edit was overwritten without being counted as a write');
    assert.equal(numberFrom(r.stdout, 'notes unchanged'), 0);
    assert.equal(readFileSync(note, 'utf8').includes('hand-edited by the user'), false, 'the exporter did not win, which is correct');
  } finally {
    cleanup(f);
  }
});

// ---------- 6. redaction end to end ----------

test('a planted secret is redacted out of the note and counted in the summary', async () => {
  const f = fixture('redaction');
  try {
    // Built from fragments so this file does not contain a literal that a secret
    // scanner would flag, and so the test fails for a redaction reason rather
    // than for "the fixture already contained it".
    const secret = ['gh', 'p', '_', 'Ab3dEf5h'.repeat(4)].join('');
    assert.match(secret, /^gh[pousr]_[A-Za-z0-9]{20,}$/, 'the planted value does not match the github-token pattern');

    const db = new Database(f.fx.path);
    try {
      const rows = db
        .query(`SELECT id, data FROM session_message WHERE session_id = ? AND type = 'user'`)
        .all(FIXTURE_SESSION_IDS[0]);
      assert.equal(rows.length, 1, 'the fixture should have exactly one user message to plant into');
      for (const row of rows) {
        const data = JSON.parse(row.data);
        data.text = `${data.text}\n\nmy deploy key is ${secret} if you need it`;
        db.run('UPDATE session_message SET data = ? WHERE id = ?', [JSON.stringify(data), row.id]);
      }
    } finally {
      db.close();
    }

    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--limit', '1']);
    assert.equal(r.code, 0, r.stderr);

    const [note] = mdFiles(f.conversations);
    assert.ok(note, 'no note was written');
    const body = readFileSync(note, 'utf8');
    assert.ok(!body.includes(secret), 'the secret reached the note');
    assert.ok(body.includes('[REDACTED:github-token]'), 'the redaction marker is not in the note');

    // The count is reported per pattern and is non-zero, because a redactor that
    // fires but reports nothing has told the operator nothing.
    const line = /^redacted github-token: (\d+)$/m.exec(r.stdout);
    assert.ok(line, `the summary does not report github-token:\n${r.stdout}`);
    assert.ok(Number(line[1]) >= 1, `github-token count was ${line[1]}`);

    // Every pattern is listed, so an operator can see which rules exist and not
    // only which ones fired.
    for (const pattern of ['aws-access-key-id', 'github-token', 'jwt', 'bearer-token', 'totp-code', 'generic-secret-assignment']) {
      assert.match(r.stdout, new RegExp(`^redacted ${pattern}: \\d+$`, 'm'), `the summary omits ${pattern}`);
    }
  } finally {
    cleanup(f);
  }
});

// ---------- 7. --project-dir ----------

test('--project-dir matching nothing writes no notes and exits 0', async () => {
  const f = fixture('project-none');
  try {
    const r = await run([
      '--db', f.fx.path, '--vault', f.vault,
      '--project-dir', '/definitely/not/a/real/worktree',
    ]);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(numberFrom(r.stdout, 'sessions discovered'), 3);
    assert.equal(numberFrom(r.stdout, 'sessions matched'), 0, 'a filter that excludes everything must say so');
    assert.equal(numberFrom(r.stdout, 'sessions processed'), 0);
    assert.deepEqual(mdFiles(f.vault), []);
    assert.equal(existsSync(f.vault), false, 'a run with nothing to export created the vault directory');
  } finally {
    cleanup(f);
  }
});

test('--project-dir selects only the sessions whose directory is inside it', async () => {
  const f = fixture('project-some');
  try {
    const r = await run(['--db', f.fx.path, '--vault', f.vault, '--project-dir', FIXTURE_PROJECT_WORKTREE]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(numberFrom(r.stdout, 'sessions matched'), 3);
    assert.equal(mdFiles(f.conversations).length, 3);
    assert.match(r.stdout, /^project-dir: .*fixture\/project-a$/m);
  } finally {
    cleanup(f);
  }
});

test('matchesProjectDir is exact or a parent, never a string prefix', () => {
  // `/fixture/project-ab` STARTS WITH the string `/fixture/project-a` but is a
  // different worktree. A `startsWith` filter would export the wrong project.
  assert.equal(matchesProjectDir('/fixture/project-a', '/fixture/project-a'), true);
  assert.equal(matchesProjectDir('/fixture/project-a/src', '/fixture/project-a'), true);
  assert.equal(matchesProjectDir('/fixture/project-ab', '/fixture/project-a'), false);
  assert.equal(matchesProjectDir('/fixture/project-a', '/fixture/project-a/'), true, 'a trailing slash must not break the match');
  assert.equal(matchesProjectDir('/fixture/project-a', '/fixture/project-a/src'), false, 'a child worktree is not its parent');
  assert.equal(matchesProjectDir(null, '/fixture/project-a'), false);
  assert.equal(matchesProjectDir('/fixture/project-a', null), true, 'no filter matches everything');
});

// ---------- 8. a bad session is skipped, not fatal ----------

/**
 * Corrupt the timestamp of N sessions in place.
 *
 * `time_created` is `NOT NULL`, so a bad value cannot be NULL — it has to be a
 * non-numeric string, which SQLite stores happily in an INTEGER column because
 * of type affinity. That is also the realistic shape of the failure: a row that
 * some earlier tool wrote, not an empty id, which would fail on the primary key
 * before it ever reached the exporter.
 */
function corruptTimestamps(dbPath, count) {
  const db = new Database(dbPath);
  try {
    const ids = db.query('SELECT id FROM session_v2 ORDER BY time_created ASC, id ASC LIMIT ?').all(count);
    assert.equal(ids.length, count, 'the fixture does not have enough sessions to corrupt');
    for (const row of ids) {
      db.run('UPDATE session_v2 SET time_created = ? WHERE id = ?', ['not-a-timestamp', row.id]);
    }
    return ids.map((r) => r.id);
  } finally {
    db.close();
  }
}

test('one unnameable session is skipped, reported, and the run still exits 0', async () => {
  const f = fixture('one-bad', { sessionIds: ['ses_ok_one', 'ses_ok_two', 'ses_ok_three'] });
  try {
    corruptTimestamps(f.fx.path, 1);

    const r = await run(['--db', f.fx.path, '--vault', f.vault]);

    assert.equal(r.code, 0, `one bad session must not fail the run: ${r.stderr}`);
    assert.match(r.stderr, /timeCreated is required/, `the failure was not reported with a reason: ${r.stderr}`);
    assert.equal(numberFrom(r.stdout, 'sessions failed'), 1);
    assert.equal(numberFrom(r.stdout, 'sessions processed'), 2);
    assert.equal(mdFiles(f.conversations).length, 2, 'the two good sessions must still be exported');
  } finally {
    cleanup(f);
  }
});

test('more than half the sessions failing exits non-zero rather than mirroring half a history', async () => {
  const f = fixture('most-bad', { sessionIds: ['ses_ok_one', 'ses_ok_two', 'ses_ok_three'] });
  try {
    corruptTimestamps(f.fx.path, 2);

    const r = await run(['--db', f.fx.path, '--vault', f.vault]);

    assert.notEqual(r.code, 0, 'a run that exported 1 of 3 sessions reported success');
    assert.equal(numberFrom(r.stdout, 'sessions failed'), 2);
    assert.equal(numberFrom(r.stdout, 'sessions processed'), 1, 'the one good session was still rendered');
    assert.match(r.stderr, /more than half/);
    // The buffered decision: a partial mirror presented as a complete one is
    // worse than no mirror, so nothing at all is written.
    assert.equal(existsSync(f.vault), false, 'a mostly-failed run still wrote to the vault');
  } finally {
    cleanup(f);
  }
});

// ---------- 9. usage ----------

test('--help exits 0 and prints the usage', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage:/);
  for (const flag of ['--dry-run', '--limit', '--vault', '--db', '--project-dir']) {
    assert.ok(r.stdout.includes(flag), `the usage does not document ${flag}`);
  }
});

test('an unknown flag exits non-zero and names the flag', async () => {
  const r = await run(['--not-a-flag', 'x']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /unknown flag/);
  assert.match(r.stderr, /--not-a-flag/);
});

test('a flag that needs a value and does not get one is a usage error, not a crash', async () => {
  const r = await run(['--vault']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--vault/);
});

test('a non-numeric --limit is refused instead of silently becoming NaN', async () => {
  const r = await run(['--limit', 'many']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--limit/);
});

// ---------- 10. a vault path containing a space, end to end ----------

test('a vault whose own name contains a space works end to end', async () => {
  // The real vault is "Dokumen/Obsidian Vault". Any argv handling that splits on
  // spaces would shred this name, and the failure would look like a missing
  // note rather than a mis-parsed flag.
  const root = mkdtempSync(path.join(tmpdir(), 'vault with space-'));
  try {
    const fx = buildFixtureDb(path.join(root, 'opencode.db'));
    const vault = path.join(root, 'Obsidian Vault');
    assert.ok(vault.includes(' '), 'the fixture vault name must contain a space for this test to mean anything');

    const r = await run(['--db', fx.path, '--vault', vault, '--limit', '1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^vault: .*Obsidian Vault$/m);

    const notes = mdFiles(path.join(vault, CONVERSATIONS_DIR));
    assert.equal(notes.length, 1, `the note did not land inside "${vault}"`);
    assert.ok(notes[0].startsWith(vault + path.sep), `${notes[0]} escaped the vault directory`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveVaultRoot prefers the flag, then the environment', () => {
  assert.equal(resolveVaultRoot({}, '/tmp/flag'), '/tmp/flag');
  assert.equal(resolveVaultRoot({ [VAULT_ENV_VAR]: '/tmp/env' }, '/tmp/flag'), '/tmp/flag');
  assert.equal(resolveVaultRoot({ [VAULT_ENV_VAR]: '/tmp/env' }, null), '/tmp/env');
});

// ---------- 10b. the default vault is configured at call time, not hard-coded ----------

/**
 * Run `fn` with OPENCODE_EXPORT_VAULT set or cleared, restoring whatever the
 * shell had afterwards. The tests below exercise the configured default, so
 * they set `process.env` explicitly and clean up: a value leaked into the
 * environment could redirect a later test into someone's real vault.
 */
function withVaultEnv(value, fn) {
  const prev = process.env[VAULT_ENV_VAR];
  if (value === undefined) delete process.env[VAULT_ENV_VAR];
  else process.env[VAULT_ENV_VAR] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[VAULT_ENV_VAR];
    else process.env[VAULT_ENV_VAR] = prev;
  }
}

test('the default vault comes from the environment before local.config.json', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'export-history-vault-env-'));
  try {
    const configPath = path.join(root, 'local.config.json');
    writeFileSync(configPath, JSON.stringify({ vaultRoot: '/cfg/vault-from-config' }), 'utf8');
    withVaultEnv('/env/vault-from-env', () => {
      assert.equal(defaultVaultRoot(configPath), '/env/vault-from-env');
      assert.equal(resolveVaultRoot({}, null, configPath), '/env/vault-from-env');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the default vault falls back to local.config.json "vaultRoot" when the environment is silent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'export-history-vault-config-'));
  try {
    const configPath = path.join(root, 'local.config.json');
    writeFileSync(configPath, JSON.stringify({ vaultRoot: '/cfg/vault-from-config' }), 'utf8');
    withVaultEnv(undefined, () => {
      // A blank env entry is not a vault either: it falls through exactly like
      // an absent one, for the same reason a blank shell value must not select
      // a real vault by accident.
      assert.equal(defaultVaultRoot(configPath), '/cfg/vault-from-config');
      assert.equal(resolveVaultRoot({ [VAULT_ENV_VAR]: '   ' }, null, configPath), '/cfg/vault-from-config');
      assert.equal(resolveVaultRoot({}, null, configPath), '/cfg/vault-from-config');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with no environment and no config the default vault throws, naming the env var and the example file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'export-history-vault-missing-'));
  try {
    // The config path points inside a directory that does not exist, so this
    // test cannot depend on whether this checkout happens to carry its own
    // local.config.json.
    const configPath = path.join(root, 'absent', 'local.config.json');
    withVaultEnv(undefined, () => {
      assert.throws(() => defaultVaultRoot(configPath), (err) => {
        assert.match(err.message, /OPENCODE_EXPORT_VAULT/);
        assert.match(err.message, /local\.config\.example\.json/);
        return true;
      });
      assert.throws(() => resolveVaultRoot({}, null, configPath), /OPENCODE_EXPORT_VAULT/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('importing the module resolves no default vault', () => {
  // A child process with the env var stripped: if the default were resolved at
  // module load, the import itself would throw on a machine that configures no
  // vault (this checkout has no local.config.json, and the var is gone here).
  const env = { ...process.env };
  delete env[VAULT_ENV_VAR];
  const proc = Bun.spawnSync({
    cmd: ['bun', '--eval', "await import('./scripts/export-opencode-history.mjs');"],
    cwd: REPO_ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = proc.stderr.toString();
  assert.equal(proc.exitCode, 0, `importing the module failed: ${stderr}`);
  assert.equal(stderr, '');
});

test('parseArgs keeps a spaced value intact and never splits on it', () => {
  const opts = parseArgs(['--vault', '/home/me/Obsidian Vault', '--limit', '3', '--dry-run', '--db', '/tmp/a b.db']);
  assert.equal(opts.vault, '/home/me/Obsidian Vault');
  assert.equal(opts.limit, 3);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.db, '/tmp/a b.db');
});

test('projectSlug reduces a worktree to one safe directory segment', () => {
  assert.equal(projectSlug('/home/testuser'), 'home-testuser');
  assert.equal(projectSlug('/fixture/project-a'), 'fixture-project-a');
  assert.equal(projectSlug('/'), 'root', 'the filesystem root has no name left to slug');
  assert.equal(projectSlug(''), 'unknown-project');
  assert.equal(projectSlug(null), 'unknown-project');
  // Never a traversal, never a separator: this string is joined onto the vault.
  assert.equal(projectSlug('/a/../../etc').includes('/'), false);
  assert.equal(projectSlug('/a/../../etc').includes('..'), false);
});

// ---------- 11. a missing database fails loudly ----------

test('a missing --db path fails loudly and does not create an empty database', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'export-history-missing-db-'));
  try {
    const missing = path.join(root, 'no-such-dir', 'opencode.db');
    const vault = path.join(root, 'vault');
    const r = await run(['--db', missing, '--vault', vault]);

    assert.notEqual(r.code, 0, 'a missing database reported success');
    assert.equal(existsSync(missing), false, 'the exporter created the database it was asked to read');
    assert.match(r.stderr, /no-such-dir/, `the error does not name the path: ${r.stderr}`);
    assert.match(r.stderr, /database/i);
    assert.equal(existsSync(vault), false, 'a failed run still touched the vault');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a database that is not a database is reported, not treated as empty', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'export-history-garbage-db-'));
  try {
    const junk = path.join(root, 'opencode.db');
    writeFileSync(junk, 'this is not a sqlite file\n');
    const r = await run(['--db', junk, '--vault', path.join(root, 'vault')]);
    assert.notEqual(r.code, 0, 'a corrupt database reported success; 0 sessions would read like a real answer');
    assert.match(r.stderr, /database/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 12. no side effects on import ----------

test('importing the module does not run an export', () => {
  // A child process, because "importing did nothing" cannot be observed from
  // inside a module that has already been imported. If the CLI guard were wrong
  // this child would open the real 454 MB database.
  const proc = Bun.spawnSync({
    cmd: ['bun', '--eval', "await import('./scripts/export-opencode-history.mjs');"],
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  assert.equal(proc.exitCode, 0, `importing the module failed: ${stderr}`);
  assert.ok(!stdout.includes('sessions discovered'), `importing ran the export:\n${stdout}`);
  assert.ok(!stdout.includes('usage:'), `importing ran the CLI:\n${stdout}`);
  assert.equal(stderr, '', `importing wrote to stderr:\n${stderr}`);
});

test('the vault default is configured, never hard-coded', () => {
  // Documentation as an assertion: the env var name is the contract shared with
  // the usage text and with anyone's shell alias, and the default is a function
  // resolved at call time, never a path baked into this module. Every test above
  // still passes both --db and --vault, and an empty env to main(), so no test
  // can be redirected into whatever this machine has configured.
  assert.equal(VAULT_ENV_VAR, 'OPENCODE_EXPORT_VAULT');
  assert.equal(typeof defaultVaultRoot, 'function');
  assert.equal(CONVERSATIONS_DIR, '05 - Conversations');
  assert.equal(ATTACHMENTS_DIRNAME, '.attachments');
});
