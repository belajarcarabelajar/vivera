// scripts/hooks/output-cap.mjs
//
// PreToolUse hook for Read: denies a full Read of a regular file over 16,384
// bytes and names bounded alternatives instead. A Read that sets offset,
// limit, or pages always passes, so the agent cannot loop on the deny. The
// size comes from stat only; the file is never opened. Missing paths and
// directories are left to the Read tool itself.
//
// Images, PDFs, and notebooks are never capped: Claude Code renders them
// itself, and the text alternatives in the deny reason do not apply to them.
//
// Kill switch and fail-open behaviour come from scripts/lib/hook-io.mjs.
//
// Revert: remove the context hooks from settings.json with the context hooks
// installer (--uninstall), then delete this file and output-cap.test.mjs.

import { statSync } from 'node:fs';
import path from 'node:path';
import { runHook } from '../lib/hook-io.mjs';

const CAP_BYTES = 16384;
const UNCAPPED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.pdf', '.ipynb']);

function reasonFor(file, size) {
  return (
    `${file} is ${size} bytes, over the ${CAP_BYTES} byte cap for one full Read. Use one of: ` +
    `Read with offset and limit (for example limit 200); a bounded command such as ` +
    `rg -n '<pattern>' ${file} or sed -n '1,200p' ${file}; wc -c or head first to see its shape.`
  );
}

export function decide(input) {
  if (input.tool_name !== 'Read') return null;
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (toolInput.offset !== undefined || toolInput.limit !== undefined || toolInput.pages !== undefined) return null;
  const filePath = toolInput.file_path;
  if (typeof filePath !== 'string' || filePath === '') return null;
  if (UNCAPPED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;
  const base = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const file = path.resolve(base, filePath);
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.size <= CAP_BYTES) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reasonFor(file, stat.size),
    },
  };
}

if (import.meta.main) await runHook('output-cap', decide);
