#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { checkRunnerContract } from './check-runner-contract.mjs';
import { TIERS, checkPrereqs, hasTool, loadTierTable } from './lib/prereq.mjs';
import { PHASE_SKILLS, readSkillCorpus, readSkillText } from './skill-corpus.mjs';
// Safe to import: plan-issue-sync runs its CLI only when it is argv[1] itself.
import { ISSUES_STORE } from './plan-issue-sync.mjs';
import { systemPuppeteerBrowser } from './puppeteer-browser.mjs';
import {
  SUBAGENT_CONTRACT_TERMS as subagentContractTerms,
  SNIPPET_CONTRACTS as snippetContracts,
  COMMAND_SNIPPET_CONTRACTS as commandSnippetContracts,
  TINYFISH_LADDER_NEED,
  BANNED_RUNTIME_SNIPPETS,
  hasStrictMermaidFence,
  extractMermaidBlocksStrict,
  renderMermaidBatch,
  checkGateCatalog,
  classifyMermaidResult,
} from './validate-lib.mjs';
import { INVARIANTS, checkInvariants, listDocReferenceFiles } from './lib/skill-invariants.mjs';
import { checkDocReferences } from './lib/doc-references.mjs';
import { DEFAULT_CACHE_REL, cacheKey, loadCache, saveCache, partition, recordResults, rendererVersion } from './lib/mermaid-cache.mjs';

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

// 0c. This repository's own artifacts must obey the copy rules. Whether the
// rules are still written down is a wording question; add it to INVARIANTS in
// lib/skill-invariants.mjs as one line if it needs pinning.
//
// The SCOPE is deliberately narrow: the user-visible ARTIFACTS of this repository
// (README, the PR and review templates, the trigger prompts), not every file. The
// master skill and the code comments legitimately contain em dashes, including in
// this very rule's quoted examples, and a scan that flagged those would teach
// people to ignore the scan.
{
  const { checkFile, checkCommits } = await import('./check-copy-rules.mjs');
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

// 0. Prerequisites for the chosen tier (scripts/install/tiers.tsv). The default
// tier is `full`, so the CI gate keeps a missing tgrep or gh a hard error; a
// lower tier records a counted SKIP instead.
//
// `gh` is required because the PR delivery stage calls `gh pr create` and `gh pr view`.
// Auth is not checked: `gh auth status` reaches the network and can prompt.
{
  // `--tier x` and `--tier=x` both count, and the last one given wins, as in install.sh.
  let tierArg;
  let tierGiven = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tier') {
      tierGiven = true;
      tierArg = argv[++i];
    } else if (argv[i].startsWith('--tier=')) {
      tierGiven = true;
      tierArg = argv[i].slice('--tier='.length);
    }
  }
  const tier = tierGiven ? tierArg : process.env.VIVERA_TIER || 'full';
  if (!TIERS.includes(tier)) {
    console.error(`❌ Invalid tier "${tier ?? ''}" (from --tier or VIVERA_TIER). Expected one of: ${TIERS.join(', ')}.`);
    process.exit(2);
  }
  const tierRows = loadTierTable();
  // The wording these two checks printed before the tier table existed; kept verbatim.
  const missingMessage = {
    tgrep: '❌ Prerequisite missing: tgrep (microsoft/tgrep) is mandatory.',
    gh: '❌ Prerequisite missing: gh (GitHub CLI). The PR delivery stage calls `gh pr create`; without it a session cannot open its PR.',
  };
  for (const tool of ['tgrep', 'gh']) {
    const version = hasTool(tool);
    const verdict = checkPrereqs({ tier, rows: tierRows.filter((r) => r.tool === tool), has: () => version });
    if (version) {
      console.log(`✅ Prerequisite verified: ${version}`);
    } else if (verdict.errors.length > 0) {
      console.error(missingMessage[tool]);
      errors++;
    } else {
      skip(`prerequisite ${tool} at tier ${tier}`, `${verdict.warnings[0]}.`);
    }
  }
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
  'spec-template.md',
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
  'spec-template.md',
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

// 3g. The PR delivery stage names tools. Prose that says "pick a unique branch"
// is a request; the tool refusing a collision is the guarantee, so the tools and
// their contract with the skill are checked here.
{
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

// 3h. The plan-issue mirror names a sync CLI and a checked-in project mapping.
{
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
  // ISSUES_STORE is the file the sync CLI and the merged gate read, so a
  // PLAN_ISSUES_CONFIG override is validated here too, not a different file.
  const issuesConfigPath = ISSUES_STORE;
  const issuesRel = path.relative(rootDir, issuesConfigPath);
  const issuesLabel = issuesRel.startsWith('..') || path.isAbsolute(issuesRel) ? issuesConfigPath : issuesRel;
  if (!fs.existsSync(issuesConfigPath)) {
    skip(
      `${issuesLabel} (the plan.issues.json project to owner/repo mapping, overridable with PLAN_ISSUES_CONFIG) is absent, so its JSON was NOT parsed and the project-to-repository mapping was NOT validated`,
      'The default plan.issues.json is gitignored machine-local state (.gitignore:63), so no clone or worktree has it. The publisher and the issue sync cannot resolve a vault or a repository until it is created; this run says nothing about either.',
    );
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(issuesConfigPath, 'utf8'));
      const projects = parsed.projects ?? {};
      if (parsed.version !== 1) {
        console.error(`❌ ${issuesLabel} has unsupported version ${JSON.stringify(parsed.version)}; this repository writes version 1.`);
        errors++;
      } else if (Object.keys(projects).length === 0) {
        console.error(`❌ ${issuesLabel} declares no projects, so every plan sync would be refused. Add at least {"projects": {"<project>": "owner/repo"}}.`);
        errors++;
      } else {
        const bad = Object.entries(projects).filter(([, v]) => !/^[\w.-]+\/[\w.-]+$/.test(String(v)));
        if (bad.length) {
          console.error(`❌ ${issuesLabel} projects entries must be "owner/repo": ${bad.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
          errors++;
        } else {
          console.log(`✅ Plan-issue registry valid: ${Object.keys(projects).length} project(s) mapped to a repository.`);
        }
      }
    } catch (e) {
      console.error(`❌ ${issuesLabel} is not valid JSON: ${e.message}`);
      errors++;
    }
  }
}

// 3l. Retired typed-approval phrases and the gate catalog shape.
{
  const rules = 'skills/sucp-rules/SKILL.md';
  const orchestrator = 'Super Ultra Code Plan Implementation.md';
  // skills/super-ultra-code-plan/SKILL.md is a symlink to the orchestrator, so it is skipped.
  const typedApprovalPhrases = ['wait for explicit yes', 'nod sufficient', 'wait for explicit approval before plan'];
  const typedApprovalFiles = [
    orchestrator,
    ...['sucp-brainstorm', 'sucp-debt-sweep', 'sucp-overnight', 'sucp-plan', 'sucp-rules', 'sucp-tdd-debug', 'sucp-verify-deliver']
      .map((name) => `skills/${name}/SKILL.md`),
  ];
  let typedApprovalClean = true;
  for (const file of typedApprovalFiles) {
    const target = path.join(rootDir, file);
    const text = fs.existsSync(target) ? readSkillText(rootDir, file) : '';
    for (const phrase of typedApprovalPhrases) {
      if (text.includes(phrase)) {
        console.error(`❌ Typed-approval phrase still present: "${phrase}" in ${file}`);
        errors++;
        typedApprovalClean = false;
      }
    }
  }
  if (typedApprovalClean) console.log('✅ No typed-approval phrase remains');

  // This pins the gate table's shape (header cap, unique headers, Basis column,
  // safe-option-first). Logic and tests live in validate-lib.mjs.
  const catalogFile = path.join(rootDir, rules);
  const catalogProblems = checkGateCatalog(fs.existsSync(catalogFile) ? readSkillText(rootDir, rules) : '');
  if (catalogProblems.length === 0) {
    console.log('✅ Gate catalog shape is valid');
  } else {
    for (const problem of catalogProblems) {
      console.error(`❌ Gate catalog: ${problem}`);
      errors++;
    }
  }
}

// 3q. Each INVARIANTS sentence (lib/skill-invariants.mjs) must appear somewhere
// in the skill corpus, so a rule may move between files but not disappear.
{
  const missingInvariants = fs.existsSync(masterPath) ? checkInvariants(readSkillCorpus(rootDir)) : [];
  for (const inv of missingInvariants) {
    console.error(`❌ Skill invariant missing: ${inv.label}: "${inv.text}" appears nowhere in the skill corpus.`);
    errors++;
  }
  if (fs.existsSync(masterPath) && missingInvariants.length === 0) console.log(`✅ Skill invariants present: ${INVARIANTS.length}.`);
}

// 3r. Commands, flags, and repository paths named in the docs must exist.
{
  const docFiles = listDocReferenceFiles(rootDir);
  const { checked, findings } = checkDocReferences({ root: rootDir, files: docFiles });
  for (const f of findings) {
    console.error(`❌ Doc reference: ${f.file}:${f.line}: ${f.message}`);
    errors++;
  }
  if (findings.length === 0) {
    console.log(`✅ Doc references: ${checked} checked in ${docFiles.length} file(s), none missing.`);
  } else {
    console.error(`❌ Doc references: ${findings.length} of ${checked} checked reference(s) point at nothing.`);
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

// 3f. The evidence rules live inline in the master skill, so a pointer to the
// retired separate TinyFish skill is stale.
{
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

// 4b. Plan Publishing: the CLI the skill names and the registry it reads are
// each asserted separately. Placed before section 5
// on purpose: section 5 renders every Mermaid block in the repository with mmdc
// and costs 60-120 seconds, so a cheap missing-contract error must not queue
// behind the expensive render pass.
{
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
      // target/ and dist/ hold build output, never authored Markdown.
      if (['node_modules', '.git', 'diagrams', 'target', 'dist'].includes(entry.name)) continue;
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

  // Collect every block first so one mmdc call (one Chromium launch) renders
  // them all; one call per block cost about 2.7 s each.
  const collected = [];
  for (const mdFile of mdFiles) {
    const content = fs.readFileSync(mdFile, 'utf8');
    // Strict extraction mirroring scripts/render-diagrams.sh awk
    // (/^```mermaid[ \t]*$/ open, /^```[ \t]*$/ close). Canonical
    // implementation lives in scripts/validate-lib.mjs.
    const blocks = extractMermaidBlocksStrict(content);
    const rel = path.relative(rootDir, mdFile);
    blocks.forEach((source, i) => collected.push({ rel, index: i, source }));
  }

  // Standalone diagram sources (the README hero) are checked like fenced blocks.
  const diagramSrcDir = path.join(rootDir, 'docs', 'diagrams-src');
  if (fs.existsSync(diagramSrcDir)) {
    for (const f of fs.readdirSync(diagramSrcDir).filter((n) => n.endsWith('.mmd')).sort()) {
      collected.push({
        rel: path.relative(rootDir, path.join(diagramSrcDir, f)),
        index: 0,
        source: fs.readFileSync(path.join(diagramSrcDir, f), 'utf8'),
      });
    }
  }

  const puppeteerCfg = path.join(rootDir, 'puppeteer-config.json');
  const mermaidCfg = path.join(rootDir, 'mermaid.config.json');
  const mmdcArgs = [
    ...(fs.existsSync(mermaidCfg) ? ['-c', mermaidCfg] : []),
    ...(fs.existsSync(puppeteerCfg) ? ['-p', puppeteerCfg] : []),
    '-b', 'transparent',
  ];
  // A block whose source, mermaid config, other mmdc args, and renderer version
  // are unchanged since a passing render is not rendered again. Paths in the
  // args are root-relative so the key does not depend on the checkout location.
  const noCache = process.argv.slice(2).includes('--no-cache');
  const cachePath = path.join(rootDir, DEFAULT_CACHE_REL);
  const cache = loadCache(cachePath);
  const keyConfig = JSON.stringify([
    fs.existsSync(mermaidCfg) ? fs.readFileSync(mermaidCfg, 'utf8') : '',
    mmdcArgs.map((a) => (path.isAbsolute(a) ? path.relative(rootDir, a) : a)).join(' '),
  ]);
  const version = rendererVersion(rootDir);
  const keyOf = (b) => cacheKey({ block: b.source, config: keyConfig, rendererVersion: version });
  const { toRender } = partition(collected, noCache ? {} : cache, keyOf);

  // Without ~/.cache/puppeteer the bundled Chrome is missing, so mmdc gets a
  // system browser for this render only (shared resolver, see render-diagrams.sh).
  const browser = systemPuppeteerBrowser();
  if (browser) process.env.PUPPETEER_EXECUTABLE_PATH = browser;
  let rendered;
  try {
    ({ results: rendered } = toRender.length
      ? renderMermaidBatch(toRender.map((b) => b.source), { mmdc, args: mmdcArgs, tmpDir })
      : { results: [] });
  } finally {
    if (browser) delete process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const renderedBy = new Map(toRender.map((b, k) => [b, rendered[k]]));

  // The wiring check reads the SVG the renderer just wrote, because the source
  // accTitle/accDescr alone would pass even if the renderer dropped the tags. A
  // cached block passed that check when it was stored, and its source is part
  // of the key, so it gets the source check only.
  const outcomes = [];
  for (const block of collected) {
    const { rel, index: i, source } = block;
    const result = renderedBy.get(block) ?? { ok: true, cached: true };
    const { status, cacheable } = classifyMermaidResult({ result, source });
    if (renderedBy.has(block)) outcomes.push({ key: keyOf(block), ok: cacheable });
    if (status === 'invalid') {
      console.error(`❌ Mermaid syntax error in ${rel} [block ${i + 1}]`);
      console.error(`   ${result.error}`);
      mermaidInvalid++;
      errors++;
      continue;
    }
    mermaidValid++;
    if (status === 'no-a11y') {
      console.error(`❌ Missing accessibility metadata in ${rel} [block ${i + 1}]: add accTitle + accDescr.`);
      mermaidMissingA11y++;
      errors++;
    } else if (status === 'no-wiring') {
      console.error(`❌ Rendered SVG lacks the a11y wiring in ${rel} [block ${i + 1}]: the source declares `
        + 'accTitle/accDescr but the output has no <title>/<desc> pair referenced by aria-labelledby/aria-describedby.');
      mermaidMissingWiring++;
      errors++;
    }
  }
  // A global mmdc on a fresh clone has no node_modules, and creating one here
  // would hide the gitignored-state skip on the next run.
  if (fs.existsSync(path.join(rootDir, 'node_modules'))) saveCache(cachePath, recordResults(cache, outcomes));
  console.log(`✅ mermaid: ${toRender.length} rendered, ${collected.length - toRender.length} cached${noCache ? ' (--no-cache)' : ''}.`);

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
    console.log(toRender.length
      ? '✅ Accessibility: every rendered SVG carries the a11y wiring (<title>/<desc> + aria-labelledby/aria-describedby).'
      : '✅ Accessibility: no SVG rendered this run; every cached block passed the wiring check when it was rendered.');
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
