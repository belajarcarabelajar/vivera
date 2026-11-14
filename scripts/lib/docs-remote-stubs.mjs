// scripts/lib/docs-remote-stubs.mjs
//
// Shared harness for scripts/docs-remote.test.mjs (VPS mode) and
// scripts/docs-remote-local.test.mjs (--local). Stub `ssh`, `rsync`, `git`,
// `bun`, `bunx` and `cargo` each append one line per call to a shared log, so
// the order of calls across stubs is observable. No network, no VPS, no real
// deploy. tmp, bin and callLog are live bindings reset by installHarness().

import { expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dir, '..', '..');
export const SCRIPT = path.join(ROOT, 'scripts', 'docs-remote.sh');
export const REAL_GIT = Bun.which('git');
export const BASH = Bun.which('bash');
export const ACK = 'I_UNDERSTAND_THIS_CHANGES_LIVE';
export const LIVE_URL = 'https://vivera.belajarcarabelajar.com/docs/';
export const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

export const STUBS = {
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
    # Local mode really extracts the stream, so it gets a real tar of a fixture tree.
    if [ -n "\${STUB_TAR_SRC:-}" ]; then
      case " \${args[*]:$i} " in
        *" HEAD:apps "*) tar -c -f - -T /dev/null ;;
        *) tar -c -f - -C "$STUB_TAR_SRC" . ;;
      esac
      exit 0
    fi
    printf 'STUB-TAR'
    exit 0 ;;
  rev-parse)
    if [ -n "\${STUB_HEAD_SHA:-}" ]; then
      case " \${args[*]:$i} " in
        *" --short "*) printf '%s\\n' "\${STUB_HEAD_SHA:0:7}" ;;
        *) printf '%s\\n' "$STUB_HEAD_SHA" ;;
      esac
      exit 0
    fi ;;
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


export let tmp;
export let bin;
export let callLog;

export function installHarness() {
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
}

const dropUndefined = (env) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));

export function run(args, env = {}, script = SCRIPT) {
  const base = { ...process.env };
  delete base.VIVERA_DOCS_DEPLOY_ACK;
  delete base.VIVERA_VPS;
  const proc = Bun.spawnSync([BASH, script, ...args], {
    cwd: ROOT,
    stdin: 'ignore',
    env: dropUndefined({
      ...base,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: callLog,
      STUB_REAL_GIT: REAL_GIT,
      VIVERA_DOCS_LOG_DIR: tmp,
      // VPS mode needs an explicit host; a test passes undefined to leave it unset.
      VIVERA_VPS: 'vps-bcb',
      ...env,
    }),
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
}

export function calls() {
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

export const sshCalls = () => calls().filter((c) => c.tool === 'ssh');
export const RUN_DIR = /\/tmp\/vivera-docs-[a-z]+-\d{8}T\d{6}Z-[A-Za-z0-9]{6}/g;

// The mktemp template itself also matches RUN_DIR (XXXXXX), so its call is skipped.
export function runDirs(seq) {
  const found = seq.filter((c) => !c.text.includes('mktemp')).flatMap((c) => c.text.match(RUN_DIR) ?? []);
  return [...new Set(found)];
}
export const REAL_WRANGLER_DEPLOY = /bunx wrangler@4\.151\.1 deploy(?!\s+--dry-run)/;

export function expectInOrder(haystack, markers) {
  let from = 0;
  for (const marker of markers) {
    const at = haystack.indexOf(marker, from);
    expect({ marker, found: at >= 0 }).toEqual({ marker, found: true });
    from = at + marker.length;
  }
}


// --local runs every step on this host through bash -c. The script puts
// $HOME/.cargo/bin and $HOME/.bun/bin first on PATH, which on this PC hold the
// real bun and cargo (A15), so these tests point HOME at a temp dir holding the
// stubs, never inherit the caller's PATH, and drop every CLOUDFLARE_* and
// VIVERA_* variable unless a test sets a fake one. Each stub logs the
// credential variables it can see.
export const ENV_FMT = '\\tcf=%s\\tvd=%s\\tacct=%s';
export const ENV_ARGS = '"${CLOUDFLARE_API_TOKEN-UNSET}" "${VIVERA_DOCS_CF_TOKEN-UNSET}" "${CLOUDFLARE_ACCOUNT_ID-UNSET}"';
export const LOCAL_STUBS = {
  bun: `#!/usr/bin/env bash
printf 'bun\\t%s${ENV_FMT}\\n' "$*" ${ENV_ARGS} >> "$STUB_LOG"
case "$*" in
  *"docs-site-check.mjs apps/docs/dist"*)
    # The work dir is removed on exit, so the stamp is copied out while it exists.
    if [ -f apps/docs/dist/docs/version.json ]; then
      printf 'stamp\\tpresent\\n' >> "$STUB_LOG"
      cp apps/docs/dist/docs/version.json "$STUB_CAPTURE"
    else
      printf 'stamp\\tabsent\\n' >> "$STUB_LOG"
    fi ;;
  *" --live "*) exit "\${STUB_LIVE_EXIT:-0}" ;;
esac
exit 0
`,
  bunx: `#!/usr/bin/env bash
printf 'bunx\\t%s${ENV_FMT}\\n' "$*" ${ENV_ARGS} >> "$STUB_LOG"
if [[ "$*" == wrangler@* ]]; then
  printf 'wrangler-cwd\\t%s\\t%s\\n' "$PWD" "$(ls wrangler.json dist/docs/version.json 2>/dev/null | tr '\\n' ' ')" >> "$STUB_LOG"
fi
# A real deploy prints wrangler 4.151.1's "Current Version ID: <uuid>" line
# unless STUB_NO_VERSION_ID is set; deployments status answers STUB_STATUS_JSON.
if [[ "$*" == *" deploy" ]]; then
  echo "Uploaded vivera-docs"
  [ -n "\${STUB_NO_VERSION_ID:-}" ] || echo "Current Version ID: \${STUB_VERSION_ID:-0f1e2d3c-4b5a-4968-8776-655443322110}"
fi
if [[ "$*" == *"deployments status --json"* ]]; then
  printf '%s\n' "\${STUB_STATUS_JSON:-}"
fi
if [[ "$*" == *"deployments list --json"* ]]; then
  for ((k = 1; k <= \${STUB_DEPLOYMENTS:-2}; k++)); do printf '{"id": "dep-%s"}\\n' "$k"; done
fi
exit 0
`,
  cargo: `#!/usr/bin/env bash
printf 'cargo\\t%s\\ttarget=%s${ENV_FMT}\\n' "$*" "\${CARGO_TARGET_DIR-UNSET}" ${ENV_ARGS} >> "$STUB_LOG"
exit 0
`,
};

export function runLocal(args, env = {}, script = SCRIPT) {
  const home = path.join(tmp, 'home');
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'apps', 'docs', 'static', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(src, 'apps', 'docs', 'static', 'generated', 'diagram.svg'), '<svg></svg>\n');
  for (const dir of [path.join(home, '.cargo', 'bin'), path.join(home, '.bun', 'bin'), bin]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(LOCAL_STUBS)) {
      fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
    }
  }
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CLOUDFLARE_') && !k.startsWith('VIVERA_')),
  );
  const proc = Bun.spawnSync([BASH, script, ...args], {
    cwd: ROOT,
    stdin: 'ignore',
    env: {
      ...base,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      STUB_LOG: callLog,
      STUB_REAL_GIT: REAL_GIT,
      STUB_TAR_SRC: src,
      STUB_HEAD_SHA: HEAD_SHA,
      STUB_CAPTURE: path.join(tmp, 'version.json'),
      VIVERA_DOCS_LOG_DIR: tmp,
      VIVERA_DOCS_TARGET_DIR: path.join(tmp, 'target'),
      ...env,
    },
  });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

export const argsOf = (c) => c.text.split('\t')[0];
export const envOf = (c) =>
  Object.fromEntries(
    c.text
      .split('\t')
      .slice(1)
      .map((f) => [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)]),
  );
export const steps = () => calls().map((c) => `${c.tool} ${argsOf(c)}`);
export const isWrangler = (c) => c.tool === 'bunx' && argsOf(c).startsWith('wrangler@4.151.1 ');
export const noRemote = () => calls().filter((c) => c.tool === 'ssh' || c.tool === 'rsync');

// A checkout copy for ship: the workflow downloads the build artifact into
// apps/docs/dist, so the fixture holds one stamped with stamp.
export function shipRepo({ stamp = HEAD_SHA, dist = true } = {}) {
  const repo = path.join(tmp, 'repo');
  const docs = path.join(repo, 'apps', 'docs');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'docs-remote.sh'));
  fs.writeFileSync(path.join(docs, 'Cargo.toml'), '[package]\n');
  fs.writeFileSync(path.join(docs, 'wrangler.json'), '{"name": "vivera-docs"}\n');
  if (dist) {
    fs.mkdirSync(path.join(docs, 'dist', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'dist', 'docs', 'index.html'), '<!doctype html>\n');
    fs.writeFileSync(path.join(docs, 'dist', 'docs', 'version.json'), `{"commit": "${stamp}", "built_at": "2026-11-15T00:00:00Z"}\n`);
  }
  return path.join(repo, 'scripts', 'docs-remote.sh');
}

export const VERSION_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

// The shape wrangler 4.151.1 prints for deployments status --json:
// JSON.stringify(latestDeployment, null, 2).
export const statusJson = (versions) =>
  JSON.stringify(
    {
      id: 'dep-1',
      source: 'wrangler',
      strategy: 'percentage',
      author_email: 'owner@example.com',
      created_on: '2026-11-15T00:00:00.000000Z',
      versions: versions.map(([version_id, percentage]) => ({ version_id, percentage })),
    },
    null,
    2,
  );
