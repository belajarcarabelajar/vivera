// PermissionRequest hook for sessions lan-claude launched (LAN_CLAUDE_JOB is set by the launcher).
// Sends the request to the lan-claude server over its Unix socket and waits for a tap on the phone.
// Any failure, a timeout, or "no answer" prints nothing and exits 0: Claude Code then shows its
// normal terminal dialog. This hook never allows anything on its own.
import { hookOutput, type Decision } from "../src/permissions";
import { config } from "../src/config";

async function main(): Promise<void> {
  const job = process.env.LAN_CLAUDE_JOB;
  if (!job) return;
  const input = JSON.parse(await Bun.stdin.text()) as { tool_name?: string; tool_input?: unknown; session_id?: string };
  const res = await fetch("http://lan-claude/hook/permission", {
    unix: config.socketPath,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job, tool: input.tool_name ?? "?", input: input.tool_input ?? {}, session: input.session_id ?? "" }),
    signal: AbortSignal.timeout(config.permissionWaitMs + 20_000),
  });
  if (!res.ok) return;
  const { decision } = (await res.json()) as { decision: Decision };
  if (decision === "allow" || decision === "deny") process.stdout.write(hookOutput(decision));
}

main().catch(() => {}).finally(() => process.exit(0));
