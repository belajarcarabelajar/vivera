// scripts/docs-remote-local.test.mjs
//
// Drives scripts/docs-remote.sh --local, which runs every step on this host,
// with the stubs and the temp HOME from scripts/lib/docs-remote-stubs.mjs.

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACK,
  HEAD_SHA,
  LIVE_URL,
  ROOT,
  RUN_DIR,
  argsOf,
  calls,
  envOf,
  expectInOrder,
  installHarness,
  isWrangler,
  noRemote,
  runLocal,
  shipRepo,
  statusJson,
  VERSION_ID,
  steps,
  tmp,
} from './lib/docs-remote-stubs.mjs';

installHarness();

test('deploy --local with the ack runs the VPS step order on this host without ssh or rsync', () => {
  const r = runLocal(['deploy', '--local'], { VIVERA_DOCS_DEPLOY_ACK: ACK, VIVERA_DOCS_CF_TOKEN: 'fake-docs-token' });
  expect(r.out).not.toContain('fake-docs-token');
  expect(r.code).toBe(0);
  expect(calls().length).toBeGreaterThan(0);
  expect(noRemote()).toEqual([]);
  expectInOrder(steps().join('\n'), [
    'git status',
    'git archive --format=tar HEAD',
    'bun install --frozen-lockfile',
    'bun scripts/docs-gen.mjs --check --scope all',
    'bun scripts/docs-gen.mjs --write',
    'cargo run --release --locked',
    'bunx pagefind@1.5.2 --site dist --output-path dist/docs/pagefind',
    'bun scripts/docs-site-check.mjs apps/docs/dist',
    'stamp present',
    'bunx wrangler@4.151.1 deploy --dry-run',
    'bunx wrangler@4.151.1 deploy\n',
    `bun ${ROOT}/scripts/docs-site-check.mjs --live ${LIVE_URL}`,
  ]);
  expect(calls().filter(isWrangler).map(argsOf)).toEqual(['wrangler@4.151.1 deploy --dry-run', 'wrangler@4.151.1 deploy']);
  const cargo = calls().find((c) => c.tool === 'cargo');
  expect(envOf(cargo).target).toBe(path.join(tmp, 'target'));

  const dir = r.out.match(RUN_DIR)?.[0];
  expect(dir).toMatch(/^\/tmp\/vivera-docs-deploy-/);
  expect(fs.existsSync(dir)).toBe(false);
  expect(r.out).toContain('cleanup: removed');
});

test('build --local writes docs/version.json with the full HEAD SHA before the site check', () => {
  const r = runLocal(['build', '--local']);
  expect(r.code).toBe(0);
  expect(calls().length).toBeGreaterThan(0);
  expect(noRemote()).toEqual([]);
  expect(steps()).toContain('stamp present');
  const stamp = JSON.parse(fs.readFileSync(path.join(tmp, 'version.json'), 'utf8'));
  expect(stamp.commit).toBe(HEAD_SHA);
  expect(stamp.built_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(calls().some((c) => c.tool === 'bunx' && argsOf(c).includes('wrangler'))).toBe(false);
});

test('deploy --local hands the token to the wrangler commands only, never to bun, cargo or pagefind', () => {
  const r = runLocal(['deploy', '--local'], {
    VIVERA_DOCS_DEPLOY_ACK: ACK,
    VIVERA_DOCS_CF_TOKEN: 'fake-docs-token',
    CLOUDFLARE_API_TOKEN: 'outer-token-must-vanish',
    CLOUDFLARE_ACCOUNT_ID: 'fake-account',
    STUB_LIVE_EXIT: '1',
    VIVERA_DOCS_LIVE_ATTEMPTS: '1',
    STUB_DEPLOYMENTS: '2',
  });
  expect(r.code).toBe(1);
  expect(calls().length).toBeGreaterThan(0);
  expect(r.out).not.toContain('fake-docs-token');
  expect(r.out).toContain('rollback: exit 0');

  const wrangler = calls().filter(isWrangler);
  expect(wrangler.map((c) => argsOf(c).split(' ')[1])).toEqual(['deploy', 'deploy', 'deployments', 'rollback']);
  for (const c of wrangler) expect(envOf(c)).toEqual({ cf: 'fake-docs-token', vd: 'UNSET', acct: 'fake-account' });

  const others = calls().filter((c) => ['bun', 'bunx', 'cargo'].includes(c.tool) && !isWrangler(c));
  expect(others.map((c) => c.tool).sort()).toEqual(['bun', 'bun', 'bun', 'bun', 'bun', 'bunx', 'cargo']);
  for (const c of others) {
    expect({ step: argsOf(c), cf: envOf(c).cf, vd: envOf(c).vd }).toEqual({ step: argsOf(c), cf: 'UNSET', vd: 'UNSET' });
  }
});

test('deploy --local without the ack is refused before any step', () => {
  const r = runLocal(['deploy', '--local'], { VIVERA_DOCS_CF_TOKEN: 'fake-docs-token' });
  expect(r.code).toBe(1);
  expect(r.out).toContain('VIVERA_DOCS_DEPLOY_ACK');
  expect(calls()).toEqual([]);
});

test('deploy --local without a token is refused before any build step', () => {
  const r = runLocal(['deploy', '--local'], { VIVERA_DOCS_DEPLOY_ACK: ACK });
  expect(r.code).toBe(1);
  expect(r.out).toContain('VIVERA_DOCS_CF_TOKEN');
  expect(calls()).toEqual([]);
});

test.each([
  [['deploy', '--dry-run', '--local']],
  [['deploy', '--local', '--dry-run']],
])('%p (local dry run) needs no token, runs only the wrangler dry run, and a no-op cf env keeps the command valid', (args) => {
  const r = runLocal(args);
  expect(r.code).toBe(0);
  expect(calls().length).toBeGreaterThan(0);
  expect(noRemote()).toEqual([]);
  const wrangler = calls().filter(isWrangler);
  expect(wrangler.map(argsOf)).toEqual(['wrangler@4.151.1 deploy --dry-run']);
  expect(envOf(wrangler[0]).cf).toBe('UNSET');
  expect(calls().some((c) => argsOf(c).includes('--live'))).toBe(false);
});

test('build --local with VIVERA_DOCS_OUT copies the built dist with docs/version.json', () => {
  const out = path.join(tmp, 'out');
  const r = runLocal(['build', '--local'], { VIVERA_DOCS_OUT: out });
  expect(r.code).toBe(0);
  expect(calls().length).toBeGreaterThan(0);
  expect(JSON.parse(fs.readFileSync(path.join(out, 'docs', 'version.json'), 'utf8')).commit).toBe(HEAD_SHA);
  expect(fs.existsSync(path.join(out, 'docs', 'generated', 'diagram.svg'))).toBe(true);
});

test('build --local refuses a non-empty VIVERA_DOCS_OUT before any step', () => {
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'old.html'), 'old\n');
  const r = runLocal(['build', '--local'], { VIVERA_DOCS_OUT: out });
  expect(r.code).toBe(1);
  expect(r.out).toContain('VIVERA_DOCS_OUT');
  expect(calls()).toEqual([]);
});

const SHIP_ENV = { VIVERA_DOCS_DEPLOY_ACK: ACK, VIVERA_DOCS_CF_TOKEN: 'fake-docs-token' };
const notWrangler = (c) =>
  c.tool === 'cargo' || (c.tool === 'bun' && !argsOf(c).includes(' --live ')) || (c.tool === 'bunx' && !isWrangler(c));

test('ship --local deploys the downloaded dist from a work dir with wrangler only, and only wrangler sees the token', () => {
  const script = shipRepo();
  const r = runLocal(['ship', '--local'], { ...SHIP_ENV, CLOUDFLARE_API_TOKEN: 'outer-token-must-vanish' }, script);
  expect(r.code).toBe(0);
  expect(calls().length).toBeGreaterThan(0);
  expect(noRemote()).toEqual([]);
  expect(calls().filter(notWrangler)).toEqual([]);
  expectInOrder(steps().join('\n'), [
    'bunx wrangler@4.151.1 deploy --dry-run',
    'bunx wrangler@4.151.1 deploy\n',
    `docs-site-check.mjs --live ${LIVE_URL}`,
  ]);
  const cwds = calls().filter((c) => c.tool === 'wrangler-cwd');
  expect(cwds).toHaveLength(2);
  for (const c of cwds) {
    expect(c.text).toMatch(/^\/tmp\/vivera-docs-ship-\d{8}T\d{6}Z-[A-Za-z0-9]{6}\/apps\/docs\t/);
    expect(c.text).toContain('dist/docs/version.json wrangler.json');
  }
  for (const c of calls().filter(isWrangler)) expect(envOf(c).cf).toBe('fake-docs-token');
  for (const c of calls().filter((c) => c.tool === 'bun')) expect(envOf(c)).toMatchObject({ cf: 'UNSET', vd: 'UNSET' });
  expect(fs.existsSync(path.join(path.dirname(script), '..', 'apps', 'docs', 'dist', 'docs', 'version.json'))).toBe(true);
});

test('ship --local --dry-run needs no token and only dry-runs wrangler', () => {
  const r = runLocal(['ship', '--local', '--dry-run'], {}, shipRepo());
  expect(r.code).toBe(0);
  expect(calls().filter(isWrangler).map(argsOf)).toEqual(['wrangler@4.151.1 deploy --dry-run']);
  expect(calls().filter(notWrangler)).toEqual([]);
});

test.each([
  ['a missing dist', { dist: false }, {}, 'apps/docs/dist'],
  ['a stamp that differs from HEAD', { stamp: 'f'.repeat(40) }, {}, 'does not match HEAD'],
  ['a real ship without a token', {}, { VIVERA_DOCS_CF_TOKEN: '' }, 'VIVERA_DOCS_CF_TOKEN'],
])('ship --local refuses %s before any wrangler call', (_name, repo, env, message) => {
  const r = runLocal(['ship', '--local'], { ...SHIP_ENV, ...env }, shipRepo(repo));
  expect(r.code).toBe(1);
  expect(r.out).toContain(message);
  expect(calls().filter((c) => c.tool === 'bun' || c.tool === 'bunx')).toEqual([]);
});

test('ship without --local is a usage error before any step (ship is local only)', () => {
  const r = runLocal(['ship'], SHIP_ENV, shipRepo());
  expect(r.code).toBe(2);
  expect(r.out).toContain('ship --local [--dry-run]');
  expect(calls()).toEqual([]);
});

const API = { ...SHIP_ENV, VIVERA_DOCS_LIVE_CHECK: 'api', VIVERA_DOCS_LIVE_INTERVAL: '0' };
const isLiveHttp = (c) => c.tool === 'bun' && argsOf(c).includes(' --live ');
const wranglerSteps = () => calls().filter(isWrangler).map((c) => argsOf(c).replace('wrangler@4.151.1 ', ''));

test('ship --local with VIVERA_DOCS_LIVE_CHECK=api passes when deployments status shows the new version at 100%, with no HTTP check', () => {
  const r = runLocal(['ship', '--local'], { ...API, STUB_STATUS_JSON: statusJson([[VERSION_ID, 100]]) }, shipRepo());
  expect(r.code).toBe(0);
  expect(calls().length).toBeGreaterThan(0);
  expect(wranglerSteps()).toEqual(['deploy --dry-run', 'deploy', 'deployments status --json']);
  for (const c of calls().filter(isWrangler)) expect(envOf(c).cf).toBe('fake-docs-token');
  expect(calls().filter(isLiveHttp)).toEqual([]);
  expect(r.out).toContain(`Current Version ID: ${VERSION_ID}`);
  expect(r.out).toContain('live check: attempt 1/10 exit 0');
});

test.each([
  ['another version at 100%', [['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 100]]],
  ['a split with the new version at 50%', [[VERSION_ID, 50], ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 50]]],
])('ship --local api check retries, then rolls back and exits 1 when status shows %s', (_name, versions) => {
  const r = runLocal(['ship', '--local'], { ...API, VIVERA_DOCS_LIVE_ATTEMPTS: '2', STUB_STATUS_JSON: statusJson(versions) }, shipRepo());
  expect(r.code).toBe(1);
  expect(wranglerSteps()).toEqual([
    'deploy --dry-run',
    'deploy',
    'deployments status --json',
    'deployments status --json',
    'deployments list --json',
    'rollback --message smoke failed --yes',
  ]);
  expect(calls().filter(isLiveHttp)).toEqual([]);
  expect(r.out).toContain('rollback: exit 0');
});

test('ship --local api check rolls back and exits 1 when the deploy output names no version id', () => {
  const r = runLocal(['ship', '--local'], { ...API, STUB_NO_VERSION_ID: '1' }, shipRepo());
  expect(r.code).toBe(1);
  expect(r.out).toContain('no version id');
  expect(wranglerSteps()).toEqual(['deploy --dry-run', 'deploy', 'deployments list --json', 'rollback --message smoke failed --yes']);
  expect(calls().filter(isLiveHttp)).toEqual([]);
});

test('deploy --local refuses an unknown VIVERA_DOCS_LIVE_CHECK with exit 2 before any step', () => {
  const r = runLocal(['deploy', '--local', '--dry-run'], { VIVERA_DOCS_LIVE_CHECK: 'ping' });
  expect(r.code).toBe(2);
  expect(r.out).toContain('VIVERA_DOCS_LIVE_CHECK');
  expect(calls()).toEqual([]);
});
