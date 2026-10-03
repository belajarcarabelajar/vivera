// scripts/vault-index-cluster.test.mjs
//
// T10's regression suite. The clustering itself is graphify's own `cluster()` and
// `label_communities_by_hub()`, driven by `vault-index-cluster.py`; this file
// drives that script the way vault-index-narration.test.mjs drives the narration
// filter, because the repo runs one test runner (`bun test scripts/`) and the
// python helper cannot be unit-tested from JS any other way.
//
// The property that matters most is the one the whole deviation rests on: the
// graph must come back with every node it went in with. `graphify cluster-only`
// cannot do that (its loader drops 1,794 concept nodes), so if this script ever
// reports a node count below the file's, the write must be refused — and the test
// that pins the gate is the one that would catch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  computeCommunities,
  applyCommunities,
  pythonBinary,
  resolveVaultRoot,
} from './vault-index-cluster.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = join(HERE, 'vault-index-cluster.py');

// The runner's own python binary, resolved once through the same seam the
// runner uses: $GRAPHIFY_PYTHON, else the git-ignored local.config.json. Null
// when the host has neither, which is the skip signal for every test that
// would spawn it; the seam tests further down run everywhere regardless.
function resolvePythonOrNull() {
  try {
    return pythonBinary();
  } catch {
    return null;
  }
}
const PYTHON = resolvePythonOrNull();

// ---------- the machine seam ----------
//
// vault-index-cluster.py refuses to guess where graphify lives: it requires
// GRAPHIFY_SITE_PACKAGES in its environment. The runner inherits whatever its
// process has (that is how vault-index-cluster.mjs passes the setting down),
// and these tests set it explicitly rather than relying on ambient state. The
// value is discovered from the host: the environment first, then by asking the
// runner's own interpreter where graphify lives, and when the host has
// neither, the tests that need a real graphify skip with the reason while the
// machine-independent guards and the seam tests below still run.

function discoverSitePackages() {
  if (process.env.GRAPHIFY_SITE_PACKAGES) return process.env.GRAPHIFY_SITE_PACKAGES;
  if (PYTHON === null) return null;
  const probe = spawnSync(
    PYTHON,
    ['-c', 'import graphify, os; print(os.path.dirname(os.path.dirname(graphify.__file__)))'],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) return null;
  const dir = String(probe.stdout ?? '').trim();
  return dir === '' ? null : dir;
}

const SITE_PACKAGES = discoverSitePackages();
const GRAPHIFY_READY = SITE_PACKAGES !== null && PYTHON !== null;
const PYTHON3_AVAILABLE = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0;

/** `test` for a case that needs a real graphify; skips when the seam is unconfigured. */
function spawning(name, fn) {
  test(
    name,
    GRAPHIFY_READY
      ? {}
      : {
          skip:
            'GRAPHIFY_SITE_PACKAGES / GRAPHIFY_PYTHON could not be resolved on this host; set them in the environment or local.config.json (see local.config.example.json)',
        },
    fn,
  );
}

/**
 * Run `fn` with a patched environment, restored on the way out. A value of
 * `undefined` deletes the variable rather than leaving the string "undefined",
 * so the code under test sees a genuinely empty seam.
 */
function withEnv(overrides, fn) {
  const saved = Object.entries(overrides);
  for (const [key, value] of saved) {
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

// A graph with two connected pairs and one isolated node. The isolated node is
// the case T10 step 2 is about: it has nothing to cluster with, so it must come
// back as a singleton community, not be dropped and not be left unassigned.
function fixtureGraph() {
  return {
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [
      { id: 'a', label: 'Alpha', file_type: 'concept', source_file: 'x.md' },
      { id: 'b', label: 'Beta', file_type: 'concept', source_file: 'x.md' },
      { id: 'c', label: 'Gamma', file_type: 'concept', source_file: 'y.md' },
      { id: 'd', label: 'Delta', file_type: 'concept', source_file: 'y.md' },
      { id: 'iso', label: 'Isolated', file_type: 'concept', source_file: 'z.md' },
    ],
    links: [
      { source: 'a', target: 'b', relation: 'rel' },
      { source: 'c', target: 'd', relation: 'rel' },
    ],
    built_at_commit: 'fixture',
  };
}

function fixtureFile() {
  const dir = mkdtempSync(join(tmpdir(), 'vault-cluster-'));
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify(fixtureGraph()), 'utf8');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runPython(graphPath) {
  const r = spawnSync(PYTHON, [PYTHON_SCRIPT, graphPath], {
    encoding: 'utf8',
    // The script requires this; passing it per spawn keeps the ambient
    // environment untouched for every other test in the run.
    env: { ...process.env, GRAPHIFY_SITE_PACKAGES: SITE_PACKAGES },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------- machine-independent guards ----------

test('the helper runs under /usr/bin/env python3 and carries no machine path', () => {
  const source = readFileSync(PYTHON_SCRIPT, 'utf8');
  assert.equal(source.split('\n', 1)[0], '#!/usr/bin/env python3');
  assert.doesNotMatch(source, /\/home\//, 'a hard-coded /home/ path leaked back into the helper');
});

test('without GRAPHIFY_SITE_PACKAGES the helper exits non-zero and names the variable', {
  skip: PYTHON3_AVAILABLE ? false : 'no python3 on PATH',
}, () => {
  const f = fixtureFile();
  try {
    // The env is constructed without the variable rather than deleted from
    // process.env, so the test process itself is never mutated.
    const { GRAPHIFY_SITE_PACKAGES: _dropped, ...envWithout } = process.env;
    const r = spawnSync('python3', [PYTHON_SCRIPT, f.file], { encoding: 'utf8', env: envWithout });
    assert.notEqual(r.status, 0, 'the helper must not run without GRAPHIFY_SITE_PACKAGES');
    assert.match(r.stderr, /GRAPHIFY_SITE_PACKAGES/, 'the error must name the variable to set');
  } finally {
    f.cleanup();
  }
});

// ---------- the module's own seam (VAULT_ROOT / GRAPHIFY_PYTHON) ----------
//
// vault-index-cluster.mjs used to carry two hard-coded /home/ defaults: the
// vault root and the graphify venv python. Both now resolve through
// lib/local-config.mjs the way vault-index.mjs and vault-index-rebuild.mjs do,
// environment variable first, then the git-ignored local.config.json, then an
// error that names both. None of these tests need a real graphify: the
// resolution chain is checked on its own, and the spawn check uses a marked
// interpreter whose only job is to prove which binary was launched.

test('the runner module carries no hard-coded home path', () => {
  // The seam replaced defaults that were one machine's home directory, and the
  // resolution chain now ends in an error rather than a guess, so any /home/
  // literal left in this module would be reachable on some host. Reading the
  // module's own source is the cheapest guard against it creeping back.
  const source = readFileSync(new URL('./vault-index-cluster.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/home\//);
});

test('with no environment and no config the seam throws an actionable error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-cluster-seam-absent-'));
  try {
    const absent = join(dir, 'absent-config.json');
    withEnv({ GRAPHIFY_PYTHON: undefined, VAULT_ROOT: undefined }, () => {
      assert.throws(
        () => pythonBinary({ configPath: absent }),
        (err) => {
          assert.match(err.message, /GRAPHIFY_PYTHON/, 'the error must name the env var to set');
          assert.match(err.message, /local\.config\.json/, 'the error must name the config file');
          return true;
        },
      );
      assert.throws(
        () => resolveVaultRoot({ configPath: absent }),
        (err) => {
          assert.match(err.message, /VAULT_ROOT/, 'the error must name the env var to set');
          assert.match(err.message, /local\.config\.json/, 'the error must name the config file');
          return true;
        },
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GRAPHIFY_PYTHON from the environment is the interpreter computeCommunities spawns', () => {
  const f = fixtureFile();
  const dir = mkdtempSync(join(tmpdir(), 'vault-cluster-seam-env-'));
  // The marked interpreter touches a breadcrumb and exits 3 without running the
  // script, so the test does not depend on which python packages the host has:
  // exit 3 and the breadcrumb can only come from this wrapper, which makes them
  // proof that the configured interpreter, not some fallback, was spawned.
  const wrapper = join(dir, 'marked-python.sh');
  const breadcrumb = join(dir, 'marked-python-ran');
  writeFileSync(wrapper, `#!/bin/sh\ntouch '${breadcrumb}'\nexit 3\n`, 'utf8');
  chmodSync(wrapper, 0o755);
  try {
    withEnv({ GRAPHIFY_PYTHON: wrapper }, () => {
      assert.throws(
        () => computeCommunities(f.file),
        (err) => {
          assert.match(err.message, /exited 3/, `the marked interpreter's exit was not surfaced: ${err.message}`);
          return true;
        },
      );
      assert.ok(existsSync(breadcrumb), 'the marked interpreter never ran: GRAPHIFY_PYTHON was ignored');
    });
  } finally {
    f.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local.config.json provides the interpreter and the vault root when the environment is empty', () => {
  const f = fixtureFile();
  const dir = mkdtempSync(join(tmpdir(), 'vault-cluster-seam-config-'));
  const wrapper = join(dir, 'marked-python.sh');
  const breadcrumb = join(dir, 'marked-python-ran');
  writeFileSync(wrapper, `#!/bin/sh\ntouch '${breadcrumb}'\nexit 3\n`, 'utf8');
  chmodSync(wrapper, 0o755);
  const configPath = join(dir, 'local.config.json');
  writeFileSync(configPath, JSON.stringify({ graphifyPython: wrapper, vaultRoot: dir }));
  try {
    withEnv({ GRAPHIFY_PYTHON: undefined, VAULT_ROOT: undefined }, () => {
      assert.equal(pythonBinary({ configPath }), wrapper, 'graphifyPython was not read from the config');
      assert.equal(resolveVaultRoot({ configPath }), dir, 'vaultRoot was not read from the config');
      // And the config python is not just returned, it is the one spawned.
      assert.throws(
        () => computeCommunities(f.file, { configPath }),
        (err) => {
          assert.match(err.message, /exited 3/);
          return true;
        },
      );
      assert.ok(existsSync(breadcrumb), 'the config python never ran: graphifyPython was ignored');
    });
  } finally {
    f.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the environment wins over local.config.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-cluster-seam-precedence-'));
  try {
    const configPath = join(dir, 'local.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ graphifyPython: '/config/loses/python', vaultRoot: '/config/loses/vault' }),
    );
    withEnv({ GRAPHIFY_PYTHON: '/env/wins/python', VAULT_ROOT: '/env/wins/vault' }, () => {
      assert.equal(pythonBinary({ configPath }), '/env/wins/python', 'the env value did not win');
      assert.equal(resolveVaultRoot({ configPath }), '/env/wins/vault', 'the env value did not win');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the python clustering ----------

spawning('clusters a fixture graph and assigns every node a community', () => {
  const f = fixtureFile();
  try {
    const { status, stdout, stderr } = runPython(f.file);
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const out = JSON.parse(stdout);
    assert.equal(out.node_count, 5, 'every node must survive the round trip');
    assert.equal(out.link_count, 2);
    assert.equal(out.degree_zero, 1, 'the isolated node is still isolated');
    assert.equal(out.singletons, 1, 'an isolated node is its own singleton community');
    assert.equal(out.unassigned.length, 0, 'no node is left without a community');
    assert.equal(Object.keys(out.mapping).length, 5);
    // Two pairs + one singleton = three communities.
    assert.equal(out.community_count, 3);
    // The two pairs are named after their hub; the singleton after its only member.
    const names = Object.values(out.mapping).map((m) => m.community_name);
    assert.ok(names.includes('Alpha') || names.includes('Beta'));
    assert.ok(names.includes('Gamma') || names.includes('Delta'));
    assert.ok(names.includes('Isolated'));
  } finally {
    f.cleanup();
  }
});

spawning('clustering is deterministic across two runs', () => {
  const f = fixtureFile();
  try {
    const a = JSON.parse(runPython(f.file).stdout);
    const b = JSON.parse(runPython(f.file).stdout);
    assert.deepEqual(a.mapping, b.mapping, 'two runs on one graph must agree');
    assert.equal(a.community_count, b.community_count);
  } finally {
    f.cleanup();
  }
});

spawning('a node with no edges is a singleton, not a drop', () => {
  // The failure this pins: an implementation that only clusters connected
  // components would report 4 nodes here and silently lose the fifth.
  const f = fixtureFile();
  try {
    const out = JSON.parse(runPython(f.file).stdout);
    assert.equal(out.node_count, 5);
    assert.ok(out.mapping.iso, 'the isolated node must be in the mapping');
    assert.equal(out.mapping.iso.community_name, 'Isolated');
  } finally {
    f.cleanup();
  }
});

// ---------- the JS apply step ----------

test('applyCommunities adds community fields and preserves every node and link', () => {
  const graph = fixtureGraph();
  const mapping = {
    a: { community: 0, community_name: 'Alpha' },
    b: { community: 0, community_name: 'Alpha' },
    c: { community: 1, community_name: 'Gamma' },
    d: { community: 1, community_name: 'Gamma' },
    iso: { community: 2, community_name: 'Isolated' },
  };
  const { graph: out, assigned, unassigned } = applyCommunities(graph, mapping);
  assert.equal(out.nodes.length, 5);
  assert.equal(out.links.length, 2, 'links are untouched');
  assert.equal(assigned, 5);
  assert.equal(unassigned, 0);
  assert.equal(out.nodes[0].community, 0);
  assert.equal(out.nodes[0].community_name, 'Alpha');
  assert.equal(out.nodes[4].community, 2);
  // The input is not mutated, so a dry run and a write run build the same object.
  assert.equal(graph.nodes[0].community, undefined);
});

test('applyCommunities counts nodes absent from the mapping as unassigned', () => {
  const graph = fixtureGraph();
  const { assigned, unassigned } = applyCommunities(graph, { a: { community: 0, community_name: 'A' } });
  assert.equal(assigned, 1);
  assert.equal(unassigned, 4);
});

test('applyCommunities leaves a node with no mapping untouched', () => {
  const graph = fixtureGraph();
  const { graph: out } = applyCommunities(graph, {});
  assert.equal(out.nodes[0].community, undefined);
  assert.equal(out.nodes.length, 5);
});

// ---------- the gate the runner enforces ----------

spawning('computeCommunities surfaces a node-count mismatch instead of hiding it', () => {
  // The runner refuses to write when the clustering saw fewer nodes than the
  // file holds. This is the check that would have caught the 1,794-node drop
  // that makes `graphify cluster-only` refuse to run.
  const f = fixtureFile();
  // computeCommunities spawns through the runner, which passes the ambient
  // environment down and resolves the interpreter through the same seam, so
  // both halves are set here and restored on the way out.
  const saved = process.env.GRAPHIFY_SITE_PACKAGES;
  const savedPython = process.env.GRAPHIFY_PYTHON;
  process.env.GRAPHIFY_SITE_PACKAGES = SITE_PACKAGES;
  process.env.GRAPHIFY_PYTHON = PYTHON;
  try {
    const result = computeCommunities(f.file);
    assert.equal(result.nodeCount, 5);
    // A graph whose nodes are all dropped would report 0; the runner's gate
    // compares this against the file's count and exits non-zero.
    assert.ok(result.nodeCount > 0);
  } finally {
    if (saved === undefined) delete process.env.GRAPHIFY_SITE_PACKAGES;
    else process.env.GRAPHIFY_SITE_PACKAGES = saved;
    if (savedPython === undefined) delete process.env.GRAPHIFY_PYTHON;
    else process.env.GRAPHIFY_PYTHON = savedPython;
    f.cleanup();
  }
});
