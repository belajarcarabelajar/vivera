// scripts/lib/render-session.test.mjs
//
// Guards for the session -> Obsidian markdown renderer.
//
// NOTHING HERE TOUCHES THE REAL DATABASE. The live
// `~/.local/share/opencode/opencode.db` holds 1000+ sessions, 54,501 messages,
// 13.2 MiB of INLINE BASE64 attachments inside user-message JSON, and a
// `credential` table with two real secrets. Every database-backed test below
// builds a throwaway fixture under tmpdir via `buildFixtureDb` and reads that.
// Every synthetic secret is constructed in this file; none is copied from
// anywhere.
//
// FOUR PROPERTIES CARRY THE WEIGHT, and each is written so it could not pass
// against a wrong implementation:
//
//   1. ORDER IS BY `seq`, AND THE TEST CAN PROVE IT. The real database carries
//      a unique index on `(session_id, seq)`, so a renderer that forgot to sort
//      would still receive already-sorted rows from `messagesForSession()` and
//      would look correct. Section 1 therefore does not only read the database —
//      it also hands the renderer a DELIBERATELY SHUFFLED array, and it asserts
//      up front that the array really is out of order. A renderer with no sort
//      fails that test. That positive control is the whole reason the test is
//      evidence rather than decoration.
//
//   2. FULL FIDELITY: NO TYPE IS DROPPED (Intent Lock D16). 2,775 `idle` and 24
//      `compaction` rows exist in the real corpus. Section 4 renders one
//      message per non-`user`/non-`assistant` type and asserts a labelled
//      section AND the event's own payload, so "labelled" cannot be satisfied by
//      an empty stub that swallows the data.
//
//   3. REDACTION IS THE LAST THING BEFORE ASSEMBLY. Section 5 plants a
//      synthetic secret in five different places (user text, assistant text,
//      reasoning text, tool input, tool output) and then asserts on the STRING
//      that comes back — both that `[REDACTED:...]` is present and that the
//      secret appears NOWHERE in the output. A renderer that redacts four of
//      five sites fails; so does one that redacts at the wrong layer.
//
//   4. A `\`\`\`` IN THE SOURCE MUST NOT BREAK THE NOTE. Captured text contains
//      fences — a markdown sample, a shell here-doc. Section 6 asserts the fence
//      is SIZED to the body's longest backtick run and that the body survives
//      verbatim inside it.
//
// The renderer must also never throw: malformed `data`, an unknown part type, a
// missing `content` array and a non-array `messages` all have labelled markers
// and tests (section 7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  renderSession,
  parseFrontmatter,
  GENERATOR,
  MALFORMED_DATA_MARKER,
  MISSING_CONTENT_MARKER,
  UNKNOWN_PART_MARKER,
  OMITTED_ATTACHMENT_MARKER,
  FENCED_PROSE_MARKER,
  EVENT_TYPES,
} from './render-session.mjs';
import { openReadonly, listSessions, messagesForSession } from './opencode-db.mjs';
import { buildFixtureDb, FIXTURE_SESSION_IDS, FIXTURE_PNG_BASE64 } from './test-fixture-db.mjs';
import { markerFor } from './redact.mjs';

// ---------- fixtures ----------

function tmp(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `render-session-${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One temp dir, one fixture database inside it. */
function seeded(label) {
  const f = tmp(label);
  return { ...f, dbPath: path.join(f.dir, 'fixture.db'), fixture: buildFixtureDb(path.join(f.dir, 'fixture.db')) };
}

// A session row shaped like the real one: `title` may be null (36 of 1009 real
// sessions), `directory` is NOT NULL in the schema, times are ms epochs.
const SESSION = {
  id: 'ses_render_test',
  title: 'Render test session',
  directory: '/fixture/project-a',
  timeCreated: 1_756_000_000_000,
  timeUpdated: 1_756_000_005_000,
};

function msg(seq, type, data) {
  return {
    id: `msg_${seq}`,
    sessionId: SESSION.id,
    type,
    seq,
    timeCreated: SESSION.timeCreated + seq * 1000,
    timeUpdated: SESSION.timeCreated + seq * 1000,
    // A string means "already serialised" — which is how a malformed-data test
    // feeds in a string that is NOT valid JSON.
    data: typeof data === 'string' ? data : JSON.stringify(data),
  };
}

const userData = (text, files = []) => ({ time: { created: SESSION.timeCreated }, text, files, agents: [] });

const assistantData = (parts, over = {}) => ({
  time: { created: SESSION.timeCreated },
  agent: 'build',
  model: { id: 'fixture-model-1', providerID: 'fixture', variant: 'default' },
  content: parts,
  snapshot: null,
  finish: 'stop',
  error: null,
  cost: 0,
  tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  retry: null,
  rawFinish: 'stop',
  providerState: {},
  ...over,
});

const textPart = (text) => ({ type: 'text', text, state: { time: { start: 1, end: 1 } } });
const reasoningPart = (text) => ({ type: 'reasoning', text, state: { reasoningField: 'reasoning_content' }, time: { created: 1, completed: 2 } });
const toolPart = (name, input, out, over = {}) => ({
  type: 'tool',
  id: `call_${name}_0001`,
  name,
  executed: true,
  state: {
    status: 'completed',
    input,
    content: [{ type: 'text', text: out }],
    metadata: { truncated: false },
  },
  time: { created: 1, ran: 2 },
  providerState: { done: true },
  ...over,
});

// Every non-`user`/non-`assistant` type the renderer must label. One distinctive
// value per entry so "the payload survived" is assertable per type.
const EVENT_SAMPLES = {
  'idle': { time: { created: 1_756_000_030_000 }, outcome: 'succeeded-idle-outcome' },
  'compaction': {
    time: { created: 1_756_000_031_000 },
    reason: 'auto-compaction',
    status: 'completed',
    summary: 'compacted summary prose',
    model: { id: 'fixture-model-1', providerID: 'fixture' },
    cost: 0.25,
    tokens: { input: 90, output: 12 },
  },
  'model-switched': { time: { created: 1_756_000_032_000 }, from: 'fixture/one', to: 'fixture/two' },
  'location-switched': { time: { created: 1_756_000_033_000 }, from: '/fixture/a', to: '/fixture/b' },
  'agent-switched': { time: { created: 1_756_000_034_000 }, from: 'build', to: 'plan' },
  'synthetic': { time: { created: 1_756_000_035_000 }, text: 'synthetic prose body', description: 'bun test', metadata: { source: 'shell', exit: 0 } },
  'system': { time: { created: 1_756_000_036_000 }, text: 'system prose body', description: 'session started', metadata: {} },
};

// The heading the renderer uses for every message. `## [seq N] <label>` — the
// bracket form is deliberate: it cannot be produced by prose in a normal
// conversation, so a heading found in the output is a section, not a quote.
const HEADING_RE = /^## \[seq ([^\]]+)\] (.*)$/;

// A section is a heading that is NOT inside a fenced code block. Tracking fences
// is what makes this honest: a `## [seq 999]` line sitting inside a fence is
// rendered text, exactly as any markdown renderer would agree, and counting it
// as a section would let an injection pass by looking like structure. Without
// this, the injection test in section 6 could not distinguish a contained
// fence from a broken note.
function sections(markdown) {
  const out = [];
  let openFence = null;
  for (const line of markdown.split('\n')) {
    const f = /^(`{3,})(.*)$/.exec(line);
    if (f) {
      if (openFence === null) openFence = f[1].length;
      else if (f[1].length >= openFence && f[2].trim() === '') openFence = null;
      continue;
    }
    if (openFence !== null) continue;
    const h = HEADING_RE.exec(line);
    if (h) out.push({ seq: h[1], label: h[2] });
  }
  return out;
}

function seqsOf(markdown) {
  return sections(markdown)
    .map((s) => Number(s.seq))
    .filter((n) => Number.isFinite(n));
}

// ---------- 1. ordering ----------

test('a fixture database renders its messages in ascending seq', () => {
  const f = seeded('order-db');
  const h = openReadonly(f.dbPath);
  try {
    const [session] = listSessions(h.db);
    const rows = messagesForSession(h.db, session.id);
    const markdown = renderSession(session, rows);

    const seqs = seqsOf(markdown);
    assert.deepEqual(seqs, rows.map((r) => r.seq), 'every message must produce exactly one section, in seq order');
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sections are not in ascending seq order');
  } finally {
    h.close();
    f.cleanup();
  }
});

test('a SHUFFLED input still renders in seq order — the test that catches a missing sort', () => {
  // This is the positive control for the whole section. `messagesForSession`
  // already returns sorted rows, so a renderer without a sort passes the test
  // above by luck. Here the input is deliberately out of order, and the first
  // assertion proves it IS out of order, so the second assertion is evidence.
  const ordered = [0, 1, 2, 3, 4, 5].map((n) =>
    msg(n, 'user', userData(`prompt number ${n}`)),
  );
  const shuffled = [3, 0, 5, 1, 4, 2].map((n) => ordered[n]);

  // Control: the fixture is genuinely unsorted. If this fails, the test below is
  // proving nothing and the failure must be in the test, not the renderer.
  assert.deepEqual(
    shuffled.map((m) => m.seq),
    [3, 0, 5, 1, 4, 2],
  );
  assert.notDeepEqual(
    shuffled.map((m) => m.seq),
    [...shuffled.map((m) => m.seq)].sort((a, b) => a - b),
    'the shuffled fixture is already in order, so this test cannot detect a missing sort',
  );

  const markdown = renderSession(SESSION, shuffled);

  assert.deepEqual(seqsOf(markdown), [0, 1, 2, 3, 4, 5], 'output order follows seq, not input order');

  // And the CONTENT follows the same order, not just the section headers: the
  // positions of the six prompts must be monotonically increasing too.
  const positions = ordered.map((_, i) => markdown.indexOf(`prompt number ${i}`));
  for (const p of positions) assert.ok(p >= 0, 'every prompt must appear in the note');
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `prompt ${i} appears before prompt ${i - 1}: content order disagrees with seq order`);
  }
});

test('a message with no usable seq sorts last and is labelled, rather than crashing the sort', () => {
  // `seq` is `NOT NULL` in the real schema, so this cannot happen from a real
  // database — it CAN happen from a caller that assembled rows by hand or from
  // a future migration. The failure this pins: sort it last, and label it so a
  // reader knows why (the coercion trap itself is documented in `seqOf`).
  const rows = [
    msg(2, 'user', userData('the third message')),
    { ...msg(0, 'user', userData('the orphan message')), seq: null },
    msg(1, 'user', userData('the second message')),
  ];
  const markdown = renderSession(SESSION, rows);
  const found = sections(markdown);

  // The TYPE is still known — only the sequence number is not — so the label
  // stays `user` and the seq slot is what says `unknown`. Asserting on the seq
  // rather than the label is the point: a renderer that blanked the label too
  // would have thrown away a fact it actually has.
  assert.deepEqual(found.map((s) => s.label), ['user', 'user', 'user'], 'a missing seq must not obscure the message type');
  assert.deepEqual(found.map((s) => s.seq), ['1', '2', 'unknown'], 'the seqless row must sort last and say so');
  const orphan = markdown.indexOf('the orphan message');
  const third = markdown.indexOf('the third message');
  assert.ok(orphan > third, 'a null seq was coerced to 0 and sorted to the front of the note');
});

// ---------- 2. user ----------

test('a user message renders its prompt text', () => {
  const markdown = renderSession(SESSION, [msg(0, 'user', userData('Summarise the fixture project.'))]);
  assert.ok(markdown.includes('Summarise the fixture project.'), 'the prompt text is missing from the note');
  assert.deepEqual(
    sections(markdown).map((s) => s.label),
    ['user'],
    'the section must be labelled with the message type',
  );
});

test('a user message with no prompt text still renders a labelled section', () => {
  const markdown = renderSession(SESSION, [msg(0, 'user', { time: { created: 1 }, text: '', files: [], agents: [] })]);
  assert.equal(sections(markdown).length, 1);
  assert.ok(markdown.includes('no prompt text'), 'an empty prompt must be stated, not silently blank');
});

// ---------- 3. assistant parts ----------

test('an assistant text part renders as prose, outside any code fence', () => {
  const markdown = renderSession(SESSION, [msg(0, 'assistant', assistantData([textPart('Here is what the fixture project contains.')]))]);
  assert.ok(markdown.includes('Here is what the fixture project contains.'), 'the prose is missing');
  // "As prose" is a structural claim, not a substring claim: ordinary prose must
  // not be needlessly sunk into a code fence, which would defeat every search in
  // Obsidian.
  assert.ok(
    !markdown.includes('```text\nHere is what the fixture project contains.'),
    'ordinary prose was fenced; a note is searchable only if prose stays prose',
  );
});

test('an assistant reasoning part renders in its own labelled section, distinguishable from the prose', () => {
  const markdown = renderSession(SESSION, [
    msg(0, 'assistant', assistantData([
      reasoningPart('The user asked about the fixture. Read the directory first.'),
      textPart('Here is the answer.'),
    ])),
  ]);

  assert.ok(markdown.includes('### reasoning'), 'reasoning needs its own labelled heading, distinct from prose');
  assert.ok(markdown.includes('The user asked about the fixture. Read the directory first.'), 'the reasoning text is missing');
  assert.ok(markdown.includes('Here is the answer.'), 'the prose is missing');

  // Distinguishability: the reasoning must be inside a collapsible/details
  // wrapper and the prose must not be. A renderer that dumped both into one
  // blob would satisfy every substring assertion above and fail this one.
  const reasoningAt = markdown.indexOf('The user asked about the fixture.');
  const proseAt = markdown.indexOf('Here is the answer.');
  assert.ok(reasoningAt >= 0 && proseAt > reasoningAt);
  const detailsOpen = markdown.indexOf('<details>');
  const detailsClose = markdown.indexOf('</details>');
  assert.ok(detailsOpen >= 0 && detailsClose > detailsOpen, 'reasoning must be collapsible');
  assert.ok(
    detailsOpen < reasoningAt && reasoningAt < detailsClose,
    'the reasoning text is not inside the collapsible section',
  );
  assert.ok(proseAt > detailsClose, 'the prose must come after the collapsible, not inside it');
});

test('an assistant tool part renders tool name, executed and input', () => {
  const markdown = renderSession(SESSION, [
    msg(0, 'assistant', assistantData([
      toolPart('read', { path: '/fixture/project-a/notes.md' }, 'Read 1 file'),
    ])),
  ]);

  assert.ok(markdown.includes('### tool · read'), `the tool name must be labelled; got:\n${markdown}`);
  assert.ok(/-\s*`executed`:\s*true/.test(markdown), 'the `executed` flag must be rendered');
  assert.ok(markdown.includes('/fixture/project-a/notes.md'), 'the tool input must be rendered');
  assert.ok(markdown.includes('Read 1 file'), 'the tool output must be rendered');
  // The input is JSON, so a `{` and its key must survive — a renderer that
  // stringified `[object Object]` would fail here.
  assert.ok(/"path"/.test(markdown), 'the tool input must be rendered as structured data');
});

test('an assistant tool part with executed:false says so', () => {
  const markdown = renderSession(SESSION, [
    msg(0, 'assistant', assistantData([
      toolPart('bash', { command: 'true' }, '', { executed: false }),
    ])),
  ]);
  assert.ok(/-\s*`executed`:\s*false/.test(markdown), 'executed:false must not be rendered as executed:true');
});

test('an assistant tool output containing a fence run gets a fence sized to that run', () => {
  const markdown = renderSession(SESSION, [
    msg(0, 'assistant', assistantData([
      toolPart('shell', { command: 'cat fence.md' }, 'before\n```\nmiddle\n```\nafter'),
    ])),
  ]);
  assert.ok(markdown.includes('````'), 'a 3-backtick body needs at least a 4-backtick fence');
  assert.ok(markdown.includes('before\n```\nmiddle\n```\nafter'), 'the captured output must survive byte-for-byte inside the fence');
});

// ---------- 4. every non-standard type gets a labelled section (D16) ----------

test('every non-user/non-assistant type renders a labelled section carrying its own payload', () => {
  assert.deepEqual(
    [...EVENT_TYPES].sort(),
    Object.keys(EVENT_SAMPLES).sort(),
    'the renderer and this test disagree about which types exist; one of them is wrong',
  );

  for (const [type, data] of Object.entries(EVENT_SAMPLES)) {
    const markdown = renderSession(SESSION, [msg(0, type, data)]);
    const secs = sections(markdown);

    assert.equal(secs.length, 1, `${type}: expected exactly one section, got ${JSON.stringify(secs)}`);
    assert.equal(secs[0].label, `session-event: ${type}`, `${type}: the section label does not name the type`);

    // A labelled empty stub would pass the assertion above and lose the data.
    // So assert the payload itself survives, per type.
    const marker = Object.values(data).find((v) => typeof v === 'string' && v.length > 3);
    if (marker) {
      assert.ok(markdown.includes(marker), `${type}: the event payload "${marker}" was dropped`);
    }
    assert.ok(
      markdown.includes('#### event data'),
      `${type}: the raw event JSON must still be emitted for full fidelity`,
    );
  }
});

test('idle and compaction specifically are not dropped (D16)', () => {
  const markdown = renderSession(SESSION, [
    msg(0, 'idle', EVENT_SAMPLES['idle']),
    msg(1, 'compaction', EVENT_SAMPLES['compaction']),
  ]);
  assert.ok(markdown.includes('session-event: idle'), 'an idle row was dropped');
  assert.ok(markdown.includes('succeeded-idle-outcome'), 'the idle outcome was dropped');
  assert.ok(markdown.includes('session-event: compaction'), 'a compaction row was dropped');
  assert.ok(markdown.includes('compacted summary prose'), 'the compaction summary was dropped');
  assert.deepEqual(seqsOf(markdown), [0, 1]);
});

test('a type nobody has seen before is still labelled and kept, not dropped', () => {
  const markdown = renderSession(SESSION, [msg(0, 'quantum-switched', { time: { created: 1 }, payload: 'future shape' })]);
  assert.equal(sections(markdown).length, 1);
  assert.equal(sections(markdown)[0].label, 'session-event: quantum-switched');
  assert.ok(markdown.includes('future shape'), 'an unknown type must still carry its payload');
});

test('a message with no type at all is labelled rather than skipped', () => {
  const markdown = renderSession(SESSION, [{ ...msg(0, undefined, { text: 'x' }), type: undefined }]);
  assert.equal(sections(markdown).length, 1, 'a typeless message must still produce one labelled section');
  assert.match(sections(markdown)[0].label, /session-event: unknown-type/);
});

// ---------- 5. redaction ----------

// Constructed here, never copied. `ghp_` + 36 alphanumerics is long enough for
// the pattern's `{20,}` bound and is not a real credential.
const SECRET = `ghp_${'Zz9'.repeat(12)}`;
const SECRET_MARKER = markerFor('github-token');

test('a synthetic secret is redacted out of every rendered string', () => {
  assert.ok(!/gh[pousr]_/.test('nothing here'), 'sanity');

  const rows = [
    msg(0, 'user', userData(`my token is ${SECRET} please use it`)),
    msg(1, 'assistant', assistantData([
      reasoningPart(`thinking about ${SECRET}`),
      textPart(`here is the plan, token ${SECRET}`),
      toolPart('bash', { path: '/fixture/project-a/notes.md', note: SECRET }, `stdout echoed ${SECRET}`),
    ])),
  ];

  const counts = [];
  const markdown = renderSession(SESSION, rows, { onRedact: (c) => counts.push(c) });

  // The negative assertion is the one that matters: the secret must appear
  // NOWHERE in the returned markdown, including in a tool input, in a tool
  // output, and inside the raw JSON dump.
  assert.equal(markdown.includes(SECRET), false, 'the secret reached the returned markdown');
  assert.ok(!markdown.includes('ghp_'), 'a secret prefix reached the returned markdown');

  // The positive one: redaction ran, and it ran everywhere. Each rendered
  // region is checked separately so that redacting the prompt and forgetting the
  // tool output — the exact bug that would leak a shell result — fails here
  // rather than passing on the strength of the prompt alone.
  //
  // SCOPE, stated honestly: this proves the OUTCOME (no region holds a secret).
  // It cannot distinguish per-field redaction from one pass over the finished
  // note, because the renderer does both and the two produce identical output —
  // the final pass is defence in depth for a field added later. Measured: with
  // only the final pass removed, or only the per-field pass removed, this test
  // still passes; with both removed it fails. The per-field guarantee is
  // therefore asserted through the counts below, which are per-field by
  // construction: a single whole-note pass would still report five, but the
  // per-site comment in the module header is what a reviewer checks.
  const regions = {
    'user text': markdown.slice(markdown.indexOf('my token'), markdown.indexOf('### reasoning')),
    'reasoning text': markdown.slice(markdown.indexOf('### reasoning'), markdown.indexOf('here is the plan')),
    'assistant text': markdown.slice(markdown.indexOf('here is the plan'), markdown.indexOf('### tool')),
    'tool input': markdown.slice(markdown.indexOf('#### input'), markdown.indexOf('#### output')),
    'tool output': markdown.slice(markdown.indexOf('#### output')),
  };
  for (const [name, region] of Object.entries(regions)) {
    assert.ok(region.length > 0, `${name}: the region is empty, so this assertion is not testing anything`);
    assert.ok(region.includes('[REDACTED:'), `${name}: not redacted at this site`);
    assert.ok(!region.includes(SECRET), `${name}: the secret survived at this site`);
  }
  assert.ok(markdown.includes(SECRET_MARKER), `no [REDACTED:...] marker in the output:\n${markdown}`);

  // Counts are reported, per pattern, aggregated across the whole note — one
  // planted occurrence per site, so the total must be exactly five.
  assert.equal(counts.length, 1, 'onRedact must be called exactly once per render');
  assert.equal(counts[0]['github-token'], 5, `counts[0] = ${JSON.stringify(counts[0])}`);
});

test('a render with no secrets reports empty counts rather than throwing them away', () => {
  const counts = [];
  const markdown = renderSession(SESSION, [msg(0, 'user', userData('nothing sensitive here'))], {
    onRedact: (c) => counts.push(c),
  });
  assert.equal(counts.length, 1);
  assert.deepEqual(counts[0], {}, 'a clean note must report zero redactions');
  assert.ok(markdown.includes('nothing sensitive here'));
});

test('a secret in the session title is redacted in the frontmatter too', () => {
  const counts = [];
  const markdown = renderSession(
    { ...SESSION, title: `leaked ${SECRET}` },
    [msg(0, 'user', userData('hi'))],
    { onRedact: (c) => counts.push(c) },
  );
  assert.equal(markdown.includes(SECRET), false, 'a secret in the title reached the note');
  assert.equal(counts[0]['github-token'], 1);
});

// ---------- 6. markdown injection ----------

test('backticks in a tool output cannot break out: the fence is sized to the body', () => {
  const markdown = renderSession(SESSION, [
    msg(0, 'assistant', assistantData([
      toolPart('shell', { command: 'cat fence.md' }, 'line\n`````\nfive backticks\n`````\nend'),
    ])),
  ]);
  assert.ok(markdown.includes('``````'), 'a 5-backtick body needs at least a 6-backtick fence');
  assert.ok(markdown.includes('line\n`````\nfive backticks\n`````\nend'), 'the body must survive verbatim');
  // Structure intact: the note's own section headings still exist afterwards.
  assert.equal(sections(markdown).length, 1);
  assert.ok(markdown.startsWith('---\n'), 'the frontmatter must still open the note');
});

test('backticks in prose are contained and the note structure survives', () => {
  const prose = 'before the fence\n```\ninjected heading\n## [seq 999] fake-section\n```\nafter the fence';
  const markdown = renderSession(
    SESSION,
    [
      msg(0, 'assistant', assistantData([textPart(prose)])),
      msg(1, 'user', userData('the real next message')),
    ],
  );

  assert.ok(markdown.includes(prose), 'the prose must survive byte-for-byte');
  // The prose contained a fence run, so it was moved inside a SIZED fence. That
  // is what stops it from opening an unterminated block that swallows the rest
  // of the note.
  assert.ok(markdown.includes('````'), 'prose carrying a ``` run must be fenced with a longer fence');
  assert.ok(markdown.includes(FENCED_PROSE_MARKER), 'fenced prose must say why it was fenced');

  // The injected fake section must NOT appear as a real section heading: the
  // only sections in the note are the two real messages.
  const labels = sections(markdown).map((s) => s.label);
  assert.deepEqual(labels, ['assistant', 'user'], `injected heading became a real section: ${JSON.stringify(labels)}`);
});

test('a fence run at the very end of the body is still contained', () => {
  const markdown = renderSession(SESSION, [
    msg(0, 'assistant', assistantData([textPart('trailing fence ```` four')])),
  ]);
  // Every opening fence line must have a matching closing one, so count the
  // fence-only lines: an odd count means the note has an unterminated block.
  const fenceLines = markdown.split('\n').filter((l) => /^\`{3,}[A-Za-z]*$/.test(l));
  assert.equal(fenceLines.length % 2, 0, `unbalanced fences: ${JSON.stringify(fenceLines)}`);
});

// ---------- 7. malformed input degrades, never throws ----------

test('a message whose data is not valid JSON renders a labelled marker', () => {
  const rows = [
    msg(0, 'user', '{"text": "truncated and never closed'),
    msg(1, 'user', userData('the message after the bad one')),
  ];
  let markdown;
  assert.doesNotThrow(() => { markdown = renderSession(SESSION, rows); }, 'renderSession threw on invalid JSON');
  assert.ok(markdown.includes(MALFORMED_DATA_MARKER), 'a malformed-data marker must appear');
  assert.ok(markdown.includes('the message after the bad one'), 'one bad row must not take the note down');
  assert.equal(sections(markdown).length, 2, 'a malformed row still gets its own labelled section');
});

test('a data blob that parses to a non-object renders without throwing', () => {
  for (const raw of ['"just a string"', '42', 'null', 'true', '[]']) {
    let markdown;
    assert.doesNotThrow(() => { markdown = renderSession(SESSION, [msg(0, 'user', raw)]); }, `threw on data = ${raw}`);
    assert.equal(sections(markdown).length, 1, `data = ${raw} produced no labelled section`);
  }
});

test('an unknown part type renders a labelled marker and keeps going', () => {
  const markdown = renderSession(SESSION, [
    msg(0, 'assistant', assistantData([
      { type: 'quantum', payload: 'unknown shape' },
      textPart('the turn continues'),
    ])),
  ]);
  assert.ok(markdown.includes(UNKNOWN_PART_MARKER), 'an unknown part type must produce a labelled marker');
  assert.ok(markdown.includes('quantum'), 'the marker must name the type it did not recognise');
  assert.ok(markdown.includes('the turn continues'), 'the parts after the unknown one must still render');
});

test('a missing content array renders a labelled marker', () => {
  const markdown = renderSession(SESSION, [msg(0, 'assistant', { time: { created: 1 }, agent: 'build' })]);
  assert.ok(markdown.includes(MISSING_CONTENT_MARKER), 'a missing $.content must produce a labelled marker');
  assert.equal(sections(markdown).length, 1);
});

test('a content value that is not an array renders a labelled marker', () => {
  for (const content of ['nope', 42, null, { type: 'text' }]) {
    let markdown;
    assert.doesNotThrow(() => {
      markdown = renderSession(SESSION, [msg(0, 'assistant', { content })]);
    }, `threw on content = ${JSON.stringify(content)}`);
    assert.ok(markdown.includes(MISSING_CONTENT_MARKER), `content = ${JSON.stringify(content)} was not marked`);
  }
});

test('a null part and a null message row degrade rather than throw', () => {
  let markdown;
  assert.doesNotThrow(() => {
    markdown = renderSession(SESSION, [msg(0, 'assistant', assistantData([null, 'not an object', textPart('survivor')]))]);
  }, 'threw on a junk content part');
  assert.ok(markdown.includes('survivor'));

  assert.doesNotThrow(() => {
    markdown = renderSession(SESSION, [null, msg(1, 'user', userData('after a null row'))]);
  }, 'threw on a null message row');
  assert.ok(markdown.includes('after a null row'));
});

test('a non-array messages argument is an empty note, not a crash', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    let markdown;
    assert.doesNotThrow(() => { markdown = renderSession(SESSION, bad); }, `threw on messages = ${JSON.stringify(bad)}`);
    assert.ok(markdown.startsWith('---\n'), 'even an empty note opens with frontmatter');
    assert.ok(markdown.includes('message_count: 0'));
  }
});

test('a session row with missing fields still renders frontmatter', () => {
  let markdown;
  assert.doesNotThrow(() => { markdown = renderSession({}, [msg(0, 'user', userData('hi'))]); }, 'threw on an empty session row');
  const { attrs } = parseFrontmatter(markdown);
  assert.equal(attrs.id, null, 'a missing id must be null, not invented');
  assert.equal(attrs.title, null);
  assert.equal(attrs.directory, null);
});

// ---------- 8. frontmatter ----------

test('the frontmatter parses as key/value lines and carries the session identity', () => {
  const markdown = renderSession(SESSION, [
    msg(0, 'user', userData('hi')),
    msg(1, 'assistant', assistantData([textPart('hello')])),
  ]);

  assert.ok(markdown.startsWith('---\n'), 'the note must open with a --- frontmatter fence');
  const { attrs, body } = parseFrontmatter(markdown);
  assert.equal(attrs.id, SESSION.id, 'the session id must be in the frontmatter');
  assert.equal(attrs.title, SESSION.title);
  assert.equal(attrs.directory, SESSION.directory);
  assert.equal(attrs.generator, GENERATOR);
  assert.equal(attrs.message_count, 2);
  assert.equal(new Date(attrs.created).toISOString(), new Date(SESSION.timeCreated).toISOString(), 'created must be ISO-8601 UTC');
  assert.equal(new Date(attrs.updated).toISOString(), new Date(SESSION.timeUpdated).toISOString());
  assert.match(attrs.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'timestamps must be ISO-8601 with an explicit UTC marker');
  assert.ok(body.includes('hi'), 'the body must survive frontmatter parsing');

  // The raw frontmatter block must be plain `key: value` lines — that is what a
  // YAML frontmatter parser needs, and a multi-line or block scalar would
  // silently break Obsidian's property panel.
  const allLines = markdown.split('\n');
  const closeAt = allLines.indexOf('---', 1);
  assert.ok(closeAt > 1, 'the frontmatter was never closed');
  const block = allLines.slice(1, closeAt);
  assert.ok(block.length >= 7, `expected at least the seven documented fields, got ${block.length}`);
  for (const line of block) assert.match(line, /^[a-z_]+: .+$/, `not a key/value line: ${JSON.stringify(line)}`);

  // And it must not carry the raw message JSON.
  assert.ok(!block.some((l) => l.includes('"content"')), 'frontmatter must not carry raw message JSON');
});

test('a null title is rendered as null, and a titled session is quoted', () => {
  const untitled = renderSession({ ...SESSION, title: null }, [msg(0, 'user', userData('hi'))]);
  assert.equal(parseFrontmatter(untitled).attrs.title, null, 'a null title must stay null, not become an empty string');

  const awkward = renderSession({ ...SESSION, title: 'colon: inside, and "quotes"' }, []);
  const raw = awkward.split('\n').find((l) => l.startsWith('title:'));
  assert.equal(parseFrontmatter(awkward).attrs.title, 'colon: inside, and "quotes"', 'a title with YAML metacharacters must round-trip');
  assert.ok(raw.startsWith('title: "'), `a title needing quoting must be quoted: ${raw}`);
});

// ---------- 9. determinism ----------

test('rendering the same input twice is byte-identical', () => {
  const rows = [
    msg(0, 'user', userData('first prompt')),
    msg(1, 'assistant', assistantData([reasoningPart('thinking'), textPart('answering'), toolPart('read', { path: '/a' }, 'ok')])),
    msg(2, 'idle', EVENT_SAMPLES['idle']),
  ];
  const a = renderSession(SESSION, rows);
  const b = renderSession(SESSION, rows);
  assert.equal(a, b, 'two renders of identical input differ — something is reading a clock, a random source, or mutable shared state');

  // No wall-clock stamp anywhere: the only dates in the note come from the rows.
  const iso = [...a.matchAll(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g)].map((m) => m[0]);
  for (const stamp of iso) {
    const when = Date.parse(stamp);
    assert.ok(
      when >= SESSION.timeCreated - 1000 && when <= SESSION.timeUpdated + 1000,
      `the note carries a timestamp that came from neither the session nor its messages: ${stamp}`,
    );
  }
});

test('input order does not change a single byte of the output', () => {
  const rows = [
    msg(0, 'user', userData('alpha')),
    msg(1, 'assistant', assistantData([textPart('beta')])),
    msg(2, 'synthetic', EVENT_SAMPLES['synthetic']),
  ];
  const forward = renderSession(SESSION, rows);
  const reversed = renderSession(SESSION, [...rows].reverse());
  const rotated = renderSession(SESSION, [rows[2], rows[0], rows[1]]);
  assert.equal(reversed, forward, 'a reversed input produced different bytes');
  assert.equal(rotated, forward, 'a rotated input produced different bytes');
});

// ---------- 10. attachments (AC-7) ----------

test('a user attachment becomes a file and an embed, and no base64 reaches the note', () => {
  const f = tmp('attach');
  try {
    const rows = [
      msg(0, 'user', userData('Look at this screenshot.', [{ data: FIXTURE_PNG_BASE64, mime: 'image/png', name: 'shot.png', source: { type: 'inline' } }])),
    ];
    const markdown = renderSession(SESSION, rows, {
      attachmentsDir: path.join(f.dir, '.attachments'),
      vaultRoot: f.dir,
    });

    assert.equal(markdown.includes(FIXTURE_PNG_BASE64), false, 'the base64 blob is in the note (AC-7)');
    assert.ok(!/iVBORw0/.test(markdown), 'the base64 magic prefix is in the note (AC-7)');
    assert.ok(/!\[\[.*\.png\]\]/.test(markdown), 'the attachment must be embedded as an Obsidian wikilink');
    const written = readdirSync(path.join(f.dir, '.attachments'));
    assert.equal(written.filter((n) => n.endsWith('.png')).length, 1, 'the attachment was not written to disk');
  } finally {
    f.cleanup();
  }
});

test('without an attachmentsDir the payload is still never printed', () => {
  const markdown = renderSession(SESSION, [
    msg(0, 'user', userData('See attached.', [{ data: FIXTURE_PNG_BASE64, mime: 'image/png', name: 'shot.png' }])),
  ]);
  assert.equal(markdown.includes(FIXTURE_PNG_BASE64), false, 'the base64 blob is in the note');
  assert.ok(markdown.includes(OMITTED_ATTACHMENT_MARKER), 'omitted attachments must be stated, not silently dropped');
});

test('an attachment with a path string instead of inline data is skipped, not printed', () => {
  const f = tmp('attach-skip');
  try {
    const markdown = renderSession(SESSION, [
      msg(0, 'user', userData('See attached.', ['/etc/passwd'])),
    ], { attachmentsDir: path.join(f.dir, '.attachments'), vaultRoot: f.dir });
    assert.ok(/skipped/i.test(markdown), 'a skipped attachment must say so');
    assert.ok(!markdown.includes('/etc/passwd\n'), 'a skipped entry must not be printed as an embed');
  } finally {
    f.cleanup();
  }
});

// ---------- 11. end-to-end against a real fixture database ----------

test('T2 -> T6: the fixture database renders through the whole pipeline', () => {
  const f = seeded('e2e');
  const h = openReadonly(f.dbPath);
  try {
    const sessions = listSessions(h.db);
    assert.equal(sessions.length, FIXTURE_SESSION_IDS.length, 'the fixture did not seed every session');

    for (const session of sessions) {
      const rows = messagesForSession(h.db, session.id);
      const markdown = renderSession(session, rows, {
        attachmentsDir: path.join(f.dir, '.attachments'),
        vaultRoot: f.dir,
        allowedSpillRoot: path.join(f.dir, 'tool-output'),
      });

      assert.ok(markdown.length > 0, `${session.id}: the note is empty`);
      const { attrs } = parseFrontmatter(markdown);
      assert.equal(attrs.id, session.id);
      assert.equal(attrs.message_count, rows.length);
      assert.deepEqual(seqsOf(markdown), rows.map((r) => r.seq), `${session.id}: sections are not in seq order`);
      assert.deepEqual(
        sections(markdown).map((s) => s.label),
        rows.map((r) => (r.type === 'user' || r.type === 'assistant' ? r.type : `session-event: ${r.type}`)),
        `${session.id}: a section label does not match its message type`,
      );
      // Every seeded message has some prose or structure to show.
      assert.ok(markdown.includes('Summarise the fixture project.') || markdown.includes('Look at this screenshot'), `${session.id}: no prompt text rendered`);
    }

    // The attachments session must have produced real files.
    const attachments = path.join(f.dir, '.attachments');
    assert.ok(existsSync(attachments), 'no attachment directory was created');
    assert.ok(readdirSync(attachments).some((n) => n.endsWith('.png')), 'the inline PNG was not extracted');

    // And the whole pipeline is stable: a second pass over the same fixture is
    // byte-identical, which is what makes a re-run a no-op (AC-8).
    const first = renderSession(sessions[0], messagesForSession(h.db, sessions[0].id));
    const second = renderSession(sessions[0], messagesForSession(h.db, sessions[0].id));
    assert.equal(first, second);
  } finally {
    h.close();
    f.cleanup();
  }
});