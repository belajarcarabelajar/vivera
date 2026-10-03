# Vault Index Extraction Contract — Semantic Layer

> This is the contract every subagent in the vault indexing fan-out is held to. It is not a code-editing contract: a subagent here **reads notes and emits JSON**. It writes no source file, runs no test suite, and touches no git state. The only artifact is one chunk file.
>
> Read `scripts/lib/chunk-schema.mjs` before you start. It is the machine-checkable version of everything below, and `validateChunk()` is what decides whether your output counts. Prose that disagrees with the validator loses.

## 1. Delegation Metadata

- **Task ID:** T8 / batch `<NNN>`
- **Subagent Role:** Note Reader — concept and rationale extraction
- **Parent Goal:** `docs/code-plan/plans/2026-10-02-subagent-driven-vault-index.md`
- **Delegation Mode:** `isolated-files` — your chunk file is yours alone
- **Working directory:** `~/vivera`
- **Vault root (transcripts):** `~/Documents/conversations-archive`
- **Vault root (plans, wiki, notes):** `~/Dokumen/Obsidian Vault`

### 1a. Git Boundary

You do not touch git state. Never `git commit`, `git add`, `git checkout`, `git push`, or `gh`. The deliverable is your chunk file on disk, not a commit. If you believe a file outside your scope needs changing, name it in your report and let the parent decide.

### 1b. What you produce

One file: `vault-index/semantic/chunk-<NNN>.json`

Nothing else. No prose wrapper around the JSON, no markdown fences, no commentary inside the file. A chunk that does not parse as JSON is a failed batch, and re-running you costs the parent a dispatch.

## 2. Scope — the one rule that matters

**Every node you emit names a `source_file`, and that path is a real file in your assigned batch.**

This is not a style preference. The vault's existing graph carries **1,299 nodes whose `source_file` is null or empty** — 1,269 null and 30 blank, of which 1,185 nonetheless carry edges. They are ghost nodes: an extractor emitted a concept without recording which note it came from. They cannot be re-verified against disk, `graphify explain` cannot link them to a file, and they fail the project's own chunk validator. Nobody knows which note they came from, so nobody can ever check or delete them.

You are the layer most likely to reproduce that failure, because you are the layer inventing `concept` and `rationale` nodes rather than reading them off a heading. **If you cannot name the file a concept came from, do not emit the concept.**

The validator enforces this and will reject your chunk. Writing it correctly the first time is cheaper.

## 3. What to emit

The structural layer (task T7, already built, deterministic) has already emitted, for every note:

- one `document` node per file
- `contains` edges from each file to its headings
- `references` edges for every wikilink

**Do not re-emit any of that.** Duplicates are tolerated by the merger but they inflate the graph and waste review.

You emit only the layer that needs judgment:

| Node `file_type` | What it is | Typical count |
|---|---|---|
| `concept` | A named idea the note is actually about — a technique, a decision, a system, a term of art | 0–4 per note |

**A "why" is an attribute, not a node.** This is graphify's rule and this project
follows it. When a choice has a stated reason, the reason belongs *on* the
concept it explains:

```json
{
  "id": "concept--some-decision",
  "label": "Some decision",
  "file_type": "concept",
  "rationale": "Stated reason, in the note's own words, with its anchor.",
  "source_file": "01 - Projects/foo/plans/2026-09-30-some-plan.md",
  "source_location": "L142"
}
```

Do **not** create a separate node whose only content is "X was chosen because
Y", and do not emit a `rationale_for` edge to carry it. A standalone why-node is
a fragment, not an idea, and it fragments the graph the same way a per-note id
would.

`file_type: "rationale"` is still valid in graphify
(`site-packages/graphify/validate.py:4`) — but only for a node that is itself a
concept-like thing: an idea, principle, mechanism, or design pattern that the
note names as such. "Fail-closed signature verification" is a mechanism and
deserves a node. "We chose fail-closed because the mirror lacked signatures" is
a why and does not.

**Corollary, and it bites immediately: a why about another chunk's concept
cannot be expressed in this schema.** Your chunk is your own file, so you can
only attach a rationale to a node you also own. If the concept the note
explains was emitted by a different batch, you have no node to hang the reason
on — and leaving it as a standalone `rationale` node plus a `rationale_for`
edge that crosses a chunk boundary produces an edge the merger must resolve
across chunks. Measured 2026-10-02 on `chunk-rem-017.json`: two `rationale--`
nodes whose `rationale_for` targets live in `chunk-rem-004.json`, invisible to a
per-chunk fold and left unattached.

So: attribute the why onto a concept **in your own batch**. If the note's
subject is genuinely something another batch owns, emit the concept node here
too — the merger unions duplicate ids on purpose, and that union is what makes
the attachment possible. Do not emit a why that dangles.

| Relation | Direction | Meaning |
|---|---|---|
| `conceptually_related_to` | concept → concept | two ideas a reader would want side by side |

Use only relations from the validator's vocabulary. `contains` and `references`
belong to T7.

## 4. Node shape

### 4a. Quote the note verbatim. Then explain it.

A `rationale` opens with `[<source_file>:L<n>]` and then the reason. Everything
between that bracket and the end of the string must be the **note's own words**,
copied exactly — because that span is what a reader lands on and expects to
match.

Measured across this corpus: writing your commentary after the anchor instead
puts *your* words on that line, so the reader finds a paraphrase where the note
never said it. Six consecutive batches reported anchors as verified while a
sixth to a half of them pointed at a line carrying no part of the quote.

So:

- **Verbatim first, commentary after the quote**, never interleaved. If you need
  to say "reused id, same claim as chunk-rem-060", put that BEFORE the bracket.
- **No silent normalisation.** Do not transliterate `—` into `-` or `→` into
  `->` inside a quoted span. Five chunks carry those substitutions and each one
  makes the quote unmatchable against the line it cites.
- **A quote that wraps across source lines gets two anchors.** One `L<n>` cannot
  cover two lines and the schema has no range syntax. Quote each fragment at its
  own line rather than dropping the tail or inflating the anchor.

Every path in this corpus ends in `[ses_…]`, so an anchor contains a `]` before
its `:L<n>`. Parse it greedily to the last `:` before the digits. A non-greedy
`\[([^\]]+):L(\d+)\]` silently matches **zero** anchors and reports success.

Verify by reading the line back and substring-matching, and **print how many
anchors you parsed**. Zero parsed and zero failed are different results, and
only the second means anything.

### 4b. Required fields

```json
{
  "id": "concept--<slug>",
  "label": "Leiden community detection",
  "file_type": "concept",
  "source_file": "01 - Projects/foo/plans/2026-09-30-some-plan.md",
  "source_location": "L142",
  "norm_label": "leiden community detection",
  "rationale": "[01 - Projects/foo/plans/2026-09-30-some-plan.md:L88] \"Verbatim words from that exact line, nothing added.\""
}
```

- `id` — a stable slug. Same concept in two notes gets the **same** id, so the merger unions them instead of duplicating. Slug the normalised label, not the note path; a per-note id would make every concept a singleton and reproduce the fragmentation this project exists to fix.
- `source_file` — repo-relative, from your batch list, verbatim. Never absolute, never `..`.
- `source_location` — `L<n>`, a real line number the file actually has. Not a character offset: several subagents wrote one, producing anchors past the end of the file. Count the lines.
- `rationale` — the note's own stated reason, quoted, per §4a. A string, or an array of strings when the note gives more than one anchor. No rationale is better than an invented one.

## 5. Judgement calls

These are the decisions that make this layer worth a model, and the ones a parser cannot make.

- **A concept is something the note is about, not something it mentions.** "Cloudflare" appearing in a list of tools is not a concept node for that note. A note whose entire subject is a decision to move DNS to Cloudflare has one.
- **Zero is a valid answer.** Most notes in this vault are plans, logs, or transcripts, and many have no distinct concept worth a node. A batch that returns nothing is a correct batch, not a failed one. Do not pad to hit a quota.
- **A `rationale` attribute requires an actual stated reason.** "Chose X" is not a rationale. "Chose X because Y broke under Z load" is. If the note records a choice without a reason, emit the concept and leave the attribute off. A why with no stated reason is a guess, and a guess written into an attribute reads the same as a sourced one.
- **Do not invent.** If the note does not say it, it is not in the graph. A concept you inferred from general knowledge rather than read here is a hallucination with a file path attached, which is worse than a missing node.
- **Transcripts are not plans.** Roughly half the corpus is `05 - Conversations/`, raw session logs. A discarded approach discussed in a transcript is worth a concept node; a tool invocation is not.

## 5a. Id reuse — check before you invent

Node ids are the graph's primary keys. Two chunks emitting different nodes
under one id silently unions two claims; two chunks emitting the same claim
under different ids silently fragments it. Both are invisible at merge, and
both are worse than either alternative being obviously wrong.

Node ids carry a `concept--` / `rationale--` prefix, so searching a bare slug
misses. Use the script — it matches on substring and prints which chunk
emitted each id:

```bash
cd ~/vivera
bun scripts/vault-index-ids.mjs tgrep          # by subject or slug fragment
bun scripts/vault-index-ids.mjs                # list every id
bun scripts/vault-index-ids.mjs --owner=concept--exact-id
```

Run it once per candidate slug, plus one for the note's main subject. A hit
means **read that chunk's node** before deciding — the label text alone will
not tell you whether it is the same claim.

Then the rule:

- **Reuse an id when another chunk emitted the SAME claim.** Same fact, same
  mechanism, same finding — even if worded differently and from a different
  session. Union them.
- **Do not reuse on adjacency.** Two notes touching the same subsystem make
  different claims. Adjacent is not the same.
- **A narrower claim gets its own id.** If an existing node is the general case
  and yours is the specific one, emit a new id. A later reader looking for the
  specific claim should find it, not have to settle for the general one.
- **When you reuse, keep your own `rationale` if the note states its own
  reason.** Do not import the other chunk's. Attributing a reason the note
  never gave is the same error as inventing a node.
- **Verify by reading the cited line**, not by matching slug text. Two slugs can
  look identical and mean different things.

If you cannot read the existing ids, say so in your report. Do not quietly
emit batch-local generics and let the merge discover the collisions.

## 5b. What counts as source

A transcript is a record of a session, so it contains several kinds of text,
and only some of them are the note speaking.

- **Citable:** what the user said, what the assistant concluded, and what the
  output of a run actually showed. Those are the session's own record.
- **Not citable:** a dispatch prompt or task brief. `rem-094`, `rem-142`,
  `rem-144` and `rem-149` anchored concepts on the text of a subagent's own
  instructions; `rem-104` and `rem-122` avoided it. The second practice is the
  correct one, and it is now the rule rather than an inconsistency.

The distinction matters because a prompt states what was *asked for*, and a
reader will take it as what happened. "Extract the failing anchors" is not a
finding that there were failing anchors. When a user message itself settles
something — a decision, a requirement, a correction — it is citable, because
that is the user speaking in the note. The prompt that a harness then handed to
a worker is not.

A practical test: if the sentence would still be true with the dispatch removed
from the transcript, it is source. If it only exists because someone asked for
it, it is a brief.

The same line separates tool output from tool input. Output — the log, the test
result, the error — is what happened, and is citable. Input is what someone asked
to be written, and is not: one subagent anchored a claim on a 7,108-character
`newString` payload sitting in an `### tool · edit` block, which is the shape of
the prompt problem wearing a different bracket.

## 5c. Two chunks, one id

`§5a` tells you when to reuse an id. This tells the merge what to do when two
chunks already disagree, because 5 chunks have emitted conflicting `label` and
`norm_label` values under one id, and 5 more reused an id whose `source_file`
names a different transcript. There is no merge runner yet, so this is the
policy it will implement:

- **The rationale decides.** Compare the two nodes with
  `./scripts/check-anchors.mjs`; the one whose quoted spans verify keeps the id.
  A label whose only support is an anchor that does not resolve is the node that
  is wrong, not the other one.
- **If both verify, take the more specific label.** The narrower claim is the
  one a reader is looking for, and `§5a` already says a narrower claim deserves
  its own id — so a conflict means one chunk over-generalised. Prefer the label
  that names the mechanism over the one that names the topic.
- **`norm_label` is recomputed from the winning `label`.** It is a derived
  field, never a source of truth, so keeping the loser's value only preserves a
  contradiction in a place where nothing will notice it.
- **`source_file` is set to the file its own primary anchor cites.** A rationale
  string already carries its own path per anchor, and a node legitimately cites
  more than one transcript — so a differing `source_file` is not by itself a
  conflict. It is a conflict only when the file does not resolve at all.

The general shape: the citation is the evidence, so the citation arbitrates.
Everything the schema duplicates from it — `source_location`, `source_file`,
`norm_label` — is a convenience that should be rewritten to agree with the
evidence rather than treated as a second opinion.

## 6. Verification — run this yourself before reporting

From `~/vivera`:

```bash
./scripts/verify-chunk.sh <NNN>
```

Exit 0 means your chunk counts. A non-zero exit means the parent discards it and re-dispatches you, which is the most expensive outcome available to you. Run it.

**Use this script, not a bare `validateChunk(c)`.** Endpoint resolution is
conditional: `validateChunk` only counts a `crossChunk` or `dangling` endpoint
when you pass it `knownNodeIds`, and a bare call reports neither. So the plain
form cannot see a link that points at a node in another batch, and will happily
print `"dangling": 0` on a chunk whose link endpoint exists nowhere at all.
Measured on `chunk-rem-086.json`: two cross-chunk endpoints, both resolving
correctly, and a bare `validateChunk` reporting `crossChunk: 0` anyway. The
script reads every chunk in `vault-index/semantic/`, passes the union in, and
separately lists endpoints that resolve to nothing — which is the failure the
bare form is structurally blind to.

## 7. Report back

State, plainly and without restating the contract:

- the batch id and how many files you read
- node and edge counts by `file_type` and `relation`
- any file you could not attribute a concept to, and why
- anything in your batch that looked like it needed a judgement the contract does not cover

Do not claim success without having run the verification in §6 and seen exit 0.

## 8. Parent Diff Audit Gate

The parent does not take your word. It re-runs §6 itself, re-reads your chunk, and checks that every `source_file` is in your assigned batch. A chunk that reports success and fails the parent's re-run is re-dispatched alone, never by restarting the batch.
