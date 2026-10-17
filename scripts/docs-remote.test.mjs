// scripts/docs-remote.test.mjs
//
// Drives scripts/docs-remote.sh through its command line with stub `ssh`,
// `rsync`, `git` and `bun` on PATH. Each stub appends one line per call to a
// shared log, so the order of calls across stubs is observable. No network, no
// VPS, no real deploy.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'docs-remote.sh');
const REAL_GIT = Bun.which('git');
const BASH = Bun.which('bash');
const ACK = 'I_UNDERSTAND_THIS_CHANGES_LIVE';
const LIVE_URL = 'https://vivera.belajarcarabelajar.com/docs/';

const STUBS = {
  ssh: `#!/usr/bin/env bash
cmd="\${!#}"
bytes=$(wc -c | tr -d ' ')
printf 'ssh\\t%s\\t%s\\n' "$bytes" "\${cmd//$'\\n'/ }" >> "$STUB_LOG"
if [ -n "\${STUB_SSH_FAIL_MATCH:-}" ] && [[ "$cmd" == *"$STUB_SSH_FAIL_MATCH"* ]]; then
  echo "stub ssh: failing on purpose" >&2
  exit 1
fi
if [[ "$cmd" == *"mktemp -d "* ]]; then
  mktemp -u "\${cmd##*mktemp -d }"
fi
# Same shape as wrangler 4.151.1 \`deployments list --json\` (JSON.stringify(list, null, 2)).
if [[ "$cmd" == *"deployments list --json"* ]]; then
  n="\${STUB_DEPLOYMENTS:-2}"
  printf '['
  for ((k = 1; k <= n; k++)); do
    [ "$k" -eq 1 ] || printf ','
    printf '\\n  {\\n    "id": "dep-%s",\\n    "source": "wrangler",\\n    "versions": [\\n      {\\n        "version_id": "ver-%s",\\n        "percentage": 100\\n      }\\n    ]\\n  }' "$k" "$k"
  done
  printf '\\n]\\n'
fi
exit 0
`,
  rsync: `#!/usr/bin/env bash
printf 'rsync\\t%s\\n' "$*" >> "$STUB_LOG"
exit 0
`,
  git: `#!/usr/bin/env bash
args=("$@")
i=0
while [ "$i" -lt "\${#args[@]}" ]; do
  case "\${args[$i]}" in -C|-c) i=$((i + 2)) ;; *) break ;; esac
done
case "\${args[$i]:-}" in
  status)
    printf 'git\\tstatus\\n' >> "$STUB_LOG"
    [ -z "\${STUB_GIT_STATUS:-}" ] || printf '%s\\n' "$STUB_GIT_STATUS"
    exit 0 ;;
  archive)
    printf 'git\\t%s\\n' "\${args[*]:$i}" >> "$STUB_LOG"
    printf 'STUB-TAR'
    exit 0 ;;
esac
exec "$STUB_REAL_GIT" "$@"
`,
  bun: `#!/usr/bin/env bash
printf 'bun\\t%s\\n' "$*" >> "$STUB_LOG"
case " $* " in *" --live "*)
  # STUB_LIVE_EXITS is one exit code per live check; the last one repeats.
  if [ -n "\${STUB_LIVE_EXITS:-}" ]; then
    read -r -a codes <<< "$STUB_LIVE_EXITS"
    n=$(grep -c -e ' --live ' "$STUB_LOG")
    [ "$n" -le "\${#codes[@]}" ] || n="\${#codes[@]}"
    exit "\${codes[$((n - 1))]}"
  fi
  exit "\${STUB_LIVE_EXIT:-0}" ;;
esac
exit 0
`,
  sleep: `#!/usr/bin/env bash
printf 'sleep\\t%s\\n' "$*" >> "$STUB_LOG"
exit 0
`,
};

let tmp;
let bin;
let callLog;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-remote-test-'));
  bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  callLog = path.join(tmp, 'calls.log');
  fs.writeFileSync(callLog, '');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args, env = {}, script = SCRIPT) {
  const base = { ...process.env };
  delete base.VIVERA_DOCS_DEPLOY_ACK;
  delete base.VIVERA_VPS;
  const proc = Bun.spawnSync([BASH, script, ...args], {
    cwd: ROOT,
    stdin: 'ignore',
    env: {
      ...base,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: callLog,
      STUB_REAL_GIT: REAL_GIT,
      VIVERA_DOCS_LOG_DIR: tmp,
      ...env,
    },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
}

function calls() {
  return fs
    .readFileSync(callLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tool, ...rest] = line.split('\t');
      if (tool === 'ssh') return { tool, bytes: Number(rest[0]), text: rest.slice(1).join('\t') };
      return { tool, bytes: 0, text: rest.join('\t') };
    });
}

const sshCalls = () => calls().filter((c) => c.tool === 'ssh');
const RUN_DIR = /\/tmp\/vivera-docs-[a-z]+-\d{8}T\d{6}Z-[A-Za-z0-9]{6}/g;

// The mktemp template itself also matches RUN_DIR (XXXXXX), so its call is skipped.
function runDirs(seq) {
  const found = seq.filter((c) => !c.text.includes('mktemp')).flatMap((c) => c.text.match(RUN_DIR) ?? []);
  return [...new Set(found)];
}
const REAL_WRANGLER_DEPLOY = /bunx wrangler@4\.151\.1 deploy(?!\s+--dry-run)/;

function expectInOrder(haystack, markers) {
  let from = 0;
  for (const marker of markers) {
    const at = haystack.indexOf(marker, from);
    expect({ marker, found: at >= 0 }).toEqual({ marker, found: true });
    from = at + marker.length;
  }
}

test('an unknown mode exits 2 and the usage names every mode', () => {
  const r = run(['bogus']);
  expect(r.code).toBe(2);
  expect(r.out).toContain('build');
  expect(r.out).toContain('deploy [--dry-run]');
  expect(calls()).toEqual([]);
});

test('deploy without the ACK and without --dry-run exits 1 before any ssh', () => {
  const r = run(['deploy']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('VIVERA_DOCS_DEPLOY_ACK');
  expect(sshCalls()).toEqual([]);
});

test('build with a dirty tree exits 1 before any ssh', () => {
  const r = run(['build'], { STUB_GIT_STATUS: ' M README.md' });
  expect(r.code).toBe(1);
  expect(r.out).toContain('README.md');
  expect(sshCalls()).toEqual([]);
});

test('deploy --dry-run streams HEAD, runs the build steps in order, and only dry-runs wrangler', () => {
  const r = run(['deploy', '--dry-run'], { STUB_GIT_STATUS: '?? node_modules' });
  expect(r.code).toBe(0);

  const archives = calls().filter((c) => c.tool === 'git').map((c) => c.text);
  expect(archives).toContain('archive --format=tar HEAD');
  expect(archives).toContain('archive --format=tar --prefix=apps/ HEAD:apps');

  const ssh = sshCalls();
  const [dir] = runDirs(ssh);
  const upload = ssh.find((c) => c.text.includes('tar -x'));
  expect(upload.text).toContain(`tar -x --ignore-zeros -C ${dir}`);
  expect(upload.bytes).toBe('STUB-TARSTUB-TAR'.length);

  expectInOrder(ssh.map((c) => c.text).join('\n'), [
    'mktemp -d /tmp/vivera-docs-deploy-',
    `tar -x --ignore-zeros -C ${dir}`,
    'bun install --frozen-lockfile',
    'bun scripts/docs-gen.mjs --check --scope all',
    'bun scripts/docs-gen.mjs --write',
    'CARGO_TARGET_DIR=/root/.cache/vivera-docs-target',
    'dist/docs/generated',
    'bunx pagefind@1.5.2 --site dist --output-path dist/docs/pagefind',
    'bun scripts/docs-site-check.mjs apps/docs/dist',
    'bunx wrangler@4.151.1 deploy --dry-run',
    `rm -rf -- ${dir}`,
  ]);

  const dry = ssh.find((c) => c.text.includes('bunx wrangler@4.151.1 deploy --dry-run'));
  expect(dry.text).toContain('. ~/cloudflare/.env');
  expect(ssh.some((c) => REAL_WRANGLER_DEPLOY.test(c.text))).toBe(false);
  expect(calls().some((c) => c.tool === 'bun')).toBe(false);

  const logLine = r.out.split('\n').find((l) => l.startsWith('log: '));
  expect(path.basename(logLine.slice(5))).toMatch(/^vivera-docs-remote-deploy-\d{8}T\d{6}Z\.log$/);
});

const isLive = (c) => c.tool === 'bun' && c.text.includes(`--live ${LIVE_URL}`);
const isRollback = (c) =>
  c.tool === 'ssh' && c.text.includes('bunx wrangler@4.151.1 rollback --message "smoke failed" --yes');
const isDeploymentsList = (c) => c.tool === 'ssh' && c.text.includes('bunx wrangler@4.151.1 deployments list --json');
const sleeps = () => calls().filter((c) => c.tool === 'sleep').map((c) => c.text);

test('a live check that fails twice then passes exits 0 with no rollback', () => {
  const r = run(['deploy'], { VIVERA_DOCS_DEPLOY_ACK: ACK, STUB_LIVE_EXITS: '1 1 0' });
  expect(r.code).toBe(0);
  expect(calls().filter(isLive)).toHaveLength(3);
  expect(sleeps()).toEqual(['20', '20']);
  expect(calls().some(isRollback)).toBe(false);
  expect(calls().some(isDeploymentsList)).toBe(false);
  expectInOrder(r.out, [
    'live check: attempt 1/10 exit 1',
    'live check: attempt 2/10 exit 1',
    'live check: attempt 3/10 exit 0',
    'deploy: ok, live check passed',
  ]);
});

test('a live check that fails every attempt with an earlier deployment rolls back and exits 1', () => {
  const r = run(['deploy'], { VIVERA_DOCS_DEPLOY_ACK: ACK, STUB_LIVE_EXIT: '1', STUB_DEPLOYMENTS: '2' });
  expect(r.code).toBe(1);

  const seq = calls();
  const deployAt = seq.findIndex((c) => c.tool === 'ssh' && REAL_WRANGLER_DEPLOY.test(c.text));
  const firstLiveAt = seq.findIndex(isLive);
  const lastLiveAt = seq.findLastIndex(isLive);
  const listAt = seq.findIndex(isDeploymentsList);
  const rollbackAt = seq.findIndex(isRollback);
  expect(deployAt).toBeGreaterThan(-1);
  expect(firstLiveAt).toBeGreaterThan(deployAt);
  expect(seq.filter(isLive)).toHaveLength(10);
  expect(sleeps()).toEqual(Array(9).fill('20'));
  expect(listAt).toBeGreaterThan(lastLiveAt);
  expect(rollbackAt).toBeGreaterThan(listAt);
  expect(r.out).toContain('live check: attempt 10/10 exit 1');
  expect(r.out).toContain('live check: exit 1');
  expect(r.out).toContain('rollback: exit 0');
});

test('a live check that fails every attempt on a first deployment skips the rollback and exits 1', () => {
  const r = run(['deploy'], { VIVERA_DOCS_DEPLOY_ACK: ACK, STUB_LIVE_EXIT: '1', STUB_DEPLOYMENTS: '1' });
  expect(r.code).toBe(1);
  expect(calls().some(isDeploymentsList)).toBe(true);
  expect(calls().some(isRollback)).toBe(false);
  expect(r.out).toContain('nothing to roll back to');
  expect(r.out).toContain('remove the docs routes by hand');
  expect(r.out).toContain('live check: exit 1');
});

test('a deployments list that fails skips the rollback and exits 1', () => {
  const r = run(['deploy'], {
    VIVERA_DOCS_DEPLOY_ACK: ACK,
    STUB_LIVE_EXIT: '1',
    STUB_SSH_FAIL_MATCH: 'deployments list',
  });
  expect(r.code).toBe(1);
  expect(calls().some(isRollback)).toBe(false);
  expect(r.out).toContain('could not list deployments');
});

test('VIVERA_DOCS_LIVE_ATTEMPTS and VIVERA_DOCS_LIVE_INTERVAL set the retry count and the wait', () => {
  const r = run(['deploy'], {
    VIVERA_DOCS_DEPLOY_ACK: ACK,
    STUB_LIVE_EXIT: '1',
    VIVERA_DOCS_LIVE_ATTEMPTS: '3',
    VIVERA_DOCS_LIVE_INTERVAL: '5',
  });
  expect(r.code).toBe(1);
  expect(calls().filter(isLive)).toHaveLength(3);
  expect(sleeps()).toEqual(['5', '5']);
  expect(r.out).toContain('live check: attempt 3/3 exit 1');
});

test.each([
  ['VIVERA_DOCS_LIVE_ATTEMPTS', '0'],
  ['VIVERA_DOCS_LIVE_ATTEMPTS', 'three'],
  ['VIVERA_DOCS_LIVE_INTERVAL', '-1'],
])('deploy refuses %s=%s with exit 2 before any ssh', (name, value) => {
  const r = run(['deploy'], { VIVERA_DOCS_DEPLOY_ACK: ACK, [name]: value });
  expect(r.code).toBe(2);
  expect(r.out).toContain(name);
  expect(sshCalls()).toEqual([]);
});

test('a real deploy whose live check passes exits 0 without a rollback', () => {
  const r = run(['deploy'], { VIVERA_DOCS_DEPLOY_ACK: ACK, STUB_LIVE_EXIT: '0' });
  expect(r.code).toBe(0);
  expect(sshCalls().some((c) => REAL_WRANGLER_DEPLOY.test(c.text))).toBe(true);
  expect(sshCalls().some((c) => c.text.includes('rollback --message'))).toBe(false);
});

test('a failed rollback after a failed live check exits 1 and prints both results', () => {
  const r = run(['deploy'], {
    VIVERA_DOCS_DEPLOY_ACK: ACK,
    STUB_LIVE_EXIT: '3',
    STUB_SSH_FAIL_MATCH: 'rollback --message',
  });
  expect(r.code).toBe(1);
  expect(r.out).toContain('live check: exit 3');
  expect(r.out).toContain('rollback: exit 1');
});

test('every wrangler call runs the pinned wrangler@4.151.1', () => {
  const r = run(['deploy'], { VIVERA_DOCS_DEPLOY_ACK: ACK, STUB_LIVE_EXIT: '1' });
  expect(r.code).toBe(1);
  const wrangler = sshCalls()
    .map((c) => c.text)
    .filter((t) => t.includes('wrangler'))
    .map((t) => t.match(/bunx (wrangler\S*) (\w+)/).slice(1));
  expect(wrangler).toEqual([
    ['wrangler@4.151.1', 'deploy'],
    ['wrangler@4.151.1', 'deploy'],
    ['wrangler@4.151.1', 'deployments'],
    ['wrangler@4.151.1', 'rollback'],
  ]);
});

test('two consecutive test runs each use their own remote directory and remove exactly it', () => {
  const used = [];
  for (let i = 0; i < 2; i++) {
    expect(run(['test']).code).toBe(0);
    const seq = calls();
    const dirs = runDirs(seq);
    expect(dirs).toHaveLength(1);
    const [dir] = dirs;
    expect(dir).toMatch(/^\/tmp\/vivera-docs-test-\d{8}T\d{6}Z-[A-Za-z0-9]{6}$/);
    expect(seq.find((c) => c.tool === 'ssh').text).toContain('mktemp -d /tmp/vivera-docs-test-');
    expect(seq.find((c) => c.tool === 'rsync').text).toContain(`vps-bcb:${dir}/`);
    expect(seq.at(-1).tool).toBe('ssh');
    expect(seq.at(-1).text).toContain(`rm -rf -- ${dir}`);
    used.push(dir);
    fs.writeFileSync(callLog, '');
  }
  expect(used[0]).not.toBe(used[1]);
});

test('a build that fails on the VPS still removes its own remote directory', () => {
  const r = run(['build'], { STUB_SSH_FAIL_MATCH: 'docs-gen.mjs --check' });
  expect(r.code).toBe(1);
  const seq = calls();
  const dirs = runDirs(seq);
  expect(dirs).toHaveLength(1);
  expect(dirs[0]).toMatch(/^\/tmp\/vivera-docs-build-\d{8}T\d{6}Z-[A-Za-z0-9]{6}$/);
  expect(seq.at(-1).tool).toBe('ssh');
  expect(seq.at(-1).text).toContain(`rm -rf -- ${dirs[0]}`);
});

test('a failed mktemp exits 1 and removes nothing on the VPS', () => {
  const r = run(['test'], { STUB_SSH_FAIL_MATCH: 'mktemp -d' });
  expect(r.code).toBe(1);
  expect(sshCalls().some((c) => c.text.includes('rm -rf'))).toBe(false);
  expect(calls().some((c) => c.tool === 'rsync')).toBe(false);
});

test('wrangler.json serves the build output on the docs routes only, with workers.dev and previews off', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'docs', 'wrangler.json'), 'utf8'));
  expect(config.name).toBe('vivera-docs');
  expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(config.main).toBeUndefined();
  expect(config.assets).toEqual({ directory: './dist', not_found_handling: '404-page' });
  expect(config.routes).toEqual([
    { pattern: 'vivera.belajarcarabelajar.com/docs*', zone_name: 'belajarcarabelajar.com' },
    { pattern: 'vivera.belajarcarabelajar.com/id/docs*', zone_name: 'belajarcarabelajar.com' },
    { pattern: 'vivera.belajarcarabelajar.com/_maudit/*', zone_name: 'belajarcarabelajar.com' },
  ]);
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
});

test('test mode still refuses a missing apps/docs/Cargo.toml before any ssh', () => {
  const fixture = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
  const copy = path.join(fixture, 'scripts', 'docs-remote.sh');
  fs.copyFileSync(SCRIPT, copy);
  const r = run(['test'], {}, copy);
  expect(r.code).toBe(1);
  expect(r.out).toContain('apps/docs/Cargo.toml missing');
  expect(calls().filter((c) => c.tool === 'ssh' || c.tool === 'rsync')).toEqual([]);
});
