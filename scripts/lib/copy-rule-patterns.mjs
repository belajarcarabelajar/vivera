// scripts/lib/copy-rule-patterns.mjs
//
// The attribution patterns of scripts/check-copy-rules.mjs, kept here so the
// checker stays under its size ceiling. A `strict` pattern matches a shape that is
// never a sentence about the rule (a trailer ending in an address, a line holding
// only the robot emoji), so the neighbour exemption for rule statements does not
// apply to it, and the em-dash check is skipped on a line it already fails.

// Each entry names the rule it enforces and prints the phrase that matched, so a
// hit tells the reader what to remove without them re-deriving the rule.
// ATTRIBUTION POSITION ONLY.
//
// The first draft of this list also matched a bare vendor name (`claude code`,
// `cursor`, `gemini`, `copilot`, `gpt-N`). That was wrong, and the validator
// proved it within one run: README.md's harness table lists `Claude Code` and
// `Copilot` as supported harnesses, and the mermaid lifecycle diagram carries a
// `🤖 Subagents execute` node. Both are legitimate. A pattern broad enough to
// catch those is broad enough to be ignored, and a gate people ignore is worse
// than no gate because it reports success while checking nothing.
//
// So the patterns below match the SHAPE of an attribution line, not the names.
// `Generated with X` is an attribution whatever X is, and a bare tool name is
// not.
export const WATERMARK_PATTERNS = [
  { re: /generated with\b/i, label: 'generated-with footer' },
  // The `u` flag is load-bearing and was missing on the first attempt, which made
  // this pattern silently incapable of matching anything: without `u`,
  // `\u{1F916}` is an identity escape for the literal text `u{1F916}`. The test
  // suite caught it because it asserts against the real footer string rather than
  // against a pattern that merely looks right.
  { re: /^\s*\u{1F916}\s+\S/u, label: 'robot emoji used as a credit badge' },
  { re: /^\s*co-authored-by\s*:/im, label: 'co-author trailer' },
  { re: /^\s*signed-off-by\s*:/im, label: 'sign-off trailer' },
  { re: /^\s*(?:co-authored-by|signed-off-by)\s*\[/im, label: 'trailer in link form' },
  // Found by the PR #161 review: a badge line holding only the emoji, and a trailer
  // without its colon or right under a line that quotes the rule.
  { re: /^\s*\u{1F916}\u{FE0F}?\s*$/u, label: 'robot emoji used as a credit badge', strict: true },
  // The address ends the line, so prose that only mentions one mid-sentence is not a trailer.
  { re: /^\s*co-authored-by\b[^\n]*<[^<>@\s]+@[^<>\s]+>\s*$/i, label: 'co-author trailer', strict: true },
  { re: /^\s*signed-off-by\b[^\n]*<[^<>@\s]+@[^<>\s]+>\s*$/i, label: 'sign-off trailer', strict: true },
];
