// Stop hook for sessions lan-claude launched: tells the server a turn ended, with the last reply,
// so the phone page can show "Claude menunggu". Never blocks the stop (prints nothing, exits 0).
import { config } from "../src/config";

async function main(): Promise<void> {
  const job = process.env.LAN_CLAUDE_JOB;
  if (!job) return;
  const input = JSON.parse(await Bun.stdin.text()) as { last_assistant_message?: string };
  await fetch("http://lan-claude/hook/stop", {
    unix: config.socketPath,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job, last: String(input.last_assistant_message ?? "").slice(0, 4000) }),
    signal: AbortSignal.timeout(5_000),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
