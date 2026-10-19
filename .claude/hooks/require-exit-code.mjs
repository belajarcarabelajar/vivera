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
// exit code that names a different command than the claim.

// A pass claim in the present or past tense; "should pass" and "will pass" are not claims.
const PASS_CLAIM = new RegExp([
  String.raw`\b\d+\s+(tests?\s+)?pass(ed|es|ing)?\b`,
  String.raw`\b(tests?|specs?|checks?|suites?|gates?|builds?|typecheck|lint)\s+(all\s+|now\s+|still\s+)?(pass(ed|es)?|succeed(ed|s)?|(is|are)\s+(passing|green))\b`,
  String.raw`\ball\s+(\w+\s+)?(pass(ed|es|ing)?|green)\b`,
  String.raw`\b(is|are)\s+green\b`,
  String.raw`\blulus\b`,
].join("|"), "i");

// The eval scenario's form ("exit 0", "exited 0", "exit code: 0", "exit=0") for any code, plus "with".
const EXIT_CODE = /\bexit(s|ed)?( code| status)?:? ?(was |of |is |=|with )?(code )?`?\d+\b/i;

export const REASON = [
  'Your final message claims a pass but names no exit code. Rewrite it so each passing claim names',
  'the command and its exit code from a run in this session, with the words "exit 0", for example:',
  '`bun test` exit 0, 4 pass, 0 fail. If you did not see the code, rerun the command first as',
  '`cmd; echo "exit=$?"` (never after a pipe). Change nothing else and start no new work.',
].join(" ");

export function check(input) {
  if (!input || input.stop_hook_active) return null;
  const message = String(input.last_assistant_message ?? "");
  if (!PASS_CLAIM.test(message) || EXIT_CODE.test(message)) return null;
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
