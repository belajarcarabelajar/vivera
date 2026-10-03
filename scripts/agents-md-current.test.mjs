// scripts/agents-md-current.test.mjs
//
// Guards for the detector that answers one question: does a repo's
// `## graphify` section still say what the INSTALLED graphify says?
//
// The drift this exists for is not a formatting nit. The section is an
// always-on instruction block — it is read by every agent session that opens
// the repo, and it is the only thing telling them a knowledge graph exists.
// Two repos on this machine carried the opposite claim:
//
//     No knowledge graph has been built in this directory yet: `graphify-out/`
//     does not exist. The graph is built on demand, so never assume one is
//     present — check `test -f graphify-out/graph.json` before relying on it.
//
// That sentence is false. ai-skills has a 644 KB graph whose `built_at_commit`
// equals HEAD; the vault has 5.7 MB. It is stale text left by an older graphify
// release and it survived every reinstall, because the installer treats "a
// `## graphify` section already exists" as a reason to refresh the section —
// not as a reason to check whether what it is about to overwrite is the
// current wording.
//
// A stale always-on block is the worst class of drift here, and the reason is
// asymmetry. If the section is MISSING, an agent reads no graphify instruction
// at all, asks the user, or falls back to grep — loud, and self-correcting. If
// the section is STALE and wrong, the agent reads confident prose telling it
// the graph is absent, skips `graphify query`, and produces a worse answer
// with total conviction and no signal that anything was wrong. Nothing fails.
// The only place this is visible is a comparison against the installed file.
//
// So the extractor below is not allowed to be approximate. graphify's own
// `_replace_or_append_section` defines what "the section" is — from a line that
// IS exactly `## graphify` to the line before the next `## `, last exact match
// winning — and a checker that extracts a different span than the installer
// would replace reports drift that does not exist and hides drift that does.
// That rule has two sharp edges, and both are pinned below rather than
// described: the marker is matched as a WHOLE LINE (a substring match once
// anchored the replace on a mention inside a bullet and deleted every line from
// there to the next heading, #1688), and when a section is followed by another
// H2 the extractor must stop at the heading, not swallow what follows.
//
// Fixtures are synthetic. A drift guard that asserted against the real repos
// would be permanently red until someone fixes it and permanently green
// afterwards, and in neither state is it evidence of anything. The one live
// test at the bottom is the deliberate exception and is written so that RED is
// the correct state today: it asserts the ai-skills block is current, and it
// fails, quoting the stale sentence it found. It goes green when the installer
// is re-run, and before that its failure is the measurement.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALWAYS_ON_BLOCK, UV_TOOL_SITE_PACKAGES, extractSection, normalise, checkAgentsMd } from './agents-md-current.mjs';

// ---------- fixtures ----------

// Every test builds its own tree. `bun test` does not guarantee file order
// within a file, so a shared mutable fixture would turn one test's edit into
// another test's mystery.
const madeDirs = [];

after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp repo root holding one AGENTS.md.
 *
 * `expected` is written beside it so tests never depend on the installed
 * graphify's current wording — except the one test that deliberately does.
 */
function makeRepo(agentsContent, { expected = null, marker = '## graphify' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agents-md-current-'));
  madeDirs.push(root);
  writeFileSync(join(root, 'AGENTS.md'), agentsContent, 'utf8');
  if (expected !== null) writeFileSync(join(root, 'expected.md'), expected, 'utf8');
  return {
    root,
    expectedPath: expected === null ? join(root, 'no-such-expected.md') : join(root, 'expected.md'),
    marker,
  };
}

/**
 * A synthetic always-on block, shaped like the real one: marker line, prose,
 * a rules list. Built here rather than pasted from the installed file so the
 * boundary tests read as boundary tests.
 */
const SYNTHETIC_BLOCK = [
  '## graphify',
  '',
  'This project has a knowledge graph at graphify-out/ with god nodes.',
  '',
  'When the user types `/graphify`, use the installed graphify skill.',
  '',
  'Rules:',
  '- Run `graphify query "<question>"` first.',
  '- Run `graphify update .` after modifying code.',
].join('\n');

/** The wording both real repos carry, which is what this module exists to catch. */
const STALE_BODY = [
  '',
  'No knowledge graph has been built in this directory yet: `graphify-out/` does',
  'not exist. The graph is built on demand, so never assume one is present —',
  'check `test -f graphify-out/graph.json` before relying on it.',
  '',
].join('\n');

// ---------- normalise ----------

test('normalise collapses CRLF and CR onto LF, so one verdict covers every platform', () => {
  const lf = '## graphify\n\nline one\nline two\n';
  const crlf = '## graphify\r\n\r\nline one\r\nline two\r\n';
  const cr = '## graphify\r\rline one\rline two\r';

  assert.equal(normalise(crlf), normalise(lf));
  assert.equal(normalise(cr), normalise(lf));
});

test('normalise drops trailing whitespace per line and blank padding at the edges', () => {
  // Trailing spaces are invisible in a diff view and are how an editor mangles a
  // block it never meant to touch. Leading and trailing blank lines come from the
  // blank-line separator the installer writes around the section.
  const padded = '\n\n## graphify   \n\nbody\t\n\n\n';
  assert.equal(normalise(padded), '## graphify\n\nbody');
});

test('normalise does not touch interior blank lines — a missing rule is a real difference', () => {
  // The tempting over-normalisation is collapsing runs of blank lines. That would
  // make a block that lost a paragraph compare equal to one that kept it, which
  // is precisely the silent-drift case this module is not allowed to have.
  assert.notEqual(normalise('a\n\nb'), normalise('a\n\n\nb'));
  assert.notEqual(normalise('a\n\nb'), normalise('a\nb'));
});

test('normalise is idempotent, so a report can be re-rendered and re-diffed', () => {
  const messy = '\r\n## graphify\r\n\r\nbody   \r\n\r\n';
  assert.equal(normalise(normalise(messy)), normalise(messy));
});

test('normalise survives a non-string instead of throwing', () => {
  // The same argument redact() makes: this function is handed whatever a file
  // read produced, and taking the whole check down over `null` is containment
  // failure, not strictness.
  assert.equal(normalise(null), '');
  assert.equal(normalise(undefined), '');
  assert.equal(normalise(42), '');
});

// ---------- extractSection: the boundary rule ----------

test('extractSection returns the whole section when the marker runs to EOF', () => {
  const content = `# Title\n\nintro\n\n${SYNTHETIC_BLOCK}\n`;
  const found = extractSection(content);

  assert.ok(found.startsWith('## graphify'), 'section must start at the marker line');
  assert.match(found, /graphify update/);
  assert.doesNotMatch(found, /intro/, 'content ABOVE the section must not be included');
});

test('extractSection stops at the next H2 and does not swallow it (#1688 class)', () => {
  // The installer's boundary is the next line that STARTS WITH `## ` — not a
  // stripped comparison, and not "the end of the file". A checker that runs to
  // EOF here reports drift for a file whose graphify section is perfectly fine,
  // because every following H2 is counted as part of the block.
  const content = [
    '## graphify',
    '',
    'graphify body',
    '',
    '## House Rules',
    '',
    'hand-written content that graphify must never touch',
    '',
  ].join('\n');

  const found = extractSection(content);
  assert.equal(found, '## graphify\n\ngraphify body');
  assert.doesNotMatch(found, /House Rules/);
  assert.doesNotMatch(found, /hand-written/);
});

test('extractSection ignores an indented H2, because the installer boundary does', () => {
  // `startsWith('## ')` on the raw line, no strip. A nested heading inside a
  // fenced example or an indented list item is not a boundary, and treating it
  // as one truncates the section mid-body and invents drift.
  const content = ['## graphify', '', 'body', '', '  ## nested inside an example', '', 'more body', ''].join('\n');
  const found = extractSection(content);
  assert.match(found, /more body/, 'an indented `## ` must not end the section');
});

test('extractSection does not treat the marker as a substring (#1688)', () => {
  // The real incident: an unanchored `## graphify` match inside a bullet
  // anchored the replace there, and every line from that bullet to the next
  // heading was deleted. The negative is the assertion here — a mention is not
  // a section, and this extractor must report "nothing found" rather than
  // inventing one and then claiming the hand-written lines below are drift.
  const content = [
    '# Notes',
    '',
    '- Keep the `## graphify` heading exactly as graphify writes it.',
    '- See also: ## graphify-rules for the adjacent block.',
    '',
    '## Other',
    '',
    'unrelated prose',
    '',
  ].join('\n');

  assert.equal(extractSection(content), null);
});

test('extractSection does not match a longer heading that starts with the marker', () => {
  // `### graphify` and `## graphify (advanced)` are different headings. A
  // startsWith match on the marker text would grab either.
  const content = ['### graphify', '', 'sub-heading body', '', '## graphify (extra)', '', 'x', ''].join('\n');
  assert.equal(extractSection(content), null);
});

test('extractSection matches a marker line that merely carries surrounding whitespace', () => {
  // `_replace_or_append_section` compares `line.strip() == marker`, so a
  // trailing space still counts. Mirror that or the two disagree about which
  // lines are anchors.
  const found = extractSection(['## graphify  ', '', 'body', ''].join('\n'));
  assert.equal(found, '## graphify  \n\nbody');
});

test('with two exact headings the LAST one wins, because graphify appends', () => {
  const content = [
    '## graphify',
    '',
    'older copy',
    '',
    '## Something Else',
    '',
    'middle content',
    '',
    '## graphify',
    '',
    'newer copy',
    '',
  ].join('\n');

  const found = extractSection(content);
  assert.match(found, /newer copy/);
  assert.doesNotMatch(found, /older copy/, 'the LAST exact heading is the section, not the first');
});

test('extractSection returns null for a file with no exact marker line', () => {
  assert.equal(extractSection('# Title\n\njust prose\n'), null);
  assert.equal(extractSection(''), null);
  assert.equal(extractSection(null), null);
});

test('extractSection honours a custom marker', () => {
  const content = ['## House Rules', '', 'body', '', '## graphify', '', 'other', ''].join('\n');
  assert.equal(extractSection(content, '## House Rules'), '## House Rules\n\nbody');
});

// ---------- checkAgentsMd: the verdicts ----------

test('a section identical to the expected block is current', () => {
  // The trailing prose is under its OWN H2 on purpose. Content after the last
  // H2 is part of the graphify section by the installer's own rule, so a fixture
  // with bare trailing lines would be asserting something the installer would
  // not agree with — it would report drift for a file graphify itself would
  // leave alone.
  const { root, expectedPath } = makeRepo(
    ['# Title', '', 'intro', '', SYNTHETIC_BLOCK, '', '## After', '', 'trailing prose', ''].join('\n'),
    { expected: SYNTHETIC_BLOCK },
  );

  const result = checkAgentsMd(root, { expectedPath });
  assert.equal(result.current, true, result.reason);
  assert.equal(normalise(result.found), normalise(SYNTHETIC_BLOCK));
  assert.equal(normalise(result.expected), normalise(SYNTHETIC_BLOCK));
});

test('a section followed by another H2 is current when its own body matches', () => {
  const { root, expectedPath } = makeRepo(
    ['## graphify', '', 'graphify body', '', '## House Rules', '', 'hand-written', ''].join('\n'),
    { expected: ['## graphify', '', 'graphify body'].join('\n') },
  );

  const result = checkAgentsMd(root, { expectedPath });
  assert.equal(result.current, true, result.reason);
});

test('CRLF and LF copies of the same block get the same verdict', () => {
  // Without this the checker is a Windows bug report waiting to happen: git
  // `core.autocrlf` on one machine, none on the next, and a "drift" that is only
  // a line-ending convention.
  const lf = makeRepo(`${SYNTHETIC_BLOCK}\n`, { expected: SYNTHETIC_BLOCK });
  const crlf = makeRepo(`${SYNTHETIC_BLOCK}\r\n`, { expected: SYNTHETIC_BLOCK });

  assert.equal(checkAgentsMd(lf.root, { expectedPath: lf.expectedPath }).current, true);
  assert.equal(checkAgentsMd(crlf.root, { expectedPath: crlf.expectedPath }).current, true);
});

test('the stale "graph does not exist" wording is not current, and the reason says so', () => {
  const stale = `## graphify\n${STALE_BODY}\n- After modifying code, run \`graphify update .\`.\n`;
  const { root, expectedPath } = makeRepo(stale, { expected: SYNTHETIC_BLOCK });

  const result = checkAgentsMd(root, { expectedPath });
  assert.equal(result.current, false);
  assert.match(result.reason, /claims/i, `reason must name the false claim: ${result.reason}`);
  assert.match(result.reason, /graphify-out/, `reason must name what it claims about: ${result.reason}`);
});

test('the reason points at the first differing line when there is no known claim to name', () => {
  // A generic "differs" is a shrug. Naming the line lets the next person see
  // whether this is a one-line edit or a wholesale reversion without diffing by
  // hand.
  const { root, expectedPath } = makeRepo(
    ['## graphify', '', 'unexpected wording here', '', 'Rules:', '- something else entirely', ''].join('\n'),
    { expected: SYNTHETIC_BLOCK },
  );

  const result = checkAgentsMd(root, { expectedPath });
  assert.equal(result.current, false);
  assert.match(result.reason, /line 3/, `reason must name the first differing line: ${result.reason}`);
  assert.doesNotMatch(result.reason, /claims/, 'a difference with no known cause must not borrow a known cause');
});

test('the reason records the contradiction only when a graph really is present on disk', () => {
  // The claim is only demonstrably false if `graphify-out/graph.json` exists
  // here. Saying "while graphify-out/graph.json is present" in a repo with no
  // graph would be the checker inventing evidence, which is the same failure it
  // exists to catch.
  const withoutGraph = makeRepo(['## graphify', `${STALE_BODY}\n- rule\n`].join('\n'), {
    expected: SYNTHETIC_BLOCK,
  });
  assert.doesNotMatch(checkAgentsMd(withoutGraph.root, { expectedPath: withoutGraph.expectedPath }).reason, /is present/);

  const withGraph = makeRepo(['## graphify', `${STALE_BODY}\n- rule\n`].join('\n'), {
    expected: SYNTHETIC_BLOCK,
  });
  mkdirSync(join(withGraph.root, 'graphify-out'), { recursive: true });
  writeFileSync(join(withGraph.root, 'graphify-out', 'graph.json'), '{}', 'utf8');

  const result = checkAgentsMd(withGraph.root, { expectedPath: withGraph.expectedPath });
  assert.equal(result.current, false);
  assert.match(result.reason, /graphify-out\/graph\.json is present/);
});

test('no `## graphify` heading is a distinct reportable state, not current', () => {
  const { root, expectedPath } = makeRepo('# Title\n\nprose about graphify\n\n## Rules\n\nmore prose\n', {
    expected: SYNTHETIC_BLOCK,
  });

  const result = checkAgentsMd(root, { expectedPath });
  assert.equal(result.current, false, 'a missing section is never "current"');
  assert.equal(result.found, null);
  assert.match(result.reason, /no `## graphify` heading/i, `reason must say the heading is absent: ${result.reason}`);
});

test('a missing AGENTS.md is reported as a missing file, not as a missing heading', () => {
  // The two states get the same boolean and completely different repairs, so
  // conflating them in the reason sends the next person to look in the wrong
  // place.
  const root = mkdtempSync(join(tmpdir(), 'agents-md-current-'));
  madeDirs.push(root);
  writeFileSync(join(root, 'expected.md'), SYNTHETIC_BLOCK, 'utf8');

  const result = checkAgentsMd(root, { expectedPath: join(root, 'expected.md') });
  assert.equal(result.current, false);
  assert.equal(result.found, null);
  assert.match(result.reason, /AGENTS\.md/i);
  assert.match(result.reason, /missing|does not exist|not found/i, result.reason);
});

test('a missing or unreadable expected block throws rather than reporting drift', () => {
  // This is environment breakage, not repository drift, and reporting it as
  // drift points the repair at the wrong repo entirely.
  const { root } = makeRepo('# nothing here\n');
  assert.throws(() => checkAgentsMd(root, { expectedPath: join(root, 'absent.md') }), /agents-md-current/);
});

test('checkAgentsMd defaults to the real AGENTS.md name and a custom fileName overrides it', () => {
  // The expected block is the same two lines the section carries, so the only
  // variable under test is WHICH file was read.
  const tiny = ['## graphify', '', 'body', ''].join('\n');
  const { root } = makeRepo(tiny, { expected: tiny });
  writeFileSync(join(root, 'CLAUDE.md'), tiny, 'utf8');

  const claude = checkAgentsMd(root, { expectedPath: join(root, 'expected.md'), fileName: 'CLAUDE.md' });
  assert.equal(claude.current, true, claude.reason);

  const missingNamedFile = checkAgentsMd(root, { expectedPath: join(root, 'expected.md'), fileName: 'AGENT.md' });
  assert.equal(missingNamedFile.current, false);
});

// ---------- the installed block, used for real ----------

// Reading the installed file is not a drift assertion — it cannot go stale in a
// way that means anything, because it IS the reference. It is skipped when
// graphify is not installed so this file still runs on a machine without it.
const installedBlockPresent = existsSync(ALWAYS_ON_BLOCK);

test(
  'a file carrying the installed block verbatim is current (skipped when graphify is absent)',
  { skip: installedBlockPresent ? false : `graphify is not installed; looked at ${ALWAYS_ON_BLOCK}` },
  () => {
    // The negative half: the synthetic block is NOT the installed one, so a file
    // carrying it must be reported as stale. Asserted rather than assumed, because
    // a checker that called everything current would make every other test in
    // this file pass vacuously.
    const synthetic = makeRepo(`# Project\n\n${SYNTHETIC_BLOCK}\n`, { expected: SYNTHETIC_BLOCK });
    assert.equal(checkAgentsMd(synthetic.root, { expectedPath: ALWAYS_ON_BLOCK }).current, false);

    // The positive half: the installed bytes, verbatim, in a file of our own.
    const installedText = readFileSync(ALWAYS_ON_BLOCK, 'utf8');
    const faithful = makeRepo(`# Project\n\n${installedText}\n`, { expected: SYNTHETIC_BLOCK });
    const real = checkAgentsMd(faithful.root, { expectedPath: ALWAYS_ON_BLOCK });
    assert.equal(real.current, true, real.reason);
  },
);

// ---------- live: the real defect (RED today, by design) ----------

// The live check targets the machine's real ai-skills checkout, not the copy
// of the repo this file runs from: a worktree carries a possibly mid-edit
// AGENTS.md, and the thing under test is the checkout agent sessions actually
// read. $AI_SKILLS_ROOT names it explicitly for non-default layouts;
// $HOME/ai-skills is the documented location.
const AI_SKILLS = process.env.AI_SKILLS_ROOT ?? join(homedir(), 'ai-skills');
const live = existsSync(AI_SKILLS) ? test : test.skip;

live('the real ai-skills AGENTS.md carries the current graphify block', () => {
  // THE RED TEST. It asserts `current === true`, so it fails today — and the
  // failure message is the measurement: it quotes the stale sentence that is
  // actually in the file rather than printing a diff nobody reads. It goes
  // green when the installer is re-run against the installed 0.9.73 block, and
  // stays green after that. Asserting `current === false` here instead would be
  // green today and red tomorrow, which is a test that reports the opposite of
  // the truth about a repo that is fixed.
  const result = checkAgentsMd(AI_SKILLS);

  assert.equal(
    result.current,
    true,
    `ai-skills AGENTS.md is stale. ${result.reason}\n\n` +
      `The section currently claims:\n${result.found ?? '(nothing found)'}\n\n` +
      `The installed block (${ALWAYS_ON_BLOCK}) says:\n${result.expected}`,
  );
});

// ---------- hygiene: no machine-specific path in the source ----------

test('the fallback site-packages path is derived from the machine, never baked in', () => {
  // A hard-coded /home/<user> literal resolves on exactly one machine. On
  // every other checkout the fallback silently names a directory that cannot
  // exist, and a drift report naming a path nobody has is how a real drift
  // report gets ignored. The fallback must therefore stay homedir-derived,
  // and this test reads the module's own source to keep it that way.
  const source = readFileSync(
    fileURLToPath(new URL('./agents-md-current.mjs', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /['"`]\/home\//,
    'agents-md-current.mjs hard-codes a path starting with /home/; derive it from os.homedir() instead',
  );
  assert.equal(
    UV_TOOL_SITE_PACKAGES,
    join(homedir(), '.local/share/uv/tools/graphifyy/lib/python3.14/site-packages'),
    'the fallback must be the uv tool layout under the machine home',
  );
});