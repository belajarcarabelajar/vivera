// scripts/plan-publish-frontmatter.test.mjs
//
// Guards for the plan -> Obsidian frontmatter transform.
//
// The published mirror has to satisfy two contracts at once, and they pull in
// opposite directions:
//
//   1. The vault needs PARA properties (`title`, `type`, `para`, `status`,
//      `created`, ...) to file, search and graph the note.
//   2. `ultra-plan-runner.mjs` needs the ORIGINAL `ultra-plan/v1` document,
//      including the nested `tasks:` array, byte-for-byte. A YAML parse-and-
//      redump would reflow and re-indent that array and quietly break the
//      runner contract while still "looking" like valid YAML.
//
// The second point is why this module exists as a pure, line-level transform
// with an injected `ctx.exists` instead of a script that reads the plan and
// probes the vault itself: a transform you cannot call without a real vault is
// a transform nobody tests, and an untested frontmatter merge is how a mirror
// ends up with a wikilink to a file that does not exist.
//
// Every fixture is an inline string. Nothing here touches the real filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter, mergeFrontmatter, PUBLISHER_VERSION } from './plan-publish-frontmatter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_PATH = path.join(ROOT, 'docs', 'code-plan', 'plans', '2026-09-26-plan-publish-to-obsidian.md');
const VAULT_ROOT = path.join(homedir(), 'Dokumen/Obsidian Vault');
const INDEX_PATH = `${VAULT_ROOT}/01 - Projects/vivera/index.md`;
const INDEX_LINK = '01 - Projects/vivera/index';
const FILENAME = '2026-09-26-plan-publish-to-obsidian.md';

// A realistic `ultra-plan/v1` document. The `tasks:` block is deliberately
// awkward: flow-style maps, quoted strings, empty lists, deep nesting. Anything
// that re-serializes this instead of copying the lines will change it.
const TASKS_BLOCK = [
  'tasks:',
  '  - id: T1',
  '    depends_on: []',
  '    files: { create: [plans.publish.json, scripts/plan-publish-registry.mjs], modify: [], test: [scripts/plan-publish-registry.test.mjs] }',
  '    idempotency_key: "T1:plans.publish.json"',
  '    skip_if: "bun test scripts/plan-publish-registry.test.mjs"',
  '    verify_exit: 0',
  '  - id: T2',
  '    depends_on: [T1]',
  '    files: { create: [scripts/plan-publish-frontmatter.mjs], modify: [], test: [scripts/plan-publish-frontmatter.test.mjs] }',
  '    idempotency_key: "T2:scripts/plan-publish-frontmatter.mjs"',
  '    verify_exit: 0',
].join('\n');

function plan({ status = 'Draft', frontmatter = true, body } = {}) {
  const fm = [
    '---',
    'schema: ultra-plan/v1',
    'plan_id: 2026-09-26-plan-publish-to-obsidian',
    ...(status === null ? [] : [`status: ${status}`]),
    'version: 1',
    'runner_contract: true',
    'defaults:',
    '  retry_transient_max: 1',
    '  on_precondition_fail: stop-task-continue-independent',
    TASKS_BLOCK,
  ];
  const text = body ?? '# Plan Publishing to Obsidian — Implementation Plan\n\nSome prose.\n';
  return frontmatter ? `${fm.join('\n')}\n---\n\n${text}` : text;
}

// `ctx` with an injected existence predicate. No fs access anywhere.
// `vaultRoot` is part of the contract (it is what makes the `related` link
// resolvable); `null` here means "caller did not supply it".
function ctx({ exists = false, vaultRoot = VAULT_ROOT, ...over } = {}) {
  const seen = [];
  return {
    seen,
    planPath: PLAN_PATH,
    projectName: 'vivera',
    today: '2026-09-26',
    indexPath: INDEX_PATH,
    vaultRoot,
    exists: (p) => {
      seen.push(p);
      return exists;
    },
    ...over,
  };
}

// Read a scalar out of the published frontmatter, unquoting when needed.
// Returns the RAW scalar, quotes included, because several tests assert on the
// emitted SPELLING (that a value is quoted) rather than on its value. Use
// `fmScalar` below when the value itself is what matters.
function fmValue(doc, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(doc);
  return m ? m[1] : undefined;
}

// Mirrors the production reader (`readFrontmatterScalar` in plan-publish.mjs):
// it strips one layer of surrounding quotes before returning the value, so a
// quoted scalar reads the same here as it does where freshness is decided.
function fmScalar(doc, key) {
  const raw = fmValue(doc, key);
  return raw === undefined ? undefined : raw.replace(/^["'](.*)["']$/, '$1').trim();
}

function hasKey(doc, key) {
  return new RegExp(`^${key}:`, 'm').test(doc);
}

// ---------- splitFrontmatter ----------

test('splitFrontmatter returns the YAML block without its fences', () => {
  const { frontmatter, body } = splitFrontmatter(plan());
  assert.match(frontmatter, /^schema: ultra-plan\/v1$/m);
  assert.ok(!frontmatter.startsWith('---'));
  assert.ok(body.startsWith('# Plan Publishing to Obsidian'));
  assert.equal(`---\n${frontmatter}\n---\n\n${body}`, plan());
});

test('splitFrontmatter passes through text that has no frontmatter', () => {
  const raw = '# Just a heading\n\nno fences here\n';
  assert.deepEqual(splitFrontmatter(raw), { frontmatter: '', body: raw });
});

test('splitFrontmatter passes through an unterminated fence', () => {
  const raw = '---\nschema: ultra-plan/v1\nstill going\n';
  assert.deepEqual(splitFrontmatter(raw), { frontmatter: '', body: raw });
});

// ---------- title ----------

test('title is the first level-1 heading of the body', () => {
  const out = mergeFrontmatter(plan(), ctx());
  assert.equal(fmValue(out, 'title'), 'Plan Publishing to Obsidian — Implementation Plan');
});

test('title ignores deeper headings and falls back to the filename stem', () => {
  const body = '## Not level one\n\n### Also not level one\n\ntext only\n';
  const out = mergeFrontmatter(plan({ body }), ctx());
  assert.equal(fmValue(out, 'title'), '2026-09-26-plan-publish-to-obsidian');
});

test('title falls back to the stem when the body has no heading at all', () => {
  const out = mergeFrontmatter(plan({ body: 'prose with no heading\n' }), ctx());
  assert.equal(fmValue(out, 'title'), '2026-09-26-plan-publish-to-obsidian');
});

test('a heading containing YAML-hostile characters stays quoted and parseable', () => {
  const body = '# Plan: publish "everything" - {not: yaml}\n';
  const out = mergeFrontmatter(plan({ body }), ctx());
  const raw = fmValue(out, 'title');
  assert.ok(raw.startsWith('"') && raw.endsWith('"'), `title must be quoted, got: ${raw}`);
  assert.equal(JSON.parse(raw), 'Plan: publish "everything" - {not: yaml}');
});

// ---------- constants ----------

test('type and para use the vault-measured vocabulary, not the PARA folder names', () => {
  const out = mergeFrontmatter(plan(), ctx());
  // Measured across all 2757 markdown files of the target vault:
  //   para  -> resource(18) system(12) common(6) project(4); `projects`: 0
  //   type  -> note(717+295) reference(16+15) source(11) audit(8) ... ; `project`: 0
  // The vault is the authority. `para: project` matches its 4 precedents;
  // `type: note` matches its dominant type. Inventing `type: plan` would be a
  // schema change, which the vault's own skill forbids without approval.
  assert.equal(fmValue(out, 'type'), 'note');
  assert.equal(fmValue(out, 'para'), 'project');
  assert.equal(fmValue(out, 'project'), 'vivera');
  assert.equal(fmValue(out, 'source_path'), PLAN_PATH);
});

test('the retired constants cannot come back', () => {
  const out = mergeFrontmatter(plan(), ctx());
  assert.ok(!/^type: project$/m.test(out), 'type: project does not exist in the vault');
  assert.ok(!/^para: projects$/m.test(out), 'para: projects does not exist in the vault');
  assert.ok(!/^type: plan$/m.test(out), 'type: plan would be an unapproved schema change');
  // ...and the vault-flavoured spellings are present exactly once each.
  assert.equal(out.match(/^type: note$/gm).length, 1);
  assert.equal(out.match(/^para: project$/gm).length, 1);
});

test('an existing type/para in the source is overwritten, not duplicated', () => {
  const src = plan().replace('schema: ultra-plan/v1', 'schema: ultra-plan/v1\ntype: log\npara: system');
  const out = mergeFrontmatter(src, ctx());
  assert.equal(fmValue(out, 'type'), 'note');
  assert.equal(fmValue(out, 'para'), 'project');
  assert.equal(out.match(/^type:/gm).length, 1);
  assert.equal(out.match(/^para:/gm).length, 1);
  assert.ok(!out.includes('type: log'), 'the stale value is gone');
  assert.ok(!out.includes('para: system'), 'the stale value is gone');
});

test('a project name and path that are safe plain scalars stay unquoted', () => {
  // Vault-adjacent paths contain spaces; a plain scalar is legal there and keeps
  // the mirror greppable. Only genuinely ambiguous values get quoted.
  const c = ctx({ planPath: '/home/u/My Projects/docs/plans/2026-09-26-a.md' });
  const out = mergeFrontmatter(plan(), c);
  assert.equal(fmValue(out, 'source_path'), '/home/u/My Projects/docs/plans/2026-09-26-a.md');
  assert.equal(fmValue(out, 'created'), '2026-09-26');
});

// ---------- status ----------

test('status is copied verbatim, never remapped to another enum', () => {
  for (const status of ['InProgress', 'Verification', 'Complete', 'Blocked', 'Approved']) {
    const out = mergeFrontmatter(plan({ status }), ctx());
    assert.equal(fmValue(out, 'status'), status);
    assert.equal(hasKey(out, 'status'), true);
  }
});

test('a plan without a status key yields Draft', () => {
  const out = mergeFrontmatter(plan({ status: null }), ctx());
  assert.equal(fmValue(out, 'status'), 'Draft');
});

test('an existing status line is replaced, not duplicated', () => {
  const out = mergeFrontmatter(plan({ status: 'Draft' }), ctx());
  assert.equal(out.match(/^status:/gm).length, 1);
});

// ---------- dates ----------

test('created is parsed from the leading date in the plan filename', () => {
  const out = mergeFrontmatter(plan(), ctx());
  assert.equal(fmValue(out, 'created'), '2026-09-26');
});

test('updated comes from ctx.today, not from the machine clock', () => {
  const out = mergeFrontmatter(plan(), ctx({ today: '2030-01-02' }));
  assert.equal(fmValue(out, 'updated'), '2030-01-02');
  assert.notEqual(fmValue(out, 'updated'), fmValue(out, 'created'));
});

// ---------- publisher_version ----------

// Freshness detection cannot key on `source_hash` alone. `source_hash` is a
// hash of the PLAN TEXT, so improving the transform does not move it: every
// mirror written by an older publisher looked permanently current, was never
// rewritten, and `--check` reported those stale mirrors as OK. Observed on the
// real vault, not hypothesised. `publisher_version` is the second half of the
// freshness key: it moves exactly when the emitted output changes.

test('PUBLISHER_VERSION is a positive integer exported from this module', () => {
  assert.equal(typeof PUBLISHER_VERSION, 'number');
  assert.ok(Number.isInteger(PUBLISHER_VERSION), 'a stamp, not a package version like 0.1.0');
  assert.ok(PUBLISHER_VERSION > 0);
});

test('publisher_version is emitted with the constant value', () => {
  const out = mergeFrontmatter(plan(), ctx());
  assert.equal(fmValue(out, 'publisher_version'), String(PUBLISHER_VERSION));
  assert.match(out, /^publisher_version: \d+$/m, 'a bare integer, not a quoted string');
});

test('an existing publisher_version in the source is overwritten, not duplicated', () => {
  const src = plan().replace('schema: ultra-plan/v1', 'schema: ultra-plan/v1\npublisher_version: 999');
  const out = mergeFrontmatter(src, ctx());
  assert.equal(fmValue(out, 'publisher_version'), String(PUBLISHER_VERSION));
  assert.equal(out.match(/^publisher_version:/gm).length, 1, 'exactly one, never alongside');
  assert.ok(!out.includes('publisher_version: 999'), 'the stale value is gone');
});

test('the source plan is not mutated by the version stamp', () => {
  const src = plan();
  mergeFrontmatter(src, ctx());
  assert.ok(!src.includes('publisher_version'), 'inputs are read, never written back');
});

// ---------- related ----------

// The link text is the vault-RELATIVE path of the index, not a display name.
// Measured: the vault linter resolves `by_relative[target + ".md"]` first, then
// the file stem, then a title/heading key. `[[ai-skills index]]` matches none
// of the three (the page's title is "AI Skills"), and a bare `index` is
// ambiguous anyway — this vault holds seven `index.md` files. So the qualified
// path is the only form that resolves, and the only form emitted.

test('related is omitted entirely when the project index does not exist', () => {
  const c = ctx({ exists: false });
  const out = mergeFrontmatter(plan(), c);
  assert.equal(hasKey(out, 'related'), false, 'related key must be absent, not empty');
  assert.ok(!out.includes('[['), 'no wikilink may survive');
  assert.ok(!/^related:\s*\[\]/m.test(out), 'related must not be an empty list');
  assert.deepEqual(c.seen, [INDEX_PATH], 'exists() is consulted with the index path');
});

test('related carries the fully qualified vault-relative path when the index exists', () => {
  const out = mergeFrontmatter(plan(), ctx({ exists: true }));
  assert.equal(fmValue(out, 'related'), `["[[${INDEX_LINK}]]"]`);
});

test('the link is vault-relative, posix-separated, and never absolute', () => {
  const out = mergeFrontmatter(plan(), ctx({ exists: true }));
  const link = /\[\[([^\]]+)\]\]/.exec(out)[1];
  assert.equal(link, INDEX_LINK);
  assert.ok(!link.includes('\\'), 'no backslash separators');
  assert.ok(!link.startsWith('/'), 'never absolute');
  assert.ok(!VAULT_ROOT.includes(link), 'the vault root must not be inside the link');
  assert.equal(
    link,
    path.relative(VAULT_ROOT, INDEX_PATH).split(path.sep).join('/').replace(/\.md$/, ''),
    'link == path.relative(vaultRoot, indexPath), posix, without .md',
  );
});

test('the .md extension is stripped from the link', () => {
  const out = mergeFrontmatter(plan(), ctx({ exists: true }));
  const link = /\[\[([^\]]+)\]\]/.exec(out)[1];
  assert.ok(!link.endsWith('.md'), 'the linter appends .md itself when resolving');
  assert.ok(!link.includes('.md'), 'no .md anywhere in the link');
});

test('related is omitted when vaultRoot is absent, with no fallback to a display name', () => {
  const c = ctx({ exists: true, vaultRoot: null });
  delete c.vaultRoot;
  const out = mergeFrontmatter(plan(), c);
  assert.equal(hasKey(out, 'related'), false, 'fail closed');
  assert.ok(!out.includes('ai-skills index'), 'the known-broken display name must never come back');
  assert.ok(!out.includes('[['), 'no wikilink at all');
  // No link can be built, so the existence question is not even asked: there is
  // no answer this transform could use.
  assert.deepEqual(c.seen, []);
});

test('related is omitted when indexPath sits outside vaultRoot', () => {
  const c = ctx({ exists: true, indexPath: '/somewhere/else/01 - Projects/ai-skills/index.md' });
  const out = mergeFrontmatter(plan(), c);
  assert.equal(hasKey(out, 'related'), false, 'a ../ link would be a different broken link');
  assert.ok(!out.includes('..'), 'no parent-relative link');
});

test('related is omitted when no index path is available at all', () => {
  const c = ctx({ exists: true });
  delete c.indexPath;
  const out = mergeFrontmatter(plan(), c);
  assert.equal(hasKey(out, 'related'), false);
  assert.deepEqual(c.seen, [], 'without a path there is nothing to test');
});

test('a nested index under a spaced folder keeps its spaces and stays resolvable', () => {
  const c = ctx({
    exists: true,
    vaultRoot: VAULT_ROOT,
    indexPath: `${VAULT_ROOT}/90 - System/Legacy/Restricted Sources/index.md`,
  });
  const out = mergeFrontmatter(plan(), c);
  assert.equal(fmValue(out, 'related'), '["[[90 - System/Legacy/Restricted Sources/index]]"]');
});

test('the Related body section still carries the source as plain text, not a link', () => {
  const out = mergeFrontmatter(plan(), ctx({ exists: true }));
  assert.ok(out.includes(`Source: ${PLAN_PATH}`));
  assert.ok(!/\[\[[^\]]*plan-publish-to-obsidian/.test(out),
    'the source lives outside the vault and must stay plain text');
});

// ---------- source_hash ----------

test('source_hash is 12 hex characters and hashes the input, not the output', () => {
  const text = plan();
  const out = mergeFrontmatter(text, ctx());
  const expected = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  const got = fmScalar(out, 'source_hash');
  assert.match(got, /^[0-9a-f]{12}$/);
  assert.equal(got, expected);
  assert.notEqual(got, createHash('sha256').update(out, 'utf8').digest('hex').slice(0, 12));
});

// The quoting is the fix, so it is asserted as SPELLING rather than inferred
// from the value. Asserting the value cannot catch it: `plan()` hashes to a
// digest containing letters, which no YAML reader would coerce even unquoted.
// The hazard only appears on the roughly one digest in a few hundred that is
// all digits or contains a digit-`e`-digit run, and that is exactly why the
// mirror looked healthy right up until it did not.
//
// No YAML parser is needed, and deliberately none is added: this repository has
// no YAML dependency, which is the same reason the defect survived — every
// reader here, production included, matches frontmatter with a regex and so
// never sees a coerced value.
test('source_hash is emitted quoted, so a YAML reader cannot coerce it to a number', () => {
  const out = mergeFrontmatter(plan(), ctx());
  const raw = fmValue(out, 'source_hash');
  assert.ok(raw.startsWith('"') && raw.endsWith('"'), `source_hash must be quoted, got: ${raw}`);
  assert.match(fmScalar(out, 'source_hash'), /^[0-9a-f]{12}$/);
});

test('a bare numeric-shaped hash is what makes the quoting load-bearing', () => {
  // The shape that broke the real mirror: 12 characters, no YAML indicator, but
  // a leading digit run followed by `e` and more digits, so a plain scalar
  // matches the float grammar. `174e45826234` is the digest that shipped.
  const hazardous = '174e45826234';
  assert.match(hazardous, /^[0-9a-f]{12}$/, 'still a valid hash shape');
  // Quoted it is a string; bare it is not. Number.isFinite is false for
  // Infinity, which is what a reader produced and what Obsidian then showed as
  // an empty property.
  assert.equal(Number(hazardous), Infinity);
  assert.ok(!Number.isFinite(Number(hazardous)));
});

test('source_hash is stable across two calls on identical input', () => {
  const text = plan();
  const a = mergeFrontmatter(text, ctx());
  const b = mergeFrontmatter(text, ctx());
  assert.equal(fmScalar(a, 'source_hash'), fmScalar(b, 'source_hash'));
});

test('source_hash changes when one character of the plan changes', () => {
  const a = mergeFrontmatter(plan(), ctx());
  const b = mergeFrontmatter(plan({ body: '# Plan Publishing to Obsidian - Implementation Plan\n' }), ctx());
  assert.notEqual(fmScalar(a, 'source_hash'), fmScalar(b, 'source_hash'));
});

// ---------- pass-through: the runner contract ----------

test('the tasks array survives byte-identical', () => {
  const out = mergeFrontmatter(plan(), ctx());
  assert.ok(out.includes(TASKS_BLOCK), 'tasks block must appear verbatim in the output');
  // ...and no key of ours leaked into the middle of it.
  assert.equal(out.match(/^  - id: T\d$/gm).length, 2);
  assert.equal(out.match(/^tasks:$/gm).length, 1);
});

test('every other ultra-plan key survives untouched', () => {
  const out = mergeFrontmatter(plan(), ctx());
  for (const line of [
    'schema: ultra-plan/v1',
    'plan_id: 2026-09-26-plan-publish-to-obsidian',
    'version: 1',
    'runner_contract: true',
    'defaults:',
    '  retry_transient_max: 1',
    '  on_precondition_fail: stop-task-continue-independent',
  ]) {
    assert.ok(out.includes(line + '\n'), `missing: ${line}`);
  }
  const published = splitFrontmatter(out).frontmatter;
  assert.match(published, /^schema: ultra-plan\/v1$/m);
  assert.match(published, /^runner_contract: true$/m);
});

test('the output still opens and closes exactly one frontmatter fence', () => {
  const out = mergeFrontmatter(plan(), ctx());
  const { frontmatter, body } = splitFrontmatter(out);
  assert.ok(frontmatter.includes('schema: ultra-plan/v1'));
  assert.ok(body.startsWith('# Plan Publishing to Obsidian'));
});

test('re-transforming the published text reproduces it except for source_hash', () => {
  // NOT byte-idempotent, by design: `source_hash` is the hash of the INPUT, per
  // §3.3, so feeding the mirror back in necessarily hashes the mirror. This
  // transform is applied to plans, never to its own output — plan-publish.mjs
  // detects an unchanged plan by comparing the destination's `source_hash` with
  // the hash of the PLAN. Everything except that one line must still be stable,
  // or a re-publish would churn the mirror.
  const out = mergeFrontmatter(plan(), ctx());
  const again = mergeFrontmatter(out, ctx());
  const strip = (s) => s.split('\n').filter((l) => !l.startsWith('source_hash:')).join('\n');
  assert.equal(strip(again), strip(out));
  assert.notEqual(fmValue(again, 'source_hash'), fmValue(out, 'source_hash'));
  assert.equal(again.match(/^Source: /gm).length, 1);
  assert.equal(again.match(/^## Related$/gm).length, 1);
});

// ---------- degenerate inputs ----------

test('a document with no frontmatter at all is handled without throwing', () => {
  const text = '# Bare Plan\n\nno frontmatter here\n';
  const out = mergeFrontmatter(text, ctx({ exists: true }));
  const { frontmatter, body } = splitFrontmatter(out);
  assert.ok(frontmatter.includes('type: note'));
  assert.ok(frontmatter.includes('para: project'));
  assert.ok(frontmatter.includes('status: Draft'));
  assert.ok(body.startsWith('# Bare Plan'));
});

test('a frontmatter-less plan gains exactly one fence pair, and its body is untouched', () => {
  // Measured: of 268 plan files across the three mirrored projects, only 40
  // declare `schema: ultra-plan/v1`; 228 have no frontmatter at all. So the
  // fence-less input is the COMMON case, not an edge case: the `---` pair is
  // emitted unconditionally and the body is copied through verbatim.
  const body = '# Bare Plan\n\n## 1. Intent\n\n- a bullet with a -- dash\n\n```yaml\nnot: frontmatter\n---\nstill body\n```\n';
  const text = body;
  const out = mergeFrontmatter(text, ctx());
  assert.equal(splitFrontmatter(text).frontmatter, '', 'precondition: input has no frontmatter');
  const { frontmatter, body: outBody } = splitFrontmatter(out);
  assert.ok(frontmatter.startsWith('title: Bare Plan\n'));
  // The body is copied through verbatim, plus the one appended Related block.
  const expectedBody = `${body.replace(/\s+$/, '')}\n\n## Related\n\nSource: ${PLAN_PATH}\n`;
  assert.equal(outBody, expectedBody, 'body unchanged apart from the appended Related block');
  // The `---` inside the fenced code block is body content and must not have
  // been mistaken for a closing fence: exactly one of the three survives, and
  // it survives in the body.
  assert.equal(outBody.match(/^---$/gm).length, 1, 'the code-fence --- stayed in the body');
  assert.equal(frontmatter.includes('---'), false, 'the new block holds no stray fence');
  assert.equal(out.match(/^---$/gm).length, 3, 'one fence pair plus the body ---');
  assert.equal((out.match(/^schema:/gm) ?? []).length, 0, 'no ultra-plan keys are invented');
});

test('an empty string does not throw and still yields a parseable document', () => {
  const out = mergeFrontmatter('', ctx());
  assert.equal(fmValue(out, 'title'), '2026-09-26-plan-publish-to-obsidian');
  assert.equal(fmValue(out, 'status'), 'Draft');
  assert.ok(splitFrontmatter(out).frontmatter.includes('source_hash:'));
});

test('a plan whose status is missing but has other ultra-plan keys keeps them', () => {
  const out = mergeFrontmatter(plan({ status: null }), ctx());
  assert.ok(out.includes('schema: ultra-plan/v1'));
  assert.ok(out.includes(TASKS_BLOCK));
});

// ---------- the Related section ----------

test('a Related section is appended with the source path as plain text', () => {
  const out = mergeFrontmatter(plan(), ctx());
  assert.match(out, /\n## Related\n/);
  assert.ok(out.includes(`Source: ${PLAN_PATH}`));
  assert.ok(!/\[\[.*2026-09-26-plan-publish-to-obsidian.*\]\]/.test(out),
    'the source lives outside the vault and must never be a wikilink');
});

test('an existing Related section is extended, not duplicated', () => {
  const body = '# Plan\n\n## Related\n\n- Something else\n\n## Next\n\ntail\n';
  const out = mergeFrontmatter(plan({ body }), ctx());
  assert.equal(out.match(/^## Related$/gm).length, 1);
  const relatedIdx = out.indexOf('## Related');
  const nextIdx = out.indexOf('## Next');
  assert.ok(relatedIdx !== -1 && nextIdx !== -1);
  const section = out.slice(relatedIdx, nextIdx);
  assert.ok(section.includes('Source: ' + PLAN_PATH), 'the line belongs to the existing section');
  assert.ok(section.includes('- Something else'), 'existing content is preserved');
});

test('re-running on the published text does not duplicate the Related line', () => {
  const once = mergeFrontmatter(plan(), ctx());
  const twice = mergeFrontmatter(once, ctx());
  assert.equal(twice.match(/^Source: /gm).length, 1);
  assert.equal(twice.match(/^## Related$/gm).length, 1);
});

// ---------- published, beside the contract-required updated ----------
//
// WHY ADDITIVE, NOT A RENAME. The obvious fix for a misleading `updated` is to
// rename it to `published`, and that is wrong: `updated` is a REQUIRED mirror
// property. `tests/test_plan_mirror.py` in the vault lists it in
// REQUIRED_PROPERTIES and asserts every mirror note declares it, and the vault's
// own AGENTS.md Page Contract names it too. Renaming it would break the vault in
// order to fix the vault. So `updated` stays exactly as it is and `published`
// arrives beside it.
//
// WHAT `updated` ACTUALLY MEANS ON A MIRROR, which is the confusion this pair
// resolves: it is the date the publisher last ran, not the date the plan text
// last changed. A plan edited three months ago and re-published today shows
// `updated` as today. Nothing in a mirror can tell you when the plan changed;
// the plan's own history lives in git, and `source_hash` is the only field that
// proves the mirror matches its source right now.

test('emits published alongside the contract-required updated', () => {
  const out = mergeFrontmatter(plan(), ctx({ today: '2030-01-02' }));
  // Both present. `updated` is NOT removed: the vault test requires it.
  assert.equal(fmValue(out, 'updated'), '2030-01-02', 'updated stays; the vault contract requires it');
  assert.equal(fmValue(out, 'published'), '2030-01-02', 'published carries the same publish date');
  // They are the same value on purpose. Adding a property that computes
  // something else would invent a second meaning nobody can verify.
  assert.equal(fmValue(out, 'published'), fmValue(out, 'updated'));

  // The version stamp must move, or every one of the 271 existing mirrors keeps
  // looking current and none of them ever gains the property.
  assert.equal(PUBLISHER_VERSION, 2,
    'PUBLISHER_VERSION must be 2: the emitted document changed, and the bump is what '
    + 'forces the existing mirrors to re-publish. Asserted as a literal on purpose — '
    + 'this one test exists to fail the day someone forgets to bump it.');
});
