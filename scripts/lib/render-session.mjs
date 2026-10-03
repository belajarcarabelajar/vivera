// scripts/lib/render-session.mjs
//
// Turn one OpenCode session's message rows into one Obsidian note.
//
// WHAT THIS FILE OWNS
//
// `opencode-db.mjs` hands back rows without interpreting them, and
// `session_message.data` is deliberately still a raw JSON STRING. Parsing it,
// deciding what a `reasoning` part is, and deciding how much of a tool call a
// reader needs is this file's job and nobody else's.
//
// FIVE PROPERTIES, each of which has a test that could fail.
//
//   1. ORDER IS `seq`, AND IT IS THE RENDERER'S JOB TO SORT. The real database
//      carries a unique index on `(session_id, seq)`, so `messagesForSession`
//      already returns sorted rows and a renderer with no sort would look
//      correct against it. Sorting anyway is what makes the property true for
//      every CALLER, not just the one that happened to use the index. A `seq`
//      that is not a finite number sorts LAST rather than coercing: `Number(null)
//      === 0` would file an unsequenced message above the session's real first
//      message, which is a lie about what happened first.
//
//   2. NO MESSAGE TYPE IS DROPPED. Intent Lock D16 chose full fidelity, so
//      `idle` (2,775 real rows), `compaction` (24), `model-switched` (56),
//      `location-switched` (2), `agent-switched` (2), `synthetic` (991) and
//      `system` (298) all render as an explicitly labelled `session-event:`
//      section. Not "the ones we care about": every one, including types this
//      code has never seen. Each carries its own payload as a JSON dump, because
//      a labelled empty stub satisfies "it is labelled" while losing the data,
//      and a reader cannot tell the difference from the note alone.
//
//   3. REDACTION HAPPENS PER STRING, BEFORE ASSEMBLY. Every rendered string —
//      user text, assistant text, reasoning, tool input, tool output, event
//      fields, the session title — goes through `redact()` on its way into the
//      document. Not once over the finished string: a single final pass would
//      leave the same string un-redacted for any caller that reused it, and the
//      counts would attribute hits to the document instead of to the field that
//      held them. Counts accumulate and are handed to `opts.onRedact` once.
//
//   4. CAPTURED TEXT CANNOT BREAK THE NOTE. Assistant prose and tool output are
//      both attacker-and-accident-controlled, and both routinely contain fences
//      — a markdown sample, a shell here-doc, a diff. `fenceInline` sizes the
//      fence to the longest backtick run in the body, which is what keeps a
//      pasted document from closing a block early and turning the rest of the
//      note into prose. Prose that carries a fence run is moved inside that
//      fence and labelled, so the containment is visible rather than surprising.
//
//   5. NOTHING THROWS. A message whose `data` is not valid JSON, an unknown part
//      type, a missing `content` array, a `content` that is not an array, a null
//      part, a null row, a `messages` argument that is not an array: each
//      degrades to a labelled marker. A whole session's note is worth far more
//      than one malformed row, and a marker naming what went wrong is
//      recoverable in a way a stack trace in an export is not.
//
// DETERMINISM IS A REQUIREMENT, NOT A POLISH ITEM. `syncWrite` compares bytes to
// decide whether to touch the vault, and `obsidian-git` pushes whatever changes,
// so a note that renders differently on two runs over an unchanged database is a
// git diff for nothing. Nothing here reads a clock, a random source, or ambient
// state; every timestamp in the output is derived from the rows themselves.
//
// Revert: delete this file and scripts/lib/render-session.test.mjs. No other
// module imports it yet.

import { redact } from './redact.mjs';
import { extractAttachments } from './extract-attachments.mjs';
import { fenceInline, inlineSpill } from './inline-spills.mjs';

/** Stamped into the frontmatter so a note names the thing that produced it. */
export const GENERATOR = 'vivera/render-session@1.0.0';

/** The section heading shape. `## [seq 0] user` — see `parseFrontmatter`. */
export const SECTION_PREFIX = '## [seq ';

/**
 * The message types that get an explicitly labelled `session-event:` section
 * instead of a `user`/`assistant` body. Exported so a caller can report coverage
 * and so a test can assert the renderer and its test agree on the list.
 */
export const EVENT_TYPES = Object.freeze([
  'idle',
  'compaction',
  'model-switched',
  'location-switched',
  'agent-switched',
  'synthetic',
  'system',
]);

// ---------- the degradation markers ----------
//
// Prefixes, not whole strings: the variable part follows, so a caller (or a
// grep) can match on the bracketed tag alone. The same discipline as
// inline-spills.mjs's four markers — if a downstream renderer ever needs to
// recognise these, the prefixes ARE the vocabulary.

/** `data` did not parse as JSON, or parsed to something that is not an object. */
export const MALFORMED_DATA_MARKER = '[MALFORMED DATA';
/** `$.content` was absent, or was present but was not an array. */
export const MISSING_CONTENT_MARKER = '[MISSING CONTENT ARRAY';
/** A `$.content[]` entry whose `type` is not one this renderer knows. */
export const UNKNOWN_PART_MARKER = '[UNKNOWN PART TYPE';
/** A user message carried `files[]` but no `attachmentsDir` was supplied. */
export const OMITTED_ATTACHMENT_MARKER = '[ATTACHMENTS OMITTED';
/** Prose that had to be fenced to stop it breaking the note structure. */
export const FENCED_PROSE_MARKER = '[PROSE FENCED';
/** A `messages[]` entry that was not an object at all. */
export const NULL_MESSAGE_MARKER = '[NULL MESSAGE ROW';

// ---------- frontmatter ----------

/**
 * Render a YAML scalar.
 *
 * Quoted with `JSON.stringify` rather than YAML's own quoting, because
 * JSON-string escaping is a strict subset of YAML's double-quoted escaping: the
 * result is valid under both parsers. A title of `colon: inside, and "quotes"`
 * is ordinary user text and would otherwise produce frontmatter that a YAML
 * parser reads as a mapping.
 */
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(String(value));
}

/**
 * Milliseconds since the epoch to an ISO-8601 UTC string.
 *
 * UTC with an explicit `Z`, always. `toISOString` is already UTC and
 * already throws on a non-finite input, which is caught here rather than
 * allowed to take the whole note down: a session row with a corrupt timestamp
 * must still render its messages.
 */
function isoUtc(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/**
 * Split a note's frontmatter from its body.
 *
 * Deliberately a small hand-rolled reader rather than a YAML dependency: the
 * renderer only ever writes flat `key: value` lines, so a full parser would be a
 * dependency and an attack surface for a job that is four lines of work.
 *
 * @param {string} markdown
 * @returns {{ attrs: Record<string, unknown>, body: string }} `body` is `''`
 *   when there is no frontmatter; `attrs` is `{}` in that case too.
 */
export function parseFrontmatter(markdown) {
  const text = typeof markdown === 'string' ? markdown : '';
  const lines = text.split('\n');
  if (lines[0] !== '---') return { attrs: {}, body: text };

  const end = lines.indexOf('---', 1);
  if (end === -1) return { attrs: {}, body: text };

  const attrs = {};
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key === '') continue;
    attrs[key] = unquoteYamlScalar(line.slice(at + 1).trim());
  }
  return { attrs, body: lines.slice(end + 1).join('\n') };
}

function unquoteYamlScalar(raw) {
  if (raw === '') return '';
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  // An unquoted integer/float becomes a number, because that is what a YAML
  // parser does with it. Matching the real parser is the point of this reader:
  // a consumer must not have to know which of its fields the renderer happened
  // to quote. `message_count: 4` is a number, not the string `'4'`.
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

// ---------- redaction ----------

/**
 * A redactor that accumulates counts across every string in one note.
 *
 * `redact()` is pure and stateless per call, so the aggregation is this
 * closure's job: the caller wants ONE counts object per note, not one per field.
 */
function makeRedactor(patterns) {
  const counts = {};
  return {
    counts,
    run(text) {
      const { text: safe, counts: found } = redact(text, patterns);
      for (const [name, n] of Object.entries(found)) {
        counts[name] = (counts[name] ?? 0) + n;
      }
      return safe;
    },
  };
}

// ---------- ordering ----------

/**
 * A message's `seq`, or `null` when it is not a usable number.
 *
 * `null`, not `0`. `Number(null) === 0` and `Number('') === 0`, so a row whose
 * `seq` went missing would sort ABOVE the session's genuine first message and
 * be presented as the thing that happened first.
 */
function seqOf(row) {
  // Guarded on the row, not just on `seq`: the sort comparator runs on every
  // entry of the array BEFORE any message-level validation, so a `null` row
  // would take the whole note down here rather than reaching the branch that
  // is written to describe it.
  if (row === null || typeof row !== 'object') return null;

  // `Number()` is NOT a safe coercion here, and this is the whole reason the
  // function returns null instead of a fallback:
  //
  //     Number(null)     === 0
  //     Number(undefined) === NaN
  //     Number('')       === 0
  //     Number(false)    === 0
  //     Number([])       === 0
  //
  // So a row whose `seq` went missing would be filed as sequence ZERO and
  // rendered as the FIRST thing that happened in the session, which is a lie
  // about history and the worst failure this module could have. Only a real
  // finite number, or a string that is entirely a number, is accepted.
  const raw = row.seq;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sort by ascending `seq`, stably, with unusable sequences last.
 *
 * A stable tiebreak on the original index: `seq` is unique per session in the
 * real schema, but two rows sharing one is survivable data corruption and must
 * not produce a note whose order depends on the engine's sort implementation.
 */
function bySeq(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const sa = seqOf(a.row);
      const sb = seqOf(b.row);
      if (sa === null && sb === null) return a.index - b.index;
      if (sa === null) return 1;
      if (sb === null) return -1;
      if (sa === sb) return a.index - b.index;
      return sa - sb;
    })
    .map((entry) => entry.row);
}

// ---------- text shaping ----------

/** A fence run of three or more backticks can open a markdown code block. */
const FENCE_RUN = /`{3,}/;

/** A line that looks like one of this note's own section headings. */
const HEADING_LINE = /^#{1,6} /;

/** A horizontal rule / frontmatter fence. */
const RULE_LINE = /^(-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * True when a block of text could restructure the note around it: a fence run, a
 * heading line, or a horizontal rule.
 */
function isStructurallyActive(text) {
  return FENCE_RUN.test(text)
    || text.split('\n').some((line) => HEADING_LINE.test(line) || RULE_LINE.test(line));
}

/**
 * Render a string as prose, or fence it when it would break the note.
 *
 * Plain prose stays prose, because a note people search is a note with prose in
 * it. Prose carrying a fence run, a heading, or a rule is moved inside a fence
 * sized to its own longest backtick run, and the move is stated, so a reader
 * wondering why a paragraph is a code block gets an answer.
 */
function prose(text, redactor) {
  const safe = redactor.run(typeof text === 'string' ? text : '');
  if (safe === '') return '';
  if (!isStructurallyActive(safe)) return `${safe}\n`;
  return `${FENCED_PROSE_MARKER} this text contains markdown that would otherwise break the note\n\n${fenceInline(safe, { info: 'text' })}`;
}

/**
 * A value as a fenced JSON block, sized, and escaped if it carries a fence.
 *
 * `value` is usually an ALREADY-SERIALISED string, because the caller has to
 * redact the text before it reaches the document and redaction takes a string.
 * Re-serialising it here would double-encode it into a quoted string with
 * backslash-escaped quotes — still readable, but `\"path\"` instead of `"path"`,
 * and every key in the note would be un-greppable. So a string is taken as the
 * text to fence, and anything else is serialised first.
 */
function jsonBlock(value, info = 'json') {
  const text = typeof value === 'string' ? value : safeStringify(value);
  return fenceInline(text, { info });
}

/** A `- \`key\`: value` bullet, with newlines collapsed so it stays one line. */
function bullet(key, value) {
  const flat = String(value).replace(/\s*\n\s*/g, ' ').trim();
  if (flat === '') return '';
  return `- \`${key}\`: ${flat}\n`;
}

/** The `## [seq N] <label>` heading. */
function heading(row, label) {
  const seq = seqOf(row);
  return `${SECTION_PREFIX}${seq === null ? 'unknown' : seq}] ${label}\n\n`;
}

// ---------- per-type rendering ----------

function renderUser(out, row, data, ctx) {
  out.push(heading(row, 'user'));
  out.push('### prompt\n\n');

  const text = data.text;
  if (typeof text !== 'string' || text === '') {
    out.push('_(no prompt text)_\n\n');
  } else {
    out.push(prose(text, ctx.redactor));
    out.push('\n');
  }

  const files = Array.isArray(data.files) ? data.files : [];
  if (files.length === 0) return;

  out.push('### attachments\n\n');
  if (typeof ctx.attachmentsDir !== 'string' || ctx.attachmentsDir === '') {
    // Stated rather than dropped: a note that silently lost a screenshot reads
    // exactly like a session that had none.
    out.push(`${OMITTED_ATTACHMENT_MARKER} ${files.length} attachment(s) not written; no attachmentsDir was supplied\n\n`);
    return;
  }

  const results = extractAttachments(files, ctx.attachmentsDir, {
    sessionId: ctx.sessionId,
    messageId: typeof row.id === 'string' ? row.id : `seq-${seqOf(row)}`,
    vaultRoot: ctx.vaultRoot,
  });
  for (const result of results) {
    if (result.skipped) {
      out.push(`- entry ${result.index} — **skipped**: ${result.reason}\n`);
    } else {
      out.push(`- \`${result.filename}\` — ${result.mime}, ${result.bytes} bytes\n`);
      out.push(`  ${result.embed}\n`);
    }
  }
  out.push('\n');
}

function renderReasoning(out, part, ctx) {
  out.push('### reasoning\n\n');
  out.push('<details>\n<summary>Reasoning</summary>\n\n');
  const text = typeof part.text === 'string' ? part.text : '';
  out.push(prose(text, ctx.redactor));
  out.push('\n</details>\n\n');
}

function renderTool(out, part, ctx) {
  const name = typeof part.name === 'string' && part.name !== '' ? part.name : 'unknown';
  out.push(subheading(`tool · ${ctx.redactor.run(name)}`));

  out.push(bullet('id', ctx.redactor.run(typeof part.id === 'string' ? part.id : '(none)')));
  out.push(bullet('executed', part.executed === true ? 'true' : part.executed === false ? 'false' : 'unknown'));
  const state = part.state && typeof part.state === 'object' && !Array.isArray(part.state) ? part.state : {};
  if (typeof state.status === 'string') out.push(bullet('status', ctx.redactor.run(state.status)));
  if (typeof part.agent === 'string') out.push(bullet('agent', ctx.redactor.run(part.agent)));
  out.push('\n');

  out.push('#### input\n\n');
  const input = state.input === undefined ? part.input : state.input;
  out.push(jsonBlock(ctx.redactor.run(safeStringify(input))));
  out.push('\n');

  out.push('#### output\n\n');
  // `inlineSpill` owns the pointer question: it confines reads to
  // allowedSpillRoot, returns a labelled marker for a missing/refused/binary
  // file, and never throws. `allowedSpillRoot` is the renderer's option name;
  // the inliner's is `allowedRoot`, so the rename happens here and nowhere else.
  const output = inlineSpill(state, { allowedRoot: ctx.allowedSpillRoot });
  out.push(fenceInline(ctx.redactor.run(output), { info: 'text' }));
  out.push('\n');
}

function renderAssistant(out, row, data, ctx) {
  out.push(heading(row, 'assistant'));

  const model = data.model;
  if (model && typeof model === 'object') {
    const parts = [];
    if (model.providerID) parts.push(`\`${ctx.redactor.run(String(model.providerID))}\``);
    if (model.id) parts.push(`\`${ctx.redactor.run(String(model.id))}\``);
    if (model.variant) parts.push(`variant \`${ctx.redactor.run(String(model.variant))}\``);
    if (parts.length > 0) out.push(bullet('model', parts.join(' ')));
  } else if (typeof model === 'string') {
    out.push(bullet('model', `\`${ctx.redactor.run(model)}\``));
  }
  if (typeof data.agent === 'string') out.push(bullet('agent', ctx.redactor.run(data.agent)));
  if (data.error) out.push(bullet('error', ctx.redactor.run(safeStringify(data.error))));
  out.push('\n');

  if (!Array.isArray(data.content)) {
    out.push(`${MISSING_CONTENT_MARKER} $.content is ${describe(data.content)}; the turn has no rendered parts]\n\n`);
    return;
  }
  if (data.content.length === 0) {
    out.push('_(no content parts)_\n\n');
    return;
  }

  data.content.forEach((part, index) => {
    if (part === null || part === undefined || typeof part !== 'object' || Array.isArray(part)) {
      out.push(`${UNKNOWN_PART_MARKER} $.content[${index}] is ${describe(part)}]\n\n`);
      return;
    }
    switch (part.type) {
      case 'text':
        out.push('### assistant text\n\n');
        out.push(prose(typeof part.text === 'string' ? part.text : '', ctx.redactor));
        out.push('\n');
        break;
      case 'reasoning':
        renderReasoning(out, part, ctx);
        break;
      case 'tool':
        renderTool(out, part, ctx);
        break;
      default:
        // A part type this renderer has never seen. Named rather than dropped:
        // the note should be able to tell a reader that something was here, and
        // should not pretend the turn was empty.
        out.push(`${UNKNOWN_PART_MARKER} $.content[${index}].type = ${JSON.stringify(part.type ?? null)}]\n\n`);
    }
  });
}

/** A `###` sub-section heading, for content inside one message's section. */
function subheading(text) {
  return `### ${text}\n\n`;
}

/**
 * A session event: `idle`, `compaction`, the three `*-switched` types,
 * `synthetic`, `system`, and anything this renderer has not heard of.
 *
 * Three layers, in this order, because each answers a different reader question:
 * the label answers "what happened", the bullets answer "what were the salient
 * fields", and the JSON dump answers "was anything else in there". Dropping the
 * third layer is how a schema addition becomes silent data loss.
 */
function renderEvent(out, row, data, ctx) {
  const type = typeof row.type === 'string' && row.type !== '' ? row.type : 'unknown-type';
  out.push(heading(row, `session-event: ${ctx.redactor.run(type)}`));
  out.push(`### ${ctx.redactor.run(type)}\n\n`);

  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        out.push(bullet(key, ctx.redactor.run(value)));
      } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        out.push(bullet(key, String(value)));
      }
      // Objects and arrays are carried in the JSON dump below, not flattened
      // here: a flattened `tokens.input` bullet would be a partial rendering of
      // a structure whose full shape matters.
    }
  } else {
    out.push(`${MALFORMED_DATA_MARKER} the event payload is ${describe(data)}]\n\n`);
  }

  // The three fields that are prose rather than data. Rendered as prose so a
  // compaction summary stays readable instead of arriving as escaped JSON.
  for (const key of ['description', 'summary', 'text']) {
    const value = data !== null && typeof data === 'object' ? data[key] : undefined;
    if (typeof value !== 'string' || value === '') continue;
    out.push(`#### ${key}\n\n`);
    out.push(prose(value, ctx.redactor));
    out.push('\n');
  }

  out.push('#### event data\n\n');
  out.push(jsonBlock(ctx.redactor.run(safeStringify(data))));
  out.push('\n');
}

/** Describe an unexpected value without trusting its `toString`. */
function describe(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  const type = typeof value;
  if (type === 'object') return 'an object, not an array';
  if (type === 'string') return `a string of ${value.length} character(s)`;
  return `a ${type} (${inlineValue(value)})`;
}

/** JSON-ish rendering of a scalar, for a marker that names what went wrong. */
function inlineValue(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return 'unserialisable';
  }
}

function safeStringify(value) {
  try {
    const out = JSON.stringify(value, null, 2);
    return typeof out === 'string' ? out : String(out);
  } catch {
    return String(value);
  }
}

// ---------- the renderer ----------

/**
 * Render one session as an Obsidian note.
 *
 * Never throws. See the header: every malformed input degrades to a labelled
 * marker, because one bad row must not cost a whole session's note.
 *
 * @param {{ id?: string, title?: unknown, directory?: unknown,
 *           timeCreated?: number, timeUpdated?: number }} session a row from
 *   `listSessions()`
 * @param {Array<{ id?: string, type?: string, seq?: number, data?: string }>}
 *   messages rows from `messagesForSession()`. Order does NOT matter; they are
 *   sorted by `seq` here.
 * @param {object} [opts]
 * @param {string} [opts.attachmentsDir] where inline attachments are written.
 *   Without it, a message carrying `files[]` renders a marker instead of a
 *   base64 blob — the payload is never printed either way (AC-7).
 * @param {string} [opts.vaultRoot] base that `![[embed]]` paths are relative to.
 * @param {string} [opts.allowedSpillRoot] passed to `inlineSpill` as
 *   `allowedRoot`; reads outside it are refused before any I/O happens.
 * @param {Array<{ name: string, re: RegExp }>} [opts.redactPatterns] defaults
 *   to `PATTERNS`.
 * @param {(counts: Record<string, number>) => void} [opts.onRedact] called ONCE
 *   after assembly with the note's aggregated per-pattern counts.
 * @returns {string} the complete note. Deterministic for a given input.
 */
export function renderSession(session, messages, opts = {}) {
  const o = opts !== null && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const s = session !== null && typeof session === 'object' && !Array.isArray(session) ? session : {};
  const redactor = makeRedactor(o.redactPatterns);

  const ctx = {
    redactor,
    sessionId: typeof s.id === 'string' ? s.id : 'session',
    attachmentsDir: o.attachmentsDir,
    vaultRoot: o.vaultRoot,
    allowedSpillRoot: o.allowedSpillRoot,
  };

  const rows = bySeq(Array.isArray(messages) ? messages : []);
  const out = [];

  // ---------- frontmatter ----------
  //
  // Redacted HERE, once, and the same redacted string is reused for the H1
  // below. Two reasons, and the second is the important one:
  //
  //   * a title can carry a secret (`fix token ghp_...`), so the frontmatter —
  //     the first thing a reader and every frontmatter index see — must not be
  //     the one unredacted copy;
  //   * redacting once and reusing keeps the count attributable to the FIELD
  //     that held the secret. Redacting per occurrence would report a title
  //     that is printed twice as two secrets, which is a count no report can be
  //     trusted to interpret.
  const rawTitle = typeof s.title === 'string' && s.title.trim() !== '' ? s.title : null;
  const safeTitle = redactor.run(rawTitle ?? `session ${ctx.sessionId}`);
  // `redact` coerces a non-string to `{text:'', counts:{}}`, so a null
  // directory would become an empty string and silently stop being null. Keep
  // the distinction: "never named" and "named blank" must not collapse.
  const safeDirectory = typeof s.directory === 'string' ? redactor.run(s.directory) : null;

  out.push('---\n');
  out.push(`generator: ${yamlScalar(GENERATOR)}\n`);
  // The id is NOT redacted: it is the uniqueness key the note is named after,
  // and note-name.mjs derives the filename from it. A redacted id would name a
  // file that cannot be found again.
  out.push(`id: ${yamlScalar(s.id ?? null)}\n`);
  out.push(`title: ${yamlScalar(rawTitle === null ? null : safeTitle)}\n`);
  out.push(`directory: ${yamlScalar(safeDirectory)}\n`);
  out.push(`created: ${yamlScalar(isoUtc(s.timeCreated))}\n`);
  out.push(`updated: ${yamlScalar(isoUtc(s.timeUpdated))}\n`);
  out.push(`message_count: ${yamlScalar(rows.length)}\n`);
  out.push('---\n\n');

  // 36 of the 1009 real sessions have `title === null`, so the fallback above is
  // a normal path, not an error path.
  out.push(`# ${collapseToHeading(safeTitle)}\n\n`);
  out.push(prose(`Session \`${ctx.sessionId}\` · ${rows.length} message(s).`, redactor));
  out.push('\n');

  // ---------- messages ----------
  for (const row of rows) {
    if (row === null || row === undefined || typeof row !== 'object' || Array.isArray(row)) {
      out.push(heading({ seq: null }, NULL_MESSAGE_MARKER));
      out.push('This entry of the message array was not an object; it was skipped.\n\n');
      continue;
    }

    let data;
    try {
      // `data` is raw JSON TEXT by design in opencode-db.mjs: parsing 54k
      // documents to render one message is the reader's stall, not this one's.
      data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      out.push(heading(row, typeof row.type === 'string' && row.type !== '' ? row.type : 'unknown-type'));
      out.push(`${MALFORMED_DATA_MARKER} $.data is not valid JSON (${reason}); this message was kept as a marker]\n\n`);
      continue;
    }

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      out.push(heading(row, typeof row.type === 'string' && row.type !== '' ? row.type : 'unknown-type'));
      out.push(`${MALFORMED_DATA_MARKER} $.data parsed to ${describe(data)}, not a message object]\n\n`);
      continue;
    }

    if (row.type === 'user') renderUser(out, row, data, ctx);
    else if (row.type === 'assistant') renderAssistant(out, row, data, ctx);
    else renderEvent(out, row, data, ctx);
  }

  let note = out.join('');

  // Belt and braces. Every string above was already redacted field by field;
  // this final pass exists so that a field added later cannot silently skip that
  // step. `redact` is idempotent, so an already-redacted string contributes zero
  // counts here and the per-field counts stay attributable.
  note = redactor.run(note);

  if (typeof o.onRedact === 'function') {
    try {
      o.onRedact({ ...redactor.counts });
    } catch {
      // A reporter that throws must not take the note with it. The caller still
      // gets the note; it just does not get the counts.
    }
  }

  return note;
}

/**
 * Reduce a title to something safe as an H1.
 *
 * Only for the heading line: a title may contain newlines, which would end the
 * heading and start a new block, and control characters, which some renderers
 * swallow. The untruncated, uncollapsed value is already in the frontmatter.
 */
function collapseToHeading(text) {
  return String(text)
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}