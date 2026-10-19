#!/usr/bin/env bun
// .claude/hooks/require-exit-code.mjs
//
// Stop hook that the super-ultra-code-plan skill registers in its frontmatter: a final message that
// claims something passes must name an exit code ("Every passing claim names its evidence" in
// sucp-rules). Rule text alone did not hold: evidence-exit-code-cited failed 2 of 2 runs after the
// rule spelled out the words "exit 0", with pass counts and no exit code in the final message.
//
// A block is {"decision":"block"} on stdout, so Claude rewrites the message once. A rewrite is never
// blocked again (stop_hook_active), and every failure exits 0 with no output, because a crashing
// Stop hook must not trap the session.
//
// Does not catch: a completion message with no pass wording at all ("Done, added the test"), or an
// "exit 0" that belongs to a different command than the claim.

// A pass claim in the present or past tense; "should pass" and "will pass" are not claims. A
// subject that closes a code span counts only in the past tense ("`bun test` passed", seen in a
// failing eval run), so a gate's "Acceptance: `bun test` passes" stays a spec, not a claim.
const PASS_CLAIM = new RegExp([
  String.raw`\b\d+\s+(tests?\s+)?pass(ed|es|ing)?\b`,
  String.raw`\b(tests?|specs?|checks?|suites?|gates?|builds?|typecheck|lint)\s+(all\s+|now\s+|still\s+)?(pass(ed|es)?|succeed(ed|s)?|(is|are)\s+(passing|green))\b`,
  String.raw`\b(tests?|checks?|suites?|typecheck|lint)[\x60'"]\s+(all\s+|now\s+)?(passed|succeeded)\b`,
  String.raw`\bpassed\s+(all\s+)?(\d+|every)\b`,
  String.raw`\ball\s+(\w+\s+)?(pass(ed|es|ing)?|green)\b`,
  String.raw`\b((is|are)\s+|tests?\s+|suite\s+)green\b`,
  String.raw`\b0\s+fail(s|ed|ures?)?\b`,
  String.raw`\blulus\b`,
].join("|"), "i");

// Exactly the eval scenario's form of a zero code: "exit 0", "exited 0", "exit code: 0", "exit=0".
// A pass claim needs exit 0; the red run's "exit 1" is not evidence for the green run.
const EXIT_ZERO = /\bexit(s|ed)?( code| status)?:? ?(was |of |is |=)?`?0\b/i;
// A failing report (a nonzero fail count) may name its nonzero code instead.
const EXIT_ANY = /\bexit(s|ed)?( code| status)?:? ?(was |of |is |=|with )?(code )?`?\d+\b/i;
const FAILING = /\b[1-9]\d*\s+(tests?\s+)?fail(s|ed|ing|ures?)?\b/i;

export const REASON = [
  'Your final message claims a pass but does not say "exit 0". Rewrite it so each passing claim names',
  'the command and its exit code from a run in this session, with the words "exit 0", for example:',
  '`bun test` exit 0, 4 pass, 0 fail. If you did not see the code, rerun the command first as',
  '`cmd; echo "exit=$?"` (never after a pipe). Change nothing else and start no new work.',
].join(" ");

export function check(input) {
  if (!input || input.stop_hook_active) return null;
  const message = String(input.last_assistant_message ?? "");
  if (!PASS_CLAIM.test(message) || EXIT_ZERO.test(message)) return null;
  if (FAILING.test(message) && EXIT_ANY.test(message)) return null;
  return REASON;
}

if (import.meta.main) {
  try {
    const reason = check(JSON.parse(await Bun.stdin.text()));
    if (reason) process.stdout.write(JSON.stringify({ decision: "block", reason }));
  } catch {
    // Unparseable input lets the stop through.
  }
  process.exit(0);
}
