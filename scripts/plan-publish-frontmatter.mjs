#!/usr/bin/env bun
// scripts/plan-publish-frontmatter.mjs
//
// Transform: a plan markdown file -> the same file carrying the Obsidian
// vault's PARA properties.
//
//   bun scripts/plan-publish.mjs <plan.md>   uses this module
//   bun test scripts/plan-publish-frontmatter.test.mjs
//
// The input is ANY plan markdown, with or without an existing frontmatter
// block. Measured across the 268 plan files of the three mirrored projects,
// only 40 declare `schema: ultra-plan/v1` and 228 carry no frontmatter at all,
// so "no frontmatter" is the common case rather than an edge case: the `---`
// fence pair is emitted unconditionally and the body is copied through
// verbatim. When a frontmatter block IS present, two contracts have to hold at
// once, and they fight each other:
//
//   1. The vault needs `title`, `type`, `para`, `status`, `created`, ... to
//      file, search and graph the note.
//   2. `ultra-plan-runner.mjs` needs the original document, including the
//      nested `tasks:` array, unchanged. A YAML parse-and-redump would reflow
//      and re-indent that array, and it would look like valid YAML while
//      quietly breaking the runner contract. So this is a LINE-LEVEL merge:
//      every line of the original frontmatter is copied verbatim, and only the
//      column-0 lines of the keys this module owns are dropped and re-emitted.
//      A real YAML round-trip was considered and rejected for that reason.
//
// Why this module is pure: the only step that needs the outside world is
// "does the project index exist?", and a `[[wikilink]]` must never be emitted
// for a file that is not there (AC-5). Probing the filesystem from inside the
// transform would make that decision untestable without a real vault, so the
// predicate is injected as `ctx.exists` and both paths are handed in: the
// absolute `ctx.indexPath` and the absolute `ctx.vaultRoot`. Missing `indexPath`
// or missing `vaultRoot` => `related` is omitted, never guessed.
//
// `status` is copied verbatim rather than remapped. The ultra-plan enum
// (Draft|Approved|InProgress|Verification|Complete|Blocked) is already a
// lifecycle status, and a second enum under a different key would give one
// field two sources of truth. A plan with no `status` becomes `Draft`.
//
// `type: note` and `para: project` are the vault's own vocabulary, measured
// across its 2757 markdown files, NOT the names of its PARA folders:
//
//   para: resource(18) system(12) common(6) project(4)      <- `projects`: 0
//   type: note(717+295) reference(16+15) source(11) audit(8)
//         index(7) moc(6) system(4) log(2)                  <- `project`: 0
//
// An earlier draft of the plan text asked for `type: project` / `para: projects`,
// which is what the folders are called and what the vault actually never uses.
// `type: plan` is deliberately NOT introduced: a new `type` value is a schema
// change, and the vault's own skill forbids those without an explicit request.
// A mirror stays identifiable through `source_path`, `source_hash` and
// `project`, which the vault's AGENTS.md permits as additions.
//
// PUBLISHER_VERSION is a bump obligation, not bookkeeping. Freshness detection
// (see plan-publish.mjs) compares the destination's `source_hash` against the
// hash of the plan, and `source_hash` is a hash of the PLAN TEXT — so fixing a
// bug in this transform does not move it. Observed on the real vault: after the
// qualified-link fix, re-running the publisher on an unchanged plan printed
// SKIPPED-IDEMPOTENT, the mirror on disk kept the old broken
// `[[ai-skills index]]`, and `--check --all` called that mirror OK. A mirror
// written by an older publisher could never heal, and the drift check actively
// lied about it.
//
// So freshness has a second key: `publisher_version`, emitted into every
// published document. A change here that alters emitted output MUST increment
// it, or every mirror written by the previous version stays stale forever.
// Increment it ONLY for such a change — bumping it needlessly rewrites all
// mirrors for no visible difference. Comparing the computed output against the
// file on disk would also catch this, but `updated` is stamped with the current
// date, so the output legitimately differs every day and every mirror would be
// rewritten daily. That is why the signal is a version stamp and not bytes.
//
// The `## Related` section carries the source path as PLAIN TEXT, never as a
// `[[wikilink]]`: the source lives outside the vault, so a link to it would
// register as broken in the vault's linter. If the body already has a
// `## Related` section the line is added to it instead of starting a second
// one, so re-running never grows the mirror. Note the transform is NOT
// byte-idempotent overall: `source_hash` is the hash of the INPUT, so feeding a
// mirror back in hashes the mirror. Drift detection compares the destination's
// `source_hash` against the hash of the PLAN (see plan-publish.mjs); it does
// not re-run this transform on its own output.

import { createHash } from 'node:crypto';
import path from 'node:path';

// A stamp for "what this transform emits", NOT a package version. Bump it when
// and only when a change alters the published document — see the header.
//
// 2 — added `published` beside `updated`. The bump is the mechanism, not a
// formality: freshness requires `source_hash` AND `publisher_version` to match,
// and `source_hash` is a hash of the PLAN TEXT, which this change does not
// touch. Without the bump, all 271 existing mirrors would keep reporting
// current and none would ever gain the new property.
export const PUBLISHER_VERSION = 2;

// Column-0 keys this module owns. Any other line, at any indentation, is
// copied through untouched. `published` is owned for the same reason `updated`
// is: if a plan ever carried one of these lines itself, copying it through as
// well would emit the key twice in one frontmatter block.
const OWNED_KEYS = [
  'title',
  'type',
  'para',
  'status',
  'created',
  'updated',
  'published',
  'related',
  'source_path',
  'source_hash',
  'project',
  'publisher_version',
];

const OWNED_RE = new RegExp(`^(${OWNED_KEYS.join('|')})[ \\t]*:`);
const FENCE_RE = /^---[ \t]*$/;
const HEADING1_RE = /^#[ \t]+(.*\S)[ \t]*$/m;
const RELATED_HEADING_RE = /^##[ \t]+related[ \t]*$/i;
const ANY_HEADING_RE = /^#{1,6}[ \t]+/;
const LEADING_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

// A YAML plain scalar cannot start with an indicator character, cannot contain
// `: ` or ` #`, and cannot be empty. Plan titles and absolute paths hit those
// cases often enough to matter, and a bare scalar containing them is a
// different document (or a parse error), not the same string.
//
// Anything safe is emitted BARE on purpose: `title: Publish the plans` reads
// better in a vault file a human opens, and stays greppable for the tools that
// read these mirrors back. Only genuinely ambiguous values get quotes.
const NEEDS_QUOTES_RE = /^[-?:,[\]{}#&*!|>'"%@`]|(?::[ \t])|(?:[ \t]#)|[ \t]$|^$|[\n\r\t]/;

function yamlString(value) {
  const s = String(value);
  if (!NEEDS_QUOTES_RE.test(s)) return s;
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')}"`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function planFilename(planPath) {
  return path.basename(String(planPath ?? ''));
}

function planStem(planPath) {
  return planFilename(planPath).replace(/\.md$/i, '');
}

// `created` comes from the date the plan file was named with, which is the only
// creation timestamp the plan itself carries. A plan whose filename has no
// leading date has no evidence of one, so it falls back to `ctx.today` rather
// than to a guess about mtime.
function createdDate(planPath, today) {
  const m = LEADING_DATE_RE.exec(planStem(planPath));
  return m ? m[1] : String(today ?? '');
}

function titleFrom(body, planPath) {
  const m = HEADING1_RE.exec(body);
  return m ? m[1] : planStem(planPath);
}

// ---------- related: the one link form that resolves ----------
//
// The link text is the index page's path RELATIVE TO THE VAULT, posix-separated
// and without the `.md` extension. It was `[[<projectName> index]]` before and
// that was simply a broken link:
//
//   * `scripts/vault_lint.py` resolves a wikilink by trying
//     `by_relative[target + ".md"]`, then the file stem, then a title/heading
//     key. Measured against the real vault, `ai-skills index` matches none of
//     the three — the page's title and its `# AI Skills` heading are both
//     "AI Skills" — so it landed in the linter's broken-link set.
//   * A bare `[[index]]` is no better: this vault holds seven `index.md` files,
//     so a stem is ambiguous as well as unresolvable.
//
// Hence the qualified path, which is the form the vault's own AGENTS.md uses
// (`[[0. Common/index]]`, `[[90 - System/index]]`).
//
// Returns '' — meaning "emit no `related` key" — when the link cannot be
// derived: no index path, no vault root, or an index outside the vault. There
// is deliberately NO fallback to a display name. A wrong link is a silent
// broken link that nothing else in this pipeline would catch, so every
// uncertain case drops the key instead of guessing.
function vaultLink(indexPath, vaultRoot) {
  if (!indexPath || !vaultRoot) return '';
  const rel = path.relative(vaultRoot, indexPath);
  // Outside the vault: a `../..` link would be a different broken link.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.split(path.sep).join('/').replace(/\.md$/i, '');
}

// Returns the raw YAML block WITHOUT its `---` fences, plus the remaining body
// with the single blank line after the closing fence removed. Text that does not
// open with a fence — or opens one that is never closed — comes back untouched,
// because a plan with broken frontmatter is still a plan that must publish.
export function splitFrontmatter(text) {
  const src = typeof text === 'string' ? text : '';
  const lines = src.split('\n');
  if (lines.length === 0 || !FENCE_RE.test(lines[0])) return { frontmatter: '', body: src };

  for (let i = 1; i < lines.length; i++) {
    if (!FENCE_RE.test(lines[i])) continue;
    const frontmatter = lines.slice(1, i).join('\n');
    let body = lines.slice(i + 1);
    if (body.length > 0 && body[0].trim() === '') body = body.slice(1);
    return { frontmatter, body: body.join('\n') };
  }
  return { frontmatter: '', body: src };
}

// ---------- body: the Related section ----------

function withRelated(body, planPath) {
  const line = `Source: ${planPath}`;
  // Already recorded (we are re-publishing our own output): leave it alone.
  if (new RegExp(`^Source:[ \\t]*${escapeRegExp(planPath)}[ \\t]*$`, 'm').test(body)) return body;

  const lines = body.split('\n');
  const start = lines.findIndex((l) => RELATED_HEADING_RE.test(l));

  if (start !== -1) {
    // Extend the existing section: find the next heading, then insert before
    // it, after the section's last non-blank line.
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (ANY_HEADING_RE.test(lines[i])) {
        end = i;
        break;
      }
    }
    let at = end;
    while (at > start + 1 && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, '', line);
    return lines.join('\n');
  }

  return `${body.replace(/[\s]+$/, '')}\n\n## Related\n\n${line}\n`;
}

// ctx: { planPath, projectName, today, exists, indexPath?, vaultRoot? }
//   exists(indexPath) -> boolean, INJECTED. This module never touches the
//   filesystem; that is the whole reason it is separable from the CLI.
//   indexPath  absolute path of the project index page (optional)
//   vaultRoot  absolute path of the vault root (optional). Required to render
//              the `related` link; see vaultLink() below.
//
// Emitted properties: title, type, para, status, created, updated, related
// (only when resolvable), source_path, source_hash, project, publisher_version.
// Everything else in the source frontmatter is copied through untouched.
export function mergeFrontmatter(planText, ctx) {
  const text = typeof planText === 'string' ? planText : '';
  const { planPath = '', projectName = '', today = '', exists, indexPath, vaultRoot } = ctx ?? {};

  const { frontmatter, body } = splitFrontmatter(text);

  // The plan's own `status` line, kept as raw text. Verbatim means verbatim:
  // the value is not parsed, re-quoted, or mapped onto another enum.
  let verbatimStatus = null;
  const passthrough = [];
  for (const line of frontmatter.split('\n')) {
    const m = OWNED_RE.exec(line);
    if (!m) {
      passthrough.push(line);
      continue;
    }
    if (m[1] === 'status' && verbatimStatus === null) verbatimStatus = line;
  }

  const emitted = [
    `title: ${yamlString(titleFrom(body, planPath))}`,
    'type: note',
    'para: project',
    verbatimStatus ?? 'status: Draft',
    `created: ${createdDate(planPath, today)}`,
    // `updated` is REQUIRED on a mirror: the vault's test_plan_mirror.py lists
    // it in REQUIRED_PROPERTIES and its AGENTS.md Page Contract names it. So it
    // stays, and it stays meaning "the publisher last ran today" — which is NOT
    // when the plan text last changed. `published` is the same date under a name
    // that cannot be misread as a document-modification date. Nothing in a
    // mirror can tell you when the plan changed; that history is in git.
    `updated: ${today}`,
    `published: ${today}`,
  ];

  // A wikilink is only ever emitted for a file the caller has proven exists,
  // AND only in the one form the vault linter can actually resolve. The link is
  // derived first: when it cannot be derived, the existence probe is skipped
  // too, because its answer could not change the output.
  const link = vaultLink(indexPath, vaultRoot);
  if (link && typeof exists === 'function' && exists(indexPath)) {
    emitted.push(`related: ["[[${link}]]"]`);
  }

  emitted.push(
    `source_path: ${yamlString(planPath)}`,
    `source_hash: ${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)}`,
    `project: ${yamlString(projectName)}`,
    `publisher_version: ${PUBLISHER_VERSION}`,
  );

  const published = [...emitted, ...passthrough].join('\n');
  return `---\n${published}\n---\n\n${withRelated(body, planPath)}`;
}
