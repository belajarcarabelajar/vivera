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
case " $* " in *" --live "*) exit "\${STUB_LIVE_EXIT:-0}" ;; esac
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
const REAL_WRANGLER_DEPLOY = /bunx wrangler deploy(?!\s+--dry-run)/;

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
  const upload = ssh.find((c) => c.text.includes('tar -x'));
  expect(upload.text).toContain('rm -rf /tmp/vivera-docs-release');
  expect(upload.bytes).toBe('STUB-TARSTUB-TAR'.length);

  expectInOrder(ssh.map((c) => c.text).join('\n'), [
    'rm -rf /tmp/vivera-docs-release',
    'bun install --frozen-lockfile',
    'bun scripts/docs-gen.mjs --check --scope all',
    'bun scripts/docs-gen.mjs --write',
    'CARGO_TARGET_DIR=/root/.cache/vivera-docs-target',
    'dist/docs/generated',
    'bunx pagefind@1.5.2 --site dist --output-path dist/docs/pagefind',
    'bun scripts/docs-site-check.mjs apps/docs/dist',
    'bunx wrangler deploy --dry-run',
  ]);

  const dry = ssh.find((c) => c.text.includes('bunx wrangler deploy --dry-run'));
  expect(dry.text).toContain('. ~/cloudflare/.env');
  expect(ssh.some((c) => REAL_WRANGLER_DEPLOY.test(c.text))).toBe(false);
  expect(calls().some((c) => c.tool === 'bun')).toBe(false);

  const logLine = r.out.split('\n').find((l) => l.startsWith('log: '));
  expect(path.basename(logLine.slice(5))).toMatch(/^vivera-docs-remote-deploy-\d{8}T\d{6}Z\.log$/);
});

test('a real deploy whose live check fails rolls back and exits 1', () => {
  const r = run(['deploy'], { VIVERA_DOCS_DEPLOY_ACK: ACK, STUB_LIVE_EXIT: '1' });
  expect(r.code).toBe(1);

  const seq = calls();
  const deployAt = seq.findIndex((c) => c.tool === 'ssh' && REAL_WRANGLER_DEPLOY.test(c.text));
  const liveAt = seq.findIndex((c) => c.tool === 'bun' && c.text.includes(`--live ${LIVE_URL}`));
  const rollbackAt = seq.findIndex(
    (c) => c.tool === 'ssh' && c.text.includes('bunx wrangler rollback --message "smoke failed" --yes'),
  );
  expect(deployAt).toBeGreaterThan(-1);
  expect(liveAt).toBeGreaterThan(deployAt);
  expect(rollbackAt).toBeGreaterThan(liveAt);
  expect(r.out).toContain('live check: exit 1');
  expect(r.out).toContain('rollback: exit 0');
});

test('a real deploy whose live check passes exits 0 without a rollback', () => {
  const r = run(['deploy'], { VIVERA_DOCS_DEPLOY_ACK: ACK, STUB_LIVE_EXIT: '0' });
  expect(r.code).toBe(0);
  expect(sshCalls().some((c) => REAL_WRANGLER_DEPLOY.test(c.text))).toBe(true);
  expect(sshCalls().some((c) => c.text.includes('wrangler rollback'))).toBe(false);
});

test('a failed rollback after a failed live check exits 1 and prints both results', () => {
  const r = run(['deploy'], {
    VIVERA_DOCS_DEPLOY_ACK: ACK,
    STUB_LIVE_EXIT: '3',
    STUB_SSH_FAIL_MATCH: 'wrangler rollback',
  });
  expect(r.code).toBe(1);
  expect(r.out).toContain('live check: exit 3');
  expect(r.out).toContain('rollback: exit 1');
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
