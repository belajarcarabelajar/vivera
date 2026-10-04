// scripts/lib/test-fixture-db.test.mjs
//
// Tests for the synthetic OpenCode database fixture.
//
// The key invariants being tested:
// 1. buildFixtureDb creates a valid SQLite database
// 2. The database has the correct schema (project, session_v2, session_message)
// 3. Session data is correct (3 sessions, correct titles, correct order)
// 4. Message data is correct (4 messages per session, correct types)
// 5. Attachments carry inline base64 PNG data
// 6. The fixture is deterministic (two builds produce identical output)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import {
  buildFixtureDb,
  FIXTURE_EPOCH_MS,
  FIXTURE_PROJECT_ID,
  FIXTURE_PROJECT_WORKTREE,
  FIXTURE_VERSION,
  FIXTURE_SESSION_IDS,
  FIXTURE_PNG_BASE64,
} from './test-fixture-db.mjs';

// Cleanup everywhere is `fs.rmSync(dir, { recursive: true, force: true })`, never
// `unlinkSync(dbPath)` + `rmdirSync(dir)`: every reader here opens the WAL
// database and leaves `-wal`/`-shm` sidecar files behind, so `rmdir` fails with
// ENOTEMPTY on a directory that looks empty.
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'test-fixture-db-'));
}

function query(dbPath, sql, params = []) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

// ---------- buildFixtureDb ----------

test('buildFixtureDb creates a database file', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  const result = buildFixtureDb(dbPath);
  assert.ok(fs.existsSync(dbPath), 'database file not created');
  assert.equal(result.path, path.resolve(dbPath));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildFixtureDb returns correct session IDs', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  const result = buildFixtureDb(dbPath);
  assert.deepEqual(result.sessionIds, FIXTURE_SESSION_IDS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildFixtureDb returns correct epoch', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  const result = buildFixtureDb(dbPath);
  assert.equal(result.epochMs, FIXTURE_EPOCH_MS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildFixtureDb accepts custom epoch', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  const customEpoch = 1_700_000_000_000;
  const result = buildFixtureDb(dbPath, { epochMs: customEpoch });
  assert.equal(result.epochMs, customEpoch);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildFixtureDb accepts custom session IDs', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  const customIds = ['ses_custom_1', 'ses_custom_2'];
  const result = buildFixtureDb(dbPath, { sessionIds: customIds });
  assert.deepEqual(result.sessionIds, customIds);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildFixtureDb throws on invalid destPath', () => {
  assert.throws(() => buildFixtureDb(''), TypeError);
  assert.throws(() => buildFixtureDb(null), TypeError);
  assert.throws(() => buildFixtureDb(123), TypeError);
});

// ---------- Schema ----------

test('database has project table with correct schema', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, 'SELECT * FROM project');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, FIXTURE_PROJECT_ID);
  assert.equal(rows[0].worktree, FIXTURE_PROJECT_WORKTREE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('database has session_v2 table with 3 sessions', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, 'SELECT * FROM session_v2 ORDER BY time_created');
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.version, FIXTURE_VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('database has session_message table with 12 messages', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, 'SELECT * FROM session_message');
  assert.equal(rows.length, 12); // 3 sessions × 4 messages
  fs.rmSync(dir, { recursive: true, force: true });
});

test('session_v2 has correct titles', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, 'SELECT id, title FROM session_v2 ORDER BY time_created');
  assert.equal(rows[0].title, 'Fixture: a session that was named');
  assert.equal(rows[1].title, null); // untitled session
  assert.equal(rows[2].title, 'Fixture: a session with attachments');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('session_v2 has empty path for all sessions', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, 'SELECT path FROM session_v2');
  for (const row of rows) {
    assert.equal(row.path, '');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- Message data ----------

test('each session has 4 messages', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, 'SELECT session_id, COUNT(*) as cnt FROM session_message GROUP BY session_id');
  for (const row of rows) {
    assert.equal(row.cnt, 4);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('messages have correct types', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, 'SELECT DISTINCT type FROM session_message ORDER BY type');
  const types = rows.map((r) => r.type);
  assert.ok(types.includes('user'));
  assert.ok(types.includes('assistant'));
  assert.ok(types.includes('idle'));
  assert.ok(types.includes('synthetic'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('messages have correct seq order', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, 'SELECT session_id, seq FROM session_message ORDER BY session_id, seq');
  // Each session should have seq 0, 1, 2, 3
  const bySession = {};
  for (const row of rows) {
    if (!bySession[row.session_id]) bySession[row.session_id] = [];
    bySession[row.session_id].push(row.seq);
  }
  for (const [sid, seqs] of Object.entries(bySession)) {
    assert.deepEqual(seqs, [0, 1, 2, 3], `Session ${sid} has wrong seq order`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('user message has correct data structure', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, "SELECT data FROM session_message WHERE type = 'user' LIMIT 1");
  const data = JSON.parse(rows[0].data);
  assert.ok(data.time);
  assert.ok(data.text);
  assert.ok(Array.isArray(data.files));
  assert.ok(Array.isArray(data.agents));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assistant message has correct data structure', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, "SELECT data FROM session_message WHERE type = 'assistant' LIMIT 1");
  const data = JSON.parse(rows[0].data);
  assert.ok(data.time);
  assert.ok(data.agent);
  assert.ok(data.model);
  assert.ok(Array.isArray(data.content));
  assert.ok(data.snapshot === null);
  assert.ok(data.finish);
  assert.ok(data.error === null);
  assert.ok(data.cost === 0);
  assert.ok(data.tokens);
  assert.ok(data.retry === null);
  assert.ok(data.rawFinish);
  assert.ok(data.providerState);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assistant message content has correct types', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, "SELECT data FROM session_message WHERE type = 'assistant' LIMIT 1");
  const data = JSON.parse(rows[0].data);
  const types = data.content.map((c) => c.type);
  assert.ok(types.includes('reasoning'));
  assert.ok(types.includes('text'));
  assert.ok(types.includes('tool'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('idle message has correct data structure', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, "SELECT data FROM session_message WHERE type = 'idle' LIMIT 1");
  const data = JSON.parse(rows[0].data);
  assert.ok(data.time);
  assert.ok(data.outcome);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('synthetic message has correct data structure', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, "SELECT data FROM session_message WHERE type = 'synthetic' LIMIT 1");
  const data = JSON.parse(rows[0].data);
  assert.ok(data.time);
  assert.ok(data.text);
  assert.ok(data.description);
  assert.ok(data.metadata);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- Attachments ----------

test('attachment session has inline base64 PNG', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, "SELECT data FROM session_message WHERE type = 'user' AND session_id = 'ses_fixture_attachments'");
  const data = JSON.parse(rows[0].data);
  assert.equal(data.files.length, 1);
  assert.equal(data.files[0].data, FIXTURE_PNG_BASE64);
  assert.ok(data.files[0].data.startsWith('iVBORw0KGgo')); // PNG magic
  fs.rmSync(dir, { recursive: true, force: true });
});

test('non-attachment sessions have empty files array', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const rows = query(dbPath, "SELECT data FROM session_message WHERE type = 'user' AND session_id != 'ses_fixture_attachments'");
  for (const row of rows) {
    const data = JSON.parse(row.data);
    assert.equal(data.files.length, 0);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- Determinism ----------

test('two builds produce identical session list', () => {
  const dir = tmpDir();
  const dbPath1 = path.join(dir, 'test1.db');
  const dbPath2 = path.join(dir, 'test2.db');
  buildFixtureDb(dbPath1);
  buildFixtureDb(dbPath2);
  const rows1 = query(dbPath1, 'SELECT id, title, time_created FROM session_v2 ORDER BY id');
  const rows2 = query(dbPath2, 'SELECT id, title, time_created FROM session_v2 ORDER BY id');
  assert.deepEqual(rows1, rows2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two builds produce identical message list', () => {
  const dir = tmpDir();
  const dbPath1 = path.join(dir, 'test1.db');
  const dbPath2 = path.join(dir, 'test2.db');
  buildFixtureDb(dbPath1);
  buildFixtureDb(dbPath2);
  const rows1 = query(dbPath1, 'SELECT id, session_id, type, seq FROM session_message ORDER BY id');
  const rows2 = query(dbPath2, 'SELECT id, session_id, type, seq FROM session_message ORDER BY id');
  assert.deepEqual(rows1, rows2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- WAL mode ----------

test('database uses WAL journal mode', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'test.db');
  buildFixtureDb(dbPath);
  const db = new Database(dbPath, { readonly: true });
  const result = db.prepare('PRAGMA journal_mode').get();
  db.close();
  assert.equal(result.journal_mode, 'wal');
  fs.rmSync(dir, { recursive: true, force: true });
});
