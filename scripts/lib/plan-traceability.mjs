// scripts/lib/plan-traceability.mjs
//
// The `require_traceability` check of ultra-plan-runner.mjs validatePlan: every
// acceptance criterion the body defines (`- [ ] AC-1: ...`) has a row in the
// Traceability table naming a task from tasks[] and the check that proves it.
//
// OPT-IN, for the reason `require_impacts` is: of 32 registered plans that use
// AC ids, 28 had an AC that never shares a line with a task id, and many of
// those plans belong to repositories this one does not own. Without the key the
// gaps are one aggregated warning, never an error.

const ENABLE_HINT = 'Set `defaults.require_traceability: true` in this plan to make it an error instead of a warning';
const AC_DEF = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?AC-?(\d+)\s*:/;
const AC_TOKEN = /\bAC-?(\d+)(?:\s*(?:\.\.|-|\u2013|\bto\b)\s*(?:AC-?)?(\d+))?\b/g;
// A range is expanded id by id, so a typo such as AC1-AC999999999 must not be.
const MAX_RANGE = 200;
const FENCE = /^\s*(```|~~~)/;
const TABLE_MARKER = /^\s*(?:(?:[-*+]\s+)?\*\*Traceability:?\*\*|#{1,6}\s.*Traceability)/i;

const acId = (n) => `AC-${Number(n)}`;
const byAcNumber = (a, b) => Number(a.slice(3)) - Number(b.slice(3));

function parseAcCell(text) {
  const ids = new Set();
  const backwards = [];
  const tooLarge = [];
  for (const m of String(text).matchAll(AC_TOKEN)) {
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) { backwards.push(m[0]); continue; }
    if (hi - lo + 1 > MAX_RANGE) { tooLarge.push(m[0]); continue; }
    for (let n = lo; n <= hi; n++) ids.add(acId(n));
  }
  return { ids: [...ids].sort(byAcNumber), backwards, tooLarge };
}

// dup-defs: allow the ci-targeted.mjs copy is private to that CLI and not exported
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idRe = (body) => new RegExp(`(?<![\\w-])${body}(?!\\w)`, 'g');

// Known ids are matched literally, so any id shape works. A GHOST is a token with
// the letter prefix of an existing id (T9 beside T1..T6) that is not in tasks[]:
// UTF-8, SHA256 or P1 in a note are not task references.
function taskRefs(cell, knownIds) {
  const named = knownIds.filter((id) => idRe(escapeRe(id)).test(cell));
  const prefixes = new Set(knownIds.map((id) => id.match(/^([A-Za-z]+-?)\d+[a-z]?$/)?.[1]).filter(Boolean));
  const ghosts = new Set();
  for (const p of prefixes) {
    for (const m of cell.matchAll(idRe(`${escapeRe(p)}\\d+[a-z]?`))) {
      if (!knownIds.includes(m[0])) ghosts.add(m[0]);
    }
  }
  return { named, ghosts: [...ghosts] };
}

export function normaliseAcIds(text) {
  return parseAcCell(text).ids;
}

// Body lines outside code fences, so a plan that quotes the format is not read as using it.
function unfencedLines(body) {
  const out = [];
  let inFence = false;
  for (const line of String(body).split(/\r?\n/)) {
    if (FENCE.test(line)) { inFence = !inFence; out.push(''); continue; }
    out.push(inFence ? '' : line);
  }
  return out;
}

// Splits a table row on `|`, except an escaped `\|` or one inside a backtick span,
// because a Check cell is often a shell pipeline.
function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

function findTable(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!TABLE_MARKER.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*#{1,6}\s/.test(lines[j])) break;
      if (lines[j].trim().startsWith('|') && isSeparator(lines[j + 1] || '')) {
        const rows = [];
        for (let k = j + 2; k < lines.length && lines[k].trim().startsWith('|'); k++) rows.push(splitRow(lines[k]));
        return { header: splitRow(lines[j]).map((h) => h.toLowerCase()), rows };
      }
    }
  }
  return null;
}

function columnOf(header, word, taken) {
  const exact = header.findIndex((h, i) => !taken.includes(i) && h === word);
  return exact !== -1 ? exact : header.findIndex((h, i) => !taken.includes(i) && h.includes(word));
}

export function validateTraceability(plan, body, errors, warnings) {
  const lines = unfencedLines(body);
  const defined = new Set();
  for (const line of lines) {
    const m = line.match(AC_DEF);
    if (m) defined.add(acId(m[1]));
  }
  if (defined.size === 0) return;

  const requireKey = plan.defaults?.require_traceability === true;
  const problems = [];
  const extra = new Set();
  const table = findTable(lines);
  const ac = table ? columnOf(table.header, 'ac', []) : -1;
  const task = table ? columnOf(table.header, 'task', [ac]) : -1;
  const chk = table ? columnOf(table.header, 'check', [ac, task]) : -1;

  if (!table) {
    problems.push('the body has no Traceability table (a Markdown table after a `**Traceability:**` line or a '
      + 'Traceability heading, with AC, Task and Check columns)');
  } else if (ac === -1 || task === -1 || chk === -1) {
    const missing = [['AC', ac], ['Task', task], ['Check', chk]].filter(([, i]) => i === -1).map(([n]) => n);
    problems.push(`the Traceability table has no ${missing.join(', ')} column header; it needs AC, Task and Check columns`);
  } else {
    const knownIds = (plan.tasks || []).map((t) => t.id).filter((id) => typeof id === 'string' && id);
    const listed = new Set();
    for (const row of table.rows) {
      const acCell = row[ac] || '';
      const { ids, backwards, tooLarge } = parseAcCell(acCell);
      for (const b of backwards) problems.push(`Traceability row "${acCell}" has a backwards range ${b}; write the lower id first`);
      for (const r of tooLarge) problems.push(`Traceability row "${acCell}" has a range too large to expand: ${r} spans more than ${MAX_RANGE} ids`);
      if (ids.length === 0) continue;
      for (const id of ids) {
        listed.add(id);
        if (!defined.has(id)) extra.add(id);
      }
      const { named, ghosts } = taskRefs(row[task] || '', knownIds);
      for (const n of ghosts) problems.push(`Traceability row "${acCell}" names unknown task ${n} (GHOST reference: ${n})`);
      if (named.length === 0) {
        problems.push(`Traceability row "${acCell}" names no task from tasks[] in its Task cell: "${row[task] || ''}"`);
      }
      if ((row[chk] || '').replace(/`/g, '').trim() === '') {
        problems.push(`Traceability row "${acCell}" has an empty Check cell; name the command that proves it`);
      }
    }
    const untraced = [...defined].filter((id) => !listed.has(id)).sort(byAcNumber);
    for (const id of untraced) {
      problems.push(`${id} is defined but has no row in the Traceability table; add one naming the task that `
        + 'delivers it and the check that proves it');
    }
  }

  const extraMsg = extra.size
    ? `${extra.size} AC id(s) in the Traceability table are not defined in the body: ${[...extra].sort(byAcNumber).join(', ')}`
    : null;
  if (requireKey) {
    errors.push(...problems);
    if (extraMsg) warnings.push(`${extraMsg}; define each as a \`- [ ] AC-n:\` list item or drop it from the table`);
    return;
  }
  if (extraMsg) problems.push(extraMsg);
  if (problems.length) {
    warnings.push(`${problems.length} traceability gap(s): ${problems.join('; ')}. ${ENABLE_HINT}`);
  }
}
