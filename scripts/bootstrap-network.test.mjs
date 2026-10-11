// scripts/bootstrap-network.test.mjs
//
// scripts/bootstrap.sh over a real network hop: https only (a plain-http base, an https-to-http
// redirect, an untrusted certificate), and, with curl absent, the same download through wget, whose
// redirects the script follows itself (https-to-ftp, root-relative, path-relative and upper-case
// redirects, a chain of 5 followed and of 6 refused). Two loopback origins serve the built release,
// `plain` over http and `secure` over https with a certificate made at run time; they and the rest of
// the fixtures are in scripts/lib/bootstrap-fixtures.mjs. They need openssl (and wget for the wget
// tests), and those tests skip without them.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  HAS_OPENSSL,
  HAS_WGET,
  MINIMAL,
  TAG,
  boot,
  bootAsync,
  buildRelease,
  cleanupFixture,
  closeSandboxes,
  expectInstalled,
  expectUntouched,
  ftpConnects,
  hopServed,
  plain,
  plainHits,
  secureBase,
  setup,
  startOrigins,
  trust,
} from './lib/bootstrap-fixtures.mjs';

beforeAll(() => {
  buildRelease();
  if (HAS_OPENSSL) startOrigins();
});
afterAll(cleanupFixture);
afterEach(closeSandboxes);

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
