// scripts/lib/install-sandbox.mjs
//
// A sandbox for running install.sh in tests: a temp HOME, a COPY of the
// installer payload, and a PATH made only of symlinks to a named tool list.
//
// Why a copy of the repo and not the repo itself: install.sh writes into its own
// checkout (step 7 relinks skills/super-ultra-code-plan, step 8 sets
// core.hooksPath in that repo's git config). Running the real tree would change
// the checkout under test, so the copy has no .git unless a test asks for one.
//
// Why a symlinked PATH: "git is missing" and "bun is missing" must be true on
// the PATH the installer sees, not simulated, so those two are linked only when
// a test names them.

import { setDefaultTimeout } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every suite that runs install.sh spawns bash, git and bun many times. bun test's default of 5 s is
// too short on a loaded machine, and `bun test <file>` does not read the --timeout of the npm test
// script, so the helper sets it for every suite that imports it.
setDefaultTimeout(30_000);

const WORKTREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Repo-relative paths copied into the sandbox repo. The two optional entries
// appear in later tasks; every other entry must exist or the copy throws.
export const INSTALL_PAYLOAD = [
  'install.sh',
  'scripts/install',
  'scripts/gen-sprite-agents.mjs',
  'scripts/sprite-agents',
  'scripts/validate-agents.mjs',
  'scripts/lib',
  'agents',
  '.claude/hooks',
  'skills',
  'templates',
  'examples',
  'mermaid.config.json',
  'mermaid.dark.config.json',
  'package.json',
  'Super Ultra Code Plan Implementation.md',
];
const OPTIONAL_PAYLOAD = new Set(['scripts/install', 'scripts/sprite-agents']);

export const BASE_TOOLS = [
  'bash', 'env', 'ln', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'dirname', 'basename', 'readlink',
  'cat', 'date', 'sort', 'sed', 'awk', 'mktemp', 'tr', 'head', 'tail', 'cut', 'chmod', 'find',
  'uname', 'sha256sum', 'tee', 'printf', 'test', 'true', 'false', 'wc', 'ls', 'uniq', 'grep',
  'xargs', 'bun', 'git',
];
// On PATH only when a test names them, so a test can leave either out.
const NAMED_ONLY = new Set(['bun', 'git']);

const SYSTEM_DIRS = ['/usr/bin', '/bin'];

function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// System dirs first: a wrapper earlier on the user's PATH (this machine has a
// grep shim that delegates to tgrep) must not leak into the sandbox PATH.
function resolveTool(name) {
  for (const dir of SYSTEM_DIRS) {
    const p = path.join(dir, name);
    if (isExecutableFile(p)) return p;
  }
  return Bun.which(name);
}

// realpath of the deepest existing ancestor plus the rest, so a HOME that does
// not exist yet still resolves through a symlinked temp dir.
function resolveReal(p) {
  let head = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    rest.unshift(path.basename(head));
    head = parent;
  }
  return path.join(fs.realpathSync(head), ...rest);
}

export function assertSandbox(env) {
  const home = env && env.HOME;
  if (!home) throw new Error('install sandbox guard: HOME is not set');
  const real = resolveReal(home);
  if (real === resolveReal(os.homedir())) {
    throw new Error(`install sandbox guard: HOME is the real home directory (${home})`);
  }
  const tmp = resolveReal(os.tmpdir());
  if (!real.startsWith(tmp + path.sep)) {
    throw new Error(`install sandbox guard: HOME ${home} is not under ${os.tmpdir()}`);
  }
}

function copyEntry(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dest);
  } else if (st.isDirectory()) {
    fs.mkdirSync(dest);
    for (const name of fs.readdirSync(src)) copyEntry(path.join(src, name), path.join(dest, name));
  } else {
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, st.mode & 0o777);
  }
}

function copyPayload(repo) {
  for (const rel of INSTALL_PAYLOAD) {
    const src = path.join(WORKTREE, rel);
    let present = true;
    try {
      fs.lstatSync(src);
    } catch {
      present = false;
    }
    if (!present) {
      if (OPTIONAL_PAYLOAD.has(rel)) continue;
      throw new Error(`install sandbox: payload entry ${rel} is missing from ${WORKTREE}`);
    }
    const dest = path.join(repo, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyEntry(src, dest);
  }
  fs.symlinkSync(path.join(WORKTREE, 'node_modules'), path.join(repo, 'node_modules'));
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function makeSandbox({ tools = [], git = false, extraEnv = {} } = {}) {
  // Resolve every tool before creating anything, so a bad name leaves no temp dir behind.
  const links = [];
  for (const name of new Set([...BASE_TOOLS.filter((n) => !NAMED_ONLY.has(n)), ...tools])) {
    const target = resolveTool(name);
    if (target) links.push([name, target]);
    else if (tools.includes(name)) throw new Error(`install sandbox: tool '${name}' not found on this machine`);
  }
  const bash = resolveTool('bash');
  if (!bash) throw new Error("install sandbox: 'bash' not found on this machine");
  const gitBin = git ? resolveTool('git') : null;
  if (git && !gitBin) throw new Error("install sandbox: 'git' not found on this machine");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-install-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  try {
    for (const dir of [home, bin, tmp]) fs.mkdirSync(dir);
    for (const [name, target] of links) fs.symlinkSync(target, path.join(bin, name));
    copyPayload(repo);
    if (gitBin) {
      // Never read the real git config: install.sh step 8 writes to this repo's.
      const gitEnv = { HOME: home, PATH: path.dirname(gitBin), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
      for (const args of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']]) {
        const r = Bun.spawnSync([gitBin, ...args], { cwd: repo, env: gitEnv });
        if (r.exitCode !== 0) throw new Error(`install sandbox: git ${args.join(' ')} failed: ${r.stderr.toString()}`);
      }
    }
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }

  // BUN_RUNTIME_TRANSPILER_CACHE_PATH=0: without it bun writes ~/.bun/install/cache/@t@/*.pile
  // into HOME while the installer runs its scripts, which is bun's output and not the installer's
  // and would break exact-layout and read-only-HOME checks.
  const env = {
    HOME: home,
    PATH: bin,
    VIVERA_NOW: '20260101T000000Z',
    TMPDIR: tmp,
    LANG: 'C',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    ...extraEnv,
  };
  const roots = new Set([root, fs.realpathSync(root)]);
  const mask = (s) => [...roots].reduce((acc, r) => acc.split(r).join('<ROOT>'), s);

  // `opts.env` overrides single variables for one run; the guard sees the merged env.
  function run(args = [], opts = {}) {
    const runEnv = { ...env, ...(opts.env ?? {}) };
    assertSandbox(runEnv);
    const pairs = Object.entries(runEnv).map(([k, v]) => `${k}=${v}`);
    const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, bash, path.join(repo, 'install.sh'), ...args], {
      cwd: home,
      timeout: 60_000,
    });
    return { status: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }

  function snapshot(dir = home) {
    const out = [];
    const walk = (abs, rel) => {
      for (const name of fs.readdirSync(abs)) {
        const p = path.join(abs, name);
        const r = rel ? `${rel}/${name}` : name;
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) out.push(`${r}|l|${mask(fs.readlinkSync(p))}`);
        else if (st.isDirectory()) {
          out.push(`${r}|d|`);
          walk(p, r);
        } else if (st.isFile()) out.push(`${r}|f|${sha256(p)}`);
        else out.push(`${r}|o|`);
      }
    };
    walk(dir, '');
    return out.sort();
  }

  function cleanup() {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { root, home, repo, bin, env, run, snapshot, cleanup };
}
