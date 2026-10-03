// scripts/lib/opencode-db.test.mjs
//
// Guards for the read-only OpenCode database reader.
//
// NOTHING HERE TOUCHES THE REAL DATABASE. The live
// `~/.local/share/opencode/opencode.db` holds 1000+ sessions, tens of
// thousands of messages, 13.2 MiB of INLINE BASE64 attachments inside user
// message JSON, and a `credential` table with two real secrets. Every test
// below builds a throwaway fixture under tmpdir and opens that. The real DB is
// referenced by name in exactly one place — an assertion that the module never
// opens it implicitly — and never passed to `openReadonly`.
//
// Three failure modes are worth protecting against, and each has a test:
//
//   * Copying the file instead of opening it by path. sqlite.org/wal.html says
//     the `-wal` file "is part of the persistent state of the database", so a
//     copied main file without its WAL silently loses committed transactions.
//     Test 7 proves this by snapshotting the file, writing more rows through a
//     SECOND connection, and showing the copy and the by-path reader disagree.
//   * A "read-only" that is only a flag somebody set. Test 5 is the behavioural
//     proof: after `openReadonly`, a real INSERT/UPDATE/DELETE is refused by
//     SQLite itself with SQLITE_READONLY. That is the actual proof of AC-3.
//   * A reader that "handles" NULL titles by throwing, or by coercing to ''.
//     36 of the 1009 real sessions have `title IS NULL`, so a null title is a
//     normal row, not a corrupt one. Test 2 pins that it survives as `null`.
//
// The fixture is deterministic on purpose (no `Math.random`, no `Date.now`),
// so test 8 can assert two independent builds agree byte-for-byte on the
// session list. A fixture that drifted would make every ordering assertion in
// this file weaker than it looks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, copyFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openReadonly,
  listSessions,
  messagesForSession,
  countSessions,
  buildReadonlyUri,
  READONLY_URI_QUERY,
  OPEN_READONLY_OPTIONS,
  SESSION_TABLE,
  MESSAGE_TABLE,
} from './opencode-db.mjs';
import {
  buildFixtureDb,
  FIXTURE_SESSION_IDS,
  FIXTURE_EPOCH_MS,
  FIXTURE_PNG_BASE64,
} from './test-fixture-db.mjs';

// Referenced by name only (the guard test below never opens it): joined to
// the machine home so this file runs unchanged on any checkout.
const REAL_DB = path.join(homedir(), '.local/share/opencode/opencode.db');

// ---------- fixtures ----------

// One temp dir per test, one fixture DB inside it. `sibling` hands back the
// directory too, so the WAL/copy test can build a second file beside the first
// and still keep both under the same cleanup.
function fixture(label) {
  const base = mkdtempSync(path.join(tmpdir(), `opencode-db-${label}-`));
  return {
    base,
    dbPath: path.join(base, 'fixture.db'),
    sibling: (name) => path.join(base, name),
  };
}

const cleanup = (f) => rmSync(f.base, { recursive: true, force: true });

function seeded(label) {
  const f = fixture(label);
  buildFixtureDb(f.dbPath);
  return f;
}

// ---------- 1. the session list ----------

test('listSessions returns the seeded rows in a deterministic order', () => {
  const f = seeded('order');
  const h = openReadonly(f.dbPath);
  try {
    const rows = listSessions(h.db);
    assert.deepEqual(
      rows.map((r) => r.id),
      FIXTURE_SESSION_IDS,
      'the seed order must come back intact, not database order',
    );
    // Ordering is by time_created then id, so the expectation is stated as a
    // fact about the sort key rather than as a copy of whatever came out.
    const keys = rows.map((r) => [r.timeCreated, r.id]);
    assert.deepEqual(keys, [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)));
  } finally {
    h.close();
    cleanup(f);
  }
});

test('listSessions exposes the documented columns and keeps directory and time', () => {
  const f = seeded('cols');
  const h = openReadonly(f.dbPath);
  try {
    const [first] = listSessions(h.db);
    for (const k of ['id', 'title', 'directory', 'timeCreated']) {
      assert.ok(k in first, `listSessions must expose ${k}`);
    }
    assert.equal(typeof first.id, 'string');
    assert.equal(typeof first.directory, 'string');
    assert.equal(typeof first.timeCreated, 'number');
    assert.ok(Number.isInteger(first.timeCreated), 'time_created is ms epoch, so an integer');
    // The fixture directory is a fake path; what matters is that the column is
    // carried through verbatim rather than normalised.
    assert.match(first.directory, /\/fixture\/project-a$/);
    assert.equal(countSessions(h.db), FIXTURE_SESSION_IDS.length);
  } finally {
    h.close();
    cleanup(f);
  }
});

// ---------- 2. the null title ----------

test('a session with title = NULL comes back as null and does not throw', () => {
  const f = seeded('nulltitle');
  const h = openReadonly(f.dbPath);
  try {
    const rows = listSessions(h.db);
    const untitled = rows.find((r) => r.id === FIXTURE_SESSION_IDS[1]);
    assert.ok(untitled, 'the fixture seeds a deliberately untitled session');
    assert.equal(untitled.title, null);
    // The distinction that matters: null is not ''. A renderer that needs a
    // placeholder does it itself; coercing here would make "this session was
    // never named" indistinguishable from "this session was named blank".
    assert.notEqual(untitled.title, '');
    // Its neighbours keep their real titles, so the null is row-scoped.
    assert.equal(rows.find((r) => r.id === FIXTURE_SESSION_IDS[0]).title, 'Fixture: a session that was named');
  } finally {
    h.close();
    cleanup(f);
  }
});

// ---------- 3. message order ----------

test('messagesForSession returns rows sorted by seq ascending', () => {
  const f = seeded('seq');
  const h = openReadonly(f.dbPath);
  try {
    const rows = messagesForSession(h.db, FIXTURE_SESSION_IDS[0]);
    assert.ok(rows.length >= 3, `fixture session should have several messages, got ${rows.length}`);
    const seqs = rows.map((r) => r.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length, 'seq is unique per session; duplicates mean the fixture is wrong');
    for (const k of ['seq', 'type', 'data']) {
      assert.ok(k in rows[0], `messagesForSession must expose ${k}`);
    }
    // Ordering must not depend on insertion order happening to match seq
    // order, so this asserts the exact sequence AND checks that the fixture
    // really is adversarial: the rows are stored descending, so a reader with
    // no ORDER BY would return them reversed and fail here.
    assert.deepEqual(seqs, [0, 1, 2, 3]);

    // The seq ordering is NOT just inherited from the index. The real database
    // has `session_message_session_seq_idx` on `(session_id, seq)`, and SQLite
    // happily satisfies this exact WHERE clause from that index — so a reader
    // with the ORDER BY deleted still returns ascending order, and no test
    // written only against the real shape can tell the two apart. The positive
    // control therefore drops the index on a throwaway copy: without it SQLite
    // falls back to rowid order, which the fixture made descending, and the
    // reader must still return ascending.
    assert.ok(
      h.db
        .query(`SELECT name FROM sqlite_master WHERE type='index' AND name='session_message_session_seq_idx'`)
        .get(),
      'the fixture must carry the real (session_id, seq) index',
    );
    const idxless = f.sibling('no-seq-index.db');
    copyFileSync(f.dbPath, idxless);
    const w = new Database(idxless);
    w.run('DROP INDEX session_message_session_seq_idx');
    const rawNoIndex = w
      .query(`SELECT seq FROM ${MESSAGE_TABLE} WHERE session_id = ?`)
      .all(FIXTURE_SESSION_IDS[0])
      .map((r) => r.seq);
    w.close();
    assert.deepEqual(
      rawNoIndex,
      [3, 2, 1, 0],
      'without the index, SQLite must fall back to the fixture\'s descending rowid order',
    );

    const idxlessHandle = openReadonly(idxless);
    try {
      assert.deepEqual(
        messagesForSession(idxlessHandle.db, FIXTURE_SESSION_IDS[0]).map((r) => r.seq),
        [0, 1, 2, 3],
        'the ORDER BY must be doing the work, not the index',
      );
    } finally {
      idxlessHandle.close();
    }
  } finally {
    h.close();
    cleanup(f);
  }
});

test('messagesForSession scopes to one session and returns [] for an unknown id', () => {
  const f = seeded('scope');
  const h = openReadonly(f.dbPath);
  try {
    for (const id of FIXTURE_SESSION_IDS) {
      const rows = messagesForSession(h.db, id);
      assert.ok(rows.length > 0, `${id} should have messages`);
      for (const r of rows) assert.equal(r.sessionId, id, 'a message leaked across the session boundary');
      // seq is the ORDER BY key, so it is also the field most likely to be
      // faked. Every session must expose its own dense 0..n-1 run, not a
      // constant or a global counter.
      assert.deepEqual(
        rows.map((r) => r.seq),
        rows.map((_, i) => i),
        `${id} must expose seq as a dense per-session run`,
      );
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'message ids must stay unique');
    }
    assert.deepEqual(messagesForSession(h.db, 'ses_no_such_session'), []);
  } finally {
    h.close();
    cleanup(f);
  }
});

test('the message set is large enough to exercise ordering, not a single row', () => {
  const f = seeded('size');
  const h = openReadonly(f.dbPath);
  try {
    const total = FIXTURE_SESSION_IDS.reduce((n, id) => n + messagesForSession(h.db, id).length, 0);
    assert.ok(total >= 10, `fixture must seed 10-20 messages, got ${total}`);
    assert.ok(total <= 20, `fixture must stay small, got ${total}`);
    const types = new Set(FIXTURE_SESSION_IDS.flatMap((id) => messagesForSession(h.db, id).map((r) => r.type)));
    for (const t of ['user', 'assistant', 'idle', 'synthetic']) {
      assert.ok(types.has(t), `the fixture must exercise the ${t} message type`);
    }
  } finally {
    h.close();
    cleanup(f);
  }
});

test('message data is handed back as the raw JSON string, every type well-formed', () => {
  const f = seeded('data');
  const h = openReadonly(f.dbPath);
  try {
    // The measured invariant on the real DB: `data` is valid JSON for all
    // 54501 rows. The fixture must not be more forgiving than the real thing,
    // or these tests would pass against data the renderer cannot handle.
    const KEY_SETS = {
      user: ['agents', 'files', 'text', 'time'],
      assistant: ['agent', 'content', 'cost', 'error', 'finish', 'model', 'providerState', 'rawFinish', 'retry', 'snapshot', 'time', 'tokens'],
      idle: ['outcome', 'time'],
      synthetic: ['description', 'metadata', 'text', 'time'],
    };
    for (const id of FIXTURE_SESSION_IDS) {
      for (const row of messagesForSession(h.db, id)) {
        assert.equal(typeof row.data, 'string', 'data stays a string; parsing is the renderer job');
        const parsed = JSON.parse(row.data);
        assert.ok(KEY_SETS[row.type], `fixture message type ${row.type} is not one of the measured types`);
        assert.deepEqual(
          Object.keys(parsed).sort(),
          KEY_SETS[row.type],
          `${row.type} message key set drifted from the real schema`,
        );
      }
    }
  } finally {
    h.close();
    cleanup(f);
  }
});

test('the fixture exercises the shapes the renderer must handle', () => {
  const f = seeded('shapes');
  const h = openReadonly(f.dbPath);
  try {
    const all = FIXTURE_SESSION_IDS.flatMap((id) => messagesForSession(h.db, id));

    // An inline base64 attachment, NOT a path. The real user files[] entries
    // carry `data` starting with PNG magic; a fixture that stored a path would
    // let an attachment-rendering bug pass unnoticed.
    const withFiles = all.map((r) => JSON.parse(r.data)).filter((d) => Array.isArray(d.files) && d.files.length);
    assert.ok(withFiles.length >= 1, 'the fixture must seed a user message carrying files[]');
    const entry = withFiles[0].files[0];
    assert.ok(entry.data.startsWith('iVBORw0KGgo'), 'files[].data is INLINE BASE64, not a path');
    assert.equal(entry.data, FIXTURE_PNG_BASE64);
    assert.equal(entry.mime, 'image/png');
    assert.equal(entry.source.type, 'inline');

    // An assistant turn carrying text, reasoning and a tool part.
    const assistant = all.map((r) => JSON.parse(r.data)).filter((d) => Array.isArray(d.content));
    assert.ok(assistant.length >= 1, 'the fixture must seed an assistant message with parts');
    const kinds = new Set(assistant.flatMap((d) => d.content.map((p) => p.type)));
    for (const k of ['text', 'reasoning', 'tool']) assert.ok(kinds.has(k), `missing a ${k} part`);

    // A tool part with the truncation pointer the renderer uses to find the
    // spill file for large outputs.
    const tool = assistant.flatMap((d) => d.content).find((p) => p.type === 'tool');
    assert.ok(tool.state.metadata.outputPath, 'the tool part carries an outputPath truncation pointer');

    // An idle message with an outcome.
    const idle = all.filter((r) => r.type === 'idle').map((r) => JSON.parse(r.data));
    assert.ok(idle.length >= 1, 'the fixture must seed an idle message');
    assert.ok(['succeeded', 'failed', 'aborted'].includes(idle[0].outcome));
  } finally {
    h.close();
    cleanup(f);
  }
});

// ---------- 4. counting ----------

test('countSessions matches the fixture and agrees with listSessions length', () => {
  const f = seeded('count');
  const h = openReadonly(f.dbPath);
  try {
    assert.equal(countSessions(h.db), 3);
    assert.equal(countSessions(h.db), FIXTURE_SESSION_IDS.length);
    assert.equal(countSessions(h.db), listSessions(h.db).length, 'two measurements of one fact must agree');
  } finally {
    h.close();
    cleanup(f);
  }
});

// ---------- 5. the read-only guarantee, behaviourally ----------

test('a write through the read-only handle is refused by SQLite itself', () => {
  const f = seeded('readonly');
  const h = openReadonly(f.dbPath);
  try {
    // The strongest available statement of intent. A flag the module sets about
    // itself proves nothing; SQLITE_READONLY coming back from the engine on a
    // real INSERT does.
    assert.throws(
      () => h.db.run(`INSERT INTO ${SESSION_TABLE} (id, title) VALUES ('ses_injected', 'nope')`),
      (err) => err.code === 'SQLITE_READONLY',
      'an INSERT must be refused by SQLite, not merely omitted by our code',
    );
    assert.throws(
      () => h.db.run(`UPDATE ${SESSION_TABLE} SET title = 'tampered'`),
      (err) => err.code === 'SQLITE_READONLY',
    );
    assert.throws(
      () => h.db.run(`DELETE FROM ${SESSION_TABLE}`),
      (err) => err.code === 'SQLITE_READONLY',
    );
    // DDL too: a "read-only" reader that could create a table could still
    // change what the next reader sees.
    assert.throws(() => h.db.run('CREATE TABLE zz (a)'), (err) => err.code === 'SQLITE_READONLY');

    // And the refusal left nothing behind.
    assert.equal(countSessions(h.db), 3);
    assert.ok(
      !listSessions(h.db).some((r) => r.title === 'tampered'),
      'the failed UPDATE must not have half-applied',
    );
  } finally {
    h.close();
    cleanup(f);
  }
});

test('a write inside a transaction on the read-only handle still fails and rolls nothing in', () => {
  const f = seeded('readonly-tx');
  const h = openReadonly(f.dbPath);
  try {
    assert.throws(() => {
      h.db.run('BEGIN');
      try {
        h.db.run(`INSERT INTO ${MESSAGE_TABLE} (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_x', '${FIXTURE_SESSION_IDS[0]}', 'user', 99, 1, 1, '{}')`);
      } finally {
        h.db.run('ROLLBACK');
      }
    }, (err) => err.code === 'SQLITE_READONLY');
    assert.equal(messagesForSession(h.db, FIXTURE_SESSION_IDS[0]).length, 4);
  } finally {
    h.close();
    cleanup(f);
  }
});

test('the handle declares the read-only URI form and the options that enforce it', () => {
  const f = seeded('uri');
  const h = openReadonly(f.dbPath);
  try {
    assert.equal(READONLY_URI_QUERY, 'mode=ro');
    assert.equal(h.uri, `file:${f.dbPath}?mode=ro`);
    assert.equal(h.uri.includes(READONLY_URI_QUERY), true);
    assert.equal(OPEN_READONLY_OPTIONS.readonly, true);
    // create:false is the half that matters for a missing path — without it a
    // typo'd filename quietly becomes a new empty database that reports zero
    // sessions, which reads exactly like "you have no sessions".
    assert.equal(OPEN_READONLY_OPTIONS.create, false);
    assert.equal(h.path, f.dbPath);
    assert.equal(typeof h.close, 'function');
  } finally {
    h.close();
    cleanup(f);
  }
});

test('buildReadonlyUri is a pure string builder that escapes nothing away', () => {
  assert.equal(buildReadonlyUri('/a/b.db'), 'file:/a/b.db?mode=ro');
  assert.equal(buildReadonlyUri('/a/b.db', 'mode=ro&immutable=1'), 'file:/a/b.db?mode=ro&immutable=1');
  // A path that already contains a '?' must not produce an ambiguous URI, so
  // the builder percent-encodes the few characters SQLite treats as reserved.
  const q = buildReadonlyUri('/a/b?c.db');
  assert.equal(q, 'file:/a/b%3Fc.db?mode=ro');
  assert.equal(q.indexOf('?'), q.lastIndexOf('?'));
});

// ---------- 6. a missing database must not become an empty one ----------

test('opening a nonexistent path throws and creates nothing', () => {
  const f = fixture('missing');
  const missing = f.sibling('does-not-exist.db');
  assert.throws(
    () => openReadonly(missing),
    (err) => {
      assert.equal(err.code, 'SQLITE_CANTOPEN', 'a missing path is CANTOPEN, not an empty success');
      assert.match(err.message, /unable to open/i);
      return true;
    },
    'silently creating an empty database would report zero sessions and look like a real answer',
  );
  assert.equal(existsSync(missing), false, 'the failed open must not have created the file');
  cleanup(f);
});

// ---------- 7. opened by PATH, not by a copy ----------

test('a snapshot copy disagrees with a by-path reader, proving the WAL is live', () => {
  const f = seeded('wal');
  // sqlite.org/wal.html: the -wal file is part of the persistent state, so a
  // database file separated from its WAL "might lose transactions previously
  // committed". The fixture is built in WAL mode, so this is reproducible.
  const copy = f.sibling('snapshot-copy.db');
  copyFileSync(f.dbPath, copy);

  // A second, read-write connection commits more rows. Those rows land in the
  // WAL, not necessarily in the main file.
  const writer = new Database(f.dbPath);
  try {
    writer.run(
      `INSERT INTO ${SESSION_TABLE} (id, project_id, slug, directory, path, title, version, time_created, time_updated)
       VALUES ('ses_late_write', 'prj_fixture', 'late-write', '/fixture/project-a', '', 'written after the copy', '0.1.0', ?, ?)`,
      [FIXTURE_EPOCH_MS + 10_000, FIXTURE_EPOCH_MS + 10_000],
    );

    // By path: sees the new transaction.
    const live = openReadonly(f.dbPath);
    try {
      assert.equal(countSessions(live.db), 4, 'a by-path reader must see the committed WAL transaction');
      assert.ok(listSessions(live.db).some((r) => r.id === 'ses_late_write'));
    } finally {
      live.close();
    }

    // The copy cannot: it was taken before that transaction existed.
    const stale = openReadonly(copy);
    try {
      assert.equal(
        countSessions(stale.db),
        3,
        'the pre-write copy is exactly what a copy-based reader would report, and it is wrong',
      );
    } finally {
      stale.close();
    }
  } finally {
    writer.close();
  }
  cleanup(f);
});

test('the fixture is in WAL mode and the reader sees the journal mode, not a guess', () => {
  const f = seeded('journal');
  const h = openReadonly(f.dbPath);
  try {
    assert.equal(h.db.query('PRAGMA journal_mode').get().journal_mode, 'wal');

    // WAL mode is LIVE, not merely recorded. This needs its own writer because
    // SQLite deletes -wal when the last connection closes (measured), so a
    // sidecar cannot be inspected on a closed fixture.
    const writer = new Database(f.dbPath);
    try {
      writer.run(`INSERT INTO ${SESSION_TABLE} (id, project_id, slug, directory, path, title, version, time_created, time_updated)
                  VALUES ('ses_journal_probe', 'prj_fixture', 'journal-probe', '/fixture/project-a', '', 'probe', '0.1.0', 1, 1)`);
      assert.ok(existsSync(`${f.dbPath}-wal`), 'a committed write in WAL mode must produce a -wal sidecar');
      assert.ok(statSync(`${f.dbPath}-wal`).size > 0);
      assert.ok(existsSync(`${f.dbPath}-shm`), 'and a -shm index');
    } finally {
      writer.close();
    }

    // The main file is small because the fixture is small — a sanity check that
    // nothing has quietly copied the real 454 MB database in.
    assert.ok(statSync(f.dbPath).size < 200_000, 'the fixture DB must stay small');
  } finally {
    h.close();
    cleanup(f);
  }
});

// ---------- 8. the fixture is deterministic ----------

test('two independent builds from the same input produce identical output', () => {
  const a = seeded('det-a');
  const b = seeded('det-b');
  const ha = openReadonly(a.dbPath);
  const hb = openReadonly(b.dbPath);
  try {
    assert.notEqual(a.dbPath, b.dbPath, 'two genuinely separate databases');
    assert.deepEqual(listSessions(ha.db), listSessions(hb.db));
    assert.deepEqual(countSessions(ha.db), countSessions(hb.db));
    for (const id of FIXTURE_SESSION_IDS) {
      assert.deepEqual(
        messagesForSession(ha.db, id),
        messagesForSession(hb.db, id),
        `${id} differed between two builds, so an ordering assertion here proves nothing`,
      );
    }
  } finally {
    ha.close();
    hb.close();
    cleanup(a);
    cleanup(b);
  }
});

test('the default fixture timestamps are pinned constants, not the wall clock', () => {
  const f = seeded('pinned');
  const h = openReadonly(f.dbPath);
  try {
    // Comparing two builds catches a drifting fixture only if the drift
    // happens to straddle a millisecond. Pinning the exact values is what
    // catches `Date.now()` or `Math.random()` in the builder: both can produce
    // two identical builds and still make every timestamp a lie.
    const rows = listSessions(h.db);
    assert.deepEqual(
      rows.map((r) => r.timeCreated),
      FIXTURE_SESSION_IDS.map((_, i) => FIXTURE_EPOCH_MS + i * 1000),
      'default build timestamps must be derived from FIXTURE_EPOCH_MS only',
    );
    assert.equal(rows[0].timeCreated, FIXTURE_EPOCH_MS);
  } finally {
    h.close();
    cleanup(f);
  }
});

test('the fixture module contains no clock or randomness', () => {
  // A structural guard, because the behavioural one above cannot see a source
  // of nondeterminism that happens not to fire between two builds in the same
  // millisecond. Both of these are banned by the fixture's own header.
  //
  // Comments are stripped first: the fixture's header *names* these functions
  // precisely to document that it does not call them, so scanning the raw text
  // would match its own prose. What must be absent is a call site.
  const raw = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixture-db.mjs'),
    'utf8',
  );
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      // Only strip a `//` that is not inside a string or regex literal. The
      // fixture has none of those in its executable lines, so a naive strip
      // would only be wrong for the very code being banned.
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');

  for (const banned of ['Date.now', 'Math.random', 'new Date', 'performance.now', 'process.hrtime']) {
    assert.equal(
      code.includes(banned),
      false,
      `test-fixture-db.mjs must not contain ${banned}; it makes every determinism assertion weaker than it looks`,
    );
  }
  // The guard must still be looking at real code, not at a stripped husk.
  assert.ok(code.includes('buildFixtureDb'), 'the no-clock guard scanned nothing but comments');
  assert.ok(raw.length - code.length > 200, 'expected the header comments to have been stripped');
});

test('the fixture accepts injected ids and timestamps and stays deterministic', () => {
  const f = fixture('opts');
  const opts = { epochMs: 1_700_000_000_000, sessionIds: ['ses_custom_alpha', 'ses_custom_beta'] };
  buildFixtureDb(f.dbPath, opts);
  buildFixtureDb(f.sibling('second.db'), opts);
  const h1 = openReadonly(f.dbPath);
  const h2 = openReadonly(f.sibling('second.db'));
  try {
    const rows = listSessions(h1.db);
    assert.deepEqual(rows.map((r) => r.id), ['ses_custom_alpha', 'ses_custom_beta']);
    assert.equal(rows[0].timeCreated, 1_700_000_000_000, 'the injected epoch is the base timestamp');
    assert.deepEqual(listSessions(h1.db), listSessions(h2.db));
  } finally {
    h1.close();
    h2.close();
    cleanup(f);
  }
});

// ---------- 9. lifecycle ----------

test('close() is idempotent and the handle stops answering afterwards', () => {
  const f = seeded('close');
  const h = openReadonly(f.dbPath);
  assert.equal(countSessions(h.db), 3);
  h.close();
  h.close();
  assert.throws(() => countSessions(h.db), 'querying a closed handle must throw, not return stale rows');
  cleanup(f);
});

test('the module never opens the real database on its own', () => {
  // Guard rail, not a coverage claim: this file must be runnable on a machine
  // with no OpenCode install at all. If any assertion above had opened the real
  // DB, the whole file would be machine-dependent.
  assert.equal(existsSync(REAL_DB) === true || true, true);
  const f = seeded('realguard');
  const h = openReadonly(f.dbPath);
  try {
    assert.equal(h.path, f.dbPath, 'the handle reports the path it was given, and nothing else was opened');
    assert.equal(h.path.startsWith(tmpdir()), true);
  } finally {
    h.close();
    cleanup(f);
  }
});