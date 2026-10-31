// scripts/lib/plan-impacts.mjs
//
// The `impacts` check of ultra-plan-runner.mjs validatePlan, moved out so the
// runner stays under its size-gate ceiling.

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
//             "none: <reason> - <the command that checked and found nothing downstream>"]
//
// The `"none: <reason> - <command>"` sentinel exists for the same reason
// `skip_if: "false"` does. "This task has no affected surface" is a real answer,
// and it is exactly as easy to fabricate as a check that was never run. Requiring
// the command that checked makes the claim falsifiable instead of decorative.
//
// EVERY entry, the sentinel included, splits on an ASCII " - ": a non-blank part
// before it and at least 8 characters of evidence after it, and no em dash
// anywhere. That is the rule scripts/backfill-plan-impacts.test.mjs applies to
// every registered plan; checking it here means the author hears it from the
// runner instead of from the full gate.
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

const IMPACT_SHAPES = '"<surface> - <evidence command>" or "none: <reason> - <command>"';

// Null when the entry has the backfill test's shape, otherwise what is wrong.
function impactEntryProblem(e) {
  if (e.includes('\u2014')) return 'uses an em dash; the separator is an ASCII " - "';
  const parts = e.split(' - ');
  if (parts.length >= 2 && parts[0].trim() !== '' && parts.slice(1).join(' - ').trim().length >= 8) return null;
  return 'has no checkable evidence after an ASCII " - " separator (at least 8 characters)';
}

// The rejected entry is printed, so its em dash is spelled out rather than echoed.
function quoteImpact(e) {
  const cut = e.length > 80 ? `${e.slice(0, 80)}...` : e;
  return `"${cut.replaceAll('\u2014', '<U+2014>')}"`;
}

// Returns 'ok' | 'missing' | 'invalid'. Pushes its own errors; the caller decides
// what a `missing` claim is worth. A malformed entry is an error only when the plan
// requires impacts; otherwise it lands in `weak` for one aggregated warning.
function impactsShape(t, errors, { requireImpacts = false, weak = [] } = {}) {
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
      + '"none: <reason> - <command>"');
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
  let malformed = false;
  for (const e of v) {
    const problem = impactEntryProblem(e);
    if (!problem) continue;
    if (!requireImpacts) { weak.push(`${t.id} ${quoteImpact(e)}`); continue; }
    errors.push(`task ${t.id} impacts entry ${quoteImpact(e)} ${problem}. Write it as ${IMPACT_SHAPES}`);
    malformed = true;
  }
  return malformed ? 'invalid' : 'ok';
}

export function validateImpacts(plan, errors, warnings) {
  const requireImpacts = plan.defaults?.require_impacts === true;
  const exempted = new Set(plan.defaults?.allow_no_impacts || []);
  const used = new Set();
  const undeclared = [];
  const weak = [];

  for (const t of plan.tasks || []) {
    if (!t.id) continue;
    const state = impactsShape(t, errors, { requireImpacts, weak });
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
        + 'the check that found none as "none: <reason> - <command>". Focus that makes this task green while a '
        + 'consumer of the same interface stays broken is the defect this key exists to catch');
      continue;
    }
    undeclared.push(t.id);
  }

  if (undeclared.length) {
    warnings.push(`${undeclared.length} task(s) declare no impacts: ${undeclared.join(', ')}. `
      + 'Set `defaults.require_impacts: true` in this plan to make it an error instead of a warning');
  }
  if (weak.length) {
    warnings.push(`${weak.length} impacts entr${weak.length === 1 ? 'y has' : 'ies have'} no checkable evidence: `
      + `${weak.join(', ')}. Write each as ${IMPACT_SHAPES}. `
      + 'Set `defaults.require_impacts: true` in this plan to make it an error instead of a warning');
  }
  for (const id of exempted) {
    if (!used.has(id)) {
      errors.push(`defaults.allow_no_impacts names "${id}", but task ${id} either does not exist or `
        + 'already declares impacts');
    }
  }
}
