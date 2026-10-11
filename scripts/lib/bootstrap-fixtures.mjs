// scripts/lib/bootstrap-fixtures.mjs
//
// Shared fixtures for the scripts/bootstrap-*.test.mjs files (scripts/bootstrap.sh: download a pinned
// release archive and its checksum, verify, extract, run the extracted install.sh). The release is built
// here from the COMMITTED tree (git archive HEAD, through scripts/release/build-archive.sh) and served
// with file:// URLs, so nothing touches the network and the checkout's work in progress never enters the
// archive. Every run uses the install sandbox: a temp HOME, a private TMPDIR, and a PATH made only of
// the tools a test names.
//
// A test file registers the lifecycle itself, so it stays visible where it is used:
//   beforeAll(buildRelease);   // the network file also calls startOrigins()
//   afterAll(cleanupFixture);
//   afterEach(closeSandboxes);
// The state below is exported with `export let`: importers read the live value, which the functions
// here reassign, so a test body reads `fixture`, `plain` or `plainHits` as a plain name.

import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSandbox, makeSandbox } from './install-sandbox.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BOOT = path.join(ROOT, 'scripts', 'bootstrap.sh');
export const BUILD = path.join(ROOT, 'scripts', 'release', 'build-archive.sh');
export const TAG = 'v0.1.0-rc.1';
export const ARCHIVE = `vivera-${TAG}.tar.gz`;
export const TOOLS = ['git', 'bun', 'curl', 'tar', 'gzip'];
export const MINIMAL = ['--', '--tier', 'minimal', '--only', 'agents'];

export let fixture;
export let headCommit = '';

// Builds the release into <fixture>/dl/<TAG>: the files a release serves.
export function buildRelease() {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-bootstrap-'));
  const released = path.join(fixture, 'dl', TAG);
  const env = { PATH: process.env.PATH, HOME: fixture, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', VIVERA_REPO_DIR: ROOT };
  const r = Bun.spawnSync(['bash', BUILD, TAG, released], { env });
  if (r.exitCode !== 0) throw new Error(`build-archive.sh failed: ${r.stderr.toString()}`);
  headCommit = Bun.spawnSync(['git', '-C', ROOT, 'rev-parse', '--short', 'HEAD'], { env }).stdout.toString().trim();
}

export function cleanupFixture() {
  plain?.stop(true);
  secure?.stop(true);
  ftp?.stop(true);
  fs.rmSync(fixture, { recursive: true, force: true });
}

// --- Two local origins that serve the built release, for the checks that need a real network hop:
// `plain` speaks http, `secure` speaks https with a certificate made here (clients are told to trust
// it through CURL_CA_BUNDLE and WGETRC, so the system trust store is never touched). Under
// secure, /ok/<tag>/<file> serves the file, /to-http/... redirects to the plain origin, and
// /to-https/... redirects to the same server under another host name, which is another origin.
// /to-ftp/... redirects to `ftp` (a bare TCP listener that counts connects), /to-root/... with a
// root-relative Location, /to-dir/... with a path-relative one, /to-upper/... to an upper-case
// HTTPS:// URL that then redirects root-relative, and /hop/<n>/... through n redirects
// (odd hops absolute, even hops root-relative) before it serves the file.
export const HAS_OPENSSL = Bun.which('openssl') !== null;
export const HAS_WGET = Bun.which('wget') !== null;
export let plain;
export let secure;
export let ftp;
export let ftpConnects = 0;
export let hopServed = 0;
export let plainHits = 0;
let certFile = '';
let wgetrc = '';

function served(pathname) {
  const file = path.join(fixture, 'dl', pathname);
  if (pathname.includes('..') || !fs.existsSync(file)) return new Response('not found', { status: 404 });
  return new Response(Bun.file(file));
}

export function startOrigins() {
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
export const secureBase = (kind) => `https://127.0.0.1:${secure.port}/${kind}`;
export const trust = () => ({ CURL_CA_BUNDLE: certFile, WGETRC: wgetrc });

const open = [];
export function closeSandboxes() {
  while (open.length) open.pop().cleanup();
}

// A sandbox plus its own copy of the release, so a test may damage the copy.
export function setup(tools = TOOLS) {
  const sb = makeSandbox({ tools });
  open.push(sb);
  const dl = path.join(sb.root, 'dl');
  fs.cpSync(path.join(fixture, 'dl'), dl, { recursive: true, verbatimSymlinks: true });
  return { sb, base: `file://${dl}`, dest: path.join(sb.root, 'dest'), served: path.join(dl, TAG) };
}

// Runs bootstrap.sh as `bash <file> args`, or as `bash -s -- args` with the text on stdin.
export function boot(sb, args, { base, stdin, env = {} } = {}) {
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
export async function bootAsync(sb, args, { base, env = {} } = {}) {
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

export const tmpLeft = (sb) => fs.readdirSync(path.join(sb.root, 'tmp'));
export const flipByte = (file) => {
  const bytes = fs.readFileSync(file);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(file, bytes);
};

// What a refused download must leave behind: nothing in HOME, nothing at the destination, no work dir.
export function expectUntouched(sb, dest) {
  expect(sb.snapshot()).toEqual([]);
  expect(fs.existsSync(dest)).toBe(false);
  expect(tmpLeft(sb)).toEqual([]);
}

export function expectInstalled(sb, dest) {
  const tree = path.join(dest, TAG);
  const skill = path.join(sb.home, '.agents/skills/super-ultra-code-plan/SKILL.md');
  expect(fs.lstatSync(skill).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(skill).startsWith(`${tree}/`)).toBe(true);
  expect(fs.existsSync(skill)).toBe(true);
  expect(fs.existsSync(path.join(tree, '.git'))).toBe(false);
  expect(fs.existsSync(path.join(tree, 'install.sh'))).toBe(true);
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const EMPTY_SHA256 = sha256Hex('');
