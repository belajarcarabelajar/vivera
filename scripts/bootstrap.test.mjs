// scripts/bootstrap.test.mjs
//
// scripts/bootstrap.sh: download a pinned release archive and its checksum, verify, extract, run the
// extracted install.sh. The release is built here from the COMMITTED tree (git archive HEAD, through
// scripts/release/build-archive.sh) and served with file:// URLs, so nothing touches the network and
// the checkout's work in progress never enters the archive. Every run uses the install sandbox: a temp
// HOME, a private TMPDIR, and a PATH made only of the tools a test names.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSandbox, makeSandbox } from './lib/install-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOT = path.join(ROOT, 'scripts', 'bootstrap.sh');
const BUILD = path.join(ROOT, 'scripts', 'release', 'build-archive.sh');
const TAG = 'v0.1.0-rc.1';
const ARCHIVE = `vivera-${TAG}.tar.gz`;
const TOOLS = ['git', 'bun', 'curl', 'tar', 'gzip'];
const MINIMAL = ['--', '--tier', 'minimal', '--only', 'agents'];

let fixture;
let released; // <fixture>/dl/<TAG>: the files a release serves
let headCommit = '';

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-bootstrap-'));
  released = path.join(fixture, 'dl', TAG);
  const env = { PATH: process.env.PATH, HOME: fixture, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', VIVERA_REPO_DIR: ROOT };
  const r = Bun.spawnSync(['bash', BUILD, TAG, released], { env });
  if (r.exitCode !== 0) throw new Error(`build-archive.sh failed: ${r.stderr.toString()}`);
  headCommit = Bun.spawnSync(['git', '-C', ROOT, 'rev-parse', '--short', 'HEAD'], { env }).stdout.toString().trim();
  if (HAS_OPENSSL) startOrigins();
});

afterAll(() => {
  plain?.stop(true);
  secure?.stop(true);
  ftp?.stop(true);
  fs.rmSync(fixture, { recursive: true, force: true });
});

// --- Two local origins that serve the built release, for the checks that need a real network hop:
// `plain` speaks http, `secure` speaks https with a certificate made here (clients are told to trust
// it through CURL_CA_BUNDLE and WGETRC, so the system trust store is never touched). Under
// secure, /ok/<tag>/<file> serves the file, /to-http/... redirects to the plain origin, and
// /to-https/... redirects to the same server under another host name, which is another origin.
// /to-ftp/... redirects to `ftp` (a bare TCP listener that counts connects), /to-root/... with a
// root-relative Location, /to-dir/... with a path-relative one, /to-upper/... to an upper-case
// HTTPS:// URL that then redirects root-relative, and /hop/<n>/... through n redirects
// (odd hops absolute, even hops root-relative) before it serves the file.
const HAS_OPENSSL = Bun.which('openssl') !== null;
const HAS_WGET = Bun.which('wget') !== null;
let plain;
let secure;
let ftp;
let ftpConnects = 0;
let hopServed = 0;
let plainHits = 0;
let certFile = '';
let wgetrc = '';

function served(pathname) {
  const file = path.join(fixture, 'dl', pathname);
  if (pathname.includes('..') || !fs.existsSync(file)) return new Response('not found', { status: 404 });
  return new Response(Bun.file(file));
}

function startOrigins() {
  certFile = path.join(fixture, 'cert.pem');
  const keyFile = path.join(fixture, 'key.pem');
  const made = Bun.spawnSync([
    'openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ]);
  if (made.exitCode !== 0) throw new Error(`openssl failed: ${made.stderr.toString()}`);
  wgetrc = path.join(fixture, 'wgetrc');
  // tries = 1: a target that answers badly is given up on at once instead of retried for minutes.
  fs.writeFileSync(wgetrc, `ca_certificate = ${certFile}\ntries = 1\n`);
  plain = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      plainHits++;
      return served(new URL(req.url).pathname);
    },
  });
  ftp = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        ftpConnects++;
        socket.write('421 closed\r\n');
        socket.end();
      },
      data() {},
    },
  });
  const redirect = (location) => new Response(null, { status: 302, headers: { Location: location } });
  secure = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: Bun.file(certFile), key: Bun.file(keyFile) },
    fetch: (req) => {
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/(ok|to-http|to-https|to-ftp|to-root|to-dir|to-upper|hop)\/(.*)$/);
      if (!m) return new Response('not found', { status: 404 });
      if (m[1] === 'to-http') return Response.redirect(`http://127.0.0.1:${plain.port}/${m[2]}`, 302);
      if (m[1] === 'to-https') return Response.redirect(`https://localhost:${secure.port}/ok/${m[2]}`, 302);
      if (m[1] === 'to-ftp') return redirect(`ftp://127.0.0.1:${ftp.port}/${m[2]}`);
      if (m[1] === 'to-root') return redirect(`/ok/${m[2]}`);
      if (m[1] === 'to-upper') return redirect(`HTTPS://localhost:${secure.port}/to-root/${m[2]}`);
      if (m[1] === 'to-dir') {
        // <tag>/<file>: the redirect names only <file>, resolved against the directory of the request URL.
        if (url.searchParams.has('r')) return served(`/${m[2]}`);
        return redirect(`${m[2].split('/').pop()}?r=1`);
      }
      if (m[1] === 'hop') {
        const [n, ...rest] = m[2].split('/');
        const left = Number(n);
        if (left > 0) {
          const next = `/hop/${left - 1}/${rest.join('/')}`;
          return redirect(left % 2 === 1 ? `https://localhost:${secure.port}${next}` : next);
        }
        hopServed++;
        return served(`/${rest.join('/')}`);
      }
      return served(`/${m[2]}`);
    },
  });
}
const secureBase = (kind) => `https://127.0.0.1:${secure.port}/${kind}`;
const trust = () => ({ CURL_CA_BUNDLE: certFile, WGETRC: wgetrc });

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

// A sandbox plus its own copy of the release, so a test may damage the copy.
function setup(tools = TOOLS) {
  const sb = makeSandbox({ tools });
  open.push(sb);
  const dl = path.join(sb.root, 'dl');
  fs.cpSync(path.join(fixture, 'dl'), dl, { recursive: true, verbatimSymlinks: true });
  return { sb, base: `file://${dl}`, dest: path.join(sb.root, 'dest'), served: path.join(dl, TAG) };
}

// Runs bootstrap.sh as `bash <file> args`, or as `bash -s -- args` with the text on stdin.
function boot(sb, args, { base, stdin, env = {} } = {}) {
  const runEnv = { ...sb.env, ...(base ? { VIVERA_BASE_URL: base } : {}), ...env };
  assertSandbox(runEnv);
  const pairs = Object.entries(runEnv).map(([k, v]) => `${k}=${v}`);
  const bash = path.join(sb.bin, 'bash');
  const argv = stdin === undefined ? [bash, BOOT, ...args] : [bash, '-s', '--', ...args];
  const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, ...argv], {
    cwd: sb.home,
    timeout: 60_000,
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  });
  return { status: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

// The same run, without blocking the event loop, so the origins above can answer while bash runs.
async function bootAsync(sb, args, { base, env = {} } = {}) {
  const runEnv = { ...sb.env, ...(base ? { VIVERA_BASE_URL: base } : {}), ...env };
  assertSandbox(runEnv);
  const pairs = Object.entries(runEnv).map(([k, v]) => `${k}=${v}`);
  const proc = Bun.spawn(['/usr/bin/env', '-i', ...pairs, path.join(sb.bin, 'bash'), BOOT, ...args], {
    cwd: sb.home,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), 60_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  return { status: proc.exitCode, stdout, stderr };
}

const tmpLeft = (sb) => fs.readdirSync(path.join(sb.root, 'tmp'));
const flipByte = (file) => {
  const bytes = fs.readFileSync(file);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(file, bytes);
};

// What a refused download must leave behind: nothing in HOME, nothing at the destination, no work dir.
function expectUntouched(sb, dest) {
  expect(sb.snapshot()).toEqual([]);
  expect(fs.existsSync(dest)).toBe(false);
  expect(tmpLeft(sb)).toEqual([]);
}

function expectInstalled(sb, dest) {
  const tree = path.join(dest, TAG);
  const skill = path.join(sb.home, '.agents/skills/super-ultra-code-plan/SKILL.md');
  expect(fs.lstatSync(skill).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(skill).startsWith(`${tree}/`)).toBe(true);
  expect(fs.existsSync(skill)).toBe(true);
  expect(fs.existsSync(path.join(tree, '.git'))).toBe(false);
  expect(fs.existsSync(path.join(tree, 'install.sh'))).toBe(true);
}

describe('bootstrap: a good release', () => {
  test('installs from the archive of the committed tree into <dest>/<ref>, with links that point there', () => {
    expect(headCommit).toMatch(/^[0-9a-f]{7,}$/);
    const { sb, base, dest } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.stderr).not.toContain('[FAIL]');
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
    expect(r.stdout).toContain(path.join(dest, TAG));
    expect(tmpLeft(sb)).toEqual([]);
  });

  test('prints the extraction path before the installer output', () => {
    const { sb, base, dest } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(0);
    expect(r.stdout.indexOf(path.join(dest, TAG))).toBeGreaterThanOrEqual(0);
    expect(r.stdout.indexOf(path.join(dest, TAG))).toBeLessThan(r.stdout.indexOf('Sowing Vivera'));
  });

  test('works as a pipe: the script text on stdin to bash -s', () => {
    const { sb, base, dest } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base, stdin: fs.readFileSync(BOOT, 'utf8') });
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
    expect(tmpLeft(sb)).toEqual([]);
  });

  test('VIVERA_HOME picks the destination when --dest is not given, and --dest wins over it', () => {
    const { sb, base, dest } = setup();
    const viaEnv = path.join(sb.root, 'via-env');
    expect(boot(sb, ['--ref', TAG, ...MINIMAL], { base, env: { VIVERA_HOME: viaEnv } }).status).toBe(0);
    expect(fs.existsSync(path.join(viaEnv, TAG, 'install.sh'))).toBe(true);
    expect(boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base, env: { VIVERA_HOME: path.join(sb.root, 'ignored') } }).status).toBe(0);
    expect(fs.existsSync(path.join(dest, TAG, 'install.sh'))).toBe(true);
    expect(fs.existsSync(path.join(sb.root, 'ignored'))).toBe(false);
  });

  test('passes the arguments after -- to install.sh: --dry-run prints [DRY-RUN] and writes nothing to HOME', () => {
    const { sb, base, dest } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', dest, '--', '--tier', 'minimal', '--only', 'agents', '--dry-run'], { base });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[DRY-RUN]');
    expect(sb.snapshot()).toEqual([]);
    expect(fs.existsSync(path.join(dest, TAG, 'install.sh'))).toBe(true);
  });

  test("exits with install.sh's status", () => {
    const { sb, base, dest } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', dest, '--', '--tier', 'bogus'], { base });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Invalid tier');
    expect(tmpLeft(sb)).toEqual([]);
  });

  // wget cannot read file://, so with no curl a file:// base is refused up front, by name, instead of
  // as a generic "could not download". The shim records a call, so "before any request" is checked.
  // (This replaces a test in which a shim wget copied file:// URLs: it passed because the shim could
  // do what the real wget cannot, and the real wget path is covered through the https origins below.)
  test('a file:// base with no curl exits 1 saying file:// needs curl, and wget is never run', () => {
    const { sb, base, dest } = setup(['git', 'bun', 'tar', 'gzip']);
    const calls = path.join(sb.root, 'wget.calls');
    fs.writeFileSync(path.join(sb.bin, 'wget'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 3\n`, { mode: 0o755 });
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expect(r.stderr).toContain('file:// needs curl');
    expect(fs.existsSync(calls)).toBe(false);
    expectUntouched(sb, dest);
  });

  test('falls back to shasum -a 256 when sha256sum is absent', () => {
    const { sb, base, dest } = setup([...TOOLS, 'shasum']);
    fs.rmSync(path.join(sb.bin, 'sha256sum'));
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.stderr).not.toContain('[FAIL]');
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
  });
});

describe('bootstrap: a release that cannot be trusted is refused before anything is written', () => {
  test('a tampered archive exits 1 with [FAIL]', () => {
    const { sb, base, dest, served } = setup();
    flipByte(path.join(served, ARCHIVE));
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test('a missing .sha256 exits 1 with [FAIL]', () => {
    const { sb, base, dest, served } = setup();
    fs.rmSync(path.join(served, `${ARCHIVE}.sha256`));
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test('a wrong hash in the .sha256 exits 1 with [FAIL]', () => {
    const { sb, base, dest, served } = setup();
    fs.writeFileSync(path.join(served, `${ARCHIVE}.sha256`), `${'0'.repeat(64)}  ${ARCHIVE}\n`);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test('a missing archive exits 1 with [FAIL]', () => {
    const { sb, base, dest, served } = setup();
    fs.rmSync(path.join(served, ARCHIVE));
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test('no SHA-256 tool on PATH exits 1 with [FAIL]', () => {
    const { sb, base, dest } = setup();
    fs.rmSync(path.join(sb.bin, 'sha256sum'));
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expect(r.stderr).toMatch(/sha256sum|shasum/);
    expectUntouched(sb, dest);
  });
});

describe('bootstrap: only a release tag is accepted', () => {
  const never = 'file:///nonexistent';

  // A tag is capped at 100 characters (the file names derived from it stay far under the 255-byte limit),
  // the same cap as build-archive.sh. At the cap it passes; one more, or 300, is refused.
  const atCap = `v1.0.0-${'a'.repeat(93)}`;
  const overCap = `v1.0.0-${'a'.repeat(94)}`;
  const longTag = `v1.0.0-${'a'.repeat(293)}`;
  test('the length fixtures are 100, 101 and 300 characters', () => {
    expect([atCap.length, overCap.length, longTag.length]).toEqual([100, 101, 300]);
  });

  // From 'v1.0.0..' to 'v1.0.0-é', five match a plain [0-9A-Za-z.] pattern but are not valid git ref names,
  // or are not ASCII; the last two are over the length cap.
  const badRefs = ['main', 'v1', 'v1.0.0;rm -rf x', '0.1.0', '', 'a1b2c3d4e5f6', 'v1.0.0/../x', 'v1.0.0..', 'v1.0.0.lock', 'v1.0.0-.', 'v1.0.0-rc..1', 'v1.0.0-é', overCap, longTag];
  for (const ref of badRefs) {
    test(`--ref ${ref.length > 40 ? `(a ${ref.length}-character tag)` : JSON.stringify(ref)} exits 2 with the usage text and attempts nothing`, () => {
      const { sb, dest } = setup();
      const r = boot(sb, ['--ref', ref, '--dest', dest], { base: never });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Usage:');
      expect(r.stderr).not.toContain('[FAIL]');
      expect(r.stderr).not.toContain('nonexistent');
      expectUntouched(sb, dest);
    });
  }

  test('a non-ASCII tag is refused whatever the locale says a letter is', () => {
    const { sb, dest } = setup();
    for (const locale of ['en_US.UTF-8', 'C.UTF-8']) {
      const r = boot(sb, ['--ref', 'v1.0.0-é', '--dest', dest], { base: never, env: { LC_ALL: locale } });
      expect(r.status).toBe(2);
    }
    expectUntouched(sb, dest);
  });

  test('bootstrap.sh and build-archive.sh accept and refuse the same tags', () => {
    const { sb, dest } = setup();
    const accepted = ['v1.0.0', 'v1.0.0-rc.1', 'v1.0.0.1', 'v1.0.0-.1', 'v10.20.30', 'v1.2.3-rc.1.2', atCap];
    const buildEnv = { PATH: process.env.PATH, HOME: sb.home, GIT_CONFIG_GLOBAL: '/dev/null', VIVERA_REPO_DIR: path.join(sb.root, 'no-such-repo') };
    for (const tag of [...accepted, ...badRefs.filter((r) => r !== '' && r !== 'a1b2c3d4e5f6')]) {
      const built = Bun.spawnSync(['bash', BUILD, tag, path.join(sb.root, 'parity-out')], { env: buildEnv });
      const booted = boot(sb, ['--ref', tag, '--dest', dest], { base: never });
      // Exit 2 is the usage refusal; any other status means the tag got past the check.
      expect({ tag, build: built.exitCode === 2, bootstrap: booted.status === 2 }).toEqual({ tag, build: !accepted.includes(tag), bootstrap: !accepted.includes(tag) });
    }
  });

  test('a missing --ref exits 2 with the usage text', () => {
    const { sb, dest } = setup();
    for (const args of [[], ['--dest', dest], ['--ref']]) {
      const r = boot(sb, args, { base: never });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Usage:');
    }
    expectUntouched(sb, dest);
  });

  test('an unknown option exits 2, and install.sh flags are only accepted after --', () => {
    const { sb, dest } = setup();
    for (const args of [['--bogus'], ['--ref', TAG, '--tier', 'minimal']]) {
      const r = boot(sb, args, { base: never });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Usage:');
    }
    expectUntouched(sb, dest);
  });

  test('-h prints the usage text and exits 0', () => {
    const { sb } = setup();
    const r = boot(sb, ['-h']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });
});

describe('bootstrap: other refusals', () => {
  test('neither curl nor wget exits 1 and says so', () => {
    const { sb, base, dest } = setup(['git', 'bun', 'tar', 'gzip']);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/curl or wget/);
    expectUntouched(sb, dest);
  });

  test('an existing non-empty <dest>/<ref> exits 1 and is left as it was', () => {
    const { sb, base, dest } = setup();
    const keep = path.join(dest, TAG, 'keep.txt');
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.writeFileSync(keep, 'mine');
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(fs.readdirSync(path.join(dest, TAG))).toEqual(['keep.txt']);
    expect(fs.readFileSync(keep, 'utf8')).toBe('mine');
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
  });

  test('an existing empty <dest>/<ref> is filled', () => {
    const { sb, base, dest } = setup();
    fs.mkdirSync(path.join(dest, TAG), { recursive: true });
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
  });

  // `--dest ""` used to fall back to the default directory and install there, which is not what the
  // caller wrote; an empty value is a usage error like an empty --ref.
  test('--dest "" exits 2 with the usage text and installs nothing, not even in the default directory', () => {
    const { sb, base } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', '', ...MINIMAL], { base });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage:');
    expect(r.stderr).toContain('--dest');
    expect(r.stderr).not.toContain('[FAIL]');
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
  });

  test('a relative --dest is made absolute so the installed links do not depend on the working directory', () => {
    const { sb, base } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', 'rel-dest', ...MINIMAL], { base });
    expect(r.status).toBe(0);
    const skill = path.join(sb.home, '.agents/skills/super-ultra-code-plan/SKILL.md');
    expect(path.isAbsolute(fs.readlinkSync(skill))).toBe(true);
    // The script's working directory is HOME, and bash reports it by its physical path.
    expect(fs.readlinkSync(skill).startsWith(`${path.join(fs.realpathSync(sb.home), 'rel-dest', TAG)}/`)).toBe(true);
  });
});

// --- Fixes from the independent review ---------------------------------------------------------

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EMPTY_SHA256 = sha256Hex('');

describe('bootstrap: the network is reached over https only', () => {
  test.skipIf(!HAS_OPENSSL)('a plain-http VIVERA_BASE_URL exits 2 and says https, and no request is made', async () => {
    const { sb, dest } = setup();
    const before = plainHits;
    const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: `http://127.0.0.1:${plain.port}` });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('https');
    expect(plainHits).toBe(before);
    expectUntouched(sb, dest);
  });

  test('a base URL that is neither https nor file exits 2 before anything is fetched', () => {
    const { sb, dest } = setup();
    for (const base of ['http://example.invalid/x', 'ftp://example.invalid/x', 'example.invalid/x', 'HTTP://example.invalid/x']) {
      const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
      expect({ base, status: r.status }).toEqual({ base, status: 2 });
      expect(r.stderr).toContain('https');
    }
    expectUntouched(sb, dest);
  });

  test.skipIf(!HAS_OPENSSL)('a redirect from https to plain http is refused: exit 1, the plain origin is never contacted', async () => {
    const { sb, dest } = setup();
    const before = plainHits;
    const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('to-http'), env: trust() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expect(plainHits).toBe(before);
    expectUntouched(sb, dest);
  });

  test.skipIf(!HAS_OPENSSL)('control: https straight from the origin installs', async () => {
    const { sb, dest } = setup();
    const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('ok'), env: trust() });
    expect(r.stderr).not.toContain('[FAIL]');
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
  });

  test.skipIf(!HAS_OPENSSL)('control: a redirect to another https origin is followed (a release host redirects to its CDN)', async () => {
    const { sb, dest } = setup();
    const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('to-https'), env: trust() });
    expect(r.stderr).not.toContain('[FAIL]');
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
  });

  test.skipIf(!HAS_OPENSSL)('control: https to a certificate the system does not trust exits 1', async () => {
    const { sb, dest } = setup();
    const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('ok') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  describe('through wget, when curl is absent', () => {
    const WGET_TOOLS = ['git', 'bun', 'tar', 'gzip', 'wget'];

    test.skipIf(!HAS_OPENSSL || !HAS_WGET)('control: https straight from the origin installs', async () => {
      const { sb, dest } = setup(WGET_TOOLS);
      const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('ok'), env: trust() });
      expect(r.stderr).not.toContain('[FAIL]');
      expect(r.status).toBe(0);
      expectInstalled(sb, dest);
    });

    // GNU wget's --https-only only limits links followed in recursive mode: with wget 1.25.0 it still
    // fetched a plain-http URL and followed an https-to-http redirect (probed), so the redirect is
    // checked from the response headers instead and the downloaded file is thrown away.
    test.skipIf(!HAS_OPENSSL || !HAS_WGET)('a redirect from https to plain http is refused: exit 1, nothing installed', async () => {
      const { sb, dest } = setup(WGET_TOOLS);
      const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('to-http'), env: trust() });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[FAIL]');
      expectUntouched(sb, dest);
    });

    test.skipIf(!HAS_OPENSSL || !HAS_WGET)('a redirect to another https origin is followed', async () => {
      const { sb, dest } = setup(WGET_TOOLS);
      const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('to-https'), env: trust() });
      expect(r.stderr).not.toContain('[FAIL]');
      expect(r.status).toBe(0);
      expectInstalled(sb, dest);
    });

    // wget followed an https-to-ftp redirect on its own (anonymous FTP connects to the target) while
    // curl refuses it. The script now follows redirects itself and checks every target's scheme first.
    test.skipIf(!HAS_OPENSSL || !HAS_WGET)('a redirect from https to ftp is refused: exit 1, and nothing connects to the ftp listener', async () => {
      const { sb, dest } = setup(WGET_TOOLS);
      const before = ftpConnects;
      const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('to-ftp'), env: trust() });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[FAIL]');
      expect(r.stderr).toContain('ftp');
      expect(ftpConnects).toBe(before);
      expectUntouched(sb, dest);
    });

    test.skipIf(!HAS_OPENSSL || !HAS_WGET)('a root-relative redirect is followed on the same https origin', async () => {
      const { sb, dest } = setup(WGET_TOOLS);
      const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('to-root'), env: trust() });
      expect(r.stderr).not.toContain('[FAIL]');
      expect(r.status).toBe(0);
      expectInstalled(sb, dest);
    });

    test.skipIf(!HAS_OPENSSL || !HAS_WGET)('a path-relative redirect is followed on the same https origin', async () => {
      const { sb, dest } = setup(WGET_TOOLS);
      const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('to-dir'), env: trust() });
      expect(r.stderr).not.toContain('[FAIL]');
      expect(r.status).toBe(0);
      expectInstalled(sb, dest);
    });

    // After an upper-case HTTPS:// hop, the next relative redirect must still resolve against that host.
    test.skipIf(!HAS_OPENSSL || !HAS_WGET)('an upper-case HTTPS:// redirect is followed, and so is a relative redirect after it', async () => {
      const { sb, dest } = setup(WGET_TOOLS);
      const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('to-upper'), env: trust() });
      expect(r.stderr).not.toContain('[FAIL]');
      expect(r.status).toBe(0);
      expectInstalled(sb, dest);
    });

    test.skipIf(!HAS_OPENSSL || !HAS_WGET)('a chain of 5 redirects (absolute and relative) is followed', async () => {
      const { sb, dest } = setup(WGET_TOOLS);
      const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('hop/5'), env: trust() });
      expect(r.stderr).not.toContain('[FAIL]');
      expect(r.status).toBe(0);
      expectInstalled(sb, dest);
    });

    test.skipIf(!HAS_OPENSSL || !HAS_WGET)('a chain of 6 redirects is refused: exit 1, and the file at the end of it is never requested', async () => {
      const { sb, dest } = setup(WGET_TOOLS);
      const before = hopServed;
      const r = await bootAsync(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base: secureBase('hop/6'), env: trust() });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[FAIL]');
      expect(r.stderr).toMatch(/too many redirects/);
      expect(hopServed).toBe(before);
      expectUntouched(sb, dest);
    });
  });
});

describe('bootstrap: the checksum file must be about this archive', () => {
  test('a .sha256 that names another file, even with a digest that file really has, exits 1 before extraction', () => {
    const { sb, base, dest, served: dir } = setup();
    fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), `${EMPTY_SHA256}  /dev/null\n`);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test("the archive's real digest under another file name exits 1", () => {
    const { sb, base, dest, served: dir } = setup();
    const real = sha256Hex(fs.readFileSync(path.join(dir, ARCHIVE)));
    fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), `${real}  other-${ARCHIVE}\n`);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test('a file with no digest, or a short one, exits 1', () => {
    const { sb, base, dest, served: dir } = setup();
    for (const body of ['', '\n', `abc123  ${ARCHIVE}\n`, `${ARCHIVE}\n`]) {
      fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), body);
      const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
      expect({ body, status: r.status }).toEqual({ body, status: 1 });
    }
    expectUntouched(sb, dest);
  });

  test('control: the right name with a zero digest exits 1', () => {
    const { sb, base, dest, served: dir } = setup();
    fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), `${'0'.repeat(64)}  ${ARCHIVE}\n`);
    expect(boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base }).status).toBe(1);
    expectUntouched(sb, dest);
  });

  test('control: the right name and digest installs, also with the binary-mode marker and an upper-case digest', () => {
    for (const style of ['plain', 'binary', 'upper']) {
      const { sb, base, dest, served: dir } = setup();
      const real = sha256Hex(fs.readFileSync(path.join(dir, ARCHIVE)));
      const line = { plain: `${real}  ${ARCHIVE}\n`, binary: `${real} *${ARCHIVE}\n`, upper: `${real.toUpperCase()}  ${ARCHIVE}\n` }[style];
      fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), line);
      const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
      expect({ style, status: r.status, err: r.stderr.includes('[FAIL]') }).toEqual({ style, status: 0, err: false });
      expectInstalled(sb, dest);
    }
  });
});

describe('bootstrap: what a truncated download does', () => {
  const text = fs.readFileSync(BOOT, 'utf8');

  test('the header says what is true: nothing executes, but the shell may exit 0 having done nothing', () => {
    const header = text.split('\n').filter((l) => l.startsWith('#')).join('\n');
    expect(header).not.toMatch(/ends in a syntax error/);
    expect(header).toMatch(/nothing executes/i);
    expect(header).toMatch(/may exit 0/);
  });

  test('cut at every line boundary before the final call, no prefix fetches, extracts or installs anything', () => {
    const lines = text.split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines.at(-2)).toBe('main "$@"');
    const { sb, base, dest } = setup();
    const statuses = new Set();
    for (let n = 1; n < lines.length - 2; n++) {
      const prefix = `${lines.slice(0, n).join('\n')}\n`;
      statuses.add(boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base, stdin: prefix }).status);
    }
    // A silent exit 0 is real (the first cut is one), which is why the header must not promise a syntax error.
    expect(statuses.has(0)).toBe(true);
    expectUntouched(sb, dest);
  });
});

describe('bootstrap: a failed extraction removes only what this run created', () => {
  // A truncated archive with a checksum that matches it: the checksum passes, tar fails part way.
  function truncatedRelease(dir) {
    const archive = path.join(dir, ARCHIVE);
    const bytes = fs.readFileSync(archive);
    const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));
    fs.writeFileSync(archive, cut);
    fs.writeFileSync(`${archive}.sha256`, `${sha256Hex(cut)}  ${ARCHIVE}\n`);
  }

  test('an empty <dest>/<ref> the user made beforehand is still there, and empty, afterwards', () => {
    const { sb, base, dest, served: dir } = setup();
    truncatedRelease(dir);
    fs.mkdirSync(path.join(dest, TAG), { recursive: true });
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not extract');
    expect(fs.existsSync(path.join(dest, TAG))).toBe(true);
    expect(fs.readdirSync(path.join(dest, TAG))).toEqual([]);
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
  });

  test('control: a <dest>/<ref> this run created is removed', () => {
    const { sb, base, dest, served: dir } = setup();
    truncatedRelease(dir);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not extract');
    expect(fs.existsSync(path.join(dest, TAG))).toBe(false);
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
  });
});

describe('bootstrap: an archive with no top-level install.sh removes only what this run created', () => {
  // A well-formed archive (so extraction succeeds and the checksum matches) that has no install.sh.
  function releaseWithoutInstaller(sb, dir) {
    const stage = path.join(sb.root, 'stage');
    fs.mkdirSync(path.join(stage, `vivera-${TAG}`), { recursive: true });
    fs.writeFileSync(path.join(stage, `vivera-${TAG}`, 'README.md'), 'no installer here\n');
    const archive = path.join(dir, ARCHIVE);
    expect(Bun.spawnSync(['tar', '-czf', archive, '-C', stage, `vivera-${TAG}`]).exitCode).toBe(0);
    fs.writeFileSync(`${archive}.sha256`, `${sha256Hex(fs.readFileSync(archive))}  ${ARCHIVE}\n`);
  }

  test('a <dest>/<ref> this run created is removed, so the next run does not say "already exists"', () => {
    const { sb, base, dest, served: dir } = setup();
    releaseWithoutInstaller(sb, dir);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no install.sh');
    expect(fs.existsSync(path.join(dest, TAG))).toBe(false);
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
    // With the good release back in place, the same command now installs.
    fs.copyFileSync(path.join(fixture, 'dl', TAG, ARCHIVE), path.join(dir, ARCHIVE));
    fs.copyFileSync(path.join(fixture, 'dl', TAG, `${ARCHIVE}.sha256`), path.join(dir, `${ARCHIVE}.sha256`));
    const again = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(again.stderr).not.toContain('already exists');
    expect(again.status).toBe(0);
    expectInstalled(sb, dest);
  });

  test('an empty <dest>/<ref> the user made beforehand is still there, and empty, afterwards', () => {
    const { sb, base, dest, served: dir } = setup();
    releaseWithoutInstaller(sb, dir);
    fs.mkdirSync(path.join(dest, TAG), { recursive: true });
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no install.sh');
    expect(fs.readdirSync(path.join(dest, TAG))).toEqual([]);
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
  });
});

describe('bootstrap: .gitattributes keeps the git hooks LF', () => {
  // .githooks/pre-commit is a bash script with no .sh suffix, so *.sh does not cover it; a Windows
  // autocrlf clone would give it CRLF and break its shebang. Read-only: nothing here writes.
  test('.gitattributes lists .githooks/* as text with eol=lf, and git resolves the hook to eol=lf', () => {
    expect(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8').split('\n')).toContain('.githooks/* text eol=lf');
    const r = Bun.spawnSync(['git', '-C', ROOT, 'check-attr', 'text', 'eol', '--', '.githooks/pre-commit'], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    expect(r.stdout.toString()).toContain('.githooks/pre-commit: eol: lf');
    expect(r.stdout.toString()).toContain('.githooks/pre-commit: text: set');
  });
});

describe('bootstrap: an existing tree says how to resume', () => {
  test('a directory holding an install.sh is offered a resume command with the install.sh arguments', () => {
    const { sb, base, dest } = setup();
    const target = path.join(dest, TAG);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'install.sh'), '#!/bin/sh\n');
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(r.stderr).toContain(`cd ${target} && ./install.sh --tier minimal --only agents`);
    expect(fs.readdirSync(target)).toEqual(['install.sh']);
  });

  test('a directory without an install.sh is only refused, with no resume command', () => {
    const { sb, base, dest } = setup();
    const target = path.join(dest, TAG);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keep.txt'), 'mine');
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(r.stderr).not.toContain('./install.sh');
  });
});
