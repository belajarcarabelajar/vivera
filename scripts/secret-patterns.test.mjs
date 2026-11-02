// scripts/secret-patterns.test.mjs
//
// The detector rules of the secret gate, driven through the public scanText().
// Every credential below is assembled at run time from parts, so this file passes
// the gate it tests: no line here holds a complete token.
import { describe, expect, test } from 'bun:test';
import { HARD_RULES, HOME_ALLOW, PERSONAL_RULES, isTestPath, scanText } from './lib/secret-patterns.mjs';

const aws2 = () => `AS${'IA'}${'QWERTYUIOP123456'}`;
const alnum = (n, seed = 'aB3dE5gH7jK9mN2pQ4sT6vW8yZ1cF') => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const telegram = (n = 35) => `${'1234567'}${'890'}:${alnum(n)}`;
const anthropic = () => ['sk', 'ant', 'api03', alnum(30)].join('-');
const github = () => `gh${'p'}_${alnum(36)}`;
const githubFine = () => ['github', 'pat'].join('_') + `_${alnum(30)}`;
const aws = () => `AK${'IA'}${'QWERTYUIOP123456'}`;
const pemHeader = () => ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const home = (u, rest = '') => `/home/${u}${rest}`;
const waiver = (reason = '') => `secrets:${' '}allow${reason ? ` ${reason}` : ''}`;

const rules = (text, opts = {}) => scanText(text, opts).map((f) => f.rule);

describe('review round 1: boundaries that let a credential or the owner path through', () => {
  test('a Telegram token in the bot URL form, ending in a dash, quoted or at the end of a line', () => {
    const body = alnum(34);
    const urlForm = `https://api.telegram.org/bot${'1234567'}${'890'}:${alnum(35)}/getMe`;
    expect(rules(urlForm)).toEqual(['telegram-bot-token']);
    expect(rules(`t = '${'1234567'}${'890'}:${body}-'`)).toEqual(['telegram-bot-token']);
    expect(rules(`t = ${'1234567'}${'890'}:${body}-`)).toEqual(['telegram-bot-token']);
    expect(rules(`t = ${'1234567'}${'890'}:${alnum(36)}`)).toEqual([]); // 36 characters is not a token
    expect(rules(`n = 12${'1234567'}${'890'}:${alnum(35)}`)).toEqual([]); // 12 digits is not a bot id
  });

  test('the owner path is caught whatever follows the name', () => {
    for (const tail of ['</code>', '**', '|x', '!', '=', '?', '>', '\\nx', '. Next sentence']) {
      expect(rules(`see ${home('alice')}${tail}`)).toEqual(['home-path']);
    }
    expect(rules(`<${home('alice')}>`)).toEqual(['home-path']);
    expect(rules(`${home('alice')}/`)).toEqual(['home-path']);
    expect(rules(`${home('alice')}.`)).toEqual(['home-path']); // the dot ends a sentence, the name is still the owner's
    expect(rules(`${home('user')}.`)).toEqual([]); // a placeholder, the dot is punctuation
    expect(rules(`${home('first.last', '/x')}`)).toEqual(['home-path']); // a dot inside a name is part of it
  });

  test('macOS and removable-media roots count, with the same placeholders', () => {
    expect(rules(`/Users/${'alice'}/x`)).toEqual(['home-path']);
    expect(rules(`/run/media/${'alice'}/disk`)).toEqual(['home-path']);
    expect(rules(`/Users/${'u'}/x`)).toEqual([]);
    expect(rules(`/run/media/${'u'}/disk`)).toEqual([]);
  });

  test('AWS temporary (ASIA) keys are caught', () => {
    expect(rules(`id=${aws2()}`)).toEqual(['aws-access-key']);
  });

  test('prose that mentions the waiver word is not a waiver without a reason', () => {
    expect(rules(`use \`${waiver()}\` to waive a personal finding`)).toEqual([]);
    expect(rules(`${waiver()}.`)).toEqual([]);
  });

  test('a very long line of word characters does not stall the scan', () => {
    const started = Date.now();
    expect(rules('tokenx'.repeat(400000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('review round 2: the long-line cap was a bypass, and its neighbours', () => {
  test('a secret assignment is caught on a minified, very long line', () => {
    const filler = '{"a":1},'.repeat(700); // over 5000 characters before the secret
    expect(rules(`${filler}{"api_key":"${alnum(30)}"}`)).toEqual(['secret-assignment']);
    expect(rules(`{"password":"${alnum(30)}"}${filler}`)).toEqual(['secret-assignment']);
    expect(rules(`${'x'.repeat(100000)} {"client_secret":"${alnum(30)}"}`)).toEqual(['secret-assignment']);
  });

  test('scan time stays small just under and far over any cap', () => {
    const started = Date.now();
    for (let i = 0; i < 300; i++) rules('tokenx'.repeat(660));
    expect(rules('tokenx'.repeat(400000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a dash right after the name is punctuation, a dash that continues the name is not', () => {
    expect(rules(`${home('alice')}-`)).toEqual(['home-path']);
    expect(rules(`${home('alice')}- x`)).toEqual(['home-path']);
    expect(rules(`${home('alice')}-.`)).toEqual(['home-path']);
    expect(rules(`${home('alice-smith', '/x')}`)).toEqual(['home-path']);
    expect(rules(`${home('user')}-`)).toEqual([]);
  });

  test('a shared macOS folder is not a home path, a prefix does not hide the owner', () => {
    expect(rules('/Users/Shared/x')).toEqual([]);
    expect(rules('/Users/Guest/x')).toEqual([]);
    for (const prefix of ['/data', '/var', '.', '/mnt/x', '/System/Volumes/Data', 'rootfs', '$ROOT', '-v /host']) {
      const root = prefix.includes('System') ? 'Users' : 'home';
      expect(rules(`${prefix}/${root}/${'alice'}/x`)).toEqual(['home-path']);
    }
  });

  test('an ASIA word is not a key, an ASIA key id with a digit and an AKIA key are', () => {
    expect(rules(`REGION = ${'ASIA'}${'PACIFICSOUTHEAST'}`)).toEqual([]);
    expect(rules(`id=${aws2()}`)).toEqual(['aws-access-key']);
    expect(rules(`id=${aws()}`)).toEqual(['aws-access-key']);
  });
});

describe('hard rules', () => {
  const positives = {
    'telegram-bot-token': `TOKEN_X = '${telegram()}'`,
    'anthropic-key': `key: ${anthropic()}`,
    'github-token': `export GH=${github()}`,
    'aws-access-key': `id=${aws()}`,
    'private-key-block': `${pemHeader()}\n${alnum(64)}\n-----END RSA PRIVATE KEY-----`,
    'secret-assignment': `const API_KEY = "${alnum(24)}"`,
  };
  for (const [rule, text] of Object.entries(positives)) {
    test(`${rule} fires and names its line`, () => {
      const found = scanText(`first\n${text}\n`, { path: 'src/a.ts' });
      expect(found.map((f) => f.rule)).toContain(rule);
      expect(found.every((f) => f.kind === 'hard')).toBe(true);
      expect(found[0].line).toBeGreaterThanOrEqual(2);
    });
  }

  test('github fine-grained tokens are caught too', () => {
    expect(rules(`t=${githubFine()}`)).toEqual(['github-token']);
  });

  test('near misses do not fire', () => {
    const misses = [
      `x = ${telegram(34)}`, // 34 characters after the colon
      `x = ${['sk', 'ant', 'short'].join('-')}`,
      `x = gh${'p'}_${alnum(10)}`,
      `x = AK${'IA'}${'QWERTY12345'}`,
      pemHeader(), // a bare header, as in a redaction test
      `const API_KEY = "${alnum(8)}"`,
      'const API_KEY_ENV = "ANTHROPIC_API_KEY"', // letters only, no digit
      'const MAX_TOKENS_PER_REQUEST = 4096',
      `xAK${'IA'}${'QWERTYUIOP123456'}`, // inside a longer word
      'const withEvidenceToken = T5_GREP_FAMILY_ROWS', // a constant name, not a value
    ];
    for (const m of misses) expect(rules(m)).toEqual([]);
  });

  test('synthetic values count as placeholders', () => {
    const fakes = [
      `t = 'gh${'p'}_FAKE${alnum(32)}'`,
      `API_KEY=your-api-key-${alnum(20)}`,
      `TOKEN=${'0123456789'}abcdef${'0123456789'}`,
      `SECRET = "EXAMPLE${alnum(20)}"`,
      `PASSWORD = "<${alnum(24)}>"`,
      `${'API_KEY'}=\${${alnum(20)}}`,
      `api_key=${'synthetic'}-fixture-value-1`,
    ];
    for (const f of fakes) expect(rules(f)).toEqual([]);
  });

  test('a hard rule cannot be waived', () => {
    expect(rules(`${waiver('test fixture')}\nid=${aws()}`)).toEqual(['aws-access-key']);
    expect(rules(`id=${aws()} // ${waiver('test fixture')}`)).toEqual(['aws-access-key']);
  });

  test('two findings on one line are both reported', () => {
    expect(rules(`a=${aws()} b=${github()}`).sort()).toEqual(['aws-access-key', 'github-token']);
  });
});

describe('personal-data rules', () => {
  test('a real-looking home user fires, placeholders do not', () => {
    expect(rules(`cwd: ${home('alice', '/project')}`)).toEqual(['home-path']);
    expect(rules(`cwd: "${home('alice')}"`)).toEqual(['home-path']);
    for (const user of ['u', 'x', 'user', 'you', 'example', 'testuser', 'me', 'someone', 'bun', '...']) {
      expect(HOME_ALLOW.has(user)).toBe(true);
      expect(rules(home(user, '/project'))).toEqual([]);
    }
  });

  test('private addresses fire outside test files only', () => {
    expect(rules('host 192.168.4.20', { path: 'src/a.ts' })).toEqual(['private-ip']);
    expect(rules('host 10.0.0.1', { path: 'README.md' })).toEqual(['private-ip']);
    expect(rules('host 172.16.5.9', { path: 'src/a.ts' })).toEqual(['private-ip']);
    expect(rules('host 192.168.4.20', { path: 'src/a.test.ts' })).toEqual([]);
    expect(rules('host 192.168.4.20', { path: 'mods/x/test/a.ts' })).toEqual([]);
  });

  test('public addresses, bad octets and version strings do not fire', () => {
    for (const t of ['8.8.8.8', '192.0.2.10', '172.32.0.1', '10.999.1.1', 'v1.10.0.1.5', '172.15.0.1']) {
      expect(rules(`x ${t}`, { path: 'src/a.ts' })).toEqual([]);
    }
  });

  test('a waiver with a reason, on the line or the line above, clears a personal finding', () => {
    expect(rules(`${home('alice', '/x')} // ${waiver('demo path')}`)).toEqual([]);
    expect(rules(`// ${waiver('private-range table')}\nconst r = ['10.0.0.0', 8]`, { path: 'src/a.ts' })).toEqual([]);
  });

  test('a waiver without a reason is itself a finding and clears nothing', () => {
    const found = scanText(`// ${waiver()}\n${home('alice', '/x')}`);
    expect(found.map((f) => f.rule).sort()).toEqual(['home-path', 'waiver-no-reason']);
    expect(found.find((f) => f.rule === 'waiver-no-reason').kind).toBe('waiver');
    expect(rules(`// ${waiver('ok')}\n${home('alice', '/x')}`)).toContain('waiver-no-reason');
  });
});

describe('scanText options and shape', () => {
  test('lines limits findings to added lines but the waiver above still counts', () => {
    const text = `${home('alice', '/a')}\n// ${waiver('demo path')}\n${home('bob', '/b')}\n${home('carol', '/c')}`;
    expect(scanText(text, { lines: [1] }).map((f) => f.line)).toEqual([1]);
    expect(scanText(text, { lines: [3] })).toEqual([]);
    expect(scanText(text, { lines: [4] }).map((f) => f.line)).toEqual([4]);
  });

  test('a finding never carries the matched text', () => {
    const t = telegram();
    const found = scanText(`x = '${t}'`);
    expect(found).toHaveLength(1);
    expect(JSON.stringify(found)).not.toContain(t);
    expect(Object.keys(found[0]).sort()).toEqual(['kind', 'line', 'rule']);
  });

  test('CRLF text, empty text and a start line offset work', () => {
    expect(rules(`a\r\n${aws()}\r\n`)).toEqual(['aws-access-key']);
    expect(scanText(`a\r\n${aws()}\r\n`)[0].line).toBe(2);
    expect(scanText('')).toEqual([]);
    expect(scanText(`${aws()}`, { startLine: 41 })[0].line).toBe(41);
  });

  test('rule tables expose ids and kinds, test paths are recognised', () => {
    expect(HARD_RULES.map((r) => r.id).sort()).toEqual(['anthropic-key', 'aws-access-key', 'github-token', 'private-key-block', 'secret-assignment', 'telegram-bot-token']);
    expect(PERSONAL_RULES.map((r) => r.id).sort()).toEqual(['home-path', 'private-ip']);
    for (const p of ['a.test.mjs', 'x/a.spec.ts', 'mods/m/test/a.ts', 'a/__tests__/b.js']) expect(isTestPath(p)).toBe(true);
    for (const p of ['src/a.ts', 'scripts/check.mjs', 'contest/a.ts']) expect(isTestPath(p)).toBe(false);
  });
});
