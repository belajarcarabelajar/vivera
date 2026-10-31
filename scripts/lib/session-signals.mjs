// scripts/lib/session-signals.mjs
//
// Two waste signals from one Claude Code transcript, as counts only: runs of
// identical consecutive tool calls, and cache rebuild turns (GLOSSARY.md). Tool
// inputs are compared as strings in memory and never returned.

import fs from 'node:fs';
import readline from 'node:readline';

const num = (v) => (Number.isFinite(v) ? v : 0);

// Consecutive identity only: the same `git status` spread over a session is normal.
export function repeatedCallRuns(toolUses, min = 3) {
  let runs = 0;
  let calls = 0;
  let prev = null;
  let len = 0;
  const close = () => {
    if (len >= min) {
      runs++;
      calls += len;
    }
  };
  for (const t of toolUses) {
    const key = JSON.stringify([t?.name ?? null, t?.input ?? null]);
    if (key === prev) {
      len++;
      continue;
    }
    close();
    prev = key;
    len = 1;
  }
  close();
  return { runs, calls };
}

// The first turn of a transcript always writes its whole prefix, so it is not a rebuild.
export function cacheRebuildTurns(turns, { ratio = 0.5, minContext = 50000 } = {}) {
  let n = 0;
  turns.forEach((t, i) => {
    if (i === 0) return;
    const u = t?.usage ?? {};
    const writes = num(u.cache_creation_input_tokens);
    const ctx = num(u.input_tokens) + writes + num(u.cache_read_input_tokens);
    if (ctx > minContext && writes > ratio * ctx) n++;
  });
  return n;
}

// Claude Code streams one assistant message over several lines that repeat its
// id and usage, so turns are keyed by message id and tool calls by tool_use id.
export async function readTranscriptSignals(file) {
  const turns = new Map();
  const toolUses = [];
  const seenUses = new Set();
  let anon = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'assistant' || !rec.message) continue;
    const msg = rec.message;
    const id = msg.id ?? `#anon-${anon++}`;
    const turn = turns.get(id) ?? {};
    if (msg.usage) turn.usage = msg.usage;
    turns.set(id, turn);
    for (const item of Array.isArray(msg.content) ? msg.content : []) {
      if (item?.type !== 'tool_use') continue;
      const key = item.id ?? `${id}#${toolUses.length}`;
      if (seenUses.has(key)) continue;
      seenUses.add(key);
      toolUses.push({ name: item.name, input: item.input });
    }
  }
  return { repeatedToolCallRuns: repeatedCallRuns(toolUses), cacheRebuildTurns: cacheRebuildTurns([...turns.values()]) };
}
