// scripts/lib/redact.mjs
//
// The last thing that runs before a string is written somewhere a person can
// read it.
//
// Two properties matter more than regex quality, and both are asserted in
// redact.test.mjs rather than argued for here:
//
//   1. IT IS PURE. No filesystem, no clock, no randomness. A redactor that can
//      write is a redactor that can be the wrong layer to call last, and the
//      wrong layer to call last looks exactly like the right one in a log.
//   2. IT IS IDEMPOTENT. Placeholders are the one token in the output that no
//      pattern is allowed to match again, so a second pass is a no-op. That
//      matters because a report gets rendered, then summarised, then diffed,
//      and each of those steps may re-run this one.
//
// Ordering is part of the contract, not an accident of how the array is
// written. PATTERNS is applied in order, each pattern receiving the STRING THE
// PREVIOUS ONE PRODUCED, not the original. A single fused pass would let a
// broad pattern swallow a narrow one and lose the narrow one's count; feeding
// results forward means every pattern gets to say what it saw. The visible
// consequence is that `token=ghp_...` reports both github-token and
// generic-secret-assignment, with the wider pattern owning the final text.
//
// The 2FA pattern is deliberately label-anchored. A bare six-digit number is
// row counts, ports, build durations and postcodes; only a number sitting next
// to a word that means "I am a second factor" is a secret.

/** The single placeholder shape. Stable so that output stays greppable. */
export function markerFor(name) {
  return `[REDACTED:${name}]`;
}

/**
 * Every pattern, applied in array order.
 *
 * `name` is not decoration. It is the key in the counts object and the body of
 * the placeholder, so an unnamed pattern produces a marker nobody can grep and
 * a count nobody can report. assertPatterns refuses such an entry.
 */
export const PATTERNS = [
  {
    name: 'aws-access-key-id',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    name: 'github-token',
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: 'github-fine-grained-pat',
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  },
  {
    // Non-greedy across newlines: a key is only secret up to its END line, and
    // swallowing the rest of the log would destroy the report that mentions it.
    name: 'pem-private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    // A JWT's header is always base64url of an object, so it starts `eyJ`.
    // Requiring that is what keeps this pattern off version strings and
    // filenames, which are also three dot-separated segments.
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  },
  {
    name: 'bearer-token',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  },
  {
    // Same shapes as the hard rules in secret-patterns.mjs, so the commit gate
    // and the redactor agree on what a bare key looks like.
    name: 'anthropic-api-key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    name: 'telegram-bot-token',
    re: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  },
  {
    // The label is part of the match on purpose. Replacing only the digits
    // would leave `code: [REDACTED:totp-code]`, which is both noisy and one
    // redaction away from being a false positive on the next pass.
    //
    // The surrounding quotes are matched too, and matched symmetrically, so a
    // JSON blob comes out as `"[REDACTED:totp-code]"` rather than a mismatched
    // `"[REDACTED:totp-code]`. Consuming the delimiters also means the output
    // can be re-emitted as valid JSON instead of as a string with a brace
    // missing. The boundary sits before the closing quote, not after it, or the
    // digit-then-quote-then-comma case stops matching.
    name: 'totp-code',
    re: /["']?\b(?:(?:2fa|otp|mfa|totp|2-step|one[-_ ]?time|auth|verification)[-_ ]?code|2fa|otp|mfa|totp|code)\b["']?\s*(?:is|[:=])?\s*["']?\d{6}\b["']?/gi,
  },
  {
    // Same quote discipline on the label. The VALUE side is its own alternation
    // because a value can be a quoted string, a bracketed placeholder left by
    // an earlier pattern, or a bare run of non-delimiter characters. The label
    // may carry a `_` or `-` prefix (ANTHROPIC_API_KEY, DB_PASSWORD): `_` is a
    // word character, so a bare `\b` before the key word never fired there.
    // The lookbehind lets a match start only where such a word starts: with a
    // plain `\b` the prefix group was retried at every hyphen of a long run.
    name: 'generic-secret-assignment',
    re: /["']?(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?keys?|client[_-]?secret|secrets?|passwords?|passwd|token|auth[_-]?token|access[_-]?key)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|\[[^\]\n]*\]|[^\s,;"'`)}\]]+)/gi,
  },
];

export const PATTERN_NAMES = PATTERNS.map((p) => p.name);

/**
 * Reject a malformed table loudly.
 *
 * The alternative — skipping the bad entry — turns a typo into a silent leak,
 * and the caller sees a clean result object that means "checked, found
 * nothing". The index is in the message because the table is long enough that
 * "a pattern is malformed" is not actionable.
 *
 * @returns {Array<{name: string, re: RegExp}>} the same array, so callers can
 *   validate once and use the result.
 */
export function assertPatterns(patterns) {
  if (!Array.isArray(patterns)) {
    throw new TypeError(`patterns must be an array of { name, re }, got ${typeof patterns}`);
  }
  for (const [index, p] of patterns.entries()) {
    if (p === null || typeof p !== 'object') {
      throw new TypeError(`patterns[${index}]: every pattern needs a non-empty name, got ${p}`);
    }
    if (typeof p.name !== 'string' || p.name.trim() === '') {
      throw new TypeError(`patterns[${index}]: every pattern needs a non-empty name, got ${JSON.stringify(p.name)}`);
    }
    if (!(p.re instanceof RegExp)) {
      throw new TypeError(`patterns[${index}] (${p.name}): every pattern needs a RegExp re`);
    }
  }
  return patterns;
}

// A fresh RegExp per pass, per pattern. Two reasons: a `g` regex carries
// lastIndex, and a module-level table shared across calls would leak that state
// between them; and an injected pattern that forgot the `g` flag would
// otherwise replace only its first match and report a count nobody can trust.
function asGlobal(re) {
  const flags = re.flags.replace(/[gy]/g, '');
  return flags.includes('g') ? re : new RegExp(re.source, `${flags}g`);
}

/**
 * Replace every match of every pattern with `[REDACTED:<name>]`.
 *
 * @param {string} text
 * @param {Array<{name: string, re: RegExp}>} [patterns]
 * @returns {{ text: string, counts: Record<string, number> }} `text` is a new
 *   string; `counts` carries only the patterns that actually fired, in
 *   application order, so two runs of the same input diff cleanly.
 */
export function redact(text, patterns = PATTERNS) {
  const list = assertPatterns(patterns);
  // Checked before the loop, not inside it: the renderer hands this function
  // whatever field a JSON object happened to hold, so null and 42 are expected
  // input. Throwing here would take the report down over one empty field.
  if (typeof text !== 'string') return { text: '', counts: {} };

  const counts = {};
  let out = text;
  for (const p of list) {
    let n = 0;
    // The replacer is a function, not a string: a '$' or '$&' inside a secret
    // would otherwise be interpreted as a substitution pattern in the
    // replacement, and the redacted output would still contain the secret.
    out = out.replace(asGlobal(p.re), () => {
      n += 1;
      return markerFor(p.name);
    });
    if (n > 0) counts[p.name] = n;
  }
  return { text: out, counts };
}
