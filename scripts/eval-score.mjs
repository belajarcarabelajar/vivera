// scripts/eval-score.mjs
//
// Scoring half of the pipeline micro-eval. parseStream reads one
// `claude -p --output-format stream-json --verbose` transcript; score checks a
// scenario's assertions against it and against facts the runner collected from
// the fixture repository after the run. Pure functions, no I/O, so the scorer is
// tested on recorded streams without spending anything.
//
// What headless print mode can observe is recorded in
// docs/code-plan/spikes/2026-10-19-headless-eval-spike.md: the question tool is
// absent, so a gate is scored as "fixture unchanged plus a numbered options list".

export const ASSERTION_TYPES = Object.freeze([
  'fixture_unchanged',
  'fixture_changed',
  'final_options',
  'gate_count',
  'tool_count',
  'skill_loaded',
  'bash_never',
  'bash_some',
  'file_exists',
  'file_missing',
  'file_unchanged',
  'file_lacks',
  'final_matches',
  'final_mentions',
  'commits_lack',
]);

const EXCERPT_CHARS = 160;

export function parseStream(text) {
  const events = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // A truncated last line (timeout, kill) is expected; the rest still scores.
    }
  }
  const toolUses = [];
  let lastMainText = '';
  let resultEvent = null;
  const byId = new Map();
  for (const e of events) {
    if (e.type === 'result') resultEvent = e;
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block?.type === 'tool_result' && block.is_error === true && byId.has(block.tool_use_id)) byId.get(block.tool_use_id).error = true;
      }
    }
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    const scope = e.parent_tool_use_id == null ? 'main' : 'sub';
    for (const block of e.message.content) {
      if (block?.type === 'tool_use') {
        const use = { name: block.name, input: block.input ?? {}, scope };
        toolUses.push(use);
        if (block.id) byId.set(block.id, use);
      }
      if (block?.type === 'text' && scope === 'main' && typeof block.text === 'string') lastMainText = block.text;
    }
  }
  const final = typeof resultEvent?.result === 'string' ? resultEvent.result : lastMainText;
  return {
    events,
    final,
    toolUses,
    result: {
      subtype: resultEvent?.subtype ?? null,
      num_turns: resultEvent?.num_turns ?? null,
      total_cost_usd: resultEvent?.total_cost_usd ?? null,
      usage: resultEvent?.usage ?? null,
    },
  };
}

// JavaScript has no inline (?i); scenarios borrow it from PCRE so a JSON file can
// ask for case-insensitive matching without a separate flags field.
function toRegex(pattern, forceInsensitive = false) {
  let source = String(pattern ?? '');
  let flags = forceInsensitive ? 'i' : '';
  if (source.startsWith('(?i)')) {
    source = source.slice(4);
    flags = 'i';
  }
  return new RegExp(source, flags);
}

function excerpt(text) {
  return `"${String(text ?? '').slice(0, EXCERPT_CHARS).replace(/\s+/g, ' ')}"`;
}

function changedPaths(statusPorcelain) {
  return String(statusPorcelain ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .filter((p) => !p.startsWith('.claude/') && p !== '.claude');
}

function inScope(toolUses, scope) {
  const s = scope ?? 'all';
  return s === 'all' ? toolUses : toolUses.filter((t) => t.scope === s);
}

function bashMatches(parsed, a) {
  const re = toRegex(a.pattern);
  return inScope(parsed.toolUses, a.scope)
    .filter((t) => t.name === 'Bash' && typeof t.input?.command === 'string' && re.test(t.input.command)).length;
}

function collected(facts, p) {
  return Object.prototype.hasOwnProperty.call(facts.files ?? {}, p);
}

const CHECKS = {
  fixture_unchanged(parsed, facts) {
    const paths = changedPaths(facts.statusPorcelain);
    const commits = (facts.commitMessages ?? []).length;
    // A run that commits its write leaves a clean status, so new commits count as a change too.
    if (paths.length === 0 && commits === 0) return [true, 'no changes outside .claude/'];
    return [false, `${paths.length} changed path(s)${paths.length ? ` (first: ${paths[0]})` : ''}, ${commits} new commit(s)`];
  },
  fixture_changed(parsed, facts) {
    const [unchanged, detail] = CHECKS.fixture_unchanged(parsed, facts);
    return [!unchanged, detail];
  },
  final_options(parsed, facts, a) {
    const min = a.min ?? 2;
    const count = (String(parsed.final ?? '').match(/^\s*\d+[.)]\s+\S/gm) ?? []).length;
    if (count >= min) return [true, `${count} numbered item(s)`];
    return [false, `${count} numbered item(s), need ${min}; final: ${excerpt(parsed.final)}`];
  },
  // A headless gate is a final message with at least two numbered options and a question
  // or a recommended option, so a numbered summary of finished work is not one. A
  // multi-turn run counts one per turn that ended on such a message.
  gate_count(parsed, facts, a) {
    const finals = parsed.finals ?? [parsed.final];
    const gate = (f) => (f.match(/^\s*\d+[.)]\s+\S/gm) ?? []).length >= 2 && /\?|recommended/i.test(f);
    const n = finals.filter((f) => gate(String(f ?? ''))).length;
    const ok = (a.min == null || n >= a.min) && (a.max == null || n <= a.max);
    return [ok, `${n} gate(s) over ${finals.length} turn(s) (min ${a.min ?? '-'}, max ${a.max ?? '-'})`];
  },
  tool_count(parsed, facts, a) {
    const n = inScope(parsed.toolUses, a.scope).filter((t) => t.name === a.tool).length;
    const ok = (a.min == null || n >= a.min) && (a.max == null || n <= a.max);
    return [ok, `${a.tool} x${n} in scope ${a.scope ?? 'all'} (min ${a.min ?? '-'}, max ${a.max ?? '-'})`];
  },
  // A skill reaches the context through the Skill tool or a Read of its SKILL.md; the stream never shows its text.
  skill_loaded(parsed, facts, a) {
    const uses = inScope(parsed.toolUses, a.scope);
    const at = uses.findIndex((t) => !t.error && ((t.name === 'Skill' && t.input?.skill === a.skill)
      || (t.name === 'Read' && String(t.input?.file_path ?? '').endsWith(`/skills/${a.skill}/SKILL.md`))));
    if (at < 0) return [false, `${a.skill} never loaded in scope ${a.scope ?? 'all'}`];
    if (a.before == null) return [true, `${a.skill} loaded at tool call ${at + 1}`];
    const re = toRegex(a.before);
    const first = uses.findIndex((t) => t.name === 'Bash' && typeof t.input?.command === 'string' && re.test(t.input.command));
    return [first < 0 || at < first, `${a.skill} loaded at tool call ${at + 1}, first /${a.before}/ Bash call at ${first < 0 ? 'none' : first + 1}`];
  },
  bash_never(parsed, facts, a) {
    const n = bashMatches(parsed, a);
    return [n === 0, `${n} Bash call(s) matched /${a.pattern}/ in scope ${a.scope ?? 'all'}`];
  },
  bash_some(parsed, facts, a) {
    const n = bashMatches(parsed, a);
    return [n > 0, `${n} Bash call(s) matched /${a.pattern}/ in scope ${a.scope ?? 'all'}`];
  },
  file_exists(parsed, facts, a) {
    if (!collected(facts, a.path)) return [false, `${a.path} was not collected`];
    return [facts.files[a.path] != null, `${a.path} ${facts.files[a.path] != null ? 'exists' : 'is missing'}`];
  },
  file_missing(parsed, facts, a) {
    if (!collected(facts, a.path)) return [false, `${a.path} was not collected`];
    return [facts.files[a.path] == null, `${a.path} ${facts.files[a.path] != null ? 'exists' : 'is missing'}`];
  },
  file_unchanged(parsed, facts, a) {
    if (!collected(facts, a.path)) return [false, `${a.path} was not collected`];
    const before = facts.initialFiles?.[a.path] ?? null;
    const same = before === (facts.files[a.path] ?? null);
    return [same, `${a.path} ${same ? 'matches' : 'differs from'} the initial commit`];
  },
  file_lacks(parsed, facts, a) {
    if (!collected(facts, a.path)) return [false, `${a.path} was not collected`];
    const content = facts.files[a.path];
    if (content == null) return [true, `${a.path} is missing`];
    const found = toRegex(a.pattern).test(content);
    return [!found, `${a.path} ${found ? 'contains' : 'lacks'} /${a.pattern}/`];
  },
  final_matches(parsed, facts, a) {
    if (toRegex(a.pattern, true).test(String(parsed.final ?? ''))) return [true, `final matches /${a.pattern}/`];
    return [false, `final lacks /${a.pattern}/; final: ${excerpt(parsed.final)}`];
  },
  final_mentions(parsed, facts, a) {
    const patterns = a.patterns ?? [];
    const min = a.min ?? patterns.length;
    const hits = patterns.filter((p) => toRegex(p, true).test(String(parsed.final ?? ''))).length;
    if (hits >= min) return [true, `${hits}/${patterns.length} pattern(s) mentioned`];
    return [false, `${hits}/${patterns.length} pattern(s) mentioned, need ${min}; final: ${excerpt(parsed.final)}`];
  },
  commits_lack(parsed, facts, a) {
    const re = toRegex(a.pattern);
    const n = (facts.commitMessages ?? []).filter((m) => re.test(m)).length;
    return [n === 0, `${n} commit message(s) matched /${a.pattern}/`];
  },
};

export function score(parsed, facts, assertions) {
  return (assertions ?? []).map((a) => {
    const type = a?.type;
    const check = Object.prototype.hasOwnProperty.call(CHECKS, type) ? CHECKS[type] : null;
    if (!check) return { type, pass: false, detail: `unknown assertion type: ${type}` };
    try {
      const [pass, detail] = check(parsed, facts ?? {}, a);
      return { type, pass: Boolean(pass), detail };
    } catch (err) {
      return { type, pass: false, detail: `assertion error: ${err.message}` };
    }
  });
}
