// scripts/lib/local-config.mjs
//
// The one place where vault and mirror scripts resolve machine-specific paths.
// The repo is public, but the paths it operates on (an Obsidian vault, a
// session archive, a graphify venv) are not, and no two machines agree on
// them. Hard-coding /home/<user> paths in scripts breaks every other checkout
// and worktree. Each path therefore comes from, in order:
//
//   1. process.env[envVar], when set to a non-empty string
//   2. local.config.json[configKey]   (git-ignored, machine-specific)
//
// and otherwise the call throws. There is no default path to fall back to: a
// silent wrong guess writes exports into the wrong tree, while a thrown error
// names the env var, the config file, and the example file to copy.
//
// local.config.json schema (copy local.config.example.json to the repo root
// and fill in real values; every value is an absolute path string):
//
//   vaultRoot             absolute path to the Obsidian vault root
//   archiveRoot           absolute path to the session archive root
//   graphifySitePackages  absolute path to graphify's site-packages directory
//   graphifyPython        absolute path to the graphify venv python binary
//
// Zero dependencies, fully synchronous, and nothing is read at module import
// time: every env and file access happens inside a call, so importing this
// module can never throw and tests can override the config path.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Derived from this module's own URL (scripts/lib/ is two levels below the
// repo root), not from cwd, so any checkout or worktree resolves its own root.
function defaultConfigPath() {
  return fileURLToPath(new URL('../../local.config.json', import.meta.url));
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`local-config: ${name} must be a non-empty string`);
  }
}

// Returns null when the file does not exist. Anything else wrong (bad JSON,
// valid JSON that is not an object) throws an Error naming the file, because
// "the file is there but unusable" and "the file is not there" need different
// fixes and the caller cannot tell them apart from a bare SyntaxError.
function readLocalConfig(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`local-config: ${configPath} is not valid JSON: ${err.message}`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`local-config: ${configPath} must contain a JSON object of path settings`);
  }
  return config;
}

/**
 * Resolve one machine-specific path.
 *
 * Precedence: `process.env[envVar]` when set to a non-empty string (returned
 * verbatim, no trimming), then the JSON file at `configPath`. Anything else
 * throws rather than guessing.
 *
 * @param {object} opts
 * @param {string} opts.envVar environment variable checked first
 * @param {string} opts.configKey key looked up in the config file
 * @param {string} [opts.label] human-readable name used in the missing-file
 *   error; defaults to configKey
 * @param {string} [opts.configPath] absolute path to the JSON config file;
 *   test-only override. Defaults to <repo root>/local.config.json, resolved
 *   from this module's own URL so it is correct in any checkout or worktree.
 * @returns {string} the configured path
 * @throws {TypeError} envVar, configKey, label, or configPath is not a
 *   non-empty string
 * @throws {Error} the config file is missing, is not valid JSON, is not a JSON
 *   object, or has no usable (non-empty string) value under configKey
 */
export function resolveConfiguredPath({ envVar, configKey, label, configPath } = {}) {
  requireNonEmptyString(envVar, 'envVar');
  requireNonEmptyString(configKey, 'configKey');
  const name = label === undefined ? configKey : label;
  requireNonEmptyString(name, 'label');
  const file = configPath === undefined ? defaultConfigPath() : configPath;
  requireNonEmptyString(file, 'configPath');

  const fromEnv = process.env[envVar];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  const config = readLocalConfig(file);
  if (config === null) {
    throw new Error(
      `Missing ${name}: set ${envVar} or add "${configKey}" to local.config.json `
      + `(see local.config.example.json). Tried ${file}`,
    );
  }
  const value = config[configKey];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Missing key "${configKey}" in ${file}: set ${envVar} to override `
      + `or see local.config.example.json`,
    );
  }
  return value;
}
