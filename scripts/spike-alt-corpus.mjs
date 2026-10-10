#!/usr/bin/env node
// T1 — can a corpus of design-alternative pairs be built at all?
//
// THE ADMISSION TEST, STATED BEFORE THIS FILE EXISTED
//
// A harvested pair is admitted only when both texts come from the same
// alternative set in a real plan file, and a human-readable adjudication of
// `near-duplicate` or `distinct` is recorded per row. A row built by rewriting,
// paraphrasing, truncating, or synthesising an alternative is marked
// `synthetic: true`, counted separately, and EXCLUDED from the probe's score.
//
// That exclusion is the whole point, and it is here because of what happened to
// version 1 of the parent spike: a 77-row corpus with 96.1% of rows in one
// class passed its own size precondition and measured nothing. The obvious way
// to manufacture near-duplicate pairs is to restate an existing alternative --
// "add words to SENSITIVE_PATTERNS" becomes "extend the SENSITIVE_PATTERNS
// list" -- and every such pair is trivially separable by string overlap. A
// 6-line cosine baseline scores 1.00 on them. Measuring Jev on rows like that
// reports that a 273 ms network call beats arithmetic.
//
// WHY THIS REFUSES RATHER THAN REPORTS
//
// `classBalance` marks the corpus degenerate when the `near-duplicate` class is
// empty, and the CLI then exits 1 without writing the scored file. A corpus
// whose minority class is empty cannot measure calibration -- every bin would
// have a constant outcome and any ECE would be reporting the class prior -- and
// its agreement number is unfalsifiable, because a model answering `distinct`
// to every row scores 1.00. That number is indistinguishable from a good model
// unless you know the class counts, which is why the counts are printed on the
// way out and the file is not written at all.
//
// This mirrors `checkPreconditions` in `spike-skipif-corpus.mjs`, which fails closed with
// `E_PRECOND_IMBALANCE` for exactly the same reason.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadRegistry, enumeratePlans, resolveProject } from './plan-publish-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'spike-out', 'alt-corpus.json');
const CONFIG = process.env.PLAN_PUBLISH_CONFIG || path.join(ROOT, 'plans.publish.json');

export const LABELS = ['near-duplicate', 'distinct'];

// A heading that opens an alternatives block. Its presence is recorded on the
// set but is NOT an admission requirement: two of the three real sets carry no
// such heading, and requiring one would have dropped 2 of the 4 within-set
// pairs this corpus actually has.
const SECTION_HEADING =
  /^#{2,4}\s*(Architectural trade-offs|Trade-offs|Options|Alternatives|Approaches|Design options)\b/im;

// `Option A`, `Approach B`, `Alternative C`, with or without a bullet, a pipe,
// a bold marker, and an optional `.`/`:`/`)` after the letter. The body must
// clear MIN_BODY characters, because a bare `Option A:` label is a heading for
// an alternative, not the alternative.
const ITEM =
  /^\s*(?:[-*|#]\s*)?\**\s*(?:Option|Approach|Alternative)\s+([A-Z])\b[.:)]?\s*(.*)$/i;

// 40 characters. Chosen because the shortest real alternative body in the
// workspace is 78, so the threshold has a wide margin below the smallest real
// row and is not fitted to any one of them.
export const MIN_BODY = 40;

// Sections that are never alternatives, however they are worded.
const EXCLUDED_SECTION =
  /^#{1,6}\s*(Glossary|Appendix|Bibliography|References|Index)\b/im;

export function normalizeBody(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/** Pull every alternative out of one plan's markdown. */
export function parseAlternatives(md) {
  const lines = md.split('\n');
  const out = [];
  let excluded = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) excluded = EXCLUDED_SECTION.test(line);
    if (excluded) continue;
    const m = line.match(ITEM);
    if (!m) continue;
    // Strip the markdown emphasis the ITEM regex leaves behind, and a
    // `(recommended):**` tail that some plans bolt onto the label.
    let body = normalizeBody(m[2].replace(/^\**/, '').replace(/\**$/, '').replace(/^\(recommended\)\s*:\s*/i, ''));
    if (body.length < MIN_BODY) continue;
    out.push({ id: m[1].toUpperCase(), body });
  }
  return out;
}

/**
 * Adjudication, kept as data so a reader can check the call rather than trust it.
 *
 * `crossSet: true` pairs are never adjudicated: they come from different plans
 * about different subjects and are trivially distinct, which is why plan §5
 * excludes them from the minimum-pair count. Counting them would let a corpus
 * reach 30 rows by padding itself with rows that prove nothing.
 *
 * `label` is a human reading of the two texts. The row keeps the verbatim `a`
 * and `b` so the judgement can be re-checked, and `rationale` says why. A pair
 * whose texts propose different mechanisms is `distinct`; `near-duplicate` is
 * reserved for two texts reaching the same design by different wording.
 */
export const ADJUDICATIONS = {
  // Snipset 2026-09-06-clipboard-profanity-filter.md
  'profanity:A:B': {
    label: 'distinct',
    rationale: 'a lookup list versus a detector with persisted per-entry policy: two mechanisms, not two phrasings',
  },
  'profanity:A:C': {
    label: 'distinct',
    rationale: 'a curated word list versus a language model: the whole question is whether context is available',
  },
  'profanity:B:C': {
    label: 'distinct',
    rationale: 'a deterministic detector versus a model: offline and inspectable versus probabilistic and not',
  },
  // Snipset 2026-09-17-website-release-pinning-followup-implementation-plan.md
  'pinning:A:B': {
    label: 'distinct',
    rationale: 'restore the coverage gate versus delete it: opposite actions, not competing phrasings',
  },
};

export function setKeyOf(planFile) {
  const base = path.basename(planFile);
  if (base.includes('profanity')) return 'profanity';
  if (base.includes('release-pinning')) return 'pinning';
  return stableId(base).slice(0, 8);
}

/**
 * Every within-set pair from a harvested set, keyed for adjudication lookup.
 *
 * The two members are ordered by letter, not by position in the file. A pair is
 * an unordered proposition — "A and B are the same approach" does not depend on
 * which one a plan happened to print first — so the order has to come from
 * something the input does not control. Getting this wrong is not cosmetic: the
 * `pairKey` and the row `id` are both derived from it, so a file whose bullets
 * were reordered would produce different ids, look up no adjudication, and score
 * every row as unlabelled. That is the byte-identical property `skip_if` rests
 * on, and it has to hold against input ordering, not just against a re-read.
 */
export function pairsOf(set) {
  const out = [];
  for (let i = 0; i < set.alts.length; i++) {
    for (let j = i + 1; j < set.alts.length; j++) {
      const [x, y] = set.alts[i].id <= set.alts[j].id
        ? [set.alts[i], set.alts[j]]
        : [set.alts[j], set.alts[i]];
      out.push({ set, a: x, b: y });
    }
  }
  return out;
}

/**
 * Build the corpus. Returns rows sorted by content-addressed id so a re-run is
 * byte-identical, which is the property that lets `skip_if` mean anything.
 */
export function buildCorpus(sets) {
  const rows = [];
  for (const set of sets) {
    for (const p of pairsOf(set)) {
      const key = `${set.key}:${p.a.id}:${p.b.id}`;
      const adj = ADJUDICATIONS[key];
      rows.push({
        id: stableId(`${set.key}|${p.a.id}|${p.b.id}`),
        setId: set.key,
        pairKey: key,
        a: p.a.body,
        b: p.b.body,
        // No adjudication means no label, and an unlabelled row is not evidence.
        // It is kept, marked unlabelled, and excluded from the score -- a guess
        // recorded as a label is how a corpus stops meaning anything.
        label: adj?.label ?? null,
        rationale: adj?.rationale ?? 'no adjudication recorded',
        hard: false,
        synthetic: false,
        crossSet: false,
        project: set.project,
        sourceA: `${set.plan}#${p.a.id}`,
        sourceB: `${set.plan}#${p.b.id}`,
      });
    }
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Cross-set pairs, recorded for completeness and excluded from every count. */
export function crossPairs(sets) {
  const out = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const a of sets[i].alts) {
        for (const b of sets[j].alts) {
          // Same ordering rule as pairsOf, for the same reason.
          const [x, y] = a.id <= b.id ? [a, b] : [b, a];
          out.push({
            setId: `${sets[i].key}~${sets[j].key}`,
            a: x.body,
            b: y.body,
            label: 'distinct',
            rationale: 'different plans about different subjects; trivially distinct and excluded from every count',
            crossSet: true,
            synthetic: false,
          });
        }
      }
    }
  }
  return out;
}

/**
 * The balance check. `degenerate` is true when the minority class is empty,
 * which is the condition plan §5 condition 2 refuses on.
 *
 * `scored` is the number of rows that would actually be scored: labelled,
 * non-synthetic, within-set. Cross-set rows are counted separately and never
 * folded into `total`, so a corpus cannot reach a threshold by padding.
 */
export function classBalance(corpus, cross = []) {
  let nearDuplicate = 0;
  let distinct = 0;
  let unlabelled = 0;
  let synthetic = 0;
  for (const row of corpus) {
    if (row.synthetic) { synthetic++; continue; }
    if (row.crossSet) continue;
    if (row.label === 'near-duplicate') nearDuplicate++;
    else if (row.label === 'distinct') distinct++;
    else unlabelled++;
  }
  const total = nearDuplicate + distinct + unlabelled;
  return {
    total,
    nearDuplicate,
    distinct,
    unlabelled,
    synthetic,
    crossSet: cross.length,
    degenerate: nearDuplicate === 0,
  };
}

export function stableId(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

/** Every plan the registry enumerates, reduced to its alternative sets. */
export function harvest(configPath = CONFIG) {
  const reg = loadRegistry(configPath);
  const sets = [];
  for (const planPath of enumeratePlans(reg)) {
    let text;
    try { text = fs.readFileSync(planPath, 'utf8'); } catch { continue; }
    const alts = parseAlternatives(text);
    if (alts.length < 2) continue;
    sets.push({
      key: setKeyOf(planPath),
      plan: planPath,
      project: resolveProject(reg, planPath)?.name ?? null,
      sectionHeading: SECTION_HEADING.test(text),
      alts,
    });
  }
  return sets.sort((a, b) => (a.plan < b.plan ? -1 : 1));
}

function pct(n, d) {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

function main(argv) {
  const outArg = argv.indexOf('--out');
  const out = outArg === -1 ? DEFAULT_OUT : path.resolve(ROOT, argv[outArg + 1]);
  const statsOnly = argv.includes('--stats');

  const sets = harvest();
  const corpus = buildCorpus(sets);
  const cross = crossPairs(sets);
  const bal = classBalance(corpus, cross);

  console.log(`alternative sets with >= 2 real bodies: ${sets.length}`);
  for (const s of sets) {
    console.log(`  ${s.project ?? '?'}  ${path.basename(s.plan)}  (${s.alts.length} alternatives, section heading: ${s.sectionHeading})`);
    for (const a of s.alts) console.log(`      [${a.id}] ${a.body.slice(0, 96)}`);
  }

  console.log(`\nbalance`);
  console.log(`  sets                  ${sets.length}`);
  console.log(`  within-set pairs      ${bal.total + bal.unlabelled === 0 ? 0 : bal.total}`);
  console.log(`    near-duplicate      ${bal.nearDuplicate}`);
  console.log(`    distinct            ${bal.distinct}`);
  console.log(`    unlabelled          ${bal.unlabelled}`);
  console.log(`  synthetic (excluded)  ${bal.synthetic}`);
  console.log(`  cross-set (excluded)  ${bal.crossSet}`);

  if (bal.degenerate) {
    // Fail closed, loudly, and write nothing. See the header: a corpus with no
    // minority class produces an agreement number that cannot be told apart
    // from a perfect one.
    console.error('');
    console.error(`E_PRECOND_IMBALANCE: near-duplicate ${bal.nearDuplicate}, distinct ${bal.distinct}.`);
    console.error('Calibration cannot be measured against an empty minority class, and an agreement');
    console.error('number over these rows would be the class prior rather than a result.');
    console.error(`Nothing written to ${path.relative(ROOT, out)}.`);
    console.error('');
    console.error('This is the plan\'s RED phase, not a malfunction. Plan §5 condition 2 requires at');
    console.error('least 8 near-duplicate pairs; the workspace has none that a human wrote after');
    console.error('genuinely weighing two routes. See the plan\'s §2 and §6 T3 Step 4.');
    process.exit(1);
  }

  if (bal.unlabelled > 0) {
    console.error(`\nE_PRECOND_UNLABELLED: ${bal.unlabelled} pair(s) have no adjudication in ADJUDICATIONS and`);
    console.error('are excluded from the score. An unlabelled row is not evidence; a guess recorded as');
    console.error('a label is how a corpus stops meaning anything.');
    process.exit(1);
  }

  const payload = {
    probe: 'jev-alt-dedupe-corpus',
    harvestedAt: new Date().toISOString(),
    registry: CONFIG,
    admissionTest: 'both texts from one alternative set in a real plan, adjudicated by a human reading; synthetic rows excluded from the score',
    balance: bal,
    sets: sets.map((s) => ({ key: s.key, plan: s.plan, project: s.project, sectionHeading: s.sectionHeading, alternatives: s.alts })),
    rows: corpus,
    crossSetPairs: cross,
  };
  if (!statsOnly) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nwrote ${path.relative(ROOT, out)} (${corpus.length} scored rows)`);
  }
  console.log(`\nscored ${bal.total} rows · near-duplicate ${pct(bal.nearDuplicate, bal.total)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}