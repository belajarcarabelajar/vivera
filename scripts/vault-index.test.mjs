// scripts/vault-index.test.mjs
//
// Guards for the worklist arithmetic that decides which of the vault's notes
// still need extraction, and — more to the point — for the boundary that
// decides which notes are ALLOWED to be looked at.
//
// That boundary is the reason this module exists in the shape it does. The
// vault's `.graphifyignore` excludes `Satset/`, which holds hundreds of files
// of secret material, and the way this module finds out what is eligible is by
// asking graphify's own detector rather than by walking the tree with a
// hand-written gitignore matcher. A second implementation of a privacy
// boundary is a second thing that can be wrong, and its failure mode is the
// worst kind available: not an error, not a partial result, but a plausible
// list of files to send to a subagent, one of which should never have been
// named. Every test below that asserts an exclusion is really asserting that
// we did not reimplement the exclusion.
//
// The second property is that a quiet wrong answer is worse than a loud one.
// `detect()` on a directory that does not exist does not raise — measured, not
// assumed: it prints a warning to stderr, returns `total_files: 0`, and exits
// 0. A wrapper that forwarded that faithfully would report an empty worklist
// and read as "everything is already indexed". So the non-existent-root test
// below is not pedantry; it pins the specific behaviour that would otherwise be
// indistinguishable from success.
//
// Fixtures are synthetic and built in a temp directory, on purpose. A test that
// asserts against the real vault passes on this machine and fails on the next
// one, and a test that fails on another machine teaches the next person to
// delete it. The one live test at the bottom is the deliberate exception: it
// skips when the vault is absent, and when it does run it asserts the real
// counts so that drift in the vault is visible rather than silent.
//
// The fixture's own ignore files are named distinctively (`secret-drop/`,
// `git-drop/`) so that a test failure says which boundary broke instead of
// merely saying a number is wrong.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_BUCKETS,
  DEFAULT_EXTENSIONS,
  graphifyAvailable,
  listEligible,
  readManifest,
  scan,
  scanAll,
  PYTHON_SNIPPET,
} from './vault-index.mjs';

// ---------- per-test timeout ----------
//
// Almost every test below crosses a process boundary: it spawns `python3`,
// which imports the whole `graphify` package and walks a directory tree. On an
// idle machine one spawn costs a few hundred milliseconds and the suite passes
// on node:test's 5 s default. That default is the problem, and it was found by
// running the suite while three other agent chunks were saturating the CPU —
// the suite went red on a test that is green in isolation. A test whose verdict
// depends on machine load is not a test of the module.
//
// So the ceiling is raised here, once, for every test in the file rather than
// per-test, because picking which tests "deserve" a longer budget is a judgement
// that rots the moment someone adds a test. A ceiling is not a delay: the
// readManifest tests below still finish in milliseconds. The two `live` tests
// pass their own, larger, budget and are unaffected.
const SPAWN_TIMEOUT_MS = 60_000;

// ---------- host capability ----------
//
// The `spawning` tests below are the ones that actually cross into python: they
// import `graphify` and assert on what it walked. Where graphify lives is a
// machine-specific seam (env vars `GRAPHIFY_SITE_PACKAGES` / `GRAPHIFY_PYTHON`,
// else the git-ignored local.config.json), so on a host that has not configured
// it the resolution ends in an error by design. The probe asks the module
// whether its boundary is usable, and when it is not the `spawning` tests skip
// with the reason, exactly as the `live vault` tests at the bottom of this file
// already do. On a host WITH the seam configured nothing changes: the fixtures
// are synthetic and every assertion still runs.
//
// The tests that do NOT cross the boundary — the two root-validation throws,
// the snippet-source check, the three readManifest checks, the
// missing-interpreter check, the python-failure check and the seam tests: stay
// plain `test` and run
// everywhere, so this gate hides no behaviour that can be checked without
// graphify.
const GRAPHIFY_READY = graphifyAvailable();

/** `test` for a case that needs the graphify detector; skips when it is absent. */
function spawning(name, fn) {
  test(
    name,
    {
      timeout: SPAWN_TIMEOUT_MS,
      ...(GRAPHIFY_READY
        ? {}
        : {
            skip:
              'graphify is not configured on this host; set GRAPHIFY_SITE_PACKAGES and GRAPHIFY_PYTHON, or local.config.json (see local.config.example.json)',
          }),
    },
    fn,
  );
}

// ---------- fixture ----------

// Retained so the temp trees can be removed on the way out. Every test builds
// its own: a shared fixture that one test mutates turns an ordering dependency
// into a mystery, and `bun test` does not guarantee file order within a file.
const madeDirs = [];

after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A miniature repo with all three exclusion mechanisms in play at once.
 *
 * `.graphifyignore` and `.gitignore` each drop a differently-named directory, so
 * a failure to honour either one is attributable. The `.md` bodies are a few
 * words long because `detect()` word-counts every text file it walks, and a
 * fixture of real notes would make this slow for no added coverage.
 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'vault-index-fixture-'));
  madeDirs.push(root);

  const files = {
    'notes/alpha.md': '# alpha\n\nfirst note body.\n',
    'notes/beta.md': '# beta\n\nsecond note body.\n',
    'sub/deep.md': '# deep\n\nthird note body.\n',
    'secret-drop/hidden.md': '# hidden\n\nshould never be listed.\n',
    'git-drop/ignored.md': '# ignored\n\nshould never be listed either.\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }

  writeFileSync(join(root, '.graphifyignore'), 'secret-drop/\n');
  writeFileSync(join(root, '.gitignore'), 'git-drop/\n');
  return root;
}

/** A fixture plus a manifest naming one of its notes as already indexed. */
function makeFixtureWithManifest() {
  const root = makeFixture();
  mkdirSync(join(root, 'graphify-out'), { recursive: true });
  // Shaped like the real manifest: a flat map of repo-relative path -> row.
  writeFileSync(
    join(root, 'graphify-out', 'manifest.json'),
    JSON.stringify({ 'notes/alpha.md': { mtime: 1, seen: 2, ast_hash: 'x', semantic_hash: 'x' } }, null, 2),
  );
  return root;
}

// ---------- listEligible ----------

spawning('a plain .md file in the fixture is listed', () => {
  const root = makeFixture();
  const eligible = listEligible(root);

  assert.ok(
    eligible.includes('notes/alpha.md'),
    `expected notes/alpha.md in [${eligible.join(', ')}]`,
  );
});

spawning('a file matched by the fixture .graphifyignore is NOT listed', () => {
  const root = makeFixture();
  const eligible = listEligible(root);

  assert.ok(!eligible.includes('secret-drop/hidden.md'), '.graphifyignore was not honoured');
  assert.ok(
    !eligible.some((p) => p.startsWith('secret-drop/')),
    `secret-drop leaked into [${eligible.join(', ')}]`,
  );
});

spawning('a file matched by the fixture .gitignore is NOT listed', () => {
  const root = makeFixture();
  const eligible = listEligible(root);

  assert.ok(!eligible.includes('git-drop/ignored.md'), '.gitignore was not honoured');
  assert.ok(!eligible.some((p) => p.startsWith('git-drop/')), 'git-drop leaked into the eligible list');
});

spawning('paths come back repo-relative, never absolute', () => {
  const root = makeFixture();
  const eligible = listEligible(root);

  assert.ok(eligible.length > 0, 'fixture produced no eligible files, so this proves nothing');
  for (const p of eligible) {
    assert.ok(!isAbsolute(p), `${JSON.stringify(p)} is absolute`);
    // A Windows-style drive or UNC prefix is absolute too, and `isAbsolute` on
    // POSIX does not know about either.
    assert.ok(!/^[A-Za-z]:/.test(p), `${JSON.stringify(p)} carries a drive letter`);
    assert.ok(!p.startsWith('\\\\'), `${JSON.stringify(p)} is a UNC path`);
    // On a POSIX host the platform separator IS the slash, so this is the
    // check that would actually catch a native-separator leak.
    assert.ok(!p.includes(sep) || sep === '/', `${JSON.stringify(p)} uses a native separator`);
  }
});

spawning('the eligible list is sorted, so two runs diff cleanly', () => {
  const root = makeFixture();
  const first = listEligible(root);
  const second = listEligible(root);

  assert.deepEqual(first, second, 'two scans of one fixture disagreed');
  assert.deepEqual(first, [...first].sort(), 'result is not in sorted order');
});

test('a root that does not exist throws a named error rather than returning []', () => {
  const missing = join(tmpdir(), 'vault-index-definitely-absent-9f2a');

  // The specific hazard: detect() does not raise on a missing root. It warns on
  // stderr, returns total_files 0, and exits 0. Forwarding that would make
  // "you pointed me at nothing" look exactly like "there is nothing to do".
  assert.throws(
    () => listEligible(missing),
    (err) => {
      assert.ok(err instanceof Error, 'threw a non-Error');
      assert.match(err.message, /vault-index/);
      assert.match(err.message, /no-such-root/);
      return true;
    },
  );
});

test('a root that is a file, not a directory, throws too', () => {
  const root = makeFixture();
  const notADir = join(root, 'notes', 'alpha.md');

  assert.throws(() => listEligible(notADir), /vault-index/);
});

test('the python layer is handed a Path, never a str', () => {
  // The failure this guards is measured, not hypothetical: detect() opens with
  // `root.resolve()`, which does not exist on str, so a string root dies with
  // AttributeError. The test asserts the guarantee structurally — the module
  // exports the source of the snippet it sends, and that snippet can only ever
  // construct the argument through Path(...). A regression to `detect.detect(root)`
  // with a bare interpolated string is visible here as a missing Path(...).
  assert.equal(typeof PYTHON_SNIPPET, 'string');
  assert.match(PYTHON_SNIPPET, /Path\(\s*sys\.argv\[1\]\s*\)/);
  assert.match(PYTHON_SNIPPET, /sys\.path\.insert/);
  // And it must not pass the root through some other channel — a literal
  // f-string interpolation of the path into the snippet is the exact bug that
  // makes a path with a quote in it a code injection.
  assert.doesNotMatch(PYTHON_SNIPPET, /detect\(\s*["'{]/);
});

// ---------- readManifest ----------

test('readManifest returns repo-relative keys from graphify-out/manifest.json', () => {
  const root = makeFixtureWithManifest();

  const manifest = readManifest(root);
  assert.ok(manifest instanceof Set);
  assert.ok(manifest.has('notes/alpha.md'), 'manifest key missing from the set');
  assert.equal(manifest.size, 1);
});

test('a repo with no manifest yields an empty set rather than throwing', () => {
  const root = makeFixture();

  // A first run has nothing indexed yet, which is the normal starting state
  // and not an error. Throwing here would make `scan` unusable on a fresh
  // repo — the one case it is most needed.
  assert.deepEqual([...readManifest(root)], []);
});

test('a corrupt manifest throws, because silently indexing nothing loses work', () => {
  const root = makeFixture();
  mkdirSync(join(root, 'graphify-out'), { recursive: true });
  writeFileSync(join(root, 'graphify-out', 'manifest.json'), '{ this is not json');

  assert.throws(() => readManifest(root), /vault-index/);
});

// ---------- scan ----------

spawning('scan splits the fixture into eligible, indexed and worklist', () => {
  const root = makeFixtureWithManifest();
  const { eligible, indexed, worklist, counts } = scan(root);

  assert.ok(eligible.includes('notes/alpha.md'));
  // alpha is in the manifest: eligible, and NOT work to do.
  assert.ok(indexed.includes('notes/alpha.md'), 'alpha should be counted as already indexed');
  assert.ok(!worklist.includes('notes/alpha.md'), 'alpha is already indexed, so it is not work');
  // beta and deep are not.
  assert.ok(worklist.includes('notes/beta.md'));
  assert.ok(worklist.includes('sub/deep.md'));
  // Excluded files appear in no bucket at all.
  for (const p of [...eligible, ...indexed, ...worklist]) {
    assert.ok(!p.startsWith('secret-drop/') && !p.startsWith('git-drop/'), `${p} escaped an ignore rule`);
  }

  assert.equal(counts.eligible, eligible.length);
  assert.equal(counts.indexed, indexed.length);
  assert.equal(counts.worklist, worklist.length);
  assert.equal(counts.eligible, counts.indexed + counts.worklist);
});

spawning('the worklist is sorted and contains no duplicates', () => {
  const root = makeFixture();
  const { worklist } = scan(root);

  assert.deepEqual(worklist, [...worklist].sort(), 'worklist is not sorted');
  assert.equal(new Set(worklist).size, worklist.length, 'worklist contains duplicates');
});

spawning('worklist is eligible minus indexed, exactly', () => {
  const root = makeFixtureWithManifest();
  const { eligible, indexed, worklist } = scan(root);

  const expected = eligible.filter((p) => !indexed.includes(p));
  assert.deepEqual([...worklist].sort(), [...expected].sort());
});

spawning('scan is deterministic across repeated runs', () => {
  const root = makeFixtureWithManifest();
  const a = scan(root);
  const b = scan(root);

  assert.deepEqual(a.worklist, b.worklist);
  assert.deepEqual(a.eligible, b.eligible);
  assert.deepEqual(a.counts, b.counts);
});

spawning('counts carry a per-bucket breakdown', () => {
  const root = makeFixture();
  const { counts } = scan(root);

  assert.ok(counts.byBucket, 'counts.byBucket is missing');
  for (const bucket of DEFAULT_BUCKETS) {
    assert.equal(typeof counts.byBucket[bucket], 'number', `no count for bucket ${bucket}`);
  }
  const sum = Object.values(counts.byBucket).reduce((a, b) => a + b, 0);
  assert.equal(sum, counts.eligible, 'per-bucket counts do not add up to the eligible total');
});

spawning('the module does not silently lose files that detect() reports but we do not want', () => {
  // A .txt is eligible to graphify but is neither markdown nor a pdf. It must
  // be excluded deliberately, and the count must say so — a filter that quietly
  // drops files is indistinguishable from a filter that misses them.
  const root = makeFixture();
  writeFileSync(join(root, 'notes', 'plain.txt'), 'not markdown\n');

  const { eligible, counts } = scan(root);

  assert.ok(!eligible.includes('notes/plain.txt'), 'a .txt should not be in a markdown worklist');
  assert.equal(counts.droppedByExtension, 1, 'the dropped file was not accounted for');
});

test('a python failure surfaces as a named error carrying stderr', { timeout: SPAWN_TIMEOUT_MS }, () => {
  // A failing detector run must surface as a named error carrying stderr,
  // never as an empty result: a silent empty result here would read as
  // "nothing to index", which is the exact failure this module exists to
  // prevent. The failure is injected through the per-call python seam with a
  // stub interpreter that touches a breadcrumb, writes a marker to stderr and
  // exits 3, the same pattern the cluster suite uses, so the proof does not
  // depend on which interpreter or packages the host has. An earlier version
  // induced the failure by pointing site-packages at a directory that does not
  // exist, but a bogus sys.path entry does not fail an import: when the
  // configured interpreter carries graphify in its own site-packages the
  // import succeeds, and the test was measuring host configuration instead of
  // the module.
  const root = makeFixture();
  const dir = mkdtempSync(join(tmpdir(), 'vault-index-python-fail-'));
  madeDirs.push(dir);
  const stub = join(dir, 'failing-python.sh');
  const breadcrumb = join(dir, 'failing-python-ran');
  writeFileSync(stub, `#!/bin/sh\ntouch '${breadcrumb}'\necho 'stub-interpreter-failed' >&2\nexit 3\n`, 'utf8');
  chmodSync(stub, 0o755);
  // sitePackages is passed so seam resolution never runs; the stub ignores it,
  // so the path need not exist.
  assert.throws(
    () => listEligible(root, { python: stub, sitePackages: join(dir, 'unused-site-packages') }),
    (err) => {
      assert.match(err.message, /vault-index/);
      assert.ok(err.stderr !== undefined, 'the error should carry stderr for diagnosis');
      assert.match(err.stderr, /stub-interpreter-failed/, `stderr should carry the stub's marker, got ${JSON.stringify(err.stderr)}`);
      assert.equal(err.exitCode, 3, `the stub's exit code should be surfaced, got ${err.exitCode}`);
      assert.ok(existsSync(breadcrumb), 'the stub interpreter never ran');
      return true;
    },
  );
});

test('the python binary can be overridden, so a missing interpreter is nameable', () => {
  const root = makeFixture();
  // The site-packages override keeps this test about the interpreter alone:
  // without it, an unconfigured host would fail on path resolution before the
  // spawn ever happened.
  assert.throws(
    () =>
      listEligible(root, {
        python: join(tmpdir(), 'no-such-python-7d3e'),
        sitePackages: join(tmpdir(), 'unused-site-packages-1c9b'),
      }),
    (err) => {
      assert.match(err.message, /vault-index/);
      return true;
    },
  );
});

// ---------- the machine-specific path seam ----------
//
// site-packages and interpreter resolve env -> local.config.json -> error via
// scripts/lib/local-config.mjs. These tests prove the seam without the real
// graphify: a stub package written into a temp site-packages answers with one
// file whose name carries a marker, so a run that reports the marker went
// through the stub, and one that does not resolved its site-packages somewhere
// else. Env overrides are set explicitly and restored in `withEnv`'s finally,
// and the config always lives in a temp file, so nothing here depends on
// machine paths and nothing writes local.config.json into the repo.

function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function hostPython() {
  const candidate = process.env.GRAPHIFY_PYTHON || 'python3';
  const probe = spawnSync(candidate, ['-c', 'print(1)'], { encoding: 'utf8' });
  return probe.status === 0 ? candidate : null;
}

const HOST_PYTHON = hostPython();
const NEEDS_PYTHON_SKIP = HOST_PYTHON === null ? 'no usable python interpreter on this host' : false;

/**
 * A graphify stub plus a breadcrumb interpreter wrapper, both inside `dir`.
 *
 * The stub's `detect()` ignores the root it is handed and answers with a single
 * file named after `marker`, so the marker in a worklist is proof that this
 * stub, and therefore the site-packages value it was reached through, ran.
 * The wrapper execs the real interpreter after touching `breadcrumb`, so the
 * breadcrumb is proof that the configured interpreter, not some fallback, ran.
 */
function makeSeamFixture(dir, marker) {
  const pkg = join(dir, 'graphify');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, '__init__.py'), '', 'utf8');
  // Shaped so PYTHON_SNIPPET can read it exactly like the real detect().
  writeFileSync(
    join(pkg, 'detect.py'),
    [
      `MARKER = ${JSON.stringify(marker)}`,
      'def detect(root):',
      '    root = str(root)',
      '    return {',
      '        "files": {"document": [root + "/notes/" + MARKER + ".md"], "paper": []},',
      '        "total_files": 1,',
      '        "total_words": 3,',
      '        "ignored": [],',
      '        "unclassified": [],',
      '        "walk_errors": [],',
      '        "graphifyignore_patterns": 0,',
      '        "scan_root": root,',
      '    }',
      '',
    ].join('\n'),
    'utf8',
  );

  const real = spawnSync(HOST_PYTHON, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  if (real.status !== 0) return { sitePackages: dir, markerPython: null, breadcrumb: null };
  const executable = String(real.stdout).trim();
  const wrapper = join(dir, 'marked-python.sh');
  const breadcrumb = join(dir, 'marked-python-ran');
  writeFileSync(wrapper, `#!/bin/sh\ntouch '${breadcrumb}'\nexec '${executable}' "$@"\n`, 'utf8');
  chmodSync(wrapper, 0o755);
  return { sitePackages: dir, markerPython: wrapper, breadcrumb };
}

test('the module carries no hard-coded home path', () => {
  // The seam replaced a default that was one machine's uv tool layout, and the
  // resolution chain now ends in an error rather than a guess, so any /home/
  // literal left in this module would be reachable on some host. Reading the
  // module's own source is the cheapest guard against it creeping back.
  const source = readFileSync(new URL('./vault-index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/home\//);
});

test('with no environment and no config the seam throws an actionable error', () => {
  const root = makeFixture();
  withEnv({ GRAPHIFY_SITE_PACKAGES: undefined, GRAPHIFY_PYTHON: undefined }, () => {
    // Pinned to the site-packages half by passing a python override, so the
    // assertion does not depend on which half resolution happens to hit first
    // (the interpreter is resolved before the spawn, never after it).
    assert.throws(
      () =>
        listEligible(root, {
          python: 'python3',
          configPath: join(tmpdir(), 'vault-index-absent-config-9d4e.json'),
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /vault-index/);
        assert.match(err.message, /GRAPHIFY_SITE_PACKAGES/);
        assert.match(err.message, /local\.config\.json/);
        return true;
      },
    );
    // And with no override at all, resolution still refuses with an error
    // naming its env var and the config file, never a default path.
    assert.throws(
      () =>
        listEligible(root, { configPath: join(tmpdir(), 'vault-index-absent-config-9d4e.json') }),
      (err) => {
        assert.match(err.message, /vault-index/);
        assert.match(err.message, /GRAPHIFY_(SITE_PACKAGES|PYTHON)/);
        assert.match(err.message, /local\.config\.json/);
        return true;
      },
    );
  });
});

test('GRAPHIFY_SITE_PACKAGES from the environment drives the injected site-packages', { skip: NEEDS_PYTHON_SKIP }, () => {
  const root = makeFixture();
  const dir = mkdtempSync(join(tmpdir(), 'vault-index-seam-env-'));
  madeDirs.push(dir);
  const { sitePackages } = makeSeamFixture(dir, 'env-seam-marker');
  withEnv({ GRAPHIFY_SITE_PACKAGES: sitePackages }, () => {
    const eligible = listEligible(root, {
      python: HOST_PYTHON,
      configPath: join(dir, 'absent-config.json'),
    });
    assert.ok(
      eligible.includes('notes/env-seam-marker.md'),
      `the stub's marker is missing from [${eligible.join(', ')}]: the env value was not injected`,
    );
  });
});

test('GRAPHIFY_PYTHON from the environment is the interpreter that runs', { skip: NEEDS_PYTHON_SKIP }, () => {
  const root = makeFixture();
  const dir = mkdtempSync(join(tmpdir(), 'vault-index-seam-py-'));
  madeDirs.push(dir);
  const { sitePackages, markerPython, breadcrumb } = makeSeamFixture(dir, 'env-python-marker');
  withEnv({ GRAPHIFY_PYTHON: markerPython }, () => {
    const eligible = listEligible(root, {
      sitePackages,
      configPath: join(dir, 'absent-config.json'),
    });
    assert.ok(eligible.includes('notes/env-python-marker.md'), 'the stub site-packages did not run');
    assert.ok(existsSync(breadcrumb), 'the marked interpreter never ran: GRAPHIFY_PYTHON was ignored');
  });
});

test('local.config.json provides both halves when the environment is empty', { skip: NEEDS_PYTHON_SKIP }, () => {
  const root = makeFixture();
  const dir = mkdtempSync(join(tmpdir(), 'vault-index-seam-config-'));
  madeDirs.push(dir);
  const { sitePackages, markerPython, breadcrumb } = makeSeamFixture(dir, 'config-seam-marker');
  const configPath = join(dir, 'local.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ graphifySitePackages: sitePackages, graphifyPython: markerPython }),
  );
  withEnv({ GRAPHIFY_SITE_PACKAGES: undefined, GRAPHIFY_PYTHON: undefined }, () => {
    const eligible = listEligible(root, { configPath });
    assert.ok(
      eligible.includes('notes/config-seam-marker.md'),
      `the stub's marker is missing from [${eligible.join(', ')}]: the config was not read`,
    );
    assert.ok(existsSync(breadcrumb), 'the config python never ran: graphifyPython was ignored');
  });
});

test('the environment wins over local.config.json', { skip: NEEDS_PYTHON_SKIP }, () => {
  const root = makeFixture();
  const dir = mkdtempSync(join(tmpdir(), 'vault-index-seam-precedence-'));
  madeDirs.push(dir);
  const envStub = makeSeamFixture(join(dir, 'env-sp'), 'env-wins-marker');
  const configStub = makeSeamFixture(join(dir, 'config-sp'), 'config-loses-marker');
  const configPath = join(dir, 'local.config.json');
  writeFileSync(configPath, JSON.stringify({ graphifySitePackages: configStub.sitePackages }));
  withEnv({ GRAPHIFY_SITE_PACKAGES: envStub.sitePackages }, () => {
    const eligible = listEligible(root, { python: HOST_PYTHON, configPath });
    assert.ok(eligible.includes('notes/env-wins-marker.md'), 'the env value did not run');
    assert.ok(
      !eligible.includes('notes/config-loses-marker.md'),
      'the config value ran despite the environment being set',
    );
  });
});

// ---------- live vault (skipped when absent) ----------

const VAULT = join(homedir(), 'Dokumen/Obsidian Vault');

// The transcript half of the corpus. 05 - Conversations/ moved here on
// 2026-10-02 (vault commit 51b7a59): 50 files >1MB, 300 MB total, OOMed
// Obsidian's metadata cache at ~3.9GB on every launch. Scanning the vault
// alone reports 572 eligible and has done since the move -- not a boundary
// failure, just a corpus that is no longer there.
const ARCHIVE = join(homedir(), 'Documents/conversations-archive');
// Both halves are required: the live tests scan the real corpus THROUGH the
// detector, so a host with the vault but no graphify would fail them for the
// same "not installed here" reason the spawning tests now skip on. The vault
// check alone was enough while this file only ever ran on one machine.
const live = existsSync(VAULT) && existsSync(ARCHIVE) && GRAPHIFY_READY ? test : test.skip;

live('the real vault reports the numbers measured on 2026-10-02', { timeout: 300_000 }, () => {
  // Asserted as a band, not an exact figure, and deliberately so. The exact
  // numbers drift every time a note is added, and a test that goes red on an
  // ordinary edit trains people to ignore it. The invariants below are the ones
  // that would indicate a real problem: a worklist that is a small fraction of
  // the corpus, and a boundary that is still excluding the secrets directory.
  //
  // The bands were re-measured 2026-10-02 after two deliberate corpus changes:
  // commit 3a968b2 deleted the 748 N8n raw-capture files, and .graphifyignore
  // GROUP 7 (c20b3be) excluded 31 tool-test transcripts. Eligible fell 2,360 ->
  // 1,584. The floors below are set so that deleting notes again does not go
  // red on an ordinary edit, while a scanner that silently stopped honouring
  // .gitignore or .graphifyignore still would -- that failure inflates eligible
  // by thousands, which is the direction these bands are actually guarding.
  //
  // 1,584 is now a two-root measurement, and it reproduces exactly: vault 572 +
  // archive 1,012. The archive contributes 1,043, not 1,012, unless it carries
  // its own copy of the GROUP 7 rules -- graphify's detector reads the
  // .graphifyignore in whatever root it is handed, so one root's exclusions
  // apply to the other root's files not at all. That 31 is asserted below
  // rather than assumed, because it is the whole reason this file exists at the
  // archive: a boundary that follows the corpus when it is in one root and
  // silently evaporates when it is split across two.
  const { eligible, worklist, counts } = scanAll([VAULT, ARCHIVE]);

  assert.ok(eligible.length > 1200, `expected >1200 eligible files, got ${eligible.length}`);
  assert.ok(eligible.length < 2500, `eligible ${eligible.length} is implausibly high — is .graphifyignore still being honoured?`);
  assert.ok(worklist.length > 700, `expected >700 unindexed files, got ${worklist.length}`);
  assert.ok(
    counts.indexed > 400 && counts.indexed < 1000,
    `indexed count ${counts.indexed} is outside the plausible band`,
  );
  assert.equal(counts.eligible, counts.indexed + counts.worklist);

  // The boundary check that matters, against the real thing.
  assert.ok(
    !eligible.some((p) => p.startsWith('Satset/')),
    'Satset/ is excluded by .graphifyignore and must never appear in the worklist',
  );
  assert.ok(counts.ignored > 0, 'detect() reported no ignored paths, so the ignore files were not read');

  // The archive must honour the same scope boundary the vault does. These 31
  // are "hi", "say-pong", "say-ok" and rtk-probe duplicates -- connect-and-
  // disconnect smoke tests that a knowledge graph cannot distinguish from a
  // real conversation. Without a .graphifyignore in the archive root, the
  // detector has nothing to exclude them by and eligible lands on 1,615.
  const probes = eligible.filter((p) => /^05 - Conversations\/(tmp|tmp-opencode-)/.test(p));
  assert.equal(
    probes.length,
    0,
    `${probes.length} tool-test transcripts leaked past GROUP 7 — does ${ARCHIVE}/.graphifyignore exist?`,
  );

  // Both roots must actually be scanned. Asserted positively rather than by
  // arithmetic, because the failure mode is one root returning zero and the
  // total still looking plausible.
  assert.ok(counts.byRoot.length === 2, `expected 2 roots scanned, got ${counts.byRoot.length}`);
  assert.ok(
    counts.byRoot.every((r) => r.eligible > 0),
    `a root contributed nothing: ${JSON.stringify(counts.byRoot)}`,
  );
  assert.equal(
    counts.byRoot.reduce((n, r) => n + r.eligible, 0),
    counts.eligible,
    'per-root eligible does not sum to the total — the union is double counting or dropping',
  );
});

live('the real vault scan is deterministic', { timeout: 300_000 }, () => {
  const a = scanAll([VAULT, ARCHIVE]);
  const b = scanAll([VAULT, ARCHIVE]);

  assert.deepEqual(a.worklist, b.worklist);
  assert.deepEqual(a.counts, b.counts);
});

// resolve() is imported for the fixture assertions above; referencing it here
// keeps the import honest if the file is ever trimmed.
assert.equal(typeof resolve, 'function');
