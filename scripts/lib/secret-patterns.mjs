// scripts/lib/secret-patterns.mjs
//
// The rules of the secret gate (scripts/check-secrets.mjs), kept as data plus one
// pure function so the hook, the targeted-checks planner and the audit judge the
// same text the same way.
//
// TWO KINDS OF RULE.
//   hard      A credential: Telegram bot token, Anthropic key, GitHub token, AWS
//             access key, a private key block with a body, a secret-named
//             assignment with a real-looking value. No waiver clears one.
//   personal  Something that identifies the owner's machine or network: a
//             /home/<name>/ path of a user that is not a documented placeholder,
//             and a private-range IPv4 address outside test files. A comment
//             `secrets: allow <reason>` on the line or the line above clears one;
//             the reason is required (3 characters or more), otherwise the
//             waiver is a finding of its own (kind 'waiver').
//
// WHAT A FINDING IS. { line, rule, kind }. It never carries the matched text, so a
// report cannot leak what it reports.
//
// PLACEHOLDERS. A matched hard value that looks synthetic (FAKE, EXAMPLE,
// PLACEHOLDER, 0123456789, XXXX, REDACTED, your-..., <...>, ${...}) is skipped: the
// repository's own redaction tests need fake credentials. A bare private key header
// without a body is skipped for the same reason.
//
// defer: regex rules only, no entropy score; add one when a real secret slips past review
//
// Usage: import { scanText, isTestPath } from './lib/secret-patterns.mjs'

export const HOME_ALLOW = new Set([
  'u', 'x', 'user', 'username', 'you', 'example', 'name', 'me', 'someone', 'testuser', 'runner', 'vagrant', 'ubuntu', 'node', '...',
]);

const PLACEHOLDER = /FAKE|EXAMPLE|PLACEHOLDER|0123456789|XXXX|REDACTED|your[-_]|<[^>]+>|\$\{/i;

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const tail = (n) => `(?:\\.${OCTET}){${n}}`;
// RFC1918: 10/8, 172.16/12, 192.168/16. Not part of a longer dotted number on either side.
const PRIVATE_IP_SOURCE = `(?<![\\d.])(?:10${tail(3)}|192\\.168${tail(2)}|172\\.(?:1[6-9]|2\\d|3[01])${tail(2)})(?!\\d|\\.\\d)`;

const HOME_PATH = /\/home\/([A-Za-z0-9_.-]+)(?=[/"'`\s)\]},:;]|$)/g;
const SECRET_ASSIGNMENT = /\b\w*(?:token|secret|password|passwd|api[_-]?key)\w*["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{16,})/gi;
const PEM_HEADER = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g;
const BASE64_BODY = /[A-Za-z0-9+/=]{40,}/;
const WAIVER = /secrets:\s*allow(?:[ \t]+(\S.*))?/;

// Each hard rule: id plus a global regex; `valueGroup` picks the part judged as a placeholder.
export const HARD_RULES = [
  { id: 'telegram-bot-token', kind: 'hard', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { id: 'anthropic-key', kind: 'hard', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'github-token', kind: 'hard', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { id: 'aws-access-key', kind: 'hard', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'private-key-block', kind: 'hard', re: PEM_HEADER, multiline: true },
  { id: 'secret-assignment', kind: 'hard', re: SECRET_ASSIGNMENT, valueGroup: 1, needsLetterAndDigit: true },
];

export const PERSONAL_RULES = [
  { id: 'home-path', kind: 'personal', re: HOME_PATH, allow: (m) => HOME_ALLOW.has(m[1]) },
  { id: 'private-ip', kind: 'personal', re: new RegExp(PRIVATE_IP_SOURCE, 'g'), skipTests: true },
];

/** True for test and spec files and for anything under a test directory. */
export function isTestPath(path) {
  return /(?:\.test\.|\.spec\.|(?:^|\/)(?:test|tests|__tests__)\/)/.test(path);
}

function* matches(re, line) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    yield m;
    if (m[0] === '') re.lastIndex++;
  }
}

const looksReal = (value, rule) => {
  if (PLACEHOLDER.test(value)) return false;
  if (rule.needsLetterAndDigit && !(/[A-Za-z]/.test(value) && /\d/.test(value))) return false;
  return true;
};

/**
 * Findings for `text`. `path` decides the test-file exemption of the address rule.
 * `startLine` numbers the first line (default 1). `lines`, an array of line numbers,
 * keeps only findings on those lines (added lines of a diff); the waiver lookup still
 * reads the line above, whether or not it is in `lines`.
 */
export function scanText(text, { path = '', startLine = 1, lines = null } = {}) {
  const all = text.split(/\r?\n/);
  const keep = lines ? new Set(lines) : null;
  const wanted = (n) => keep === null || keep.has(n);
  const out = [];
  const waiverAt = (i) => {
    for (const j of [i, i - 1]) {
      const m = j >= 0 && j < all.length ? WAIVER.exec(all[j]) : null;
      if (m && (m[1] ?? '').trim().length >= 3) return true;
    }
    return false;
  };

  for (let i = 0; i < all.length; i++) {
    const n = startLine + i;
    const line = all[i];
    if (wanted(n)) {
      for (const rule of HARD_RULES) {
        for (const m of matches(rule.re, line)) {
          if (rule.multiline) {
            const rest = line.slice(m.index + m[0].length);
            const next = all[i + 1] ?? '';
            if (!BASE64_BODY.test(rest) && !/^\s*[A-Za-z0-9+/=]{40,}\s*$/.test(next)) continue;
            out.push({ line: n, rule: rule.id, kind: 'hard' });
            continue;
          }
          const value = rule.valueGroup ? m[rule.valueGroup] : m[0];
          if (looksReal(value, rule)) out.push({ line: n, rule: rule.id, kind: 'hard' });
        }
      }
      for (const rule of PERSONAL_RULES) {
        if (rule.skipTests && isTestPath(path)) continue;
        for (const m of matches(rule.re, line)) {
          if (rule.allow?.(m)) continue;
          if (!waiverAt(i)) out.push({ line: n, rule: rule.id, kind: 'personal' });
        }
      }
      const w = WAIVER.exec(line);
      if (w && (w[1] ?? '').trim().length < 3) out.push({ line: n, rule: 'waiver-no-reason', kind: 'waiver' });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}
