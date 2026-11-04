#!/usr/bin/env bun
// scripts/hooks/output-replace.mjs
//
// PostToolUse hook for Bash and MCP tools. When one field of a tool result
// (Bash stdout or stderr, or the joined MCP text) is over 4,096 bytes, the full
// text is saved (mode 0600, dirs 0700) to
// <scratchDir>/tool-output/<session_id>/<tool_use_id>.txt and that field
// becomes its first 1,024 bytes, a marker line with the saved path, and its
// last 1,024 bytes. Head plus tail keeps the command echo and the error
// tail, the two parts most often needed; the rest stays one Read away.
//
// Bash results must be replaced with the full {stdout, stderr, interrupted,
// isImage} object (a bare string is ignored by Claude Code 2.1.318). MCP results
// are an array of content blocks; any non-text block (an image, a resource)
// means the result is left alone, because a single text block would drop it.
//
// Fail-open through runHook: a bad id, a failed save, or an unknown shape gives
// no output and the original result passes through.
//
// Revert: remove the hook entry with the context hooks installer (--uninstall),
// then delete this file and output-replace.test.mjs.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runHook } from '../lib/hook-io.mjs';

const TRIGGER = 4096;
const KEEP = 1024;

const isContinuation = (byte) => (byte & 0xc0) === 0x80;

function headOf(buf) {
  let end = Math.min(KEEP, buf.length);
  while (end > 0 && end < buf.length && isContinuation(buf[end])) end -= 1;
  return buf.subarray(0, end);
}

function tailOf(buf) {
  let start = Math.max(0, buf.length - KEEP);
  while (start < buf.length && isContinuation(buf[start])) start += 1;
  return buf.subarray(start);
}

function marker(omitted, total, file) {
  return `\n[... ${omitted} bytes omitted; full output (${total} bytes) saved at ${file}; read it with Read offset and limit ...]\n`;
}

function cut(text, total, file) {
  const buf = Buffer.from(text, 'utf8');
  const head = headOf(buf);
  const tail = tailOf(buf);
  const omitted = buf.length - head.length - tail.length;
  return head.toString('utf8') + marker(omitted, total, file) + tail.toString('utf8');
}

function shrink(text, total, file) {
  return Buffer.byteLength(text, 'utf8') > TRIGGER ? cut(text, total, file) : text;
}

function safeId(id) {
  return (
    typeof id === 'string' &&
    id !== '' &&
    id !== '.' &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('..')
  );
}

// Saved outputs can hold secrets printed by a command, so only the owner reads them.
function save(paths, input, content) {
  const dir = path.join(paths.scratchDir, 'tool-output', input.session_id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${input.tool_use_id}.txt`);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function output(value) {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: value } };
}

function replaceBash(input, paths) {
  const res = input.tool_response;
  if (!res || typeof res !== 'object' || typeof res.stdout !== 'string') return null;
  if (res.isImage === true) return null;
  const stdout = res.stdout;
  const stderr = typeof res.stderr === 'string' ? res.stderr : '';
  const outBytes = Buffer.byteLength(stdout, 'utf8');
  const errBytes = Buffer.byteLength(stderr, 'utf8');
  // Only a field that is itself over the trigger gets cut, so a result with no
  // such field would only grow by the marker line.
  if (outBytes <= TRIGGER && errBytes <= TRIGGER) return null;
  const total = outBytes + errBytes;

  const separator = stdout === '' || stdout.endsWith('\n') ? '' : '\n';
  const full = stderr === '' ? stdout : `${stdout}${separator}--- stderr ---\n${stderr}`;
  const file = save(paths, input, full);

  return output({
    stdout: shrink(stdout, total, file),
    stderr: shrink(stderr, total, file),
    interrupted: res.interrupted,
    isImage: false,
  });
}

function replaceMcp(input, paths) {
  const blocks = input.tool_response;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const allText = blocks.every((b) => b && b.type === 'text' && typeof b.text === 'string');
  if (!allText) return null;
  const text = blocks.map((b) => b.text).join('\n');
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= TRIGGER) return null;
  const file = save(paths, input, text);
  return output([{ type: 'text', text: cut(text, total, file) }]);
}

export function replaceOutput(input, paths) {
  if (!safeId(input.session_id) || !safeId(input.tool_use_id)) return null;
  if (input.tool_name === 'Bash') return replaceBash(input, paths);
  if (typeof input.tool_name === 'string' && input.tool_name.startsWith('mcp__')) return replaceMcp(input, paths);
  return null;
}

if (import.meta.main) runHook('output-replace', replaceOutput);
