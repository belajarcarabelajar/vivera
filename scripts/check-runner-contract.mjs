#!/usr/bin/env bun
// The runner-contract check, on its own.
//
// Why it exists as a separate entry point: `validate-skill.mjs` renders all 27
// Mermaid blocks through a headless browser, which takes minutes. A plan's
// `skip_if` and `run[]` steps need to ask "do the template and the master
// skill still declare every key the runner reads?" in about a second, and
// `grep -q 'all N keys present' | bun scripts/validate-skill.mjs` was both slow
// and brittle: when the key count changed from 13 to 18 the grep silently
// stopped matching, so the skip fell through to the slow step and the run
// timed out. A named check with an exit code cannot drift like a string match.
//
// The comparison is STRUCTURAL, not a text search. The first draft of this check
// lived inside validate-skill and grepped for the key name; it passed even after
// `run:` was renamed to `disabled_run:`, because the word still appeared in the
// surrounding prose. Text presence is not structure, which is the same mistake
// the Mermaid contract already forbids.
//
// TWO DIRECTIONS, with different severities, and the asymmetry is the point.
// Forward: a key the runner reads that an artifact omits is an ERROR, because
// the plan cannot run. Reverse: a key an artifact declares that the runner does
// not read is a WARN, because the plan runs fine and carries a field nobody
// acts on, and this repository does not own the verdict on fields like that.
// Both artifacts declared `loop_until` while the runner read nothing under that
// name and this check still exited 0, because it only walked `want`. See
// `unreadKeys` for the measured noise floor that shaped its rule.
//
// Revert: delete this file, and drop the `checkRunnerContract()` call from
// validate-skill.mjs in favour of the inline block it was extracted from.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNER_CONTRACT_KEYS, extractFrontmatter, parseUltraPlanYaml } from './ultra-plan-runner.mjs';
import { strictYamlError } from './frontmatter-strict.mjs';
import { readSkillCorpus } from './skill-corpus.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every key path present in a parsed plan, with array indices dropped so
// `tasks[].run[].cmd` and `tasks.run.cmd` compare equal.
export function keyPaths(obj, prefix = '', out = new Set()) {
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(obj)) { keyPaths(v, prefix, out); continue; } // drop the index
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    keyPaths(v, p, out);
  }
  return out;
}

// Every key path in `RUNNER_CONTRACT_KEYS`, bracketed away the same way
// `keyPaths` drops indices, so `tasks[].run[].cmd` and `tasks.run.cmd` are one
// string on both sides of either comparison.
export function contractPaths() {
  return RUNNER_CONTRACT_KEYS.map((k) => k.replace(/\[\]\./g, '.').replace(/\[\]/g, ''));
}

// The forward half: a key the runner READS that an artifact does not declare.
// This is the direction that was always checked, and it stays an error.
export function missingKeys(planLike) {
  const present = keyPaths(planLike);
  return contractPaths().filter((k) => !present.has(k));
}

// The reverse half, and it is a WARNING, never an error.
//
// A key an artifact declares that `RUNNER_CONTRACT_KEYS` does not name is the
// drift the header above calls "worse than an undocumented one": the template
// taught a key to every agent that wrote a plan, and nothing read it. That is
// exactly what happened with `loop_until`, and the first draft of this reverse
// check did not notice because it only walked `want`.
//
// Why not an error. The errors above are about a plan that cannot RUN: the
// runner reaches for `tasks.run.cmd` and finds nothing, so the step is skipped
// or the plan aborts. This direction is about a plan that runs fine and carries
// a field the runner ignores. Several of those fields are not runner business
// at all and this repository cannot own a verdict on them: `version: 1` in both
// artifacts is a schema stamp for the plan format, not an execution knob, and
// the runner never reads it. Failing the gate over it would mean refusing a
// template field whose correct home (the runner's list, or the schema prose) is
// a decision for whoever owns those, exactly the reasoning that already made an
// unclassifiable `skip_if` a warning rather than a verdict this repository
// cannot own. So it is reported, named, and printed on every run, and it does
// not move the exit code.
//
// NARROWED, and the narrowing is measured rather than guessed. Raw keying over
// both real artifacts produced six extra paths each:
//
//   defaults             container, an ancestor of keys the contract names
//   tasks                container, same
//   tasks.files.create   read, through the `tasks[].files` already named
//   tasks.files.modify   read, through the same parent
//   tasks.files.test     read, through the same parent
//   version              genuinely unread
//
// Five of the six are false positives, and a rule that flagged them would have
// failed both artifacts of this repository on keys the runner demonstrably
// reads. `version` is the one real finding, and it is left in the output on
// purpose: see above for why it is reported rather than fixed here.
//
// The rule has three clauses, each closing one of those false positives:
//   exact      the contract names the declared path
//   container  the declared path is an ANCESTOR of a contract key, so it is a
//              group name (`tasks`, `defaults`) rather than a field
//   opaque     the declared path sits under a parent the contract names
//              deliberately. `tasks[].files` is that parent and it is the only
//              one: the runner does not dispatch on its three children, it
//              iterates `modify` and `test` in `filePrecondition` and `create`
//              in `filePostcondition`, all grouped path lists. Everywhere else
//              the contract names a child exactly when the runner dispatches on
//              it, which is why `tasks[].run` carries `cmd`, `expect_exit`,
//              `retry` and `loop_until` as four separate entries. So
//              `tasks.files.create` is covered while `tasks.run.mystery` is
//              not, and that difference is the whole test of the rule.
//
// The one-entry opaque list is a judgement about the runner's internals, so it
// stays a list with the function names that justify it rather than becoming a
// "skip anything nested" escape hatch.
const OPAQUE_CONTRACT_PATHS = ['tasks.files'];

export function unreadKeys(planLike) {
  const contract = contractPaths();
  const opaque = contract.filter((k) => OPAQUE_CONTRACT_PATHS.includes(k));
  const covered = (p) => contract.includes(p)
    || contract.some((c) => c.startsWith(`${p}.`))
    || opaque.some((c) => p.startsWith(`${c}.`));
  return [...keyPaths(planLike)].filter((p) => !covered(p)).sort();
}

export function checkRunnerContract() {
  const want = contractPaths();
  const problems = [];
  const warnings = [];

  const check = (artifact, planLike, frontmatter) => {
    const strict = strictYamlError(frontmatter);
    if (strict) problems.push(`${artifact} frontmatter is not valid YAML: ${strict}`);
    for (const k of missingKeys(planLike)) {
      problems.push(`the runner reads \`${k}\` but ${artifact} does not declare it`);
    }
    for (const k of unreadKeys(planLike)) {
      warnings.push(`\`${k}\` is declared but no runner contract key reads it (in ${artifact}); `
        + 'the runner ignores it, so a plan that relies on it is not doing what it says');
    }
  };

  const templatePath = path.join(rootDir, 'templates', 'implementation-plan-template.md');
  if (!fs.existsSync(templatePath)) {
    problems.push('templates/implementation-plan-template.md is missing');
  } else {
    try {
      const { frontmatter } = extractFrontmatter(fs.readFileSync(templatePath, 'utf8'));
      check('templates/implementation-plan-template.md', parseUltraPlanYaml(frontmatter), frontmatter);
    } catch (e) {
      problems.push(`templates/implementation-plan-template.md has unusable frontmatter: ${e.message}`);
    }
  }

  // The master file carries the same header template inside a fenced block, so
  // the plan an agent is told to write from the skill and the plan it is told to
  // write from the template cannot diverge silently.
  try {
    const masterText = readSkillCorpus(rootDir);
    const fenced = masterText.match(/```\n---\nschema: ultra-plan\/v1[\s\S]*?\n---\n/);
    if (!fenced) {
      problems.push('the master skill has no fenced `ultra-plan/v1` plan header template to check');
    } else {
      const { frontmatter } = extractFrontmatter(fenced[0].replace(/^```[^\n]*\n/, ''));
      check('the master skill plan header template', parseUltraPlanYaml(frontmatter), frontmatter);
    }
  } catch (e) {
    problems.push(`the master skill plan header template is unusable: ${e.message}`);
  }

  return { problems, warnings, total: want.length };
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-runner-contract.mjs');
if (isMain) {
  const { problems, warnings, total } = checkRunnerContract();
  if (problems.length === 0) {
    console.log(`✅ Runner contract: both artifacts declare all ${total} keys the runner reads.`);
    // Printed BEFORE the problem loop and independently of the exit code, so a
    // green run that carries an unread key still says so. Silently swallowing
    // it would put back the exact blind spot this second direction exists to
    // cover, and `grep -q 'all N keys present'` in a skip_if would then treat a
    // warning run as a clean one.
    for (const w of warnings) console.log(`⚠️  WARN: ${w}`);
    if (warnings.length > 0) {
      console.log(`\n   ${warnings.length} declared key(s) the runner does not read. Reported, not refused: `
        + 'whether each belongs to the runner or to the schema is not this check\'s call to make.');
    }
    process.exit(0);
  }
  for (const p of problems) console.error(`❌ ${p}`);
  for (const w of warnings) console.error(`⚠️  WARN: ${w}`);
  console.error(`\n   ${problems.length} contract key(s) undocumented.`);
  process.exit(1);
}
