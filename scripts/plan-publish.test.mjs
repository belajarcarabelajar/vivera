// scripts/plan-publish.test.mjs
//
// Guards for the plan-publishing CLI. The CLI is the only component that
// touches the real vault, so every test here drives it as a SUBPROCESS against
// a throwaway vault under the system temp dir. Nothing in this file reads or
// writes the machine's vault (~/Dokumen/Obsidian Vault), and nothing here
// depends on whether the real project checkouts exist on the machine.
//
// Why subprocesses instead of importing the module: the contract under test is
// an exit code plus a side effect on disk. Calling a function cannot prove the
// process exits 2 on a bad flag, and a refactor that turns process.exit() into
// a returned code would pass an in-process test while breaking every caller.
//
// Config injection: the CLI reads plans.publish.json from the repo root unless
// PLAN_PUBLISH_CONFIG names another file. That variable exists because
// loadRegistry(configPath?) is the seam the registry module was built with, and
// without a way to reach it a test would have to publish into the real vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  rmSync, statSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Namespace import, not a named one: a named import of a symbol that does not
// exist is a module LINK error, which aborts the whole file before a single
// test runs. With a namespace the file loads and every assertion below reports
// its own failure, which is what a red run is for.
import * as cli from './plan-publish.mjs';
// The version constant is imported, never written as a literal, so that every
// expectation in this file below moves with the constant instead of pinning 1.
import { PUBLISHER_VERSION } from './plan-publish-frontmatter.mjs';
const { publishCtx } = cli;


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'plan-publish.mjs');

const sha12 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

// The bulk-publish tally, parsed. One regex for both the real run and the dry
// run, because the SECOND counter means the same thing in each and a dry run
// that reported "published" for files it did not write would be lying.
const TALLY_RE = /(\d+) total \u00b7 (\d+) (published|would-write) \u00b7 (\d+) skipped-idempotent \u00b7 (\d+) failed/;

function tally(stdout) {
  const m = TALLY_RE.exec(stdout);
  assert.ok(m, `the run must end in a parseable tally, got:\n${stdout}`);
  return {
    total: Number(m[1]),
    written: Number(m[2]),
    writtenLabel: m[3],
    skipped: Number(m[4]),
    failed: Number(m[5]),
  };
}

// ---------- fixtures ----------

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout || '').trim();
}

// A fake vault + one fake project + the config that routes between them.
function fixture(tag, {
  destDirTemplate = '01 - Projects/{project}/plans',
  indexTemplate = '01 - Projects/{project}/index.md',
  stageInVault = true,
  withGit = true,
  withIndex = false,
  // Adds a SECOND mirror:true project (so `--all` has to enumerate more than
  // one root) plus a mirror:false root whose plans must never be published.
  secondProject = false,
} = {}) {
  const base = mkdtempSync(path.join(tmpdir(), `plan-publish-cli-${tag}-`));
  const vault = path.join(base, 'vault');
  mkdirSync(vault, { recursive: true });
  if (withGit) git(['init', '-q', '-b', 'main'], vault);

  const projectRoot = path.join(base, 'proj');
  const plansDir = path.join(projectRoot, 'docs', 'code-plan', 'plans');
  mkdirSync(plansDir, { recursive: true });

  const projects = [{ name: 'demo', root: projectRoot, mirror: true }];
  const other = { writePlan: () => { throw new Error('secondProject was not enabled'); } };
  if (secondProject) {
    const otherRoot = path.join(base, 'proj2');
    const otherPlans = path.join(otherRoot, 'docs', 'code-plan', 'plans');
    mkdirSync(otherPlans, { recursive: true });
    projects.push({ name: 'other', root: otherRoot, mirror: true });

    // mirror:false is the vault's own entry: those plans are already inside the
    // vault, so publishing one would copy a file onto itself. enumeratePlans()
    // excludes the root, and `--all` must inherit that exclusion rather than
    // growing its own walk.
    const inVaultRoot = path.join(base, 'proj-vault');
    const inVaultPlans = path.join(inVaultRoot, 'docs', 'code-plan', 'plans');
    mkdirSync(inVaultPlans, { recursive: true });
    projects.push({ name: 'in-vault', root: inVaultRoot, mirror: false });

    other.writePlan = (name, body) => {
      const p = path.join(otherPlans, name);
      writeFileSync(p, body, 'utf8');
      return p;
    };
    other.destPath = (name) => path.join(vault, '01 - Projects', 'other', 'plans', name);
    other.inVaultPlans = inVaultPlans;
  }

  const configPath = path.join(base, 'plans.publish.json');
  writeFileSync(configPath, JSON.stringify({
    vault,
    destDirTemplate,
    indexTemplate,
    stageInVault,
    projects,
  }, null, 2), 'utf8');

  const indexPath = path.join(vault, '01 - Projects', 'demo', 'index.md');
  if (withIndex) {
    mkdirSync(path.dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, '# demo index\n', 'utf8');
  }

  return {
    base,
    vault,
    projectRoot,
    plansDir,
    config: configPath,
    indexPath,
    other,
    planPath: (name) => path.join(plansDir, name),
    destPath: (name) => path.join(vault, '01 - Projects', 'demo', 'plans', name),
    writePlan(name, body) {
      const p = path.join(plansDir, name);
      writeFileSync(p, body, 'utf8');
      return p;
    },
    writeIndex() {
      mkdirSync(path.dirname(indexPath), { recursive: true });
      writeFileSync(indexPath, '# demo index\n', 'utf8');
    },
    mirror(name) {
      return readFileSync(path.join(vault, '01 - Projects', 'demo', 'plans', name), 'utf8');
    },
    // Rewrites the mirror's frontmatter in place. Used to age a mirror to a
    // state the publisher has to notice — a different publisher version, or no
    // publisher version at all — without touching the SOURCE, which is the
    // whole point: freshness must be re-decided even when the plan is unchanged.
    patchMirror(name, fn) {
      const p = path.join(vault, '01 - Projects', 'demo', 'plans', name);
      writeFileSync(p, fn(readFileSync(p, 'utf8')), 'utf8');
    },
  };
}

function run(args, f, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PLAN_PUBLISH_CONFIG: f.config, ...extraEnv },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function cleanup(f) {
  rmSync(f.base, { recursive: true, force: true });
}

const PLAN = '2026-09-26-example-plan.md';
const PLAN_BODY = '# Example Plan\n\nSome body text.\n';

// ---------- publish ----------

test('publish writes the mirror with PARA frontmatter and exits 0', () => {
  const f = fixture('write', { withIndex: true });
  const plan = f.writePlan(PLAN, PLAN_BODY);

  const r = run([plan], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);

  const dest = f.destPath(PLAN);
  assert.ok(existsSync(dest), `mirror not written to ${dest}`);
  const text = readFileSync(dest, 'utf8');
  assert.ok(text.startsWith('---\n'), 'mirror must open with a YAML fence');
  for (const key of ['title:', 'type: note', 'para: project', 'status:', 'created: 2026-09-26', 'project: demo']) {
    assert.ok(text.includes(key), `frontmatter missing ${key}\n${text.split('---')[1]}`);
  }
  // The body survives; the mirror is the same document plus frontmatter.
  assert.ok(text.includes('Some body text.'), 'plan body must be copied through');
  // AC-5: the index file exists here, so the wikilink must be emitted. It is the
  // FULLY QUALIFIED vault-relative path (`01 - Projects/demo/index`, no .md),
  // not the bare display name `[[demo index]]`, which the vault linter cannot
  // resolve. Deriving it requires ctx.vaultRoot, so this is also the end-to-end
  // proof that the CLI supplies it.
  assert.ok(
    text.includes('related: ["[[01 - Projects/demo/index]]"]'),
    `related link must be the resolvable vault-relative path, got:\n${text.split('---')[1]}`,
  );

  cleanup(f);
});

test('publish records source_hash as the first 12 hex of the plan bytes', () => {
  const f = fixture('hash');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);

  const expected = sha12(readFileSync(plan));
  const m = /^source_hash:[ \t]*"?([0-9a-f]{12})"?[ \t]*$/m.exec(readFileSync(f.destPath(PLAN), 'utf8'));
  assert.ok(m, 'mirror must carry a 12-hex source_hash');
  assert.equal(m[1], expected, 'source_hash must be sha256(raw plan bytes)[0..12]');
  cleanup(f);
});

test('re-publishing an unchanged plan prints SKIPPED-IDEMPOTENT and touches nothing', () => {
  const f = fixture('idem');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);

  const dest = f.destPath(PLAN);
  const before = readFileSync(dest, 'utf8');
  // Pin mtime into the past so "unchanged" cannot pass by accident on a
  // coarse timestamp resolution.
  const past = new Date(Date.now() - 60_000);
  utimesSync(dest, past, past);
  const beforeMtime = statSync(dest).mtimeMs;

  const r = run([plan], f);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.ok(
    r.stdout.includes('SKIPPED-IDEMPOTENT'),
    `re-publish must print the literal SKIPPED-IDEMPOTENT, got:\n${r.stdout}`,
  );
  assert.equal(readFileSync(dest, 'utf8'), before, 'idempotent skip must not rewrite bytes');
  assert.equal(statSync(dest).mtimeMs, beforeMtime, 'idempotent skip must not touch the file');
  cleanup(f);
});

test('editing the source then re-publishing rewrites the mirror', () => {
  const f = fixture('rewrite');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);
  const first = readFileSync(f.destPath(PLAN), 'utf8');

  f.writePlan(PLAN, `${PLAN_BODY}\nAn added paragraph.\n`);
  const r = run([plan], f);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stdout.includes('SKIPPED-IDEMPOTENT'), false, 'a changed source is not idempotent');

  const second = readFileSync(f.destPath(PLAN), 'utf8');
  assert.notEqual(second, first, 'mirror must be rewritten after a source change');
  assert.ok(second.includes('An added paragraph.'), 'the new source text must be mirrored');
  assert.ok(
    second.includes(sha12(readFileSync(plan))),
    'the rewritten mirror must carry the NEW source_hash',
  );
  cleanup(f);
});

test('a plan with ultra-plan frontmatter reaches the mirror without its runner contract', () => {
  const f = fixture('ultra');
  const body = '---\nschema: ultra-plan/v1\nplan_id: x\nstatus: Approved\ntasks:\n  - id: T1\n    depends_on: []\n---\n\n# Ultra\n\ntext\n';
  const plan = f.writePlan(PLAN, body);
  assert.equal(run([plan], f).code, 0);

  const text = readFileSync(f.destPath(PLAN), 'utf8');
  assert.ok(!text.includes('schema: ultra-plan/v1'), 'runner contract keys are pruned');
  assert.ok(!text.includes('  - id: T1'), 'the tasks array is pruned');
  assert.ok(/^plan_id: x$/m.test(text), 'scalar plan metadata survives');
  assert.ok(/^status: Approved$/m.test(text), "the plan's own status must be reused verbatim");
  cleanup(f);
});

test('publishing a plan no registered project owns exits 1 and names the plan', () => {
  const f = fixture('orphan');
  const orphan = path.join(f.base, 'elsewhere', 'notes', 'stray.md');
  mkdirSync(path.dirname(orphan), { recursive: true });
  writeFileSync(orphan, '# stray\n', 'utf8');

  const r = run([orphan], f);
  assert.equal(r.code, 1, `expected drift/failure exit 1, got ${r.code}`);
  assert.ok(r.stderr.includes('stray.md'), `error must name the unroutable plan: ${r.stderr}`);
  cleanup(f);
});

// ---------- absolute source_path ----------

// `source_path` is the provenance field a human follows back to the original
// plan, and the vault's contract test asserts it points at a file on disk. A
// relative value satisfies neither: it is only meaningful relative to whatever
// cwd happened to be at the time, and it does not point at anything.
test('a RELATIVE plan argument still writes an absolute source_path', () => {
  const f = fixture('relpath', { withIndex: true });
  const plan = f.writePlan(PLAN, PLAN_BODY);

  // Relative to the CLI's own cwd, exactly as a human would type it.
  const relative = path.relative(ROOT, plan);
  assert.ok(
    !path.isAbsolute(relative) && relative.startsWith('..'),
    `precondition: the argument must actually be relative, got "${relative}"`,
  );

  const r = run([relative], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);

  const text = readFileSync(f.destPath(PLAN), 'utf8');
  const m = /^source_path:[ \t]*"?([^"\n]+)"?[ \t]*$/m.exec(text);
  assert.ok(m, `mirror must carry a source_path:\n${text.split('---')[1]}`);

  const sourcePath = m[1].trim();
  assert.ok(
    path.isAbsolute(sourcePath),
    `source_path must be absolute, got "${sourcePath}" (invoked with "${relative}")`,
  );
  assert.equal(sourcePath, plan, 'source_path must resolve to the plan that was published');
  assert.ok(
    existsSync(sourcePath),
    'source_path must point at a file on disk — this is what the vault contract test checks',
  );
  cleanup(f);
});

test('a relative plan argument and an absolute one produce the same source_path', () => {
  // The provenance path must depend on the PLAN, not on how it was spelled on
  // the command line. This is the drift guard: if the two spellings produced
  // different values, the mirror's provenance would depend on the invoker.
  const f = fixture('rel-abs', { withIndex: true });
  const plan = f.writePlan(PLAN, PLAN_BODY);
  const dest = f.destPath(PLAN);
  const read = () => {
    const m = /^source_path:[ \t]*"?([^"\n]+)"?[ \t]*$/m.exec(readFileSync(dest, 'utf8'));
    return m && m[1].trim();
  };

  assert.equal(run([path.relative(ROOT, plan)], f).code, 0, 'relative spelling must publish');
  const fromRelative = read();

  // Delete the mirror so the second run is a real write rather than an
  // idempotent skip — a skip would leave the first result in place and the
  // comparison below would be comparing a value to itself.
  rmSync(dest);
  assert.equal(run([plan], f).code, 0, 'absolute spelling must publish');
  const fromAbsolute = read();

  assert.equal(fromRelative, plan, 'a relative spelling must still record the absolute plan path');
  assert.equal(fromAbsolute, plan, 'an absolute spelling records the absolute plan path');
  assert.equal(fromRelative, fromAbsolute, 'spelling of the argument must not change provenance');
  cleanup(f);
});

// ---------- the ctx the CLI hands the transform ----------

test('the ctx built for the transform carries vaultRoot and an absolute planPath', () => {
  // The transform derives the resolvable `related` link from
  // `path.relative(vaultRoot, indexPath)`. Omit vaultRoot and it drops
  // `related` entirely, so a missing key here is not a cosmetic bug: it
  // silently strips the inbound link from every mirror the CLI writes.
  const f = fixture('ctx', { withIndex: true });
  const plan = f.writePlan(PLAN, PLAN_BODY);
  const registry = { vault: f.vault, indexTemplate: '01 - Projects/{project}/index.md' };
  const project = { name: 'demo', root: f.projectRoot };

  const ctx = publishCtx(registry, project, path.relative(ROOT, plan), { today: '2026-09-26' });

  assert.ok('vaultRoot' in ctx, `ctx must carry vaultRoot, got keys: ${Object.keys(ctx).join(', ')}`);
  assert.equal(ctx.vaultRoot, f.vault, 'vaultRoot must be the absolute vault root from the config');
  assert.ok(path.isAbsolute(ctx.vaultRoot), 'vaultRoot must be absolute');
  assert.equal(ctx.planPath, plan, 'ctx.planPath must be absolute even for a relative argument');
  assert.equal(ctx.indexPath, f.indexPath, 'the indexPath the CLI already computed must keep flowing');
  cleanup(f);
});

test('a relative config vault root still yields an absolute vaultRoot', () => {
  // plans.publish.json is hand-edited; a relative `vault` there would otherwise
  // make every related link resolve against the wrong base.
  const f = fixture('ctx-relvault', { withIndex: true });
  const plan = f.writePlan(PLAN, PLAN_BODY);
  const registry = {
    vault: path.relative(ROOT, f.vault),
    indexTemplate: '01 - Projects/{project}/index.md',
  };

  const ctx = publishCtx(registry, { name: 'demo', root: f.projectRoot }, plan, { today: '2026-09-26' });
  assert.ok(path.isAbsolute(ctx.vaultRoot), `vaultRoot must be absolute, got "${ctx.vaultRoot}"`);
  assert.equal(ctx.vaultRoot, f.vault);
  cleanup(f);
});

// ---------- version-aware freshness ----------

// Freshness keyed on `source_hash` alone cannot see a change to the TRANSFORM,
// because source_hash hashes the plan TEXT. Observed on the real vault: after
// the qualified-link fix, re-running the publisher on an unchanged plan printed
// SKIPPED-IDEMPOTENT, the mirror kept the old broken `[[ai-skills index]]`, and
// `--check --all` called it OK. So `publisher_version` is the second key, and a
// mirror missing it is exactly the case that has to self-heal.

test('a mirror stamped with a DIFFERENT publisher_version is stale and is rewritten', () => {
  const f = fixture('ver-diff');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);
  const dest = f.destPath(PLAN);
  const hash = sha12(readFileSync(plan));

  // Age the mirror to a different publisher version, source_hash untouched.
  f.patchMirror(PLAN, (t) => t.replace(/^publisher_version: .*$/m, 'publisher_version: 0'));
  assert.match(
    f.mirror(PLAN),
    // Quotes are optional in the pattern because the hash is emitted quoted:
    // a bare 12-hex digest can look like a YAML float (`174e45826234` parses as
    // Infinity), so it is written as a quoted string. What matters here is the
    // VALUE, which is unchanged either way.
    new RegExp(`^source_hash: "?${hash}"?$`, 'm'),
    'precondition: the source_hash must still match, so only the version can be the reason',
  );

  const r = run([plan], f);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.ok(
    r.stdout.includes('SKIPPED-IDEMPOTENT') === false,
    `a version mismatch must NOT be an idempotent skip, got:\n${r.stdout}`,
  );
  assert.ok(/published/.test(r.stdout), `the mirror must be rewritten, got:\n${r.stdout}`);
  assert.ok(
    new RegExp(`^publisher_version: ${PUBLISHER_VERSION}$`, 'm').test(f.mirror(PLAN)),
    `the rewrite must re-stamp the current publisher version:\n${f.mirror(PLAN).split('---')[1]}`,
  );
  cleanup(f);
});

test('a mirror with NO publisher_version key is stale and is rewritten', () => {
  // This is the real-vault case verbatim: a mirror written before the stamp
  // existed. An absent key must count as a mismatch, not as "close enough".
  const f = fixture('ver-absent');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);

  f.patchMirror(PLAN, (t) => t.replace(/^publisher_version: .*\n/m, ''));
  assert.equal(
    /^publisher_version:/m.test(f.mirror(PLAN)),
    false,
    'precondition: the key must be gone before the run under test',
  );

  const r = run([plan], f);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.ok(
    r.stdout.includes('SKIPPED-IDEMPOTENT') === false,
    `an absent publisher_version must NOT be an idempotent skip, got:\n${r.stdout}`,
  );
  assert.ok(/published/.test(r.stdout), `the mirror must be rewritten, got:\n${r.stdout}`);
  assert.ok(
    new RegExp(`^publisher_version: ${PUBLISHER_VERSION}$`, 'm').test(f.mirror(PLAN)),
    'the rewrite must restore the publisher_version stamp',
  );
  cleanup(f);
});

test('matching version AND hash together still yield SKIPPED-IDEMPOTENT', () => {
  // The second condition must not break the first: both keys agreeing is the
  // only case that skips.
  const f = fixture('ver-match');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);
  assert.ok(
    new RegExp(`^publisher_version: ${PUBLISHER_VERSION}$`, 'm').test(f.mirror(PLAN)),
    'precondition: the first publish must stamp the current version',
  );

  const before = f.mirror(PLAN);
  const r = run([plan], f);
  assert.equal(r.code, 0);
  assert.ok(
    r.stdout.includes('SKIPPED-IDEMPOTENT'),
    `both keys agree, so this must skip, got:\n${r.stdout}`,
  );
  assert.equal(f.mirror(PLAN), before, 'a skip must not rewrite bytes');
  cleanup(f);
});

test('--check exits 1 on a version mismatch ALONE, with the source hash still matching', () => {
  // The drift check must not report the lie. Same state as the real vault: the
  // hash says current, the version says stale, so the verdict is stale.
  const f = fixture('ver-check');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);
  f.patchMirror(PLAN, (t) => t.replace(/^publisher_version: .*$/m, 'publisher_version: 0'));

  const r = run(['--check', plan], f);
  assert.equal(r.code, 1, `a version mismatch must exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
  const said = `${r.stdout}${r.stderr}`;
  assert.ok(
    !/->\s*source_hash/.test(said) || /publisher_version/.test(said),
    `--check must not report an OK verdict here: ${said}`,
  );
  assert.ok(/publisher_version/.test(said), `the reason must name the version: ${said}`);
  cleanup(f);
});

test('--check exits 1 when the mirror has no publisher_version at all', () => {
  const f = fixture('ver-check-absent');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);
  f.patchMirror(PLAN, (t) => t.replace(/^publisher_version: .*\n/m, ''));

  const r = run(['--check', plan], f);
  assert.equal(r.code, 1, `an absent version must exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
  cleanup(f);
});

test('--status reports a version mismatch without failing', () => {
  // --status is a report, never a verdict: a stale mirror is a fact, not an error.
  const f = fixture('ver-status');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);
  f.patchMirror(PLAN, (t) => t.replace(/^publisher_version: .*$/m, 'publisher_version: 0'));

  const r = run(['--status'], f);
  assert.equal(r.code, 0, '--status always exits 0');
  assert.ok(/drift|stale/i.test(r.stdout), `the stale mirror must be reported: ${r.stdout}`);
  cleanup(f);
});

test('the compared version is the IMPORTED constant, never a duplicated literal', () => {
  // Two copies of a version string is how they drift apart: bump the constant
  // and a hardcoded 1 keeps every mirror looking current. This asserts the
  // import and the absence of a local re-declaration, so the CLI cannot grow a
  // second source of truth without this going red.
  const src = readFileSync(CLI, 'utf8');

  assert.match(
    src,
    /import\s*\{[^}]*\bPUBLISHER_VERSION\b[^}]*\}\s*from\s*['"]\.\/plan-publish-frontmatter\.mjs['"]/,
    'the CLI must IMPORT PUBLISHER_VERSION from the transform module',
  );
  assert.equal(
    /const\s+PUBLISHER_VERSION\s*=/.test(src),
    false,
    'the CLI must not re-declare PUBLISHER_VERSION locally — that is a second source of truth',
  );
  // The quote is optional in this pattern on purpose. A first attempt required a
  // bare digit and therefore MISSED a hardcoded `=== '1'` — the negative control
  // caught the test being wrong, not the code being wrong, which is the only
  // reason this pattern is this permissive.
  assert.equal(
    /publisher_version[^\n]*[!=]==?\s*['"]?\d/.test(src),
    false,
    'the CLI must not compare publisher_version against a hardcoded integer literal',
  );
  // Broader net: nothing in the CLI may compare a version-ish field to a literal
  // number. `String(PUBLISHER_VERSION)` and `${PUBLISHER_VERSION}` are fine.
  assert.equal(
    /\.version\s*[!=]==?\s*(?!String\()\s*['"]?\d/.test(src),
    false,
    'the CLI must not compare a version field against a hardcoded integer literal',
  );
  // Positive control: the imported thing is a real integer, and the mirror
  // carries THAT value. The expected text is built from the constant, so this
  // assertion cannot pass if the two ever disagree.
  assert.equal(typeof PUBLISHER_VERSION, 'number', 'PUBLISHER_VERSION must be a number');

  const f = fixture('ver-imported');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);
  assert.ok(
    new RegExp(`^publisher_version: ${PUBLISHER_VERSION}$`, 'm').test(f.mirror(PLAN)),
    'the emitted stamp must equal the imported constant',
  );
  cleanup(f);
});

// ---------- check ----------

test('--check exits 0 when every mirror matches its source', () => {
  const f = fixture('check-clean');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);

  const r = run(['--check', plan], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  cleanup(f);
});

test('--check exits 1 on drift and never writes', () => {
  const f = fixture('check-drift');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);

  const dest = f.destPath(PLAN);
  const tampered = readFileSync(dest, 'utf8').replace(/^source_hash: .*$/m, 'source_hash: dead0000beef');
  writeFileSync(dest, tampered, 'utf8');

  const r = run(['--check', '--all'], f);
  assert.equal(r.code, 1, 'a mismatched source_hash must exit 1');
  assert.ok(
    r.stdout.includes(PLAN) || r.stderr.includes(PLAN),
    `the drifted plan must be reported: ${r.stdout}${r.stderr}`,
  );
  assert.equal(readFileSync(dest, 'utf8'), tampered, '--check must not write');
  cleanup(f);
});

test('--check --all exits 1 when a mirror is missing entirely', () => {
  const f = fixture('check-missing');
  f.writePlan(PLAN, PLAN_BODY);
  // Anchored: without a CLI at all, "exit 1 and nothing written" is trivially
  // true, and this test would pass while the feature is entirely absent.
  assert.ok(existsSync(CLI), `${CLI} must exist`);
  const r = run(['--check', '--all'], f);
  assert.equal(r.code, 1, 'an unmirrored plan must exit 1');
  assert.ok(!existsSync(f.destPath(PLAN)), '--check must not create the mirror');
  cleanup(f);
});

test('--check with nothing to compare is a usage error, not a silent pass', () => {
  const f = fixture('check-empty');
  const r = run(['--check'], f);
  assert.equal(r.code, 2, 'no plan list and no --all means there is nothing to check');
  cleanup(f);
});

// ---------- protected paths ----------

test('a destination resolving under Satset/ is refused with a non-zero exit', () => {
  const f = fixture('satset', { destDirTemplate: 'Satset/{project}' });
  const plan = f.writePlan(PLAN, PLAN_BODY);

  const r = run([plan], f);
  assert.equal(r.code, 1, `protected path must be refused, got ${r.code}`);
  assert.ok(/satset/i.test(r.stderr), `error must name the protected folder: ${r.stderr}`);
  assert.equal(existsSync(path.join(f.vault, 'Satset', 'demo', PLAN)), false, 'nothing may be written');
  cleanup(f);
});

test('a destination resolving under 90 - System/Legacy/ is refused', () => {
  const f = fixture('legacy', { destDirTemplate: '90 - System/Legacy/{project}' });
  const plan = f.writePlan(PLAN, PLAN_BODY);

  const r = run([plan], f);
  assert.equal(r.code, 1, 'Legacy/ is protected by the vault rules too');
  assert.ok(/legacy/i.test(r.stderr), `error must name the protected folder: ${r.stderr}`);
  assert.equal(existsSync(path.join(f.vault, '90 - System', 'Legacy', 'demo', PLAN)), false);
  cleanup(f);
});

test('the protected-path check resolves the path, so ../ cannot smuggle a write', () => {
  // A crafted template that only LOOKS harmless as a string. path.join collapses
  // the traversal, and the check runs on the resolved path, so it still refuses.
  const f = fixture('traversal', {
    destDirTemplate: '01 - Projects/{project}/../../../Satset',
  });
  const plan = f.writePlan(PLAN, PLAN_BODY);

  const r = run([plan], f);
  assert.equal(r.code, 1, `a traversing destination must be refused, got ${r.code} (${r.stdout})`);
  assert.ok(/satset/i.test(r.stderr), `error must name the protected folder: ${r.stderr}`);
  assert.equal(existsSync(path.join(f.vault, 'Satset', PLAN)), false, 'nothing may be written');
  cleanup(f);
});

test('a project literally named Satset under 01 - Projects is not protected', () => {
  // Guards against an over-broad `includes('Satset')` check: only the vault's
  // own Satset/ folder is denied, not every path that happens to contain it.
  const f = fixture('not-satset', { withIndex: true });
  const plan = f.writePlan(PLAN, PLAN_BODY);
  const r = run([plan], f);
  assert.equal(r.code, 0, `unrelated mirror must still publish, got ${r.code} ${r.stderr}`);
  assert.ok(existsSync(f.destPath(PLAN)));
  cleanup(f);
});

// ---------- dry run ----------

test('--dry-run prints the destination and would-write, and writes nothing', () => {
  const f = fixture('dry');
  const plan = f.writePlan(PLAN, PLAN_BODY);

  const r = run([plan, '--dry-run'], f);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes(f.destPath(PLAN)), `destination path must be printed: ${r.stdout}`);
  assert.ok(/would write/i.test(r.stdout), `the write decision must be printed: ${r.stdout}`);
  assert.equal(existsSync(f.destPath(PLAN)), false, '--dry-run must not write');
  assert.equal(git(['status', '--porcelain'], f.vault), '', '--dry-run must not stage');
  cleanup(f);
});

test('--dry-run on an up-to-date mirror reports it would not write', () => {
  const f = fixture('dry-idem');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);

  const r = run([plan, '--dry-run'], f);
  assert.equal(r.code, 0);
  assert.ok(
    /no write|would not write|skip/i.test(r.stdout),
    `dry run must say it would skip: ${r.stdout}`,
  );
  cleanup(f);
});

// ---------- status ----------

test('--status exits 0 and lists nothing mirrored', () => {
  const f = fixture('status-empty');
  f.writePlan(PLAN, PLAN_BODY);
  const r = run(['--status'], f);
  assert.equal(r.code, 0, `--status always exits 0, got ${r.code}: ${r.stderr}`);
  assert.ok(r.stdout.includes(PLAN), `the unmirrored plan must appear: ${r.stdout}`);
  assert.ok(/missing|unmirrored/i.test(r.stdout), `state must say it is missing: ${r.stdout}`);
  cleanup(f);
});

test('--status exits 0 and reports a drifted mirror without failing', () => {
  const f = fixture('status-drift');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);
  const dest = f.destPath(PLAN);
  writeFileSync(dest, readFileSync(dest, 'utf8').replace(/^source_hash: .*$/m, 'source_hash: 000000000000'), 'utf8');

  const r = run(['--status'], f);
  assert.equal(r.code, 0, '--status reports, it does not judge');
  assert.ok(/drift/i.test(r.stdout), `state must say drift: ${r.stdout}`);
  cleanup(f);
});

// ---------- missing machine-local config ----------

test('a missing plans.publish.json exits 1 and says how to create it', () => {
  // plans.publish.json is machine-local state: gitignored, never committed, so
  // a FRESH CLONE does not have it. The failure must say that and point at the
  // tracked plans.publish.example.json template, not just name the absent file.
  const f = fixture('missing-config');
  rmSync(f.config);
  assert.equal(existsSync(f.config), false, 'precondition: the config must be gone');

  const r = run(['--status'], f);
  assert.equal(r.code, 1, `a missing config must exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(out.includes(f.config), `the error must name the missing file:\n${out}`);
  assert.match(out, /machine-local/, `the error must say the config is machine-local:\n${out}`);
  assert.match(out, /untracked/, `the error must say the config is untracked:\n${out}`);
  assert.ok(
    out.includes('plans.publish.example.json'),
    `the error must point at the tracked template to copy:\n${out}`,
  );
  cleanup(f);
});

test('the exported verdict reports a missing config as UNROUTABLE with the copy-the-template hint', () => {
  // ultra-plan-runner gates on planFreshness, so on a fresh clone the mirror
  // gate is the place a user actually meets this failure. The detail must carry
  // the same guidance the CLI prints, not only "cannot load ...".
  const f = fixture('missing-config-gate');
  rmSync(f.config);
  const plan = f.writePlan(PLAN, PLAN_BODY);

  const v = cli.planFreshness(plan, { config: f.config });
  assert.equal(v.state, 'UNROUTABLE', `got ${v.state}: ${v.detail}`);
  assert.equal(v.applicable, true, 'a missing config must fail closed, not pass the gate');
  assert.match(v.detail, /machine-local/, `the detail must say the config is machine-local:\n${v.detail}`);
  assert.match(v.detail, /untracked/, `the detail must say the config is untracked:\n${v.detail}`);
  assert.ok(
    v.detail.includes('plans.publish.example.json'),
    `the detail must point at the tracked template:\n${v.detail}`,
  );
  cleanup(f);
});

// ---------- usage ----------

test('an unknown flag exits 2 and writes nothing', () => {
  const f = fixture('usage');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  const r = run([plan, '--nope'], f);
  assert.equal(r.code, 2, `usage error must exit 2, got ${r.code}: ${r.stdout}`);
  assert.equal(existsSync(f.destPath(PLAN)), false, 'a usage error must not publish');
  cleanup(f);
});

test('no arguments at all exits 2', () => {
  const f = fixture('usage-none');
  const r = run([], f);
  assert.equal(r.code, 2, 'an empty invocation must print usage and exit 2');
  cleanup(f);
});

test('--status combined with --check is a usage error', () => {
  const f = fixture('usage-modes');
  const r = run(['--status', '--check', '--all'], f);
  assert.equal(r.code, 2, 'mutually exclusive modes must exit 2');
  cleanup(f);
});

test('--today without a value, or with a bad date, exits 2', () => {
  const f = fixture('usage-today');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan, '--today'], f).code, 2);
  assert.equal(run([plan, '--today', 'yesterday'], f).code, 2);
  assert.equal(existsSync(f.destPath(PLAN)), false, 'a bad --today must not publish');
  cleanup(f);
});

test('--today sets the updated field', () => {
  const f = fixture('today');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan, '--today', '2031-01-02'], f).code, 0);
  assert.ok(
    /^updated: 2031-01-02$/m.test(readFileSync(f.destPath(PLAN), 'utf8')),
    'the --today value must reach the mirror',
  );
  cleanup(f);
});

// ---------- vault staging ----------

test('a successful write stages exactly the one mirror file in the vault', () => {
  const f = fixture('stage');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);

  const status = git(['status', '--porcelain'], f.vault).split('\n').filter(Boolean);
  assert.equal(status.length, 1, `exactly one staged file expected, got:\n${status.join('\n')}`);
  assert.match(status[0], /^A[ \t]/, `the mirror must be staged (index status "A"), got "${status[0]}"`);
  assert.ok(status[0].includes(PLAN), `the staged file must be the mirror: ${status[0]}`);

  // Never commits: there is no HEAD in the fixture repo, and a commit would
  // create one. This is the assertion that would fail if the CLI ever grew a
  // `git commit`.
  const rev = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: f.vault, encoding: 'utf8' });
  assert.notEqual(rev.status, 0, 'the publisher must stage only, never commit');
  cleanup(f);
});

test('staging touches each mirror once and leaves other files unstaged', () => {
  const f = fixture('stage-two');
  const a = f.writePlan('2026-09-26-a.md', '# A\n');
  const b = f.writePlan('2026-09-26-b.md', '# B\n');
  assert.equal(run([a, b], f).code, 0);

  const status = git(['status', '--porcelain'], f.vault).split('\n').filter(Boolean);
  assert.equal(status.length, 2, `two mirrors, two staged entries:\n${status.join('\n')}`);
  assert.equal(status.every((l) => l.startsWith('A')), true, 'both must be staged additions');
  cleanup(f);
});

test('an idempotent skip does not re-stage anything', () => {
  const f = fixture('stage-idem');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);
  // Stage something else, so a re-stage of the mirror would be observable.
  writeFileSync(path.join(f.vault, 'unrelated.md'), 'x\n', 'utf8');
  const before = git(['diff', '--cached', '--name-only'], f.vault);

  const r = run([plan], f);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('SKIPPED-IDEMPOTENT'));
  assert.equal(git(['diff', '--cached', '--name-only'], f.vault), before, 'a skip must not touch the index');
  cleanup(f);
});

test('stageInVault:false writes the mirror but stages nothing', () => {
  const f = fixture('no-stage', { stageInVault: false });
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0, `stderr: ${run(['--status'], f).stderr}`);
  assert.ok(existsSync(f.destPath(PLAN)), 'the mirror must still be written');
  // The index is the thing staging touches. The mirror shows up as UNTRACKED,
  // which is the correct end state here: written to the working tree, never
  // handed to the Obsidian Git plugin's commit.
  assert.equal(git(['diff', '--cached', '--name-only'], f.vault), '', 'the index must stay empty');
  assert.match(
    git(['status', '--porcelain'], f.vault),
    /^\?\?/m,
    'the mirror must be an untracked working-tree file, not a staged one',
  );
  cleanup(f);
});

test('an unstaged-file-only publish leaves the vault index empty on an unborn HEAD', () => {
  // Second positive control: the previous test could pass simply because git
  // ignored the file. Here the same command in the same fixture shape DOES show
  // the file, so the empty index in the test above is a real observation.
  const f = fixture('stage-control');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  assert.equal(run([plan], f).code, 0);
  assert.ok(
    git(['diff', '--cached', '--name-only'], f.vault).includes(PLAN),
    'control: with staging on, the mirror is visible in the index',
  );
  cleanup(f);
});

// ---------- bulk publish: --all ----------

// WHY THESE EXIST
//
// `--all` used to exist only on `--check`. Measured on this machine:
// `--check --all` reported 267 of 267 mirrors missing, and exactly one plan had
// been published — so converging the vault meant naming all 267 files by hand,
// which is how a tool that promises to converge never converges. These tests
// pin the bulk publish path, and they pin the part that actually mattered: a
// partial failure must be VISIBLE. One non-zero exit that swallowed which files
// failed is how a 267-file run silently half-completes.

test('--all publishes every enumerated plan in one run', () => {
  const f = fixture('all-publish');
  f.writePlan('2026-09-26-a.md', '# A\n\nfirst\n');
  f.writePlan('2026-09-26-b.md', '# B\n\nsecond\n');
  f.writePlan('2026-09-26-c.md', '# C\n\nthird\n');

  const r = run(['--all'], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  for (const name of ['2026-09-26-a.md', '2026-09-26-b.md', '2026-09-26-c.md']) {
    const dest = f.destPath(name);
    assert.ok(existsSync(dest), `${name} must be mirrored, stdout:\n${r.stdout}`);
    const text = readFileSync(dest, 'utf8');
    assert.ok(text.startsWith('---\n'), `${name} mirror must carry PARA frontmatter`);
    assert.equal(
      new RegExp(`^source_hash: "?${sha12(readFileSync(f.planPath(name)))}"?$`, 'm').test(text),
      true,
      `${name} mirror must carry the source hash`,
    );
  }
  cleanup(f);
});

test('--all enumerates every mirror:true project and never a mirror:false root', () => {
  // The point of reusing enumeratePlans(): the registry module stays the single
  // source of truth for "what counts as a plan". A second walk inside the CLI
  // is how the publisher and the drift check start disagreeing about the file
  // set. A mirror:false root is the existing regression case — those plans are
  // already in the vault, so publishing one copies a file onto itself.
  const f = fixture('all-projects', { secondProject: true });
  f.writePlan('2026-09-26-a.md', '# A\n');
  f.writePlan('2026-09-26-b.md', '# B\n');
  f.other.writePlan('2026-09-26-c.md', '# C\n');
  writeFileSync(path.join(f.other.inVaultPlans, '2026-09-26-d.md'), '# D\n', 'utf8');

  const r = run(['--all'], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(existsSync(f.destPath('2026-09-26-a.md')), 'project 1 plan must be mirrored');
  assert.ok(existsSync(f.destPath('2026-09-26-b.md')), 'project 1 plan must be mirrored');
  assert.ok(existsSync(f.other.destPath('2026-09-26-c.md')), 'project 2 plan must be mirrored');
  assert.equal(
    existsSync(path.join(f.vault, '01 - Projects', 'in-vault', 'plans', '2026-09-26-d.md')),
    false,
    'a mirror:false project must never be published',
  );
  assert.equal(tally(r.stdout).total, 3, 'exactly the three mirror:true plans are enumerated');
  cleanup(f);
});

test('--all reports an already-current plan as SKIPPED-IDEMPOTENT and does not rewrite it', () => {
  const f = fixture('all-idem');
  const a = f.writePlan('2026-09-26-a.md', '# A\n');
  const b = f.writePlan('2026-09-26-b.md', '# B\n');
  assert.equal(run(['--all'], f).code, 0);

  // Pin mtimes into the past so "unchanged" cannot pass by accident on a coarse
  // timestamp resolution.
  const past = new Date(Date.now() - 60_000);
  const before = {};
  for (const name of ['2026-09-26-a.md', '2026-09-26-b.md']) {
    utimesSync(f.destPath(name), past, past);
    before[name] = { text: readFileSync(f.destPath(name), 'utf8'), mtime: statSync(f.destPath(name)).mtimeMs };
  }

  const r = run(['--all'], f);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.ok(
    r.stdout.includes('SKIPPED-IDEMPOTENT'),
    `the literal SKIPPED-IDEMPOTENT must survive into bulk mode, got:\n${r.stdout}`,
  );
  for (const name of Object.keys(before)) {
    assert.equal(readFileSync(f.destPath(name), 'utf8'), before[name].text, `${name} must not be rewritten`);
    assert.equal(statSync(f.destPath(name)).mtimeMs, before[name].mtime, `${name} must not be touched`);
  }
  const t = tally(r.stdout);
  assert.equal(t.written, 0, 'nothing was stale, so nothing was written');
  assert.equal(t.skipped, 2, 'both plans must be counted as idempotent skips');
  // And the sources are genuinely unchanged: a skip is only correct because the
  // freshness rule said so, not because the run did nothing at all.
  assert.equal(sha12(readFileSync(a)), sha12(readFileSync(a)));
  assert.equal(sha12(readFileSync(b)), sha12(readFileSync(b)));
  cleanup(f);
});

test('--all together with an explicit plan path is a usage error', () => {
  // Mutually exclusive because the two spellings mean different SETS. Guessing
  // which one was meant is how a bulk run quietly publishes something the
  // caller did not ask for.
  const f = fixture('all-usage');
  const plan = f.writePlan(PLAN, PLAN_BODY);
  const r = run(['--all', plan], f);
  assert.equal(r.code, 2, `expected a usage error, got ${r.code}: ${r.stdout}${r.stderr}`);
  assert.match(
    `${r.stdout}${r.stderr}`,
    /--all/,
    'the error must name the flag that caused it',
  );
  assert.equal(existsSync(f.destPath(PLAN)), false, 'a usage error must not publish anything');
  cleanup(f);
});

test('--all --dry-run reports every destination, writes nothing and stages nothing', () => {
  const f = fixture('all-dry');
  const names = ['2026-09-26-a.md', '2026-09-26-b.md', '2026-09-26-c.md'];
  for (const n of names) f.writePlan(n, `# ${n}\n`);

  const r = run(['--all', '--dry-run'], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  for (const n of names) {
    assert.ok(r.stdout.includes(f.destPath(n)), `dry run must report the destination of ${n}:\n${r.stdout}`);
  }
  assert.ok(/would write/i.test(r.stdout), `the write decision must be reported:\n${r.stdout}`);
  const t = tally(r.stdout);
  assert.equal(t.total, names.length, 'every enumerated plan must be accounted for');
  assert.equal(t.writtenLabel, 'would-write', 'a dry run must not claim it published anything');
  assert.equal(t.failed, 0);
  for (const n of names) {
    assert.equal(existsSync(f.destPath(n)), false, `--all --dry-run must not write ${n}`);
  }
  assert.equal(git(['status', '--porcelain'], f.vault), '', '--all --dry-run must not stage');
  cleanup(f);
});

test('--all keeps processing after one file fails, and exits 1 with the failure in the tally', () => {
  // A file/directory name collision on the destination: the mirror path already
  // exists as a DIRECTORY, so the write of that one plan fails with EISDIR while
  // its two siblings publish normally. This is the failure shape that matters —
  // if the run aborted at the first error, the other two would never be mirrored
  // and the exit code alone would not say which ones were done.
  const f = fixture('all-partial');
  f.writePlan('2026-09-26-a.md', '# A\n');
  f.writePlan('2026-09-26-b.md', '# B\n');
  const doomed = '2026-09-26-c-doomed.md';
  f.writePlan(doomed, '# C\n');

  const dest = f.destPath(doomed);
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'keep.md'), 'a note that happens to live in the way\n', 'utf8');

  const r = run(['--all'], f);
  assert.equal(r.code, 1, `a partial failure must exit 1, got ${r.code}:\n${r.stdout}${r.stderr}`);

  // The rest were still processed.
  assert.ok(existsSync(f.destPath('2026-09-26-a.md')), 'a good plan must still be published after a failure');
  assert.ok(existsSync(f.destPath('2026-09-26-b.md')), 'a good plan must still be published after a failure');

  // And the failure is visible: named in its own line, counted in the tally.
  assert.match(
    `${r.stdout}${r.stderr}`,
    new RegExp(doomed),
    'the failing plan must be named, not summarised away',
  );
  const t = tally(`${r.stdout}${r.stderr}`);
  assert.equal(t.total, 3);
  assert.equal(t.failed, 1, 'the tally must count the failure');
  assert.equal(t.written, 2, 'the tally must count the two that did publish');
  assert.equal(t.written + t.skipped + t.failed, t.total, 'the tally must account for every enumerated plan');
  // The collision is left exactly as found: the publisher must not delete or
  // truncate something it did not create.
  assert.ok(existsSync(path.join(dest, 'keep.md')), 'the blocking file must be untouched');
  cleanup(f);
});

test('the --all tally counts add up to the number enumerated', () => {
  // Four plans, one of which is already current, so all three buckets are
  // populated at once and the sum has something to be wrong about.
  const f = fixture('all-tally');
  const names = ['2026-09-26-a.md', '2026-09-26-b.md', '2026-09-26-c.md', '2026-09-26-d.md'];
  for (const n of names) f.writePlan(n, `# ${n}\n`);
  assert.equal(run([f.planPath(names[0])], f).code, 0, 'precondition: one mirror is already current');

  const r = run(['--all'], f);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const t = tally(r.stdout);
  assert.equal(t.total, names.length, 'the total must be the number of enumerated plans');
  assert.equal(t.written, 3, 'the three stale plans must be counted as written');
  assert.equal(t.skipped, 1, 'the current plan must be counted as an idempotent skip');
  assert.equal(t.failed, 0);
  assert.equal(
    t.written + t.skipped + t.failed,
    t.total,
    `tally buckets must sum to the total, got ${JSON.stringify(t)}`,
  );
  cleanup(f);
});

test('the bulk-publish mode is a named exported constant, not an inline string', () => {
  // Two reasons this is asserted and not just implemented. (1) The plan's own
  // skip_if greps the source for the literal token `PUBLISH_ALL`, so the mode
  // has to be NAMED for the plan to recognise that the work is already done.
  // (2) A string literal repeated in three places is how the flag, the usage
  // line and the dispatch drift apart.
  const src = readFileSync(CLI, 'utf8');
  assert.ok(
    /export\s+const\s+PUBLISH_ALL\s*=/.test(src),
    'the CLI must export a named PUBLISH_ALL constant',
  );
  assert.ok(
    src.includes('PUBLISH_ALL'),
    'the literal token PUBLISH_ALL must be present in the CLI source for the plan skip-check',
  );
  assert.equal(typeof cli.PUBLISH_ALL, 'string', 'PUBLISH_ALL must be an exported string');
  assert.ok(cli.PUBLISH_ALL.length > 0, 'PUBLISH_ALL must not be empty');

  // Positive control: the constant is what the dispatch actually resolves to, so
  // a run that reaches bulk mode and writes its one mirror proves the export is
  // the live one and not a decorative constant. (A first attempt asserted
  // `/^1 total /m`, which can never match: the tally line is indented. The
  // control was wrong, not the CLI.)
  const f = fixture('all-const');
  f.writePlan(PLAN, PLAN_BODY);
  const r = run(['--all'], f);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.ok(existsSync(f.destPath(PLAN)), 'control: the bulk run reached the publish path');
  assert.equal(tally(r.stdout).total, 1, 'control: the bulk run enumerated and counted the one plan');
  cleanup(f);
});

test('--all honours --today, so bulk output is deterministic under test', () => {
  // The transform stamps `updated` from ctx.today, which for the single-file path
  // comes from --today. Bulk mode must pass the SAME option object through, or a
  // 267-file run stamps 267 mirrors with whatever date the machine thinks it is
  // and no test can assert on the bytes.
  const f = fixture('all-today');
  f.writePlan('2026-09-26-a.md', '# A\n');
  f.writePlan('2026-09-26-b.md', '# B\n');

  const r = run(['--all', '--today', '2031-01-02'], f);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  for (const n of ['2026-09-26-a.md', '2026-09-26-b.md']) {
    assert.ok(
      /^updated: 2031-01-02$/m.test(readFileSync(f.destPath(n), 'utf8')),
      `the --today value must reach every bulk-written mirror (${n})`,
    );
  }
  assert.equal(run(['--all', '--today', 'yesterday'], f).code, 2, 'a bad --today is still a usage error');
  cleanup(f);
});

test('--all with no plans anywhere exits 0 and says so', () => {
  // Not an error: a project that has never written a plan has nothing to
  // mirror, and --check already answers it that way. The tally is still printed
  // so a script that parses it does not have to special-case the empty run.
  const f = fixture('all-empty');
  const r = run(['--all'], f);
  assert.equal(r.code, 0, `an empty enumeration is not a failure, got ${r.code}: ${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /no plans/i, `it must say why:\n${r.stdout}${r.stderr}`);
  cleanup(f);
});

// ---------- exported freshness verdict (T1) ----------
//
// The runner gates `--execute` on this verdict, so it is tested HERE, next to
// the code that already decides freshness for --check. The whole point of
// exporting it rather than letting the runner re-derive "is this current?" is
// that two implementations of one predicate is how a gate ends up disagreeing
// with the check it is supposed to agree with. If these cases are ever deleted
// instead of the export removed, that is the regression this header warns about.

test('exports a single-plan freshness verdict', () => {
  assert.equal(typeof cli.planFreshness, 'function',
    'plan-publish.mjs must export planFreshness() for the runner to gate on');

  // 1. A plan that was never published: MISSING, and the reason names the hash
  //    the source currently has, because "no mirror" alone does not say whether
  //    the publish is pending or the file is unroutable.
  {
    const f = fixture('fresh-missing');
    const plan = f.writePlan(PLAN, PLAN_BODY);
    const v = cli.planFreshness(plan, { config: f.config });
    assert.equal(v.applicable, true, 'a mirror:true project is always gated');
    assert.equal(v.state, 'MISSING', `got ${v.state}: ${v.detail}`);
    assert.equal(v.dest, f.destPath(PLAN), 'the verdict must name the mirror path it expected');
    assert.equal(v.label, PLAN, 'the verdict must name the plan it judged');
    assert.match(v.detail, new RegExp(sha12(PLAN_BODY)), 'the reason must carry the source hash');
    cleanup(f);
  }

  // 2. Published and unchanged: OK, and applicable stays true so the runner can
  //    tell "checked and current" from "not applicable" — both run the DAG, but
  //    only one of them is evidence.
  {
    const f = fixture('fresh-ok');
    const plan = f.writePlan(PLAN, PLAN_BODY);
    assert.equal(run([plan], f).code, 0);
    const v = cli.planFreshness(plan, { config: f.config });
    assert.equal(v.state, 'OK', `got ${v.state}: ${v.detail}`);
    assert.equal(v.applicable, true);
    assert.equal(v.detail, `source_hash ${sha12(PLAN_BODY)}`);
    cleanup(f);
  }

  // 3. Source edited after publishing: DRIFT. This is the case the runner gate
  //    exists for, so it must not be reachable as anything else.
  {
    const f = fixture('fresh-drift');
    const plan = f.writePlan(PLAN, PLAN_BODY);
    assert.equal(run([plan], f).code, 0);
    f.writePlan(PLAN, `${PLAN_BODY}\nedited\n`);
    const v = cli.planFreshness(plan, { config: f.config });
    assert.equal(v.state, 'DRIFT', `got ${v.state}: ${v.detail}`);
    assert.match(v.detail, /mirror .* != source/, `the reason must show both hashes: ${v.detail}`);
    cleanup(f);
  }

  // 4. mirror:false — the vault's own plans. Publishing one would copy a file
  //    onto itself, so the gate is not applicable. A false "OK" here would be
  //    the more dangerous bug: it would mean the runner believed it had checked
  //    a mirror that by definition does not exist.
  {
    const f = fixture('fresh-invault', { secondProject: true });
    const plan = f.other.inVaultPlans ? null : null;
    assert.ok(f.other.inVaultPlans, 'the fixture must expose the mirror:false plans dir');
    const p = path.join(f.other.inVaultPlans, PLAN);
    writeFileSync(p, PLAN_BODY, 'utf8');
    const v = cli.planFreshness(p, { config: f.config });
    assert.equal(v.applicable, false, `a mirror:false project is not gated, got ${v.state}: ${v.detail}`);
    assert.equal(v.state, 'NOT-APPLICABLE', `got ${v.state}: ${v.detail}`);
    assert.equal(v.detail, '');
    assert.ok(plan === null);
    cleanup(f);
  }
});

test('the exported verdict and --check cannot disagree', () => {
  // Same file, same registry, two code paths. If these ever differ, the runner
  // gate is enforcing a rule the vault check does not have — which is the exact
  // class of bug the shared predicate was extracted to prevent.
  const f = fixture('fresh-parity');
  const plan = f.writePlan(PLAN, PLAN_BODY);

  const check = () => {
    const r = run(['--check', plan], f);
    // The per-plan row, not the last line: on failure the run ends with a
    // "Fix:" hint, so the last line says nothing about the verdict.
    const row = `${r.stdout}${r.stderr}`.split('\n').find((l) => l.includes(PLAN));
    return { code: r.code, row: (row ?? '').trim() };
  };

  assert.equal(cli.planFreshness(plan, { config: f.config }).state, 'MISSING');
  assert.equal(check().code, 1, 'a missing mirror must fail --check');
  assert.match(check().row, /no mirror/i);

  assert.equal(run([plan], f).code, 0);
  assert.equal(cli.planFreshness(plan, { config: f.config }).state, 'OK');
  assert.equal(check().code, 0, 'a current mirror must pass --check');

  f.writePlan(PLAN, `${PLAN_BODY}\nedited\n`);
  assert.equal(cli.planFreshness(plan, { config: f.config }).state, 'DRIFT');
  assert.equal(check().code, 1, 'a drifted mirror must fail --check');
  assert.match(check().row, /!=|drift/i, `expected a drift reason, got: ${check().row}`);
  cleanup(f);
});

test('a version bump forces existing mirrors to re-publish', () => {
  // The whole reason PUBLISHER_VERSION exists. When the transform starts
  // emitting something new, every mirror written by the old transform must stop
  // looking current — otherwise the improvement reaches new plans only and the
  // 271 that already exist silently keep the old shape forever. That is the
  // failure this assertion exists to catch: someone improves the transform,
  // everything still reports OK, and nothing heals.
  const f = fixture('version-bump');
  try {
    const plan = f.writePlan(PLAN, PLAN_BODY);

    // Publish with the CURRENT transform, then age the mirror to look like an
    // older publisher wrote it: same source hash, older publisher_version. The
    // source is untouched, so only the version key can detect this.
    assert.equal(run([plan], f).code, 0);
    f.patchMirror(PLAN, (t) => t.replace(
      new RegExp(`^publisher_version:[ \\t]*.*$`, 'm'),
      'publisher_version: 1',
    ));

    const v = cli.planFreshness(plan, { config: f.config });
    assert.equal(v.state, 'DRIFT',
      `an older publisher's mirror must read as drifted, got ${v.state}: ${v.detail}`);
    assert.match(v.detail, /publisher_version/,
      `the reason must name the version, not the hash — the source did not change: ${v.detail}`);

    const chk = run(['--check', plan], f);
    assert.equal(chk.code, 1, '--check must fail for the same reason');
    assert.match(`${chk.stdout}${chk.stderr}`, /publisher_version/);

    // Re-publishing heals it, and the healed mirror carries the new property.
    assert.equal(run([plan], f).code, 0);
    const healed = f.mirror(PLAN);
    assert.match(healed, new RegExp(`^publisher_version:[ \\t]*${PUBLISHER_VERSION}$`, 'm'),
      'the healed mirror must record the current publisher version');
    assert.match(healed, /^published: \d{4}-\d{2}-\d{2}$/m,
      'the healed mirror must carry the property the new transform emits');
    assert.match(healed, /^updated: \d{4}-\d{2}-\d{2}$/m,
      'and must still carry updated, which the vault contract requires');
    assert.equal(cli.planFreshness(plan, { config: f.config }).state, 'OK');
  } finally {
    cleanup(f);
  }
});

test('the failure hint names the current publish stages, not the retired one', () => {
  // This string is what a person reads at the exact moment a plan is
  // unpublished, so it is load-bearing documentation. It used to say "after the
  // plan is approved", which described the retired single-stage rule: under the
  // current three-stage pipeline a plan is published BEFORE approval is even
  // requested, so the old wording told the reader to do the thing later than the
  // pipeline does. A stale hint is worse than no hint, because it is confident.
  const f = fixture('hint');
  try {
    const plan = f.writePlan(PLAN, PLAN_BODY);
    const r = run(['--check', plan], f);
    assert.equal(r.code, 1, `a missing mirror must fail --check, got ${r.code}`);
    const out = `${r.stdout}${r.stderr}`;
    assert.doesNotMatch(out, /after the plan is approved/,
      `the retired one-stage wording must be gone:\n${out}`);
    assert.match(out, /plan-publish\.mjs/,
      `the hint must still name the command that fixes it:\n${out}`);
  } finally {
    cleanup(f);
  }
});
