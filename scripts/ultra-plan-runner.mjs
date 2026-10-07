#!/usr/bin/env node
// Ultra Plan Runner — zero-dependency orchestrator for `ultra-plan/v1` Markdown plans.
// Parses the YAML frontmatter (the runner contract), validates the task DAG,
// enforces idempotent skips, and aggregates failures into an Error Ledger.
// No MCP, no external packages — runs under Bun only.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The publisher's own freshness verdict, IMPORTED rather than re-derived. Two
// implementations of "is this mirror current?" is how a gate ends up enforcing
// a rule `plan-publish.mjs --check` does not have, and then the two disagree
// about the same file with no way to tell which one is right.
import { planFreshness } from './plan-publish.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHER = path.join(__dirname, 'plan-publish.mjs');

const SCHEMA_ID = 'ultra-plan/v1';

// ---------- The contract, declared once ----------
//
// Every frontmatter key this runner actually reads while routing, executing, or
// halting a plan. Exported so `validate-skill.mjs` can assert that the plan
// template still documents all of them.
//
// Why this list has to be machine-checked: `files`, `idempotency_key`,
// `verify_exit`, and `defaults.on_precondition_fail` were all documented in the
// template and none of them was ever read, while `run[]` — the only key that
// makes the runner execute anything — was documented nowhere and appeared in
// zero plans. The doc and the executor drifted apart with CI green the whole
// time, because nothing compared them. This export is that comparison.
//
// The first four unused keys were then made real: `verify_exit` is the default
// expected exit for a step that declares no `expect_exit`, `files` is checked
// against the working tree before and after the steps run, `idempotency_key`
// is checked against the task's own declared files, and
// `on_precondition_fail` chooses between halting one task and halting the plan.
// A documented key that nothing reads is worse than an undocumented one, so a
// key belongs here only if the runner acts on it.
//
// ONE DIRECTION ONLY, and the asymmetry is measured, not theoretical. Both
// artifacts `check-runner-contract.mjs` inspect already declared `loop_until`
// while the runner did not read it, and the check still printed "both artifacts
// declare all 22 keys the runner reads" and exited 0. It walks `want` (this list)
// and asks whether each entry is present in the artifact, so an artifact-only key
// is never visited. A key landing in the template is therefore not evidence that
// the runner acts on it, and this list alone catches only the other half of the
// drift. What covers the artifact-only half is the contract-key test asserting
// membership AND a plan that exercises the enforcement, never membership alone.
export const RUNNER_CONTRACT_KEYS = [
  'schema', 'plan_id', 'status', 'runner_contract',
  'defaults.retry_transient_max', 'defaults.step_timeout_s', 'defaults.on_precondition_fail',
  'defaults.allow_loose_skip_if', 'defaults.require_impacts', 'defaults.allow_no_impacts',
  'defaults.retry_if',
  'tasks[].id', 'tasks[].depends_on', 'tasks[].skip_if', 'tasks[].run',
  'tasks[].run[].cmd', 'tasks[].run[].expect_exit', 'tasks[].run[].retry',
  'tasks[].run[].loop_until',
  'tasks[].files', 'tasks[].verify_exit', 'tasks[].idempotency_key', 'tasks[].impacts',
];

// A `skip_if` that only proves a string is present in a file is not an
// idempotency proof. It stays true after the string is moved into a comment,
// renamed, or left behind by a reverted edit, and `plan-mark-done.mjs` then
// ticks the task off it.
//
// The discriminator is whether the command actually *runs* something that can
// fail on behaviour. A tool invocation (test runner, build, `git`, `systemctl`)
// qualifies even when a grep filters its output, because the tool has to
// succeed first. A bare file read does not.
const EVIDENCE_COMMAND = /\b(bun|node|npm|pnpm|yarn|deno|python3?|pytest|go|cargo|make|cmake|git|systemctl|curl|docker|tsc|eslint|vitest|jest|ruff|mypy|gradle|mvn)\b/;
const FILE_PROBE = /(^|[\s;&|(/])(grep|egrep|rg|tgrep|cat|head|tail|ls|find|wc|test)\b/;

// Five named classes, in this resolution order:
//
//   empty        blank or not a string — nothing was claimed
//   sentinel     the string "false", the documented "this task has no command"
//   behavioural  runs a tool that has to succeed first
//   loose        reads a file and asserts a string is in it
//   unknown      matches neither rule; the classifier does not know
//
// The order matters and is not interchangeable. `empty` first, so a blank
// `skip_if` is a blank claim rather than a malformed sentinel; `sentinel`
// before the two regexes, so the marker is recognised as a marker and not as
// whatever it happens to match.
//
// **`unknown` is the point of this function, and it used to not exist.**
// This ended in `return FILE_PROBE.test(cmd) ? 'loose' : 'behavioural'`. That
// `: 'behavioural'` filed every unrecognised command under the one class that
// means "this proves the work works", and the verdict was indistinguishable
// from a real test run. Across the registry that was 121 `skip_if` values: 77
// sentinels and 44 commands matching neither rule, of which 14 are genuine
// defects — `bash scripts/x.sh --verify …` fails on behaviour in verify mode
// and writes a file in generate mode, `pacman -Q rtkit` asserts a package is
// installed, and no token-level regex can tell those apart from each other.
// A name the rule cannot justify is reported, not guessed. It is a name and
// not a verdict: nothing in `validatePlan` acts on it yet, so nothing becomes
// unrunnable.
//
// The 44 split in two, and both halves are defects:
//   30 are grep-family probes — `tgrep -q …`, `/usr/bin/grep -q …` — which
//      FILE_PROBE misses only because it anchors on `(^|[\s;&|(])`, so a path
//      separator or a `t` prefix puts the tool name out of reach. They read a
//      file and assert a string is in it, which is the false-pass channel this
//      whole rule exists to close.
//   14 name a tool no rule knows: `bash scripts/x.sh --verify …` (behavioural in
//      verify mode, a bare file write in generate mode), `pacman -Q rtkit`
//      (asserts a package is installed, which no code change can regress),
//      `pwsh -NoProfile -Command Test-Path`, `cf d1 query`, `cmp -s a b`.
//      Adding any of these to EVIDENCE_COMMAND would be guessing, and for
//      `bash` it is measurably wrong: generate mode exits 0 unconditionally.
export function classifySkipIf(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') return 'empty';
  // `"false"` is the documented no-command marker, from the Idempotency Honesty
  // paragraph of `skills/sucp-plan/SKILL.md` (Idempotency Honesty):
  //   "When a task genuinely has no command, say so with `skip_if: "false"`
  //    rather than inventing a probe that passes."
  // 77 tasks across 22 plans in the registry write exactly this. It is its own
  // class and it is NOT redundant with `empty`: empty is a missing claim, this
  // is a deliberate one, and collapsing the two would erase the difference. It
  // was not redundant with the old `behavioural` fallthrough either — it merely
  // produced the same answer by matching no regex, which is why a future edit
  // to that fallthrough would have invalidated 77 tasks with nothing to notice.
  if (cmd.trim() === 'false') return 'sentinel';
  if (EVIDENCE_COMMAND.test(cmd)) return 'behavioural';
  if (FILE_PROBE.test(cmd)) return 'loose';
  return 'unknown';
}

// ---------- Frontmatter extraction ----------

export function extractFrontmatter(md) {
  if (!md.startsWith('---')) {
    throw new Error('Missing YAML frontmatter: plan must start with a `---` fence.');
  }
  const rest = md.slice(3);
  const end = rest.search(/\r?\n---\s*(\r?\n|$)/);
  if (end === -1) {
    throw new Error('Unterminated frontmatter: no closing `---` fence found.');
  }
  const frontmatter = rest.slice(0, end).replace(/^\r?\n/, '');
  const afterIdx = rest.indexOf('\n', end + 1);
  const body = afterIdx === -1 ? '' : rest.slice(rest.indexOf('---', end) + 3).replace(/^\r?\n/, '');
  return { frontmatter, body };
}

// ---------- Minimal YAML-subset parser (ultra-plan/v1 only) ----------

function stripComment(line) {
  let inS = false, inD = false, depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD && (c === '[' || c === '{')) depth++;
    else if (!inS && !inD && (c === ']' || c === '}')) depth--;
    else if (c === '#' && !inS && !inD && depth === 0 && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

// YAML double-quoted scalars process backslash escapes; single-quoted ones do
// not. The plan template puts shell commands in double quotes, and a command is
// exactly where a backslash appears — a regex in a `grep`, an escaped quote, a
// literal `\d`. Stripping the quotes without expanding the escapes hands the
// shell a different command than the plan author wrote, and it fails silently:
// the step runs, exits non-zero, and the ledger says "exit mismatch" with
// nothing pointing at the parsing.
//
// Only the escapes that change the string are expanded. An unrecognised escape
// is left alone, backslash included, because in a `cmd` field `\d` is far more
// likely to be a regex than a typo, and mangling it would be worse than
// tolerating it. That is deliberately more lenient than the YAML spec, which
// rejects the sequence outright.
const YAML_ESCAPES = { '\\': '\\', '"': '"', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0', a: '\x07', v: '\v', e: '\x1b' };

function unescapeDoubleQuoted(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (Object.hasOwn(YAML_ESCAPES, next)) { out += YAML_ESCAPES[next]; i++; continue; }
      if (/[0-9a-fA-F]/.test(next)) { out += s[i] + next; i++; continue; } // \xNN, \uNNNN: leave alone
    }
    out += s[i];
  }
  return out;
}

function coerceScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s.startsWith('"') && s.endsWith('"')) {
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

// Split a flow collection body by top-level commas, honoring nesting and quotes.
function splitFlow(body) {
  const out = [];
  let buf = '', inS = false, inD = false, depth = 0;
  for (const c of body) {
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    if (!inS && !inD && (c === '[' || c === '{')) depth++;
    if (!inS && !inD && (c === ']' || c === '}')) depth--;
    if (c === ',' && !inS && !inD && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim() !== '') out.push(buf);
  return out;
}

function parseValue(raw) {
  const s = raw.trim();
  if (s.startsWith('[')) {
    const inner = s.slice(1, s.lastIndexOf(']'));
    return inner.trim() === '' ? [] : splitFlow(inner).map((v) => parseValue(v));
  }
  if (s.startsWith('{')) {
    const inner = s.slice(1, s.lastIndexOf('}'));
    const obj = {};
    if (inner.trim() !== '') {
      for (const pair of splitFlow(inner)) {
        const ci = pair.indexOf(':');
        const k = pair.slice(0, ci).trim();
        obj[k] = parseValue(pair.slice(ci + 1));
      }
    }
    return obj;
  }
  return coerceScalar(s);
}

const indentOf = (l) => l.length - l.replace(/^\s+/, '').length;

// ---------- Block sequence under a task key ----------
//
// Why this exists: `run: [ {cmd: ...} ]` parses, but the block style
//
//     run:
//       - cmd: "bun test x"
//         expect_exit: 0
//
// does NOT: the task loop saw the `- cmd` line and started a *new task* from
// it, so the plan validated as `tasks=5` with three tasks named "undefined"
// instead of two real ones. That made block-style steps — the style every
// other key in the template already uses — silently unrepresentable, which is
// the whole reason the execute path was never reachable from the template.
//
// Consumes `- item` lines at a deeper indent than `parentIndent`, plus their
// own continuation keys. Returns [array, nextIndex] so the caller resumes at
// the parent's own key level.
function parseBlockSeq(lines, start, parentIndent) {
  const out = [];
  let itemIndent = null;
  let cur = null;
  let i = start;
  while (i < lines.length) {
    const ind = indentOf(lines[i]);
    if (ind <= parentIndent) break;
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('- ')) {
      if (itemIndent === null) itemIndent = ind;
      if (ind !== itemIndent) break; // dedented out of the sequence
      if (cur) out.push(cur);
      cur = {};
      const item = trimmed.slice(2);
      const ci = item.indexOf(':');
      if (ci === -1) { i++; continue; }
      const inline = item.slice(ci + 1);
      cur[item.slice(0, ci).trim()] = inline.trim() === '' ? '' : parseValue(inline);
      i++;
      continue;
    }
    if (itemIndent === null) break;      // no sequence here
    if (ind <= itemIndent) break;        // back to the parent key level
    if (cur) {
      const kci = trimmed.indexOf(':');
      if (kci !== -1) cur[trimmed.slice(0, kci).trim()] = parseValue(trimmed.slice(kci + 1));
    }
    i++;
  }
  if (cur) out.push(cur);
  return [out, i];
}

export function parseUltraPlanYaml(yamlStr) {
  const lines = yamlStr.split(/\r?\n/).map(stripComment).filter((l) => l.trim() !== '');
  const plan = { defaults: {}, tasks: [] };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (indentOf(line) !== 0) { i++; continue; }
    const ci = line.indexOf(':');
    const key = line.slice(0, ci).trim();
    const inline = line.slice(ci + 1).trim();

    if (key === 'defaults') {
      i++;
      while (i < lines.length && indentOf(lines[i]) >= 2 && !lines[i].trimStart().startsWith('-')) {
        const dl = lines[i];
        const dci = dl.indexOf(':');
        plan.defaults[dl.slice(0, dci).trim()] = parseValue(dl.slice(dci + 1));
        i++;
      }
      continue;
    }
    if (key === 'tasks') {
      i++;
      let cur = null;
      while (i < lines.length && indentOf(lines[i]) >= 2) {
        const tl = lines[i];
        const trimmed = tl.trimStart();
        if (trimmed.startsWith('- ')) {
          if (cur) plan.tasks.push(cur);
          cur = {};
          const item = trimmed.slice(2);
          const ici = item.indexOf(':');
          cur[item.slice(0, ici).trim()] = parseValue(item.slice(ici + 1));
          i++;
          continue;
        }
        if (cur) {
          const kci = trimmed.indexOf(':');
          const k = trimmed.slice(0, kci).trim();
          const inline = trimmed.slice(kci + 1);
          // An empty inline value followed by a deeper `- ` block is a nested
          // sequence of maps (today: `run:`), not a new task. Without this the
          // block form of `run:` was parsed as extra tasks and the plan failed
          // validation with phantom "undefined" task ids.
          if (inline.trim() === '') {
            const next = lines[i + 1];
            if (next !== undefined && indentOf(next) > indentOf(tl) && next.trimStart().startsWith('- ')) {
              const [arr, ni] = parseBlockSeq(lines, i + 1, indentOf(tl));
              cur[k] = arr;
              i = ni;
              continue;
            }
          }
          cur[k] = parseValue(inline);
        }
        i++;
      }
      if (cur) plan.tasks.push(cur);
      continue;
    }
    plan[key] = parseValue(inline);
    i++;
  }
  for (const t of plan.tasks) if (!Array.isArray(t.depends_on)) t.depends_on = t.depends_on ? [t.depends_on] : [];
  return plan;
}

// ---------- Graph operations ----------

export function topoSort(tasks) {
  const ids = tasks.map((t) => t.id);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const adj = new Map(ids.map((id) => [id, []]));
  for (const t of tasks) {
    for (const dep of t.depends_on || []) {
      if (!adj.has(dep)) continue;
      adj.get(dep).push(t.id);
      indeg.set(t.id, indeg.get(t.id) + 1);
    }
  }
  const queue = ids.filter((id) => indeg.get(id) === 0).sort();
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) { queue.push(m); queue.sort(); }
    }
  }
  if (order.length !== ids.length) {
    const stuck = ids.filter((id) => !order.includes(id));
    throw new Error(`Dependency cycle detected among: ${stuck.join(', ')}`);
  }
  return order;
}

export function descendants(id, tasks) {
  const children = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const dep of t.depends_on || []) if (children.has(dep)) children.get(dep).push(t.id);
  const out = new Set();
  const stack = [...(children.get(id) || [])];
  while (stack.length) {
    const n = stack.pop();
    if (out.has(n)) continue;
    out.add(n);
    for (const c of children.get(n) || []) stack.push(c);
  }
  return out;
}

// ---------- Mermaid map parsing ----------
// The Visual Implementation Map is a machine-checked contract, not prose:
// frontmatter `depends_on` == Mermaid edges == task headings. To enforce that,
// the map is parsed structurally instead of grepped for ids in raw text, so a
// task id mentioned inside an unrelated label can never satisfy the check.

// Only flowchart/graph diagrams can express the task DAG. A sequenceDiagram or
// stateDiagram-v2 in the same plan is legitimate supporting context, and its
// arrows are not dependency edges, so it is excluded from the contract check.
const FLOW_TYPES = /^(flowchart|graph)\b/i;

const ARROW_SPLIT = /(<-->|<--|-->|-\.->|---|==>|~~~|--x|--o)/;
const IDENT = /[A-Za-z][\w-]*/g;
const NODE_DECL = /([A-Za-z][\w-]*)\s*[[({]{1,2}([^\])}]*)\]/;

function lastIdent(text) {
  const m = [...text.matchAll(IDENT)];
  return m.length ? m[m.length - 1][0] : null;
}

function firstIdent(text) {
  const m = text.match(IDENT);
  return m ? m[0] : null;
}

// Returns { nodes: Set<string>, edges: Array<[from, to]> } for one diagram source.
export function parseMermaidMap(source) {
  const nodes = new Set();
  const edges = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%')) continue;

    // Mask quoted label text first so brackets, arrows, and prose inside a
    // label can never be mistaken for graph structure.
    const literals = [];
    let skeleton = line.replace(/"[^"]*"/g, (m) => `\u0000${literals.push(m) - 1}\u0000`);

    // Node declarations: record the id, drop the shape and its label.
    skeleton = skeleton.replace(NODE_DECL, (_m, id) => {
      nodes.add(id);
      return ` ${id} `;
    });

    // Edge labels such as `-->|"depends"|` are not endpoints.
    skeleton = skeleton.replace(/\|[^|]*\|/g, ' ');

    const parts = skeleton.split(ARROW_SPLIT);
    for (let i = 1; i < parts.length; i += 2) {
      const from = lastIdent(parts[i - 1]);
      const to = firstIdent(parts[i + 1]);
      if (!from || !to || from === to) continue;
      nodes.add(from);
      nodes.add(to);
      edges.push([from, to]);
    }
  }
  return { nodes, edges };
}

// Parses every ```mermaid block in a plan body and unions the result.
// `blockCount` counts all diagrams; `nodes`/`edges` come only from flowchart
// and graph diagrams, which are the only ones that can carry the task DAG.
export function parseMermaidMaps(body) {
  const blocks = body.match(/```mermaid[^\n]*\n[\s\S]*?```/g) || [];
  const nodes = new Set();
  const edges = [];
  let flowBlockCount = 0;
  for (const block of blocks) {
    const source = block.replace(/^```mermaid[^\n]*\n/, '').replace(/```\s*$/, '');
    const typeLine = source.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%'));
    if (!typeLine || !FLOW_TYPES.test(typeLine)) continue;
    flowBlockCount++;
    const parsed = parseMermaidMap(source);
    for (const n of parsed.nodes) nodes.add(n);
    edges.push(...parsed.edges);
  }
  return { nodes, edges, blockCount: blocks.length, flowBlockCount };
}

// ---------- Affected surfaces, declared once ----------
//
// WHY THIS EXISTS, in the shape of the defect it closes.
//
// A plan task declares `files: { create, modify, test }` — the paths it TOUCHES.
// Nothing in the contract ever asked what it BREAKS. So a task that changes a
// shared interface, a public export shape, a CLI flag, or a documented rule
// could declare only its own file, pass every gate, and leave every consumer of
// that interface untouched. The DAG did not help: `depends_on` orders tasks
// INSIDE one plan, so a consumer living in another module — or in another
// repository, or in the README that documents the flag — is not a node and
// cannot be an edge.
//
// The rules that were supposed to cover this gap were all prose: "inspect all
// callers", "fixed at the shared root cause so sibling callers are not left
// broken", the debt sweep's "sibling callers the fix touched only partially".
// Prose fails silently. There was no command that exited non-zero when an agent
// forgot, which means there was no gate — only a hope.
//
// The design is the same one `skip_if` already taught this codebase: a claim
// that cannot fail is a false pass, so the claim has to carry its own evidence.
//
//   impacts: ["<surface> - <the command or graph query that shows the impact>",
//             "none: <the command that checked and found nothing downstream>"]
//
// The `"none: <command>"` sentinel exists for the same reason `skip_if: "false"`
// does. "This task has no affected surface" is a real answer, and it is exactly
// as easy to fabricate as a check that was never run. Requiring the command that
// checked makes the claim falsifiable instead of decorative.
//
// FLOW STYLE ONLY. `impacts: ["a", "b"]` parses. The block style does not:
// `parseBlockSeq` cannot tell a bare scalar `- "text"` from a step map
// `- cmd: "text"`, so it builds an object either way — empty when the entry
// holds no `:`, a one-key map when it does — and the list arrives as objects
// where strings were written. That is a parser fact, not a preference, so a
// non-string entry is reported as exactly that instead of being ignored.
//
// GRANDFATHERING, twice over, because a check added to the runner is a check
// every existing plan must survive and several of those plans belong to
// repositories this one does not own.
//
//   defaults.require_impacts: true  the gate is ON for plans that opt in. The
//                                    plan template sets it, so every plan written
//                                    from the template is enforced. Off means
//                                    one aggregated warning, never an error —
//                                    the same reasoning that made an
//                                    unclassifiable `skip_if` a warning rather
//                                    than a verdict this repository cannot own.
//   defaults.allow_no_impacts: []   per-task opt-out, with the anti-decay rule
//                                    `allow_loose_skip_if` uses: naming a task
//                                    that DOES declare impacts is an error, and
//                                    naming a task that does not exist is an
//                                    error, so the list cannot decay into a
//                                    permanent blanket.

// Returns 'ok' | 'missing' | 'invalid'. Pushes its own errors; the caller decides
// what a `missing` claim is worth.
function impactsShape(t, errors) {
  const v = t.impacts;
  if (v === undefined) return 'missing';
  if (!Array.isArray(v)) {
    errors.push(`task ${t.id} impacts must be a list of strings, got ${typeof v}: ${JSON.stringify(v)}. `
      + 'Write it flow-style: impacts: ["<surface> - <evidence command>", ...]');
    return 'invalid';
  }
  if (v.length === 0) {
    errors.push(`task ${t.id} impacts is an empty list, which claims nothing and proves nothing. `
      + 'Name the surfaces this task can break, or record the check that found none as '
      + '"none: <command>"');
    return 'invalid';
  }
  for (const e of v) {
    if (typeof e !== 'string' || e.trim() === '') {
      errors.push(`task ${t.id} impacts has a non-string or blank entry: ${JSON.stringify(e)}. `
        + 'The block form `- "text"` parses as an object here, not a scalar, so this list is flow-style only: '
        + 'impacts: ["<surface> - <evidence command>", ...]');
      return 'invalid';
    }
    const noneAt = e.indexOf('none:');
    if (noneAt !== -1 && e.slice(noneAt + 'none:'.length).trim() === '') {
      errors.push(`task ${t.id} impacts uses the "none:" sentinel with no command: "${e}". `
        + 'The sentinel means "a check ran and found no downstream", so it names that check');
      return 'invalid';
    }
  }
  return 'ok';
}

// ---------- What proves an iteration finished ----------
//
// WHY THIS IS A SEPARATE KEY, and not a wider `retry`.
//
// `retry`, `defaults.retry_transient_max`, and `defaults.retry_if` all answer one
// question: how many times may this step re-RUN. None of them answers the
// question an iterative step actually has, which is what proves an ITERATION is
// finished. "Loop until nothing new is found" writes that condition as prose, and
// prose cannot fail, so the runner cannot tell converged from still-going and a
// later round re-pays to rediscover work an earlier round already rejected.
//
//   loop_until: "<command>"   # exit 0 = converged
//
// Absence is legal and means the step does not iterate, so no existing plan
// changes. This is why there is no `require_loop_until` counterpart to
// `require_impacts`: a gate every plan must survive is a gate every plan written
// before the key has to be edited to mean anything, and the plans in this
// repository's registry largely belong to repositories this one does not own.
//
// THE TEXT-PROBE BAN, inherited whole from `classifySkipIf`. `grep -q 'Done'
// src/x.ts` stays true after the behaviour it names is reverted, so it reports
// convergence that never happened, and an unconverged step that reports converged
// is the same false pass `skip_if` is banned for. The two keys share the
// classifier on purpose: they cannot disagree about the same command.
//
// Unlike `skip_if` there is no sentinel, because "this step does not iterate" is
// already said by omitting the key, and a sentinel for it would be a second
// spelling of absence. So `loop_until: "false"` is not a valid no-op: it is a
// shell command, it exits 1, and the step can never converge.
function loopUntilShape(step, taskId, index, errors, warnings) {
  if (step.loop_until === undefined) return null; // absence stays legal
  const v = step.loop_until;
  if (typeof v !== 'string' || v.trim() === '') {
    errors.push(`task ${taskId} run[${index}] loop_until is ${JSON.stringify(v)}, which is not a command. `
      + 'A convergence condition the runner cannot execute is worse than none at all: '
      + 'write the command that exits 0 once the iteration is finished, or omit the key');
    return null;
  }
  const cls = classifySkipIf(v);
  if (cls === 'loose') {
    errors.push(`task ${taskId} run[${index}] loop_until is a file-content probe: "${v}". `
      + 'It proves a string is present, not that the iteration converged: it survives the behaviour '
      + 'being reverted, so it reports convergence that did not happen. Use a command that has to succeed.');
    return null;
  }
  if (cls === 'sentinel') {
    errors.push(`task ${taskId} run[${index}] loop_until is "${v}", the no-command sentinel. `
      + 'It has no sentinel meaning here: omitting the key is how a step says it does not iterate. '
      + `"${v}" is a shell command, it exits non-zero, and the step can never converge.`);
    return null;
  }
  if (cls === 'unknown') {
    // Warned, not refused, for exactly the reason `skip_if` warns here: the
    // classifier cannot tell whether the command fails on behaviour, and a plan
    // in a repository this one does not own must not become unrunnable because a
    // token-level regex could not adjudicate its command. Reported with the
    // remediation, so the row is actionable.
    warnings.push(`task ${taskId} run[${index}] loop_until matches neither the evidence rule nor the `
      + `file-probe rule, so the runner cannot tell whether it fails on behaviour: "${v}". `
      + 'Name the tool in a form the rule recognises, or write the command that decides convergence.');
    return null;
  }
  return v;
}

function validateImpacts(plan, errors, warnings) {
  const requireImpacts = plan.defaults?.require_impacts === true;
  const exempted = new Set(plan.defaults?.allow_no_impacts || []);
  const used = new Set();
  const undeclared = [];

  for (const t of plan.tasks || []) {
    if (!t.id) continue;
    const state = impactsShape(t, errors);
    if (state === 'invalid') continue;
    if (state === 'ok') {
      // An exemption for a task that now carries its own impacts is dead weight
      // that hides the next regression, so it is refused rather than ignored.
      if (exempted.has(t.id)) {
        errors.push(`defaults.allow_no_impacts names "${t.id}", but task ${t.id} declares its own `
          + 'impacts; remove the exemption so the claim stays checked');
      }
      continue;
    }
    if (exempted.has(t.id)) { used.add(t.id); continue; }
    if (requireImpacts) {
      errors.push(`task ${t.id} declares no impacts: name the surfaces this task can break, or record `
        + 'the check that found none as "none: <command>". Focus that makes this task green while a '
        + 'consumer of the same interface stays broken is the defect this key exists to catch');
      continue;
    }
    undeclared.push(t.id);
  }

  if (undeclared.length) {
    warnings.push(`${undeclared.length} task(s) declare no impacts: ${undeclared.join(', ')}. `
      + 'Set `defaults.require_impacts: true` in this plan to make it an error instead of a warning');
  }
  for (const id of exempted) {
    if (!used.has(id)) {
      errors.push(`defaults.allow_no_impacts names "${id}", but task ${id} either does not exist or `
        + 'already declares impacts');
    }
  }
}

// ---------- Validation ----------

export function validatePlan(plan, body) {
  const errors = [];
  const warnings = [];
  if (plan.schema !== SCHEMA_ID) errors.push(`schema must be "${SCHEMA_ID}" (got "${plan.schema}")`);
  if (plan.runner_contract !== true) warnings.push('runner_contract is not true; plan may not be runner-managed.');

  const seen = new Set();
  for (const t of plan.tasks || []) {
    if (!t.id) { errors.push('task with no id'); continue; }
    if (seen.has(t.id)) errors.push(`duplicate task id: ${t.id}`);
    seen.add(t.id);
  }
  for (const t of plan.tasks || []) {
    for (const dep of t.depends_on || []) {
      if (!seen.has(dep)) errors.push(`task ${t.id} depends on unknown task ${dep} (GHOST reference: ${dep})`);
    }
  }
  try { topoSort(plan.tasks || []); } catch (e) { errors.push(e.message); }

  // Execution-hook contract. A task is machine-runnable only when it declares
  // `run[]`. A task with no `run[]` is handed to the agent as prose, which is
  // legitimate for work with no shell command (writing prose, choosing a
  // layout) but must at least be declared, or it is invisible to the runner and
  // silently exempt from every gate below.
  const looseAllowed = new Set(plan.defaults?.allow_loose_skip_if || []);
  const usedExemptions = new Set();
  for (const t of plan.tasks || []) {
    if (!t.id) continue;
    const keyMismatch = idempotencyMismatch(t);
    if (keyMismatch) {
      errors.push(`task ${t.id} idempotency_key ${keyMismatch}`);
    }
    const hasRun = Array.isArray(t.run) && t.run.length > 0;
    if (hasRun) {
      t.run.forEach((step, i) => {
        if (!step || typeof step.cmd !== 'string' || step.cmd.trim() === '') {
          errors.push(`task ${t.id} run[${i}] has no cmd; every step is one runnable command`);
          return;
        }
        // Shape-checked here so a blank or non-executable convergence condition is
        // a validation error naming the task and step, not a runtime surprise
        // discovered once the step's own work is already done.
        loopUntilShape(step, t.id, i, errors, warnings);
      });
      continue;
    }
    if (!t.skip_if) {
      errors.push(`task ${t.id} has no execution hook: declare run[] (steps the runner executes) `
        + 'or skip_if (idempotency proof for work the agent does inline). '
        + 'A task with neither is invisible to the runner.');
    } else {
      warnings.push(`task ${t.id} declares skip_if but no run[]: the runner reports NEEDS-AGENT `
        + 'and the agent executes the prose steps itself.');
    }
    if (t.skip_if) {
      const cls = classifySkipIf(t.skip_if);
      if (cls === 'loose') {
        // A text probe is a false-pass channel, not a warning: plan-mark-done
        // ticks the task on this claim alone. Existing plans are grandfathered by
        // naming the task in defaults.allow_loose_skip_if, and a name that is no
        // longer needed is an error too, so the allowlist cannot quietly become a
        // permanent blanket.
        //
        // The message is verbatim as it has always read. It is load-bearing for
        // anyone who has seen it, and a test pins it character for character, so
        // rewording it is a deliberate act rather than a side effect of adding a
        // branch next door.
        if (looseAllowed.has(t.id)) {
          usedExemptions.add(t.id);
        } else {
          errors.push(`task ${t.id} skip_if is a file-content probe: "${t.skip_if}". It proves a string is `
            + 'present, not that the behaviour works — it survives the string moving into a comment. '
            + 'Use a command that fails on behaviour, or add this task id to defaults.allow_loose_skip_if '
            + 'to grandfather an existing plan.');
        }
      } else if (cls === 'unknown') {
        // The command matches neither rule, so the runner cannot tell whether it
        // fails on behaviour. That is a different defect from `loose` and it gets
        // a different severity, for a reason measured rather than assumed:
        // 14 tasks in 7 plans carry an unclassifiable `skip_if`, and four of those
        // plans live in `ram-audit`, `PS2` and `fasttrack` — repositories this one
        // does not own. Erroring here would be one commit in this repository
        // deciding that someone else's plan cannot run.
        //
        // So: warn, per row, with the remediation. The debt becomes visible and
        // individually actionable; promoting this to an error is a follow-up that
        // lands after the 14 rows are repaired at source. `bun
        // scripts/skipif-registry-audit.mjs` re-derives the list on demand.
        //
        // Both remedies are named because both are correct answers to different
        // rows: some commands should name a tool the rule recognises, and some
        // genuinely have no exit status worth asserting — `pacman -Q rtkit`
        // asserts a package is installed, which no code change can regress — and
        // for those the documented answer is the `skip_if: "false"` sentinel.
        warnings.push(`task ${t.id} skip_if matches neither the evidence rule nor the file-probe rule, `
          + `so the runner cannot tell whether it fails on behaviour: "${t.skip_if}". `
          + 'Name the tool in a form the rule recognises, or, if the command genuinely has no exit status '
          + 'worth asserting, use skip_if: "false".');
      }
      // `empty`, `sentinel` and `behavioural` need nothing said about them. A
      // sentinel in particular is a deliberate no-command marker and must not be
      // confused with a command nobody could classify.
    }
  }
  for (const id of looseAllowed) {
    if (!usedExemptions.has(id)) {
      errors.push(`defaults.allow_loose_skip_if names "${id}", but task ${id} either does not exist or no longer needs an exemption`);
    }
  }

  validateImpacts(plan, errors, warnings);

  if (body) {
    const { nodes, edges, blockCount, flowBlockCount } = parseMermaidMaps(body);
    if (blockCount === 0) {
      errors.push('plan body must contain at least one ```mermaid diagram (Visual Implementation Map is mandatory)');
    } else if (flowBlockCount === 0) {
      errors.push('plan body must contain a flowchart or graph Visual Implementation Map with a node per task; '
        + 'a sequenceDiagram or stateDiagram alone cannot express the task DAG');
    } else {
      const edgeSet = new Set(edges.map(([a, b]) => `${a}\u0000${b}`));
      const depsOf = new Map((plan.tasks || []).map((t) => [t.id, t.depends_on || []]));

      for (const t of plan.tasks || []) {
        const headingRe = new RegExp(`Task\\s+${t.id}\\b`);
        if (!headingRe.test(body)) errors.push(`task ${t.id} has no matching "Task ${t.id}" heading in body`);
        if (!nodes.has(t.id)) errors.push(`task ${t.id} has no matching node in the mermaid map`);
      }

      // Flow direction: `A --> B` means B depends on A.
      for (const t of plan.tasks || []) {
        for (const dep of t.depends_on || []) {
          if (!seen.has(dep)) continue;
          if (!edgeSet.has(`${dep}\u0000${t.id}`)) {
            errors.push(`task ${t.id} depends_on ${dep} but the mermaid map has no edge ${dep} --> ${t.id}`);
          }
        }
      }

      for (const [from, to] of edges) {
        if (!seen.has(from) || !seen.has(to)) continue; // entry, gate, or exit node
        if (!(depsOf.get(to) || []).includes(from)) {
          errors.push(`mermaid map has edge ${from} --> ${to} but ${to}.depends_on does not declare ${from}`);
        }
      }
    }
  }
  return { errors, warnings };
}

// ---------- Declared files as a checked claim ----------
//
// A plan that names its files is making a falsifiable claim: "this task touches
// these paths and nothing else." Checking it is cheap and catches two real
// defects. A path in `modify`/`test` that does not exist means the plan is
// describing a codebase that is not there, and a path in `create` that still
// does not exist after the steps ran means the task did not do what it said.
//
// `create` is deliberately NOT required to be absent beforehand. A task whose
// file already exists is usually one being re-run, and failing it for that
// would make idempotency impossible. What matters is the end state.
function filePrecondition(t, dir) {
  const files = t.files;
  if (!files || typeof files !== 'object') return null;
  const missing = [];
  for (const group of ['modify', 'test']) {
    for (const f of files[group] || []) {
      if (typeof f !== 'string' || f === '') continue;
      if (!existsSync(path.resolve(dir, f))) missing.push(`${group}: ${f}`);
    }
  }
  return missing.length ? missing : null;
}

function filePostcondition(t, dir) {
  const files = t.files;
  if (!files || typeof files !== 'object') return null;
  const missing = [];
  for (const f of files.create || []) {
    if (typeof f !== 'string' || f === '') continue;
    if (!existsSync(path.resolve(dir, f))) missing.push(`create: ${f}`);
  }
  return missing.length ? missing : null;
}

// `idempotency_key` is written as "<task id>:<something>". Checking it against
// `files` was the obvious idea and it is wrong.
//
// The key names the task's UNIT OF WORK, and that is a behaviour, not a path:
// `T3:two-stage-trigger`, `T5:lifecycle-audit`, `T18:bulk-publish-267`. A
// behaviour has no filename. Every real key in this repository is a
// description like that, and requiring the right-hand side to be a declared
// path rejected all of them.
//
// What is still checkable, and is the part that catches a stale or copied key,
// is the left-hand side: the key must name the task it belongs to. A key
// reading `T2:...` inside task T3 is a copy-paste or a plan edited in the wrong
// place, and that is a real defect worth refusing. The right-hand side stays
// free-form, which is also why it cannot drift out of sync with the file list.
function idempotencyMismatch(t) {
  if (typeof t.idempotency_key !== 'string' || t.idempotency_key === '') return null;
  const colon = t.idempotency_key.indexOf(':');
  if (colon === -1) return `is not "<task id>:<unit of work>"`;
  const keyId = t.idempotency_key.slice(0, colon);
  if (keyId !== t.id) return `names task "${keyId}" but belongs to task "${t.id}"`;
  return null;
}

// ---------- Execution ----------

// A step that overruns `step_timeout_s` must take its CHILDREN with it.
//
// Measured, not assumed. `spawnSync(..., { shell: true, timeout })` signals only
// the shell it spawned: on `sh -c "sleep 47 & wait"` with a 2s timeout it
// returned ETIMEDOUT/SIGTERM and the backgrounded `sleep 47` was still running
// afterwards. A plan step is written as a command chain (`&&`), and commands in
// this repository spawn builds, test runners, and browsers, so a timed-out step
// used to leave exactly the dangling worker the master skill's own Stalled
// Subagent & Stale-Writer Guardrail warns about — aimed at the agent, and never
// at the runner executing on its behalf.
//
// `detached: true` puts the child in its OWN process group, so one signal to the
// negated pid reaches every descendant. SIGTERM first (the polite signal, so a
// build gets to clean up its own temp files), then SIGKILL for whatever is left
// after a short grace period.
const GROUP_KILL_GRACE_MS = 500;

function reapGroup(pid, { log } = {}) {
  if (!pid) return false;
  let killed = false;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pid, signal);
      killed = true;
    } catch (e) {
      // ESRCH means the group is already gone, which is the success case here.
      // EPERM means it exists and is not ours, and retrying SIGKILL would not
      // change that, so both stop the sweep rather than throwing: a cleanup path
      // that throws would mask the timeout the caller is trying to report.
      break;
    }
    if (signal === 'SIGTERM') {
      // Synchronous by design. There is no event loop to come back to inside
      // spawnSync's caller, so the grace period is a blocking wait, and it is
      // bounded and short by design.
      spawnSync('sleep', [`${GROUP_KILL_GRACE_MS / 1000}`]);
    }
  }
  if (killed) log?.(`      (reaped the timed-out step's process group ${pid})`);
  return killed;
}

function run(cmd, timeoutMs, { log } = {}) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: timeoutMs, detached: true });
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  const reaped = timedOut ? reapGroup(r.pid, { log }) : false;
  return {
    exit: timedOut ? 124 : (r.status ?? 1),
    timedOut,
    reaped,
    stderr: r.stderr || '',
    stdout: r.stdout || '',
  };
}

// ---------- Failure classification ----------
//
// WHY THIS EXISTS.
//
// Every step failure used to be recorded as `code`, so the Error Ledger could not
// distinguish "the change is wrong" from "the command does not exist on this
// machine". The master skill carries a six-class taxonomy in prose and in the
// plan template's §6 — code, test, contract, environment, infrastructure,
// pre-existing — and the runner emitted two of them: `code` for everything the
// command produced, and `contract` for its own precondition failures. A missing
// binary and a failing assertion were the same row.
//
// The rule here is that only what the exit code PROVES is classified. That is the
// same discipline `classifySkipIf` already applies, and it has the same limit:
// a flaky test and a deterministic failure both exit 1, and nothing in an exit
// code tells them apart. So `transient` is `true` only where the evidence forces
// it (a timeout), and `unknown` elsewhere — reported, never guessed. A name the
// rule cannot justify stays `unknown`.
//
//   124 / ETIMEDOUT  timeout      the step outlived its budget
//   127              environment  the command does not exist (POSIX sh)
//   126              environment  the command exists and is not executable
//   130              interrupted  SIGINT reached the step
//   143              terminated   SIGTERM reached the step
//   other            code         the command ran and disagreed with expect_exit
//
// `transient` answers a different question from `klass`: not "what broke" but
// "is re-running it worth anything". It is `false` only where the evidence makes a
// retry provably pointless, so a flaky test still retries exactly as it did
// before this existed, and a typo'd command fails once instead of twice.
const EXIT_CLASSES = {
  124: { klass: 'timeout', transient: true, basis: 'exit 124 (timeout)' },
  126: { klass: 'environment', transient: false, basis: 'exit 126 (found but not executable)' },
  127: { klass: 'environment', transient: false, basis: 'exit 127 (command not found)' },
  130: { klass: 'interrupted', transient: false, basis: 'exit 130 (SIGINT)' },
  143: { klass: 'terminated', transient: false, basis: 'exit 143 (SIGTERM)' },
};

// `defaults.retry_if` decides whether a step's `retry` budget is spent on a
// failure the classification calls DETERMINISTIC.
//
// WHY THIS IS OPT-IN, and why the default is the older behaviour.
//
// The runner already skips a retry when the exit code proves one cannot help
// (`transient === false`: 127, 126, 130, 143). That was a safe improvement
// because it only ever removed attempts that were provably wasted. Making the
// STRICT policy the default is a different kind of change: `transient:
// 'unknown'` covers the ordinary exit 1, which is both a deterministic assertion
// failure and a flaky test. Defaulting to "do not retry unknown" would stop
// retrying flaky tests for every plan in the registry, including plans belonging
// to repositories this one does not own. So the strict policy is opt-in, and a
// plan asks for it by name.
//
// The value is validated rather than defaulted silently, for the same reason
// `on_precondition_fail` throws on an unrecognised value: a typo must not
// quietly grant the weaker semantics.
const RETRY_IF_VALUES = ['any', 'transient'];

export function validateRetryIf(value) {
  if (value === undefined) return 'any';
  if (!RETRY_IF_VALUES.includes(value)) {
    throw new Error(`defaults.retry_if must be one of ${RETRY_IF_VALUES.map((v) => `"${v}"`).join(' or ')}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function classifyFailure({ exit, timedOut = false }) {
  if (timedOut) return { klass: 'timeout', transient: true, basis: 'ETIMEDOUT from spawnSync' };
  const known = EXIT_CLASSES[exit];
  if (known) return { ...known };
  return {
    klass: 'code',
    transient: 'unknown',
    basis: 'exit code alone cannot separate a flaky run from a deterministic one',
  };
}

// How much of the command's own output belongs in the ledger.
//
// The Iron Law asks for `[Command] → [Exit Code] → [Extracted Log Trace] →
// [Verdict]`, and the ledger is the artifact meant to deliver the third term. It
// used to deliver none of it: `run()` captured stderr and stdout and no caller
// read either, so a FAILED row said "exit 1" and stopped, leaving a human to
// re-run the command to learn why. A ledger that cannot explain itself forces
// that re-run, and a re-run of a stateful step is not the same command twice.
//
// The cap is deliberate. An unbounded log tail turns a diagnostic into a context
// flood — the exact failure the Log Capping standard exists to prevent — so the
// trace is a TAIL, the part a reader actually needs, and the row says so.
const TRACE_LINES = 4;
const TRACE_COLS = 160;

// Render one cell: newlines become a visible separator, a pipe would end the
// markdown cell, and backticks would break the `code` span. Escaping matters
// because `plan-mark-done.mjs` parses these rows back out of the rendered table.
export function ledgerTrace({ stderr, stdout }) {
  const raw = (stderr && stderr.trim()) ? stderr : (stdout || '');
  const lines = String(raw).replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  if (!lines.length) return '';
  const tail = lines.slice(-TRACE_LINES);
  const dropped = lines.length - tail.length;
  const cell = tail
    .map((l) => l.slice(0, TRACE_COLS).replace(/\|/g, '\\|').replace(/`/g, "'"))
    .join(' ⏎ ');
  return dropped > 0 ? `…${dropped} earlier line(s) hidden ⏎ ${cell}` : cell;
}

// A row is only as useful as the evidence in it, and a blank evidence cell is the
// one thing that must never reach a human who has to triage it.
function ledgerCell(e) {
  return e.trace ? e.trace : '_no output captured_';
}

// A `run[]` step that does not declare its own `expect_exit` inherits the task's
// `verify_exit`. Exported for the ledger, which has to print the expectation a
// step actually carried — not the one the task declared — or the row states half
// a disagreement.
function expectedExitOf(t, stepIndex) {
  const verifyExit = typeof t.verify_exit === 'number' ? t.verify_exit : 0;
  const step = (Array.isArray(t.run) ? t.run : [])[stepIndex];
  return step && typeof step.expect_exit === 'number' ? step.expect_exit : verifyExit;
}

// `loop_until` has exactly one expectation: 0, meaning converged. It is NOT the
// step's `expect_exit`, and borrowing that one would make a RED step's
// unconverged loop read as the expectation it declared: "exited 1, expected 1"
// is a pass sentence attached to a failure. So the ledger reports the
// disagreement the loop actually had.
const LOOP_EXPECTED_EXIT = 0;

export function executePlan(plan, { execute = false, log = () => {}, dir = process.cwd() } = {}) {
  const order = topoSort(plan.tasks);
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const retryMax = plan.defaults?.retry_transient_max ?? 1;
  const timeoutMs = (plan.defaults?.step_timeout_s ?? 120) * 1000;
  // An explicit integer policy, or fail closed. The permissive value used to be
  // the only behaviour, which meant a typo in this field silently granted the
  // weaker semantics instead of being noticed.
  const onPreconditionFail = plan.defaults?.on_precondition_fail ?? 'stop-task-continue-independent';
  if (!['stop-task-continue-independent', 'halt-plan'].includes(onPreconditionFail)) {
    throw new Error(`defaults.on_precondition_fail must be "stop-task-continue-independent" or "halt-plan", got ${JSON.stringify(onPreconditionFail)}`);
  }
  // Throws on an unrecognised value, for the same reason the line above does.
  const retryIf = validateRetryIf(plan.defaults?.retry_if);

  const status = new Map();
  const ledger = [];
  const failed = new Set();
  let planHalted = false;

  for (const id of order) {
    const t = byId.get(id);
    if (planHalted) {
      status.set(id, 'HALTED-PLAN');
      ledger.push({ task: id, step: '-', klass: 'contract', exit: '-', cause: 'plan halted by on_precondition_fail', retry: '0/0', status: 'HALTED-PLAN' });
      log(`  ${id}: HALTED-PLAN`);
      continue;
    }
    const upstreamFail = (t.depends_on || []).some((d) => failed.has(d) || status.get(d) === 'HALTED-UPSTREAM');
    if (upstreamFail) {
      status.set(id, 'HALTED-UPSTREAM');
      ledger.push({ task: id, step: '-', klass: 'contract', exit: '-', cause: 'upstream dependency failed', retry: '0/0', status: 'HALTED-UPSTREAM' });
      log(`  ${id}: HALTED-UPSTREAM`);
      continue;
    }

    if (!execute) { status.set(id, 'READY'); log(`  ${id}: READY (dry-run)`); continue; }

    if (t.skip_if) {
      const r = run(t.skip_if, timeoutMs);
      if (r.exit === 0) { status.set(id, 'SKIPPED-IDEMPOTENT'); log(`  ${id}: SKIPPED-IDEMPOTENT (skip_if exit 0)`); continue; }
    }

    if (!Array.isArray(t.run) || t.run.length === 0) {
      status.set(id, 'NEEDS-AGENT');
      log(`  ${id}: NEEDS-AGENT (no frontmatter run[]; agent executes prose steps)`);
      continue;
    }

    // A step that does not declare its own expected exit inherits the task's
    // verify_exit. A step that is expected to FAIL must say so explicitly,
    // which is the point: a RED step is a deliberate exception, and it should
    // read as one in the plan rather than be implied by a default.
    const verifyExit = typeof t.verify_exit === 'number' ? t.verify_exit : 0;
    const missing = filePrecondition(t, dir);
    if (missing) {
      const cause = `declared file(s) absent before the task ran: ${missing.join(', ')}`;
      failed.add(id);
      const st = onPreconditionFail === 'halt-plan' ? 'FAILED-BLOCKING' : (descendants(id, plan.tasks).size ? 'FAILED-BLOCKING' : 'FAILED-ISOLATED');
      status.set(id, st);
      ledger.push({ task: id, step: 'pre', klass: 'contract', exit: '-', cause, retry: '0/0', status: st });
      log(`  ${id}: ${st} (precondition: ${missing.join(', ')})`);
      if (onPreconditionFail === 'halt-plan') { planHalted = true; failed.add(id); }
      continue;
    }

    let ok = true, failStep = null, lastExit = 0, usedRetry = 0, failDetail = null, skippedRetry = null, failStepRetry = retryMax;
    // Which key produced the failure that ends the task. `loop_until` is named
    // separately because its expectation is 0 (converged) and not the step's
    // `expect_exit`, so the ledger row has to state the disagreement the loop
    // actually had rather than the step's.
    let failSource = null;
    for (let s = 0; s < t.run.length; s++) {
      const step = t.run[s];
      const want = typeof step.expect_exit === 'number' ? step.expect_exit : verifyExit;
      const stepRetry = step.retry ?? retryMax;
      failStepRetry = stepRetry;
      // Only a well-formed command gates anything. Validation already refuses
      // blank, non-string, and file-probe values, and `executePlan` is reachable
      // directly (every test in the suite goes through it without validating
      // first), so an unusable value must not be able to quietly gate a step
      // here: it is treated as no convergence condition at all, which is what a
      // step that never declared one behaves like.
      const loopCmd = typeof step.loop_until === 'string' && step.loop_until.trim() !== ''
        ? step.loop_until : null;
      // The probe is re-checked against its own value every attempt, because the
      // step re-runs on the SAME budget and each pass is a fresh iteration whose
      // convergence has to be decided again.
      let loopConverged = true;
      let attempt = 0, r;
      do {
        r = run(step.cmd, timeoutMs, { log });
        attempt++;
        loopConverged = true;
        if (r.exit === want && loopCmd !== null) {
          // Through the same run() helper and the same timeout as any step, so a
          // probe that overruns step_timeout_s is killed with its process group
          // and cannot leak the children a step command can spawn.
          const probe = run(loopCmd, timeoutMs, { log });
          if (probe.exit === 0) break; // converged: the step passes
          // Not converged. The step runs again inside the retry budget it already
          // declared, and the probe's own result is what the failure is reported
          // from, so the ledger cannot blame the step for the loop's state.
          log(`      (loop_until exited ${probe.exit}, not converged; re-running step ${s + 1})`);
          r = probe;
          loopConverged = false;
        }
        // Step success is decided by the STEP's own exit, never by `r` once the
        // probe has been assigned into it. Comparing the probe against `want`
        // here made an unconverged loop indistinguishable from a step that
        // passed: a RED step declares expect_exit 1 and its probe exits 1, so
        // `r.exit === want` was true and the do/while broke after a single pass,
        // spending zero of the retry budget the step declared. A loop declared on
        // an expect_exit:1 step could therefore never iterate, which is the exact
        // case the key exists for. `loopConverged` is the guard: the probe exit
        // is only ever compared against LOOP_EXPECTED_EXIT, and this break is
        // reachable only when no unconverged probe was assigned.
        if (r.exit === want && loopConverged) break;
        // A retry is only worth spending on something that could pass next time.
        // `transient: false` is reserved for the classes where the exit code
        // PROVES a re-run cannot help — 127 means the binary is not on this
        // machine, 130 means someone interrupted the step. `unknown` keeps the
        // old behaviour, because a flaky test and a real failure share exit 1
        // and guessing either way would be wrong.
        const cls = classifyFailure(r);
        // Two distinct reasons to stop spending the retry budget. The first is a
        // fact about the failure: the exit code proves a re-run cannot help, and
        // that has been unconditional since it was added, because it only ever
        // removes a provably wasted attempt. The second is a POLICY: a plan that
        // declares `retry_if: transient` spends the budget only on a failure the
        // classification actually calls transient, which means `unknown` (the
        // ordinary exit 1, where a flaky test and a real failure look identical)
        // is no longer retried either.
        const deterministic = cls.transient === false;
        const strictUnknown = retryIf === 'transient' && cls.transient !== true;
        if (deterministic || strictUnknown) {
          skippedRetry = deterministic
            ? `retry skipped: ${cls.basis}, and a re-run cannot change it`
            : `retry skipped under retry_if: transient (${cls.basis})`;
          log(`      (${skippedRetry})`);
          break;
        }
      } while (attempt <= stepRetry);
      usedRetry += attempt - 1;
      // `loopConverged` and not `r.exit !== want` alone: a RED step declares
      // expect_exit 1, so an unconverged loop whose probe exits 1 would otherwise
      // be indistinguishable from the step's own expected failure. The probe's
      // exit is deliberately NOT compared against `want` anywhere: it has exactly
      // one expectation, 0, which is what LOOP_EXPECTED_EXIT carries.
      if (r.exit !== want || !loopConverged) {
        ok = false;
        failStep = s + 1;
        lastExit = r.exit;
        failDetail = { ...r, cls: classifyFailure(r) };
        failSource = loopConverged ? 'cmd' : 'loop_until';
        break;
      }
    }

    if (ok) {
      const absent = filePostcondition(t, dir);
      if (absent) {
        failed.add(id);
        const st = onPreconditionFail === 'halt-plan' ? 'FAILED-BLOCKING' : (descendants(id, plan.tasks).size ? 'FAILED-BLOCKING' : 'FAILED-ISOLATED');
        status.set(id, st);
        ledger.push({ task: id, step: t.run.length, klass: 'contract', exit: 0, cause: `declared file(s) still absent after the task ran: ${absent.join(', ')}`, retry: `${usedRetry}/${failStepRetry}`, status: st });
        log(`  ${id}: ${st} (postcondition: ${absent.join(', ')})`);
        if (onPreconditionFail === 'halt-plan') planHalted = true;
        continue;
      }
      status.set(id, 'PASSED');
      log(`  ${id}: PASSED`);
      continue;
    }
    failed.add(id);
    const hasChildren = descendants(id, plan.tasks).size > 0;
    const st = hasChildren ? 'FAILED-BLOCKING' : 'FAILED-ISOLATED';
    status.set(id, st);
    // The expected exit for the step that failed, so the row states the
    // disagreement rather than only its own side of it. "exited 1" is half a
    // fact; "exited 1, expected 0" is the fact a reader can act on.
    //
    // An unconverged loop states ITS disagreement instead. It has to: the step's
    // own command exited as declared, so quoting the step's expectation would
    // produce "exited 1, expected 1" on a row that is a failure, and the key that
    // actually failed would not appear in the ledger at all.
    const loopFailed = failSource === 'loop_until';
    const expected = loopFailed ? LOOP_EXPECTED_EXIT : expectedExitOf(t, failStep - 1);
    const cause = loopFailed
      ? `step ${failStep} loop_until did not converge: exited ${lastExit}, expected ${LOOP_EXPECTED_EXIT}`
      : `step ${failStep} exited ${lastExit}, expected ${expected}`;
    const cls = failDetail?.cls ?? { klass: 'code', transient: 'unknown', basis: 'no step detail recorded' };
    ledger.push({
      task: id,
      step: failStep,
      klass: cls.klass,
      exit: lastExit,
      transient: cls.transient,
      basis: cls.basis,
      cause,
      expected,
      retry: `${usedRetry}/${failStepRetry}`,
      status: st,
      trace: ledgerTrace(failDetail ?? {}),
      note: skippedRetry,
    });
    log(`  ${id}: ${st} at step ${failStep} (${loopFailed ? 'loop_until did not converge' : `exit ${lastExit}, expected ${expected}`}, ${cls.klass})`);
  }
  return { order, status, ledger };
}

export function renderLedger(ledger) {
  if (ledger.length === 0) return 'Error Ledger: (empty — no failures)';
  // COLUMN ORDER IS A CONTRACT, and one consumer depends on it.
  //
  // `plan-mark-done.mjs` parses these rows back out of the rendered table and
  // identifies a row BY SHAPE, not position: the first cell must be id-shaped
  // and the LAST cell must be a backticked status token. Its own comment says a
  // later-added column cannot shift the check, and that is what makes widening
  // this table safe. Two consequences follow, and both are load-bearing:
  //
  //   1. `Status` stays LAST. A trace cell is never allowed to become the final
  //      cell, or every row stops parsing as a ledger row.
  //   2. The trace cell can never contain an unescaped `|`. `ledgerTrace` escapes
  //      it for exactly this reason: one pipe in a compiler's output would
  //      otherwise split the row into two and turn a real failure into a
  //      phantom task id.
  const head = '| Task | Step | Classification | Exit | Expected | Transient | Root cause | Evidence (log tail) | Retry used | Status |\n'
    + '|---|---|---|---|---|---|---|---|---|---|';
  const rows = ledger.map((e) => {
    const transient = e.transient === undefined ? '-' : String(e.transient);
    const basis = e.basis ? `${e.cause} (${e.basis})` : e.cause;
    const note = e.note ? `${e.note}` : '';
    const causeCell = [basis, note].filter(Boolean).join(' - ');
    return `| ${e.task} | ${e.step} | ${e.klass} | ${e.exit} | ${e.expected ?? '—'} | ${transient} | ${causeCell} | ${ledgerCell(e)} | ${e.retry} | \`${e.status}\` |`;
  });
  return `## Error Ledger\n${head}\n${rows.join('\n')}`;
}

// ---------- vault mirror gate ----------
//
// Why this is a gate and not a warning: the mirror is what a human reads when
// they review a plan. A plan that executes without ever reaching the vault was
// reviewed by nobody, in a place they were not looking. Making execution depend
// on the mirror is the only point in the pipeline where "publish the plan" can
// stop being advice.
//
// It runs AFTER validation and BEFORE any task step, and only for --execute.
// A dry run deliberately never consults it: validating a plan is reading and
// writing documents, which must work on a machine with no vault at all.
//
// Fail CLOSED when the verdict cannot be reached. A gate that quietly passes
// because it could not check is worse than no gate, because it manufactures
// confidence that was never earned — the same failure mode the CI version of
// this check documents.
//
// Exit 3 is deliberately distinct: 2 is already usage error and 1 is already
// validation or task failure, so a caller can tell "you forgot to publish" from
// "the plan is broken" without parsing text.

export const EXIT_MIRROR_GATE = 3;

function mirrorGate(planPath, { skip }) {
  const verdict = planFreshness(planPath);

  if (skip) {
    // Loud every time. An escape hatch that passes quietly becomes the default
    // within a week, and then nobody is publishing again.
    console.log(`⚠️  MIRROR GATE: SKIPPED by --skip-mirror-gate — ${verdict.state}${verdict.detail ? ` — ${verdict.detail}` : ''}`);
    console.log('   The plan executes without a current vault mirror. Re-publish, and drop the flag.\n');
    return null;
  }

  // Not applicable means there is no mirror by design (the vault's own plans,
  // declared mirror:false because publishing one would copy a file onto
  // itself). It is not a pass: it is the absence of a check, and it says so.
  if (!verdict.applicable) return null;
  if (verdict.state === 'OK') return null;

  console.error('MIRROR GATE: BLOCKED — refusing to execute a plan with no current Obsidian mirror.\n');
  console.error(`  plan     ${path.resolve(planPath)}`);
  if (verdict.project) console.error(`  project  ${verdict.project}`);
  if (verdict.dest) console.error(`  mirror   ${verdict.dest}`);
  console.error(`  state    ${verdict.state}`);
  if (verdict.detail) console.error(`  reason   ${verdict.detail}`);
  console.error('\n  The plan is still valid and still saved in its project repository. The mirror is');
  console.error('  derived state, so the fix is to publish it, not to change the plan:\n');
  // Absolute paths on purpose: the publisher resolves its input to an absolute
  // path anyway, and the person hitting this may be in any project directory,
  // where a repo-relative `bun scripts/plan-publish.mjs` does not exist.
  console.error(`    bun ${PUBLISHER} ${path.resolve(planPath)}`);
  if (process.env.PLAN_PUBLISH_CONFIG) {
    console.error(`\n  (registry override in use: ${process.env.PLAN_PUBLISH_CONFIG})`);
  }
  console.error('\n  To execute anyway, pass --skip-mirror-gate. It prints a warning every time.');
  return EXIT_MIRROR_GATE;
}

function main(argv) {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const execute = args.includes('--execute');
  const asJson = args.includes('--json');
  const skipGate = args.includes('--skip-mirror-gate');
  if (!file) {
    console.error('usage: ultra-plan-runner <plan.md> [--execute] [--json] [--skip-mirror-gate]');
    console.error('  --execute          run the DAG (requires a current Obsidian mirror; exit 3 if not)');
    console.error('  --skip-mirror-gate run the DAG anyway, with a warning (every time)');
    process.exit(2);
  }
  if (skipGate && !execute) {
    // Refuse rather than ignore: silently discarding a flag that exists to
    // suspend a safety check is how someone comes to believe the check is off.
    console.error('--skip-mirror-gate only means anything with --execute; it has no effect on a dry run.');
    process.exit(2);
  }
  const md = readFileSync(file, 'utf8');
  const { frontmatter, body } = extractFrontmatter(md);
  const plan = parseUltraPlanYaml(frontmatter);
  const { errors, warnings } = validatePlan(plan, body);

  // The gate sits after validation and before any task step, and only for
  // --execute. A plan that fails validation cannot run at all, so gating it
  // would report the wrong problem: it would blame the mirror for a plan that
  // was going to be rejected anyway.
  if (execute && !errors.length) {
    const blocked = mirrorGate(file, { skip: skipGate });
    if (blocked) process.exit(blocked);
  }

  if (asJson) {
    const { order, status, ledger } = errors.length ? { order: [], status: new Map(), ledger: [] } : executePlan(plan, { execute });
    console.log(JSON.stringify({ plan_id: plan.plan_id, errors, warnings, order, status: Object.fromEntries(status), ledger }, null, 2));
    process.exit(errors.length || ledger.length ? 1 : 0);
  }

  console.log(`Plan: ${plan.plan_id}  schema=${plan.schema}  status=${plan.status}  tasks=${plan.tasks.length}`);
  for (const w of warnings) console.log(`  WARN: ${w}`);
  if (errors.length) {
    console.log('\nVALIDATION FAILED:');
    for (const e of errors) console.log(`  ERROR: ${e}`);
    process.exit(1);
  }
  console.log('Validation: OK\n');
  console.log(execute ? 'Executing DAG (topological order):' : 'Dry-run DAG (topological order); pass --execute to run:');
  const { ledger } = executePlan(plan, { execute, log: (m) => console.log(m) });
  console.log('\n' + renderLedger(ledger));
  process.exit(ledger.length ? 1 : 0);
}

const isMain = process.argv[1] && process.argv[1].endsWith('ultra-plan-runner.mjs');
if (isMain) main(process.argv);
