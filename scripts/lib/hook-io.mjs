// scripts/lib/hook-io.mjs
//
// Shared stdin, path, and error handling for the Claude Code context hooks
// (output cap, output replace, session journal). A hook body passed to runHook
// gets the parsed hook input and the resolved state paths; whatever it returns
// is printed as the hook's JSON output.
//
// Fail-open by design: none of these hooks is a safety guard, so any error, a
// malformed stdin, or an unwritable log ends with exit 0 and no output, and the
// tool call goes ahead untouched. Errors land as one line each in
// <stateDir>/hook-errors.log. Creating <stateDir>/context-hooks-off turns every
// hook built on runHook into a no-op without editing settings.json.
//
// The state and scratch dirs follow VIVERA_HOOK_STATE_DIR and
// VIVERA_HOOK_SCRATCH_DIR so the eval sandbox can point them into its run dir.
//
// Revert: remove the context hooks from settings.json with the context hooks
// installer (--uninstall), then delete this file and hook-io.test.mjs.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const ERROR_LOG = 'hook-errors.log';
const KILL_SWITCH = 'context-hooks-off';

export function readHookInput(text) {
  if (typeof text !== 'string') return null;
  try {
    const input = JSON.parse(text);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    return input;
  } catch {
    return null;
  }
}

export function hookPaths(env = process.env) {
  const home = env.HOME || homedir();
  const stateDir = env.VIVERA_HOOK_STATE_DIR || path.join(home, '.local', 'state', 'vivera');
  const scratchDir = env.VIVERA_HOOK_SCRATCH_DIR || path.join(home, '.cache', 'tmp', 'vivera-scratch');
  return {
    stateDir,
    scratchDir,
    errorLog: path.join(stateDir, ERROR_LOG),
    killSwitch: path.join(stateDir, KILL_SWITCH),
  };
}

export function isDisabled(paths) {
  return existsSync(paths.killSwitch);
}

function oneLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function logHookError(paths, hookName, error) {
  try {
    mkdirSync(paths.stateDir, { recursive: true });
    appendFileSync(paths.errorLog, `${new Date().toISOString()} ${hookName} ${oneLine(error)}\n`);
  } catch {}
}

export async function runHook(hookName, handler) {
  let paths;
  try {
    // stdin is drained before the kill-switch check so the writer never sees
    // a closed pipe.
    const text = await Bun.stdin.text();
    paths = hookPaths();
    if (isDisabled(paths)) return;
    const input = readHookInput(text);
    if (input === null) {
      logHookError(paths, hookName, new Error('stdin is not a JSON object'));
      return;
    }
    const result = await handler(input, paths);
    if (result != null) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    try {
      logHookError(paths ?? hookPaths(), hookName, error);
    } catch {}
  } finally {
    process.exitCode = 0;
  }
}
