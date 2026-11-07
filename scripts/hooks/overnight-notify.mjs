// scripts/hooks/overnight-notify.mjs
//
// Claude Code StopFailure and Notification (quota_auto_resume_*) hook. During
// an unattended sucp-overnight run it sends the owner one Telegram line through
// the telegram-ask bridge, so a run stopped by a rate limit, an outage, or a
// stale quota auto-resume is seen before morning. Every other session stays
// silent.
//
// Fail-open (L98): this is a notice, not a safety check, so every path exits 0
// and prints nothing on stdout. Internal errors (bad JSON, bad session id,
// unreadable marker, notify non-zero, crash or timeout) become one ISO-stamped
// line in <dir>/errors.log.
//
// Marker: <dir>/<session_id>, written by the sucp-overnight entry gate and
// removed when it closes the handoff. Lines:
//   plan=<plan id>
//   handoff=<handoff file path>
// No marker means the session is not an overnight run. The session id is
// checked against ^[A-Za-z0-9_-]+$ before it becomes a path. The hook's
// `message` and error text fields are never forwarded, since they can carry
// account or request details.
//
// Env seams: VIVERA_OVERNIGHT_DIR (default ~/.local/state/vivera-overnight),
// NOTIFY_TS (default ~/vivera/mods/telegram-ask/bridge/notify.ts).
//
// Revert: remove the StopFailure entry and the quota Notification entry from
// ~/.claude/settings.json, or restore
// ~/.claude/settings.json.bak-20261108-worktree-overnight-hooks.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const NOTIFY_TIMEOUT_MS = 15_000;

function stateDir() {
  return process.env.VIVERA_OVERNIGHT_DIR || path.join(homedir(), '.local', 'state', 'vivera-overnight');
}

function notifyScript() {
  return process.env.NOTIFY_TS || path.join(homedir(), 'vivera', 'mods', 'telegram-ask', 'bridge', 'notify.ts');
}

function logError(dir, text) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'errors.log'), `${new Date().toISOString()} ${text.replace(/\s+/g, ' ')}\n`);
  } catch {}
}

function readMarker(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  const fields = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fields;
}

export function noticeLine(marker, input) {
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'unknown';
  const kind = input.error_type ?? input.notification_type;
  const type = typeof kind === 'string' && kind ? kind : 'unknown';
  return `${marker.plan || 'unknown-plan'}: ${event} ${type} (handoff ${marker.handoff || 'unknown'})`;
}

function run(dir, stdinText) {
  const input = JSON.parse(stdinText);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input is not a JSON object');
  const id = input.session_id;
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error(`rejected session_id ${JSON.stringify(id)}`);
  const marker = readMarker(path.join(dir, id));
  if (!marker) return;
  // process.execPath is the bun running this hook; a hook shell's PATH may lack ~/.bun/bin.
  const r = spawnSync(process.execPath, [notifyScript(), noticeLine(marker, input)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: NOTIFY_TIMEOUT_MS,
    encoding: 'utf8',
  });
  if (r.error) throw new Error(`notify failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`notify exited ${r.status ?? r.signal}: ${(r.stderr || '').slice(0, 200)}`);
}

if (import.meta.main) {
  const dir = stateDir();
  try {
    run(dir, await Bun.stdin.text());
  } catch (e) {
    logError(dir, String(e?.message ?? e));
  }
  process.exitCode = 0;
}
