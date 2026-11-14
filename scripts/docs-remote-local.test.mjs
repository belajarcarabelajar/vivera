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
