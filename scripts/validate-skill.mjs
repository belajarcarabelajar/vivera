#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { checkRunnerContract } from './check-runner-contract.mjs';
import { PHASE_SKILLS, readSkillCorpus } from './skill-corpus.mjs';
import {
  SUBAGENT_CONTRACT_TERMS as subagentContractTerms,
  SNIPPET_CONTRACTS as snippetContracts,
  COMMAND_SNIPPET_CONTRACTS as commandSnippetContracts,
  TINYFISH_LADDER_NEED,
  BANNED_RUNTIME_SNIPPETS,
  hasStrictMermaidFence,
  extractMermaidBlocksStrict,
} from './validate-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('==> Validating the Vivera farm (Ultimate All-in-One AI Skills Repository)...');
let errors = 0;
let skipped = 0;

// A third outcome, distinct from pass and from fail: SKIPPED.
//
// The three conditions that can skip are machine-local state, and every one of
// them is listed in .gitignore: plans.publish.json (.gitignore:62),
// plan.issues.json (.gitignore:63), and the node_modules/ tree holding mmdc
// (.gitignore:6). A fresh clone and a fresh git worktree have none of them, so
// the gate could not tell "the skill is broken" from "this machine has not
// installed the machine-local state yet", and it reported a false alarm on a
// healthy tree.
//
// Why a skip does NOT change the exit code. The alternative, a non-zero exit,
// leaves every fresh clone, every fresh worktree, and every CI run permanently
// red for a condition no commit can fix, and a permanently red gate is a gate
// people learn to skip, which is the outcome this file exists to prevent. So the
// exit code does prove: every check that ran found nothing. The exit code does
// NOT prove: that the skill validated end to end. Those three checks did not run,
// and only a checkout holding the machine-local state can say anything about
// them.
//
// Why the skip is loud instead of silent. The same rule that forbids a gate
// reporting success while proving nothing forbids hiding the parts that did not
// run. Each skip names the absent file or tool and states what it left
// unchecked, the count is carried into the summary line, and the summary stops
// claiming a clean pass while any skip is outstanding. Nobody reaches the last
// line without having been told which checks did not run.
//
// `warn` rather than `log`, so the skip line is visible when a caller captures
// only one stream.
const skip = (what, why) => {
  skipped++;
  console.warn(`⏭️  SKIPPED: ${what} (did not run). ${why}`);
};

// 0b. The runner contract must match what the plan template documents.
//
// The check itself lives in `check-runner-contract.mjs` so a plan's `skip_if`
// and `run[]` steps can invoke it in about a second. This file renders 27
// Mermaid blocks through a headless browser, which takes minutes, and a step
// that shells into that on every re-run is a step that times out.
{
  const { problems, total } = checkRunnerContract();
  if (problems.length === 0) {
    console.log(`✅ Runner contract documented: all ${total} keys present in the template and the master skill.`);
  } else {
    for (const p of problems) console.error(`❌ ${p}`);
    errors += problems.length;
  }
}

// 0c. The copy rules must still EXIST, and this repository's own artifacts must
// obey them.
//
// Why this checks the rules' presence and not just the artifacts: both rules were
// already written in prose, and both still shipped anyway. The em dash was
// specified in the master skill and in the PR template checklist, and 69 of them
// rode out in a single diff. A `Generated with [Claude Code]` footer went out on
// PR #15 in a session that was not Claude Code, supported by no template and no
// precedent in this repository. A rule that only exists in prose cannot stop
// anything, and a rule that exists only in prose has now been measured failing
// twice, so both the rule text and the enforcement are asserted here.
//
// The SCOPE is deliberately narrow: the user-visible ARTIFACTS of this repository
// (README, the PR and review templates, the trigger prompts), not every file. The
// master skill and the code comments legitimately contain em dashes, including in
// this very rule's quoted examples, and a scan that flagged those would teach
// people to ignore the scan.
{
  const { checkFile, checkCommits } = await import('./check-copy-rules.mjs');
  const masterText = readSkillCorpus(rootDir);

  // Are the rules still WRITTEN DOWN? A rule nobody can find is not a rule, and
  // this is the half that costs nothing to assert.
  const missing = [];
  if (!/never use em dashes/i.test(masterText)) missing.push('the master skill no longer states the em-dash copy rule');
  if (!/No Attribution Footer, Watermark, or Co-Author Line/i.test(masterText)) {
    missing.push('the master skill no longer states the no-attribution-footer rule');
  }
  if (missing.length) {
    for (const m of missing) console.error(`❌ ${m}`);
    errors += missing.length;
  } else {
    console.log('✅ Copy rules still stated: em dash and no-attribution-footer.');
  }

  // Are the TEMPLATES still carrying the checklist item? The PR template is what
  // an agent reads at PR time, so a rule missing from it is missing where it is
  // used.
  const prTemplate = fs.readFileSync(path.join(rootDir, 'templates', 'pull-request-template.md'), 'utf8');
  if (!/attribution footer, watermark, badge, or co-author line/i.test(prTemplate)) {
    console.error('❌ templates/pull-request-template.md no longer carries the no-attribution-footer checklist item');
    errors += 1;
  } else {
    console.log('✅ PR template carries both checklist items.');
  }

  // Are the ARTIFACTS obeying them? Scope: the PR-facing templates.
  //
  // NOT this repository's git history. The first version also checked the last 20
  // commit messages and failed on two commits from an earlier session
  // (`feat(exa:...`), which is not this session's to fix and would leave CI red
  // forever on history nobody is going to rewrite. Commit messages are checked by
  // `bun run copy:check --commits`, which an agent runs on its OWN commits before
  // pushing, where a hit is a hit on work this session just produced.
  //
  // README.md is deliberately NOT in the list either. It carries hundreds of em
  // dashes that predate the rule and a harness table that legitimately names
  // Claude Code and Copilot; including it produced dozens of findings on the first
  // run, which is how a gate gets learned to be noise. The rule targets the copy
  // this repository SHIPS. Pass it explicitly via `check-copy-rules.mjs` when a
  // change actually touches it.
  const artifacts = [
    'templates/pull-request-template.md',
    'templates/pr-review-template.md',
    'templates/code-review-template.md',
  ];
  const violations = [];
  for (const a of artifacts) violations.push(...checkFile(a));
  if (violations.length === 0) {
    console.log(`✅ Copy rules obeyed: ${artifacts.length} PR-facing template(s) clean.`);
  } else {
    for (const v of violations) {
      console.error(`❌ ${v.where}  [${v.rule}]${v.detail ? ` ${v.detail}` : ''}`);
      if (v.line) console.error(`     ${v.line}`);
    }
    errors += violations.length;
  }
}

// 0. Check Mandatory Prerequisites: tgrep
try {
  const tgrepOut = execSync('tgrep --version 2>&1 || ~/.local/bin/tgrep --version 2>&1', { encoding: 'utf8' }).trim().split('\n')[0];
  console.log(`✅ Prerequisite verified: ${tgrepOut}`);
} catch (err) {
  console.error('❌ Prerequisite missing: tgrep (microsoft/tgrep) is mandatory.');
  errors++;
}

// 0b-bis. `gh` is the tool the PR delivery stage calls, so it is checked here for
// the same reason tgrep is. This block did not exist while `gh` was an unused
// prerequisite in install.sh, which is exactly how a mandatory dependency rots
// into a decorative one: nothing referenced it, so nothing noticed it was
// missing. Now the skill names `gh pr create` and `gh pr view`, so a machine
// without it cannot finish a session.
//
// Auth is deliberately NOT checked. `gh auth status` reaches the network and can
// prompt, and a validation script that blocks on a credential is a script that
// fails for a reason unrelated to the repository. The skill tells the agent to
// run `gh auth status` once at the start of a session, where a human is present.
try {
  const ghOut = execSync('gh --version 2>&1', { encoding: 'utf8' }).trim().split('\n')[0];
  console.log(`✅ Prerequisite verified: ${ghOut}`);
} catch (err) {
  console.error('❌ Prerequisite missing: gh (GitHub CLI). The PR delivery stage calls `gh pr create`; without it a session cannot open its PR.');
  errors++;
}

// 1. Check Master File & Frontmatter
const masterPath = path.join(rootDir, 'Super Ultra Code Plan Implementation.md');
if (!fs.existsSync(masterPath)) {
  console.error('❌ Master file missing: Super Ultra Code Plan Implementation.md');
  errors++;
} else {
  const content = fs.readFileSync(masterPath, 'utf8');
  if (!content.startsWith('---')) {
    console.error('❌ Master file missing YAML frontmatter opening (---)');
    errors++;
  } else {
    const endFrontmatter = content.indexOf('\n---', 3);
    if (endFrontmatter === -1) {
      console.error('❌ Master file missing YAML frontmatter closing (---)');
      errors++;
    } else {
      const frontmatter = content.substring(3, endFrontmatter);
      const hasName = /name:\s*[\w-]+/.test(frontmatter);
      const hasDesc = /description:\s*.+/.test(frontmatter);
      const hasTriggers = /triggers:/.test(frontmatter);

      if (!hasName || !hasDesc || !hasTriggers) {
        console.error('❌ Frontmatter missing required fields (name, description, triggers)');
        errors++;
      } else {
        console.log('✅ Master file YAML frontmatter valid.');
      }
    }
  }

  // Token estimate (~4 chars per token)
  const charCount = content.length;
  const wordCount = content.trim().split(/\s+/).length;
  const estimatedTokens = Math.round(charCount / 4);
  console.log(`📊 Master file stats: ${charCount} chars, ${wordCount} words, ~${estimatedTokens} estimated tokens.`);

  // 1b. Mandatory Session-Close Debt Sweep contract must stay in the master file.
  // Silently dropping this stage would let every session end with unexamined technical debt.
  const sweepContract = [
    { label: 'Step 6 debt sweep heading', re: /^##\s*6️⃣.*Debt Sweep/m },
    { label: 'Done 100% saturation rule', re: /Plan Completion Saturation Rule/ },
    { label: 'NOW/LATER debt classification', re: /`NOW`/ },
    { label: 'default 3-5 follow-up cap', re: /3-5 follow-up questions|3-5 follow-ups/ },
    { label: 'harness multi-select question injection', re: /multi-select checkboxes/ },
    { label: 'debt sweep template reference', re: /templates\/follow-up-injection-template\.md/ },
  ];
  const corpus = readSkillCorpus(rootDir);
  for (const contract of sweepContract) {
    if (contract.re.test(corpus)) {
      console.log(`✅ Debt sweep contract present: ${contract.label}`);
    } else {
      console.error(`❌ Master file missing debt sweep contract: ${contract.label}`);
      errors++;
    }
  }
}

// 1c. Every phase skill must exist, carry its directory name, and be routed
// from the orchestrator. An unrouted phase is a rule nothing loads.
let phasesOk = 0;
for (const name of PHASE_SKILLS) {
  const skillPath = path.join(rootDir, 'skills', name, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    console.error(`❌ Phase skill missing: skills/${name}/SKILL.md`);
    errors++;
    continue;
  }
  const nameMatch = fs.readFileSync(skillPath, 'utf8').match(/^---\nname:\s*(\S+)/);
  if (!nameMatch || nameMatch[1] !== name) {
    console.error(`❌ skills/${name}/SKILL.md frontmatter name must be "${name}"`);
    errors++;
    continue;
  }
  const orchestrator = fs.readFileSync(path.join(rootDir, 'Super Ultra Code Plan Implementation.md'), 'utf8');
  if (!orchestrator.includes(`\`${name}\``)) {
    console.error(`❌ Orchestrator never routes to \`${name}\`: no phase would load it.`);
    errors++;
    continue;
  }
  phasesOk++;
}
if (phasesOk === PHASE_SKILLS.length) {
  console.log(`✅ Phase skills present, named, and routed: ${phasesOk}/${PHASE_SKILLS.length}.`);
}

// 2. Check Symlinks in skills/super-ultra-code-plan/
const skillDir = path.join(rootDir, 'skills', 'super-ultra-code-plan');
const requiredSkillLinks = ['SKILL.md', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json'];

for (const linkName of requiredSkillLinks) {
  const p = path.join(skillDir, linkName);
  if (!fs.existsSync(p)) {
    console.error(`❌ skills/super-ultra-code-plan/${linkName} does not exist.`);
    errors++;
  } else {
    try {
      const target = fs.readlinkSync(p);
      console.log(`✅ Symlink valid: skills/super-ultra-code-plan/${linkName} -> ${target}`);
    } catch (err) {
      console.error(`❌ Failed to read symlink ${linkName}: ${err.message}`);
      errors++;
    }
  }
}

// 3. Check Templates
const requiredTemplates = [
  'implementation-plan-template.md',
  'spike-report-template.md',
  'systematic-debugging-log-template.md',
  'verification-checklist-template.md',
  'handoff-template.md',
  'progress-log-template.md',
  'adr-template.md',
  'subagent-contract-template.md',
  'code-review-template.md',
  'deep-research-report-template.md',
  'follow-up-injection-template.md',
  'pull-request-template.md',
  'pr-review-template.md',
  'brainstorm-intent-template.md',
  'session-learning-ledger-template.md',
];

for (const tmpl of requiredTemplates) {
  const p = path.join(rootDir, 'templates', tmpl);
  if (fs.existsSync(p)) {
    console.log(`✅ Template present: templates/${tmpl}`);
  } else {
    console.error(`❌ Missing template: templates/${tmpl}`);
    errors++;
  }
}

// 3b. Mandatory Mermaid presence: every planning artifact template must embed at least one mermaid block
const mermaidRequiredTemplates = [
  'implementation-plan-template.md',
  'spike-report-template.md',
  'systematic-debugging-log-template.md',
  'verification-checklist-template.md',
  'adr-template.md',
  'subagent-contract-template.md',
  'code-review-template.md',
  'follow-up-injection-template.md',
  'pull-request-template.md',
  'pr-review-template.md',
  'brainstorm-intent-template.md',
  'session-learning-ledger-template.md',
];
for (const tmpl of mermaidRequiredTemplates) {
  const p = path.join(rootDir, 'templates', tmpl);
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, 'utf8');
    // Strict fence: must match what scripts/render-diagrams.sh extracts
    // (/^```mermaid[ \t]*$/). A loose /```mermaid/ substring test accepts
    // fences the renderer never picks up (e.g. ```mermaid {config}).
    if (hasStrictMermaidFence(content)) {
      console.log(`✅ Mermaid present: templates/${tmpl}`);
    } else {
      console.error(`❌ templates/${tmpl} must contain at least one \`\`\`mermaid diagram (planning always uses Mermaid).`);
      errors++;
    }
  }
}

// 3c. Trigger snippets must carry the mandatory subagent contract.
// A trigger prompt that omits it is the most common cause of an agent quietly
// implementing everything inline, so its absence is a build failure.
//
// The terms are per-snippet, not one global list. The first draft used a single
// array applied to every snippet, which is only correct while every snippet has
// the same job. The PR snippet drives a different phase: it owns the isolation
// contract, the PR body rules, and the ordered batch merge, and forcing the
// plan snippet's vocabulary onto it would be asserting something untrue about
// what that file is for. The shared terms stay shared; the phase-specific ones
// are named per entry. The review snippet (orkestrasi-pr-review.md) owns the
// review path: review + code-review templates and the gh evidence inputs.
// Canonical definitions live in scripts/validate-lib.mjs so unit tests can pin
// them; this file imports them rather than redefining them.

const requiredSnippets = Object.keys(snippetContracts);

for (const [snip, extraTerms] of Object.entries(snippetContracts)) {
  const p = path.join(rootDir, 'snippets', snip);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing trigger snippet: snippets/${snip}`);
    errors++;
    continue;
  }
  const body = fs.readFileSync(p, 'utf8');
  const required = [...subagentContractTerms, ...extraTerms];
  const missing = required.filter((term) => !body.includes(term));
  if (missing.length === 0) {
    console.log(`✅ Trigger snippet carries its contract: snippets/${snip}${extraTerms.length ? ` (+${extraTerms.length} phase terms)` : ''}`);
  } else {
    console.error(`❌ snippets/${snip} is missing required terms: ${missing.join(', ')}`);
    errors++;
  }
}

// 3b-bis. The short cmd-* command snippets carry their own terms only. They are
// not phase triggers, so the fan-out terms and the TinyFish ladder are not
// required of them, but they still may not use a runtime the skill prohibits.
for (const [snip, terms] of Object.entries(commandSnippetContracts)) {
  const p = path.join(rootDir, 'snippets', snip);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing command snippet: snippets/${snip}`);
    errors++;
    continue;
  }
  const body = fs.readFileSync(p, 'utf8');
  const missing = terms.filter((term) => !body.includes(term));
  const banned = BANNED_RUNTIME_SNIPPETS.filter((needle) => body.includes(needle));
  if (missing.length === 0 && banned.length === 0) {
    console.log(`✅ Command snippet carries its contract: snippets/${snip} (${terms.length} terms)`);
  } else {
    if (missing.length) console.error(`❌ snippets/${snip} is missing required terms: ${missing.join(', ')}`);
    if (banned.length) console.error(`❌ snippets/${snip} uses a prohibited runtime: ${banned.join(', ')} (use bun)`);
    errors++;
  }
}

// 3c-bis. Trigger snippets must name the evidence tool.
// Both snippets gate a research phase (deep-research in the plan path, upstream
// issue research in the debugging path), and the master skill routes that
// evidence through TinyFish. A snippet that says "run deep-research" without
// naming how evidence is gathered leaves the agent to improvise its own
// browsing, which is exactly the drift the 3f check exists to stop on the
// master-skill side.
//
// Revert: delete this block.
for (const snip of requiredSnippets) {
  const p = path.join(rootDir, 'snippets', snip);
  if (!fs.existsSync(p)) continue;
  const body = fs.readFileSync(p, 'utf8');
  // Require the ladder's free rungs by name, not the word "TinyFish" alone: a
  // snippet naming the product but not the tools still leaves the escalation
  // order undefined, and the escalation order is the part that costs nothing.
  const need = TINYFISH_LADDER_NEED;
  const missing = need.filter((n) => !body.includes(n));
  if (missing.length === 0) {
    console.log(`✅ Trigger snippet names the TinyFish evidence ladder: snippets/${snip}`);
  } else {
    console.error(`❌ snippets/${snip} does not carry the TinyFish evidence ladder: missing ${missing.join(', ')}`);
    errors++;
  }
}

// 3d. Trigger snippets must not invoke the runtime the skill prohibits.
// The master skill bans npm/npx/bare node in favour of Bun; a snippet that
// reintroduces them is a self-violating instruction.
for (const snip of requiredSnippets) {
  const p = path.join(rootDir, 'snippets', snip);
  if (!fs.existsSync(p)) continue;
  const body = fs.readFileSync(p, 'utf8');
  const banned = BANNED_RUNTIME_SNIPPETS
    .filter((needle) => body.includes(needle));
  if (banned.length === 0) {
    console.log(`✅ Trigger snippet respects the Bun runtime rule: snippets/${snip}`);
  } else {
    console.error(`❌ snippets/${snip} uses a prohibited runtime: ${banned.join(', ')} (use bun)`);
    errors++;
  }
}

// 3g. Mandatory PR delivery contract. Without this stage, a session ends in a
// commit on the working branch, and two concurrent sessions collide in ways no
// git command rejects: two agents on one ref, two agents in one worktree, and a
// batch merged in finish order. Each individual command is valid, so nothing
// downstream reports the collision.
//
// The check asserts the pieces separately because they fail separately: a skill
// that keeps the prose but loses the tool, or keeps the tool but loses the
// "never on the base branch" rule, is exactly the half-migrated state this
// block exists to catch.
//
// Revert: delete this block, the two PR templates, `pr-registry.mjs` and its
// test, the `5.5️⃣` section in the master skill, the PR snippet and its manifest
// entry, and the `pr:*` scripts in package.json.
{
  const prContract = [
    // The stage heading, line-anchored. A plain substring test is satisfied by
    // any cross-reference to the section, so deleting the section while leaving
    // a pointer behind would still pass.
    { label: 'master skill PR delivery heading', file: masterPath, needle: '^## 5\\.5️⃣.*Pull Request Delivery', multiline: true },
    { label: 'master skill claims a derived branch', file: masterPath, needle: 'pr-registry.mjs claim' },
    { label: 'master skill forbids subagent git writes', file: masterPath, needle: 'Git Ownership Is Parent-Only' },
    { label: 'master skill names the PR template', file: masterPath, needle: 'templates/pull-request-template.md' },
    { label: 'master skill names the review template', file: masterPath, needle: 'templates/pr-review-template.md' },
    { label: 'master skill requires a body file', file: masterPath, needle: '--body-file' },
    { label: 'master skill computes merge order', file: masterPath, needle: 'pr-registry.mjs order' },
    { label: 'master skill requires per-merge verification', file: masterPath, needle: 'pr-registry.mjs surface' },
    // The branch shape, stated once in the skill. Prose naming it is what stops an
    // agent from re-deriving a prefixed name by hand when the printed shape looks
    // too plain, and `branchFor` plus its test are the deterministic half.
    { label: 'master skill states the unprefixed branch shape', file: masterPath, needle: '`<plan-id>/<session-slug>`, and carries **no tool, vendor, or workflow prefix**' },
  ];
  if (!fs.existsSync(masterPath)) {
    console.error('❌ PR delivery contract cannot be checked: the master file is missing (see section 1).');
  } else {
    for (const c of prContract) {
      const body = c.file === masterPath ? readSkillCorpus(rootDir) : fs.readFileSync(c.file, 'utf8');
      const present = c.multiline ? new RegExp(c.needle, 'm').test(body) : body.includes(c.needle);
      if (present) {
        console.log(`✅ PR delivery contract present: ${c.label}`);
      } else {
        console.error(`❌ PR delivery contract missing: ${c.label} — ${c.multiline ? 'pattern' : 'literal'} "${c.needle}" not found in ${path.relative(rootDir, c.file)}.`);
        errors++;
      }
    }
  }

  // The allocator and the merge-order resolver are the deterministic half of the
  // stage. Prose that says "pick a unique branch name" is a request, not a
  // guarantee; the tool refusing a collision is the guarantee.
  for (const scr of ['scripts/pr-registry.mjs', 'scripts/pr-registry.test.mjs']) {
    if (fs.existsSync(path.join(rootDir, scr))) {
      console.log(`✅ Script present: ${scr}`);
    } else {
      console.error(`❌ Missing ${scr} (the PR delivery stage names this tool; prose without it is a request, not a guarantee).`);
      errors++;
    }
  }

  // State names are a contract between the skill and the tool. The skill tells an
  // agent to walk isolated -> active -> verified -> open -> merged, so a rename
  // in the tool that leaves the skill naming old states produces instructions no
  // command accepts.
  const registryPath = path.join(rootDir, 'scripts', 'pr-registry.mjs');
  if (fs.existsSync(registryPath) && fs.existsSync(masterPath)) {
    let states = null;
    let branchFor = null;
    try {
      ({ SESSION_STATES: states, branchFor } = await import(registryPath));
    } catch (e) {
      console.error(`❌ Cannot load scripts/pr-registry.mjs to read SESSION_STATES: ${e.message}`);
      errors++;
    }
    const masterBody = readSkillCorpus(rootDir);
    if (Array.isArray(states)) {
      const missing = states.filter((s) => !masterBody.includes(`\`${s}\``));
      if (missing.length === 0) {
        console.log(`✅ Session state names agree: all ${states.length} states appear in the master skill.`);
      } else {
        console.error(`❌ pr-registry.mjs exports states the master skill never names: ${missing.map((s) => `\`${s}\``).join(', ')}. The skill would instruct an agent to run a transition the tool refuses.`);
        errors++;
      }
    }

    // The derived branch shape is a contract with the prose the same way the state
    // names are. It is checked by CALLING branchFor rather than by grepping the
    // source, because the failure this exists to catch is a prefix reintroduced by
    // editing one template literal, and a grep for the absence of `ai/` would pass
    // just as happily over `ai-`, `agent/`, or `bot/`.
    //
    // Revert: delete this block, and the prose in the master skill it checks.
    if (typeof branchFor === 'function') {
      const derived = branchFor('plan-check', 's1');
      const expected = 'plan-check/s1';
      if (derived === expected) {
        console.log(`✅ Derived branch shape agrees with the skill: ${derived} (no tool prefix).`);
      } else {
        console.error(`❌ branchFor derives "${derived}" but the skill states "${expected}". The printed branch and the documented branch disagree, so every PR header names a ref that does not exist.`);
        errors++;
      }
    }
  }
}

// 3h. Mandatory plan-issue mirror contract. The vault mirror makes a plan
// readable; the issue mirror makes its history searchable. Without this section
// the second mirror does not exist, and the answer to "when was this approved,
// what got closed, who said what" lives only in a git log nobody reads.
//
// The check asserts the pieces separately for the same reason 3g does: a skill
// that keeps the prose but drops the tool is the half-migrated state this block
// exists to catch.
//
// Revert: delete this block, `plan.issues.json`, `plan-issue-sync.mjs` and its
// test, the `🐙 Plan → GitHub Issue` section in the master skill, and the
// `issue:*` scripts in package.json.
{
  const issueContract = [
    { label: 'master skill issue-mirror heading', file: masterPath, needle: '^## 🐙 Plan → GitHub Issue$', multiline: true },
    { label: 'master skill names the issue sync CLI', file: masterPath, needle: 'plan-issue-sync.mjs' },
    { label: 'master skill states the state mapping', file: masterPath, needle: 'Blocked' },
    { label: 'master skill keeps the issue number out of the plan', file: masterPath, needle: 'plan.issues.json' },
    { label: 'master skill forbids a summary body', file: masterPath, needle: 'A summary body is banned' },
  ];
  if (!fs.existsSync(masterPath)) {
    console.error('❌ Plan-issue contract cannot be checked: the master file is missing (see section 1).');
  } else {
    for (const c of issueContract) {
      const body = c.file === masterPath ? readSkillCorpus(rootDir) : fs.readFileSync(c.file, 'utf8');
      const present = c.multiline ? new RegExp(c.needle, 'm').test(body) : body.includes(c.needle);
      if (present) {
        console.log(`✅ Plan-issue contract present: ${c.label}`);
      } else {
        console.error(`❌ Plan-issue contract missing: ${c.label} — ${c.multiline ? 'pattern' : 'literal'} "${c.needle}" not found in ${path.relative(rootDir, c.file)}.`);
        errors++;
      }
    }
  }

  for (const scr of ['scripts/plan-issue-sync.mjs', 'scripts/plan-issue-sync.test.mjs']) {
    if (fs.existsSync(path.join(rootDir, scr))) {
      console.log(`✅ Script present: ${scr}`);
    } else {
      console.error(`❌ Missing ${scr} (the plan-issue mirror names this tool; prose without it is a request, not a guarantee).`);
      errors++;
    }
  }

  // The config is a real file, not a default. A plan filed under a guessed
  // repository is worse than one that is not filed, so the mapping from project
  // to owner/repo has to be checked in rather than assumed at runtime.
  const issuesConfigPath = path.join(rootDir, 'plan.issues.json');
  if (!fs.existsSync(issuesConfigPath)) {
    skip(
      'plan.issues.json (the project to owner/repo mapping) is absent, so its JSON was NOT parsed and the project-to-repository mapping was NOT validated',
      'It is gitignored machine-local state (.gitignore:63), so no clone or worktree has it. The publisher and the issue sync cannot resolve a vault or a repository until it is created; this run says nothing about either.',
    );
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(issuesConfigPath, 'utf8'));
      const projects = parsed.projects ?? {};
      if (parsed.version !== 1) {
        console.error(`❌ plan.issues.json has unsupported version ${JSON.stringify(parsed.version)}; this repository writes version 1.`);
        errors++;
      } else if (Object.keys(projects).length === 0) {
        console.error('❌ plan.issues.json declares no projects, so every plan sync would be refused. Add at least {"projects": {"<project>": "owner/repo"}}.');
        errors++;
      } else {
        const bad = Object.entries(projects).filter(([, v]) => !/^[\w.-]+\/[\w.-]+$/.test(String(v)));
        if (bad.length) {
          console.error(`❌ plan.issues.json projects entries must be "owner/repo": ${bad.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
          errors++;
        } else {
          console.log(`✅ Plan-issue registry valid: ${Object.keys(projects).length} project(s) mapped to a repository.`);
        }
      }
    } catch (e) {
      console.error(`❌ plan.issues.json is not valid JSON: ${e.message}`);
      errors++;
    }
  }
}

// 3i. Plan checklist contract.
//
// The to-do list lives in the plan file as a `[ ]` / `[x]` checklist. The harness
// todo tool is deliberately not used: it duplicates the list, is lost on
// compaction or a harness switch, and differs in name across harnesses. This
// block pins the master skill's section, its ownership rule, and its resume
// rule, so a later edit cannot quietly restore a mandate on the harness tool.
//
// Revert: restore the previous `📋 Harness Todo List` section in the master skill
// and this block's needles together.
{
  const todoContract = [
    { label: 'master skill checklist section heading', needle: '^## 📋 Plan Checklist$', multiline: true },
    { label: 'harness todo tool is not used', needle: "Do not use the harness's own todo tool" },
    { label: 'parent owns the checklist', needle: 'The parent owns the checklist' },
    { label: 'blocker when the plan file cannot be written', needle: 'If the plan file cannot be written' },
  ];
  if (!fs.existsSync(masterPath)) {
    console.error('❌ Todo contract cannot be checked: the master file is missing (see section 1).');
  } else {
    const masterBody = readSkillCorpus(rootDir);
    for (const c of todoContract) {
      const present = c.multiline ? new RegExp(c.needle, 'm').test(masterBody) : masterBody.includes(c.needle);
      if (present) {
        console.log(`✅ Plan checklist contract present: ${c.label}`);
      } else {
        console.error(`❌ Plan checklist contract missing: ${c.label}: ${c.multiline ? 'pattern' : 'literal'} "${c.needle}" not found in the master skill.`);
        errors++;
      }
    }
  }
}

// 3e. The snippet manifest must stay consistent with the files it tracks.
// The database comparison itself needs a local Snipset install and runs in
// `bun run snippets:check`, but these invariants hold everywhere, including CI.
{
  const manifestPath = path.join(rootDir, 'snippets.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('❌ Missing snippets.manifest.json (source-to-database mapping)');
    errors++;
  } else {
    let manifest = null;
    const before = errors;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.error(`❌ snippets.manifest.json is not valid JSON: ${e.message}`);
      errors++;
    }
    if (manifest) {
      const entries = Array.isArray(manifest.snippets) ? manifest.snippets : [];
      if (entries.length === 0) {
        console.error('❌ snippets.manifest.json has no entries');
        errors++;
      }
      const uuids = new Set();
      const keywords = new Set();
      for (const e of entries) {
        for (const field of ['source', 'uuid', 'keyword', 'name', 'description']) {
          if (!e[field]) {
            console.error(`❌ snippets.manifest.json entry ${e.source || '(no source)'} is missing "${field}"`);
            errors++;
          }
        }
        if (uuids.has(e.uuid)) {
          console.error(`❌ snippets.manifest.json has duplicate uuid: ${e.uuid}`);
          errors++;
        }
        uuids.add(e.uuid);
        if (keywords.has(e.keyword)) {
          console.error(`❌ snippets.manifest.json has duplicate keyword: ${JSON.stringify(e.keyword)}`);
          errors++;
        }
        keywords.add(e.keyword);
        if (e.source && !fs.existsSync(path.join(rootDir, e.source))) {
          console.error(`❌ snippets.manifest.json references a missing file: ${e.source}`);
          errors++;
        }
        // Every tracked source must itself carry the contract for its own phase,
        // so a database copy can never be the only place the rules exist.
        if (e.source && fs.existsSync(path.join(rootDir, e.source))) {
          const snip = path.basename(e.source);
          const extra = snippetContracts[snip];
          const cmdTerms = commandSnippetContracts[snip];
          if (!extra && !cmdTerms) continue;
          const body = fs.readFileSync(path.join(rootDir, e.source), 'utf8');
          const required = extra ? [...subagentContractTerms, ...extra] : cmdTerms;
          const missing = required.filter((term) => !body.includes(term));
          if (missing.length > 0) {
            console.error(`❌ ${e.source} is tracked in the manifest but is missing: ${missing.join(', ')}`);
            errors++;
          }
        }
      }
      // Conversely, every required trigger snippet must be tracked, or it can
      // never be synced to the database.
      for (const snip of [...requiredSnippets, ...Object.keys(commandSnippetContracts)]) {
        const rel = `snippets/${snip}`;
        if (!entries.some((e) => e.source === rel)) {
          console.error(`❌ ${rel} is not tracked in snippets.manifest.json; it can never reach the database`);
          errors++;
        }
      }
      // A keyword is a global trigger across the whole Snipset install, not a
      // per-file label, so a collision silently shadows another snippet rather
      // than failing. The existing keywords are two-character punctuation
      // sequences, which is why the check below warns on a short one instead of
      // only rejecting exact duplicates.
      for (const e of entries) {
        if (typeof e.keyword === 'string' && e.keyword.length < 3) {
          console.warn(`⚠️  ${e.source}: keyword ${JSON.stringify(e.keyword)} is ${e.keyword.length} character(s). It works, and it is unique today, but a 1-2 character global trigger is easy to shadow by an unrelated snippet added later.`);
        }
      }
      if (errors === before) {
        console.log(`✅ Snippet manifest valid: ${entries.length} tracked entr(ies), no duplicate uuid or keyword.`);
      }
    }
  }
}

// 3f. Deep-research evidence contract: the workflow must name its evidence tool.
// Without a named tool each agent improvises its own browsing and citations stop
// being reproducible. TinyFish is the tool, and as of 2026-10-01 it is integrated
// into the master skill itself rather than a separate vendored skill.
//
// The check verifies the integration is real, not merely that a word appears:
// the master skill must carry the escalation ladder plus the actual tool names
// an agent calls, and the template must defer to that section instead of
// inventing its own rules.
//
// Revert 2026-09-30: delete this block together with the Evidence Gathering
// section in templates/deep-research-report-template.md and the
// "Web Evidence & Retrieval" subsection in the master skill.
{
  const evidenceContract = [
    // The master skill is the source of truth. The heading check is line-anchored
    // on purpose: a plain substring test is satisfied by any cross-reference to
    // the section, so deleting the section while leaving a pointer behind would
    // still pass. A real negative test caught exactly that.
    { label: 'master skill web-evidence heading', file: masterPath, needle: '^### 🌐 Web Evidence & Retrieval — TinyFish$', multiline: true },
    { label: 'master skill escalation ladder', file: masterPath, needle: 'Escalation ladder' },
    { label: 'master skill fetch tool', file: masterPath, needle: 'fetch_content' },
    { label: 'master skill automation tool', file: masterPath, needle: 'run_web_automation' },
    { label: 'master skill browser tool', file: masterPath, needle: 'create_browser_session' },
    // The template must point at the master section, not restate a retired skill.
    { label: 'deep-research template defers to master section', file: path.join(rootDir, 'templates', 'deep-research-report-template.md'), needle: 'Web Evidence & Retrieval' },
  ];
  for (const c of evidenceContract) {
    const body = c.file === masterPath ? readSkillCorpus(rootDir) : fs.readFileSync(c.file, 'utf8');
    const present = c.multiline ? new RegExp(c.needle, 'm').test(body) : body.includes(c.needle);
    if (present) {
      console.log(`✅ Deep-research evidence contract present: ${c.label}`);
    } else {
      console.error(`❌ Deep-research evidence contract missing: ${c.label} — ${c.multiline ? 'pattern' : 'literal'} "${c.needle}" not found in ${path.relative(rootDir, c.file)}.`);
      errors++;
    }
  }
  // The retired separate skill must not linger as a dangling instruction. A stale
  // "use the use-tinyfish skill" pointer is worse than no pointer at all: an agent
  // would go looking for a skill that is no longer deployed.
  for (const c of [
    { label: 'master skill', file: masterPath },
    { label: 'deep-research template', file: path.join(rootDir, 'templates', 'deep-research-report-template.md') },
  ]) {
    const body = c.file === masterPath ? readSkillCorpus(rootDir) : fs.readFileSync(c.file, 'utf8');
    if (body.includes('use-tinyfish')) {
      console.error(`❌ Stale separate-skill pointer: ${c.label} still references "use-tinyfish"; the evidence rules are now inline in the master skill.`);
      errors++;
    } else {
      console.log(`✅ No stale separate-skill pointer: ${c.label}`);
    }
  }
}

// 3b. Check Examples directory
const examplesDir = path.join(rootDir, 'examples');
const requiredExamples = ['worked-example.md', 'deep-research-worked-example.md'];
for (const ex of requiredExamples) {
  const p = path.join(examplesDir, ex);
  if (fs.existsSync(p)) {
    console.log(`✅ Example present: examples/${ex}`);
  } else {
    console.error(`❌ Missing example: examples/${ex}`);
    errors++;
  }
}

// 4. Check Executable Scripts
const scripts = ['install.sh', 'scripts/sync.sh', 'scripts/render-diagrams.sh'];
for (const scr of scripts) {
  const p = path.join(rootDir, scr);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing script: ${scr}`);
    errors++;
  } else {
    console.log(`✅ Script present: ${scr}`);
  }
}

// 4b. Mandatory Plan Publishing contract. A skill contract that can be silently
// deleted is not a contract, so the mandate wording, the CLI it names, and the
// registry the CLI reads are each asserted separately. Placed before section 5
// on purpose: section 5 renders every Mermaid block in the repository with mmdc
// and costs 60-120 seconds, so a cheap missing-contract error must not queue
// behind the expensive render pass.
{
  const planPublishContract = [
    { label: 'Plan Publishing heading', needle: 'Plan Publishing' },
    { label: 'publisher CLI reference', needle: 'plan-publish.mjs' },
    { label: 'idempotency marker', needle: 'SKIPPED-IDEMPOTENT' },
  ];
  if (!fs.existsSync(masterPath)) {
    // Section 1 already counted the missing master file. Re-reading it here
    // would triple-count one root cause, so the wording checks are skipped and
    // the filesystem checks below still run.
    console.error('❌ Plan publishing contract cannot be checked: the master file is missing (see section 1).');
  } else {
    const masterBody = readSkillCorpus(rootDir);
    for (const c of planPublishContract) {
      if (masterBody.includes(c.needle)) {
        console.log(`✅ Plan publishing contract present: ${c.label}`);
      } else {
        console.error(`❌ Master file missing plan publishing contract: ${c.label} — literal "${c.needle}" not found.`);
        errors++;
      }
    }
  }

  const publisherPath = path.join(rootDir, 'scripts', 'plan-publish.mjs');
  if (fs.existsSync(publisherPath)) {
    console.log('✅ Script present: scripts/plan-publish.mjs');
  } else {
    console.error('❌ Missing script: scripts/plan-publish.mjs (the Plan Publishing mandate names a CLI that does not exist).');
    errors++;
  }

  const publishConfigPath = path.join(rootDir, 'plans.publish.json');
  if (!fs.existsSync(publishConfigPath)) {
    skip(
      'plans.publish.json (the publish registry) is absent, so its JSON was NOT parsed and the publish registry was NOT validated',
      'It is gitignored machine-local state (.gitignore:62), so no clone or worktree has it. The publisher cannot resolve a vault until it is created; this run says nothing about it.',
    );
  } else {
    try {
      JSON.parse(fs.readFileSync(publishConfigPath, 'utf8'));
      console.log('✅ Plan publish registry is valid JSON: plans.publish.json');
    } catch (e) {
      console.error(`❌ plans.publish.json is not valid JSON: ${e.message}`);
      errors++;
    }
  }

  // PUBLISHER_VERSION is a BUMP OBLIGATION, not bookkeeping, and this is the
  // only thing in the repository that enforces it. Freshness in
  // plan-publish.mjs keys on publisher_version as well as on source_hash, so a
  // change to the transform that alters published output MUST increment this
  // constant. If it is not bumped, every mirror written by the previous version
  // keeps reporting itself current and never heals — the exact failure this
  // constant was added to fix, and it is silent. Nothing else would notice.
  //
  // This IMPORTS the module and inspects the real export rather than grepping
  // the source: a text search for the word passes when the identifier appears in
  // a comment, which is precisely the state this guard exists to catch.
  const frontmatterModulePath = path.join(rootDir, 'scripts', 'plan-publish-frontmatter.mjs');
  if (!fs.existsSync(frontmatterModulePath)) {
    console.error('❌ Missing script: scripts/plan-publish-frontmatter.mjs (the transform whose PUBLISHER_VERSION gates mirror freshness does not exist).');
    errors++;
  } else {
    let observedVersion;
    let probeFailure = null;
    try {
      const mod = await import(frontmatterModulePath);
      observedVersion = mod.PUBLISHER_VERSION;
    } catch (e) {
      probeFailure = e;
    }
    if (probeFailure) {
      console.error(`❌ Cannot load scripts/plan-publish-frontmatter.mjs to read PUBLISHER_VERSION: ${probeFailure.message}`);
      errors++;
    } else if (!Number.isInteger(observedVersion)) {
      console.error(`❌ scripts/plan-publish-frontmatter.mjs must DEFINE and EXPORT an integer PUBLISHER_VERSION; the export is ${observedVersion === undefined ? 'absent' : `${typeof observedVersion} ${JSON.stringify(observedVersion)}`}. Mirrors would never be invalidated when the transform changes.`);
      errors++;
    } else {
      console.log(`✅ Plan publish freshness stamp exported: PUBLISHER_VERSION = ${observedVersion}`);
    }
  }
}

// 5. Mermaid Block Validation
const mmdcPath = path.join(rootDir, 'node_modules', '.bin', 'mmdc');
const mmdcAvailable = fs.existsSync(mmdcPath) ||
  (() => { try { execSync('mmdc --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

if (!mmdcAvailable) {
  // A counted SKIP, and not a warning, because a silent one is exactly what the
  // Zero-Tolerance Clean Pass rule forbids: the render gate is the only thing
  // here that reads the rendered SVG, so if it does not run, this output proves
  // nothing about Mermaid syntax, syntax-level accessibility metadata, or the
  // a11y wiring in the output. The skip line names the tool, the summary line
  // carries the count, and the exit code stays clean so a fresh clone is not
  // permanently red for a gitignored toolchain.
  skip(
    'mmdc not found, so the entire Mermaid render gate did NOT run: no block was parsed by the renderer, no diagram was rendered, and neither the source accTitle/accDescr check nor the rendered-SVG <title>/<desc> + aria-labelledby wiring check was performed',
    'mmdc comes from the gitignored node_modules/ tree (.gitignore:6). Install the pinned toolchain with `bun install` and re-run to actually validate Mermaid; until then every diagram in this repository is unrendered and unproven.',
  );
  console.warn('   Install the pinned toolchain first: bun install');
} else {
  const mmdc = fs.existsSync(mmdcPath) ? mmdcPath : 'mmdc';
  const mdFiles = [];

  function findMdFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'diagrams') continue;
      const full = path.join(dir, entry.name);
      // Skip symlinks: skills/*/SKILL.md points at the master file, so scanning
      // it would validate (and later render) every diagram twice.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) findMdFiles(full);
      else if (entry.name.endsWith('.md')) mdFiles.push(full);
    }
  }
  findMdFiles(rootDir);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mermaid-'));
  let mermaidValid = 0;
  let mermaidInvalid = 0;
  let mermaidMissingA11y = 0;
  let mermaidMissingWiring = 0;

  // Accessibility contract: every diagram must carry accTitle + accDescr, which
  // mermaid emits as <title>/<desc> wired to aria-labelledby. Without them the
  // SVG is an unlabelled graphic for screen readers.
  const a11yRe = /accTitle:[^\n]*\n\s*accDescr:/;

  for (const mdFile of mdFiles) {
    const content = fs.readFileSync(mdFile, 'utf8');
    // Strict extraction mirroring scripts/render-diagrams.sh awk
    // (/^```mermaid[ \t]*$/ open, /^```[ \t]*$/ close). Canonical
    // implementation lives in scripts/validate-lib.mjs.
    const blocks = extractMermaidBlocksStrict(content);

    for (let i = 0; i < blocks.length; i++) {
      const rel = path.relative(rootDir, mdFile);
      const tmpIn = path.join(tmpDir, `block-${mermaidValid + mermaidInvalid + 1}.mmd`);
      const tmpOut = path.join(tmpDir, `block-${mermaidValid + mermaidInvalid + 1}.svg`);
      fs.writeFileSync(tmpIn, blocks[i]);
      const puppeteerCfg = path.join(rootDir, 'puppeteer-config.json');
      const mermaidCfg = path.join(rootDir, 'mermaid.config.json');
      const cfgFlag = [
        fs.existsSync(mermaidCfg) ? ` -c "${mermaidCfg}"` : '',
        fs.existsSync(puppeteerCfg) ? ` -p "${puppeteerCfg}"` : '',
      ].join('');
      try {
        execSync(`"${mmdc}"${cfgFlag} -b transparent --input "${tmpIn}" --output "${tmpOut}"`, { stdio: 'pipe' });
        mermaidValid++;
      } catch (err) {
        console.error(`❌ Mermaid syntax error in ${rel} [block ${i + 1}]`);
        console.error(`   ${err.stderr?.toString().trim().split('\n')[0] || 'unknown error'}`);
        mermaidInvalid++;
        errors++;
        continue;
      }

      if (!a11yRe.test(blocks[i])) {
        console.error(`❌ Missing accessibility metadata in ${rel} [block ${i + 1}]: add accTitle + accDescr.`);
        mermaidMissingA11y++;
        errors++;
        continue;
      }

      // Source-level accTitle/accDescr is necessary but not sufficient. The
      // skill claims Mermaid emits these as <title>/<desc> wired to
      // aria-labelledby, and that claim is about the RENDERED SVG, not the
      // source. Checking only the source would pass even if the renderer
      // silently dropped the wiring, which is exactly the kind of claim that
      // goes stale unnoticed.
      //
      // I had this backwards once: a grep reported no <title> in a rendered
      // diagram, and I concluded from one failed tool result that the feature
      // was broken. It was not — the tags and the aria wiring were both there.
      // So this check reads the SVG the renderer just wrote, and the negative
      // control is a block whose source has no accTitle at all, not a guess
      // about renderer behaviour.
      const svg = fs.readFileSync(tmpOut, 'utf8');
      const wired = /<title[^>]*>/.test(svg)
        && /<desc[^>]*>/.test(svg)
        && /aria-labelledby="[^"]*"/.test(svg)
        && /aria-describedby="[^"]*"/.test(svg);
      if (!wired) {
        console.error(`❌ Rendered SVG lacks the a11y wiring in ${rel} [block ${i + 1}]: the source declares `
          + 'accTitle/accDescr but the output has no <title>/<desc> pair referenced by aria-labelledby/aria-describedby.');
        mermaidMissingWiring++;
        errors++;
      }
    }
  }

  // Cleanup temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (mermaidInvalid > 0) {
    console.error(`❌ Mermaid validation: ${mermaidValid} valid, ${mermaidInvalid} invalid block(s).`);
  } else {
    console.log(`✅ Mermaid validation: ${mermaidValid} block(s) valid.`);
  }

  if (mermaidMissingA11y > 0) {
    console.error(`❌ Accessibility: ${mermaidMissingA11y} diagram(s) lack accTitle/accDescr.`);
  } else {
    console.log('✅ Accessibility: every diagram carries accTitle + accDescr.');
  }

  if (mermaidMissingWiring === 0) {
    console.log('✅ Accessibility: every rendered SVG carries the a11y wiring (<title>/<desc> + aria-labelledby/aria-describedby).');
  } else {
    console.error(`❌ Rendered SVG: ${mermaidMissingWiring} diagram(s) render without the a11y wiring.`);
  }
}

// 6. Mermaid theming config must exist and stay paired with the renderer.
const themeConfigs = [
  ['mermaid.config.json', 'light'],
  ['mermaid.dark.config.json', 'dark'],
];
for (const [cfg, variant] of themeConfigs) {
  const p = path.join(rootDir, cfg);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing mermaid ${variant} config: ${cfg}`);
    errors++;
    continue;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed.fontFamily) {
      console.error(`❌ ${cfg} must pin fontFamily; an unpinned font re-flows labels per viewer.`);
      errors++;
    } else if (!parsed.theme) {
      console.error(`❌ ${cfg} must pin theme.`);
      errors++;
    } else {
      console.log(`✅ Mermaid ${variant} config valid: theme=${parsed.theme}, fontFamily=${parsed.fontFamily}`);
    }
  } catch (e) {
    console.error(`❌ ${cfg} is not valid JSON: ${e.message}`);
    errors++;
  }
}

// 7. The committed README hero must exist; GitHub does not render Mermaid in raw HTML.
for (const hero of ['lifecycle.svg', 'lifecycle-dark.svg']) {
  const p = path.join(rootDir, 'diagrams', hero);
  if (fs.existsSync(p)) {
    console.log(`✅ Committed hero present: diagrams/${hero}`);
  } else {
    console.error(`❌ Missing committed hero: diagrams/${hero} (run: bash scripts/render-diagrams.sh)`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n❌ Validation failed with ${errors} error(s).`);
  if (skipped > 0) {
    // A failure with outstanding skips has to say both, or the error count reads
    // as the whole result and the unrun checks disappear from the summary.
    console.error(`   ${skipped} further check(s) did not run: this run proves neither that the skill is clean nor that it is complete.`);
  }
  process.exit(1);
} else if (skipped > 0) {
  // Deliberately NOT "All validations passed successfully". Nothing failed, but
  // something did not run, and a clean-pass line printed over skipped checks is
  // the exact claim the Zero-Tolerance Clean Pass rule forbids. Exit stays 0: see
  // the skip helper for what that does and does not prove.
  console.log(`\n⚠️  No failures in the checks that ran, but ${skipped} check(s) were SKIPPED, so this is NOT a clean pass.`);
  console.log('   This run does NOT prove the skill is correct end to end. Each ⏭️ line above names the missing input and the check it did not perform.');
} else {
  console.log('\n✅ All validations passed successfully!');
}
