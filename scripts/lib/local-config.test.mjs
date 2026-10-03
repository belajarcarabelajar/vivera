// scripts/lib/local-config.test.mjs
//
// Guards for the local path config helper.
//
// local.config.json holds machine-specific absolute paths (vault root, archive
// root, graphify venv locations) and is git-ignored. Scripts must never
// hard-code /home/<user> paths, and the helper must never guess a default:
// a silent wrong guess writes exports into the wrong tree. So the contract is
// strict precedence with loud failure:
//
//   1. process.env[envVar], when set to a non-empty string
//   2. local.config.json[configKey]
//   3. otherwise throw, naming the env var, both config files, and the label
//
// FIXTURE HYGIENE. local.config.json is user state and this suite must never
// create it in the repository. Every file fixture lives in a mkdtemp directory
// under os.tmpdir() and is passed through the configPath override. The default
// repo-root resolution is proven from the missing-file error message (which
// reports the attempted path) and only asserts when the repo has no
// local.config.json, i.e. on CI and fresh clones.
//
// IMPORT PURITY. Nothing may be read at module import time: scripts import
// helpers early, and an import that throws while the local config is absent
// would break every command before it can print a usable error. The env var
// is proven to be read at call time by mutating it between two calls in one
// process; the subprocess probe covers the config side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveConfiguredPath } from './local-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(__dirname, 'local-config.mjs');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CONFIG = path.join(REPO_ROOT, 'local.config.json');

// A prefix no other script or test uses, so env mutation cannot collide.
const ENV = 'LOCAL_CONFIG_TEST_VAULT_ROOT';
const LABEL = 'Graphify site-packages';
const KEY = 'graphifySitePackages';

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return fn();
  } finally {
    if (had) process.env[name] = previous;
    else delete process.env[name];
  }
}

function withTempConfig(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'local-config-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 1. env precedence ----------

test('a set, non-empty env var wins, and the config file is never read', () => {
  // The config file is malformed on purpose: if the helper read it before
  // honouring the env var, JSON.parse would throw and this test would fail.
  withTempConfig({ 'cfg.json': '{ this is not json' }, (dir) => {
    const opts = {
      envVar: ENV,
      configKey: KEY,
      label: LABEL,
      configPath: path.join(dir, 'cfg.json'),
    };
    withEnv(ENV, '/env/site-packages', () => {
      assert.equal(resolveConfiguredPath(opts), '/env/site-packages');
    });
  });
});

test('an empty-string env var falls through to the config file', () => {
  withTempConfig({ 'cfg.json': JSON.stringify({ [KEY]: '/cfg/site-packages' }) }, (dir) => {
    const opts = {
      envVar: ENV,
      configKey: KEY,
      label: LABEL,
      configPath: path.join(dir, 'cfg.json'),
    };
    withEnv(ENV, '', () => {
      assert.equal(resolveConfiguredPath(opts), '/cfg/site-packages');
    });
  });
});

test('a whitespace-only env var is non-empty and is returned verbatim', () => {
  // The contract is "set and non-empty string"; trimming is a policy change
  // that would break callers whose paths legitimately contain spaces. Pinned
  // so that any change here has to be a conscious one.
  const opts = { envVar: ENV, configKey: KEY, configPath: '/nonexistent/local-config-test.json' };
  withEnv(ENV, ' /env with spaces ', () => {
    assert.equal(resolveConfiguredPath(opts), ' /env with spaces ');
  });
});

test('the env var is read at call time, not captured at import time', () => {
  const opts = { envVar: ENV, configKey: KEY, configPath: '/nonexistent/local-config-test.json' };
  withEnv(ENV, '/env/first', () => {
    assert.equal(resolveConfiguredPath(opts), '/env/first');
  });
  withEnv(ENV, '/env/second', () => {
    assert.equal(resolveConfiguredPath(opts), '/env/second');
  });
});

// ---------- 2. config file fallback ----------

test('with no env var, the value comes from the config file via the override', () => {
  withTempConfig(
    { 'cfg.json': JSON.stringify({ [KEY]: '/cfg/site-packages', vaultRoot: '/cfg/vault' }) },
    (dir) => {
      const configPath = path.join(dir, 'cfg.json');
      withEnv(ENV, undefined, () => {
        assert.equal(resolveConfiguredPath({ envVar: ENV, configKey: KEY, configPath }), '/cfg/site-packages');
        assert.equal(
          resolveConfiguredPath({ envVar: ENV, configKey: 'vaultRoot', label: 'Vault root', configPath }),
          '/cfg/vault',
        );
      });
    },
  );
});

// ---------- 3. missing file ----------

test('a missing config file throws an Error naming the env var, both config files, and the label', () => {
  withTempConfig({}, (dir) => {
    const opts = {
      envVar: ENV,
      configKey: KEY,
      label: LABEL,
      configPath: path.join(dir, 'absent.json'),
    };
    withEnv(ENV, undefined, () => {
      assert.throws(() => resolveConfiguredPath(opts), (err) => {
        assert.equal(err.name, 'Error');
        for (const token of [ENV, 'local.config.json', 'local.config.example.json', LABEL]) {
          assert.ok(err.message.includes(token), `message missing ${JSON.stringify(token)}: ${err.message}`);
        }
        return true;
      });
    });
  });
});

test('when label is omitted, the error falls back to the config key', () => {
  withTempConfig({}, (dir) => {
    const opts = { envVar: ENV, configKey: KEY, configPath: path.join(dir, 'absent.json') };
    withEnv(ENV, undefined, () => {
      assert.throws(() => resolveConfiguredPath(opts), (err) => {
        assert.ok(err.message.includes(`Missing ${KEY}:`), `message missing the key label: ${err.message}`);
        return true;
      });
    });
  });
});

test('with no configPath override, the default is the repo root local.config.json', () => {
  if (existsSync(DEFAULT_CONFIG)) {
    // A real local.config.json on this machine would satisfy the lookup, so
    // the default path cannot be observed here. The resolution is still
    // proven wherever the file is absent, which is CI and fresh clones.
    return;
  }
  withEnv(ENV, undefined, () => {
    assert.throws(
      () => resolveConfiguredPath({ envVar: ENV, configKey: KEY, label: LABEL }),
      (err) => {
        assert.ok(
          err.message.includes(DEFAULT_CONFIG),
          `message should name the repo root config ${DEFAULT_CONFIG}: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ---------- 4. broken config content ----------

test('malformed JSON throws an error naming the file', () => {
  withTempConfig({ 'broken.json': '{ almost json' }, (dir) => {
    const file = path.join(dir, 'broken.json');
    withEnv(ENV, undefined, () => {
      assert.throws(
        () => resolveConfiguredPath({ envVar: ENV, configKey: KEY, configPath: file }),
        (err) => {
          assert.ok(err.message.includes(file), `message missing the file path: ${err.message}`);
          assert.ok(err.message.includes('not valid JSON'), `message missing the parse complaint: ${err.message}`);
          return true;
        },
      );
    });
  });
});

test('a config file that is not a JSON object throws an error naming the file', () => {
  for (const content of ['null', '[]', '"just a string"']) {
    withTempConfig({ 'odd.json': content }, (dir) => {
      const file = path.join(dir, 'odd.json');
      withEnv(ENV, undefined, () => {
        assert.throws(
          () => resolveConfiguredPath({ envVar: ENV, configKey: KEY, configPath: file }),
          (err) => {
            assert.ok(err.message.includes(file), `message missing the file path: ${err.message}`);
            return true;
          },
        );
      });
    });
  }
});

test('a missing key throws an error naming the key and the file', () => {
  withTempConfig({ 'cfg.json': JSON.stringify({ unrelated: '/x' }) }, (dir) => {
    const file = path.join(dir, 'cfg.json');
    withEnv(ENV, undefined, () => {
      assert.throws(
        () => resolveConfiguredPath({ envVar: ENV, configKey: KEY, label: LABEL, configPath: file }),
        (err) => {
          assert.ok(err.message.includes(KEY), `message missing the key: ${err.message}`);
          assert.ok(err.message.includes(file), `message missing the file path: ${err.message}`);
          return true;
        },
      );
    });
  });
});

test('a null, empty, or non-string value is a missing key, not a returned path', () => {
  const unusable = [null, '', 42, true, {}, ['/cfg/site-packages']];
  for (const value of unusable) {
    withTempConfig({ 'cfg.json': JSON.stringify({ [KEY]: value }) }, (dir) => {
      const file = path.join(dir, 'cfg.json');
      withEnv(ENV, undefined, () => {
        assert.throws(
          () => resolveConfiguredPath({ envVar: ENV, configKey: KEY, configPath: file }),
          (err) => {
            assert.ok(err.message.includes(KEY), `value ${JSON.stringify(value)}: ${err.message}`);
            return true;
          },
        );
      });
    });
  }
});

// ---------- 5. import purity ----------

test('importing the module performs no env or config reads', () => {
  // The env var is set to the empty string, so any import-time fall-through to
  // the default config would attempt to read the repo root local.config.json.
  // Where that file is absent (CI, fresh clones) an import-time read throws
  // and this probe fails with a nonzero exit. Where a user has the file, an
  // import-time read happens to succeed, so this probe proves less there; the
  // call-time env test above carries the rest of the guarantee.
  const src = `
    import { resolveConfiguredPath } from ${JSON.stringify(pathToFileURL(MODULE).href)};
    process.stdout.write(typeof resolveConfiguredPath);
  `;
  const r = spawnSync('bun', ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, [ENV]: '' },
  });
  assert.equal(r.status, 0, `import probe failed:\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.stdout, 'function');
});
