# graphify Integration Runbook

Written 2026-10-01. Targets `graphify` v0.9.73. The methodology below was
measured on a modest personal Linux machine (one measured example: 8 threads,
**no CUDA**, 7.6 GB RAM with ~2 GB typically free, zram swap); those hardware
figures are an example, not requirements.

This file is written for a future session that has no access to the
conversation that produced it. Every number below was measured on this machine
on 2026-10-01 unless the text explicitly marks it UNMEASURED or labels it as
arithmetic derived from measured inputs. Nothing here is inferred from
documentation or from another machine.

House rule this file obeys (`~/AGENTS.md`): never state an
unverified claim as fact, separate findings from guesses, and state in-file how
to revert every change.

**Revised 2026-10-01 (same day, later).** Four measured corrections were folded
in after the first draft was written, and one measured-but-wrong claim was
retracted:

1. The multi-worker wall-clock projections in §5.1 were **wrong** and have been
   replaced. The ollama cloud backend does not parallelise; see §5.1 and §6.7.
2. The vault `.gitignore` stale-pattern fix is **applied** — see §4.4.
3. `03 - Resources/Attachments/` is now excluded from the vault's
   `.graphifyignore` — see §4.3.1.
4. The "1227 excluded notes" figure was a category error — see §1 and §4.3.

The retracted numbers are named where they are removed, so a future session does
not resurrect them from memory.

---

## 1. What this is, and the constraint you must read first

`graphify` builds a persistent knowledge graph of a codebase or note vault:
code symbols from local AST parsing, plus semantic relationships from an LLM.

**The only viable LLM backend on this machine is a CLOUD model, so running
graphify sends content off this machine.**

That is the central safety fact and it comes before any command in this file.
Concretely, when semantic extraction runs:

- Source file contents and note text are chunked and submitted over the network
  to an Ollama-hosted cloud model.
- What leaves is whatever the backend accepts **after** `.graphifyignore` and
  `.gitignore` have been applied. The ignore files are therefore the *only*
  boundary between your content and the network — see §4.
- There is no local-only mode for markdown on this machine. Measured local
  models were not viable (§5), and markdown extraction requires an LLM backend
  at all (§6.4).

Consequences for planning:

1. Read `.graphifyignore` before the first run, not after. There is no CLI flag
   that turns it off (§6.5), so its contents are the security boundary.
2. For the Obsidian vault, the strict `.graphifyignore` is what is between your
   content and the network. Measured scope: the vault holds **3087 markdown
   files / 42.0 MB** total, of which **1312 files / 11.4 MB / ~2.86 M tokens
   remain** under the strict ignore file. Do not widen it casually; §4 describes
   how to do it deliberately. (An earlier draft of this file called the
   excluded set "1227 notes". That was wrong: **1227 is the file count inside
   `03 - Resources/LLM Wiki/sources/` specifically**, not the total excluded
   across all exclusion sets. See §4.3.)
3. This repository (`ai-skills`) declares **no** cloud-extraction boundary in its
   `.graphifyignore` — the file says so itself. Adding one is a separate, reviewed
   task.

UNMEASURED: whether the specific cloud provider retains request bodies, and for
how long, was not determined on this machine. Do not assume either way.

---

## 2. Preconditions and install

### 2.1 The `[ollama]` extra is mandatory

`graphify` is installed with `uv`. **The `[ollama]` extra is required.** Without
it, extraction fails with:

```
the 'openai' package is required for this backend
```

```bash
uv tool install "graphifyy[ollama]"
```

- Reinstall/repair: `uv tool install --force "graphifyy[ollama]"`
- Installed binary: `~/.local/bin/graphify`
- Verified version at time of writing: **0.9.73**

Revert: `uv tool uninstall graphifyy`. This removes only the tool; it touches no
project files.

### 2.2 Ollama must be running

Ollama **0.35.0** at `/usr/bin/ollama`, serving on CPU only.

```bash
ollama serve          # foreground; needs to be up before extraction
```

If a desktop/service unit already runs it, do not start a second copy — the port
conflict is the symptom to look for.

Revert: stop the process you started (`Ctrl-C` if foreground, or
`systemctl --user stop ollama` if you started a user unit). Per the machine's
standing rule, do **not** uninstall Ollama without explicit instruction; check
`pacman -Qo /usr/bin/ollama` first.

### 2.3 Environment variables

These are required for the `ollama` backend and are **not persisted to any file**
by this runbook. Pass them inline on each command.

| Variable | Value | Why |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | points the client at the local Ollama |
| `OLLAMA_API_KEY` | any non-empty value | **only suppresses a warning**; it is not authentication to Ollama |
| `OLLAMA_MODEL` | `gpt-oss:120b-cloud` | the model used for community naming; this is the variable that actually works (§6.3) |

`OLLAMA_API_KEY=ollama` is fine. Never treat it as a secret and never paste a
real key here.

---

## 3. The working command set

Set `G` and the env block once per shell, then use the commands below verbatim.

```bash
export G=~/.local/bin/graphify
export OLLAMA_HOST=http://localhost:11434
export OLLAMA_API_KEY=ollama
export OLLAMA_MODEL=gpt-oss:120b-cloud
```

Revert of the above: `unset G OLLAMA_HOST OLLAMA_API_KEY OLLAMA_MODEL`. Nothing
was written to disk, so there is nothing else to revert.

### 3.1 Extract

```bash
"$G" extract <path> \
  --backend ollama \
  --model gpt-oss:120b-cloud \
  --max-concurrency 4 \
  --out <path>
```

- Writes `<path>/graphify-out/` by default. `--out DIR` redirects it.
- `--token-budget N` per-chunk cap, default **60000** (from `graphify extract
  --help` on this machine).
- `--api-timeout S` per-request timeout, default **600**.
- `--max-workers N` AST subprocess count, default = cpu count (8 here).
- `--no-cluster` writes raw extraction only.
- `--code-only` skips doc/paper/image files — see the warning in §6.4.
- `--max-concurrency N` **does not produce parallel speedup here. MEASURED
  2026-10-01: this backend serialises requests.** The flag exists on `extract`
  with default **4**, but 4 identical `gpt-oss:120b-cloud` generate requests
  fired in parallel took **41 s** wall clock, where 4 x 8 s = 32 s and a single
  request of the same payload takes **~8 s** — i.e. they ran essentially
  serially. Observed real throughput is **~6 chunks/min (~8-10 s per chunk)
  regardless of the concurrency flag**. Do not plan around a 4x speedup; see
  §6.7.

### 3.2 Cluster-only (rerun clustering + regenerate report)

```bash
"$G" cluster-only <path> --no-viz
```

- **Does not honour `--model`** (§6.3). The `OLLAMA_MODEL` env var is what makes
  this work.
- `--no-viz` skips `graph.html`; the help recommends it above 5000 nodes.
- `--no-label` keeps `Community N` placeholders and skips LLM naming entirely.

Revert: pass `--no-cluster` on the next extract, or delete
`<path>/graphify-out/` (see §7).

### 3.3 Label (name communities)

```bash
"$G" label <path> --missing-only
```

- Same `--model` caveat as §3.2. Use `OLLAMA_MODEL`.
- `--missing-only` keeps existing labels and names only missing/placeholder
  communities — the safe variant when re-running.

### 3.4 Query / path / explain (read-only, no backend needed)

```bash
"$G" query "<question>" --budget 2000
"$G" path "<node A>" "<node B>"
"$G" explain "<node>"
```

All three default to `--graph graphify-out/graph.json`. `query` is a BFS over
the existing graph; it does not call the LLM. **Measured:** `query` returns a
scoped subgraph answer and creates reference nodes for wikilink targets even when
the target file itself was not extracted — that behaviour is useful for vault
work and is not a bug.

Revert: none. These commands write nothing to the corpus.

### 3.5 Update

```bash
"$G" update <path>
```

- Help text: "re-extract code files and update the graph (**no LLM needed**)".
  AST-only, no API cost.
- `--force` overwrites `graph.json` even when the rebuild has fewer nodes; also
  available as `GRAPHIFY_FORCE=1`. Use after a refactor that deleted symbols, or
  the node count silently regresses.

### 3.6 Obsidian export — flag names, verified separately

Two different things exist, and only one of them is visible in this version's
CLI help:

- **CONFIRMED WORKING command, verified by actually running it on this machine
  (v0.9.73):**
  ```bash
  "$G" export obsidian --dir <vault-dir>
  ```
  The flag is `--dir PATH` on the `export obsidian` subcommand. Options shown in
  `graphify --help`: `--graph PATH`, `--labels PATH`, `--dir PATH`. Emits
  Obsidian vault notes + canvas. Use this one.
- **Do not use `--obsidian --obsidian-dir`.** That pair is reported on the
  extraction/skill path but is **not** present in the v0.9.73 `extract --help`
  output captured on this machine, and the export that was actually run is the
  `--dir` form above. If you see `--obsidian --obsidian-dir` in a skill or
  README, it is wrong for this version.
- **Verified behaviour, from the observed run:** the export **refuses to
  overwrite pre-existing user files**. It skips them and emits a warning naming
  what it skipped. Observed message:
  ```
  skipped 1 pre-existing file(s) graphify did not create, to avoid overwriting your notes
  ```
  It also never touches `.obsidian` config. Only files graphify creates are
  written.
- UNMEASURED: collision behaviour when a note of the same name already exists is
  measured only in the *skip* direction above; whether graphify ever suffixes
  rather than skips is still not observed. It skipped in the observed run; do
  not generalise the skip rule to suffixes.

Revert: delete the notes the export created. There is no `export obsidian
--revert`. Because it refuses to overwrite, the revert is additive-only — see §7
for the delete procedure and its guard.

---

## 4. `.graphifyignore` is a safety boundary, not an optimisation

### 4.1 Mechanics (verified)

- graphify has **no `--no-graphifyignore` flag.** `.graphifyignore` is always
  enforced.
- Its patterns are merged with `.gitignore` and evaluated last, so where the two
  disagree `.graphifyignore` wins.
- `extract --no-gitignore` exists and ignores `.gitignore` + `.git/info/exclude`
  *while prioritising `.graphifyignore`*. It is not an escape hatch for
  `.graphifyignore`.

### 4.2 Why it is the boundary

Because §1's content-leaves-the-machine fact is true, and because the only
control over *which* content leaves is this file, an over-broad pattern is a data
exfiltration bug and not a slow build. Nothing in the CLI will warn you.

### 4.3 The vault trade-off, measured — **updated 2026-10-03**

Obsidian vault corpus: **3087 markdown files / 42.0 MB** total (2026-10-01).

| Scope | Files | Size | ~Tokens |
|---|---|---|---|
| Full vault | 3087 | 42.0 MB | UNMEASURED at full scope |
| **Under the vault's strict `.graphifyignore` (2026-10-01)** | **1312** | **11.4 MB** | **~2.86 M** |
| **Under the vault's strict `.graphifyignore` (2026-10-03, after T9)** | **1585** | **—** | **—** |
| Same, but without the `sources/` exclusion | 2539 | — | ~6.90 M |

The strict file excludes these four paths (unchanged since 2026-10-01):

- `Satset/`
- `90 - System/Legacy/`
- `03 - Resources/LLM Wiki/sources/`
- `03 - Resources/Attachments/` — added after measurement; see §4.3.1

**Correction — read this before quoting any "excluded notes" total.** An earlier
revision of this file said the strict scope "drops **1227 notes**" and carried a
paragraph trying to reconcile 1227 against the 3087 − 1312 = 1765 raw
difference. Both were wrong. The verified position is:

- **1227 is the file count inside `03 - Resources/LLM Wiki/sources/`
  specifically** — one exclusion set, not the total.
- The vault total is **3087 md files / 42.0 MB**; under the strict
  `.graphifyignore` (2026-10-01), **1312 files / 11.4 MB / ~2.86 M tokens remain.**
- Under the strict `.graphifyignore` (2026-10-03, after the N8n raw-capture
  deletion in commit `3a968b2` and the `.graphifyignore` GROUP 7 addition in
  `c20b3be`), **1585 files remain eligible.**

So the excluded total is the complement of the measured remainder, and this file
does not quote a separate measured number for it. If a future session needs one,
derive it once from the two measured counts and label it as arithmetic — do not
resurrect "1227" as a total.

**Note on the 2026-10-02 plan's 2360 figure:** the plan measured
`graphify.detect.detect()` on the vault root, which counts *all* files the
detector sees (including `.txt`, `.yaml`, etc.). The T9 manifest uses a
narrower extension filter (`.md`, `.mdx`, `.pdf`), so its 1585 eligible files
are a subset of the 2360 the plan reported. Both are measured; the difference is
the extension filter, not a corpus change.

#### 4.3.1 `03 - Resources/Attachments/` — added, measured reason

**APPLIED** to the vault's `.graphifyignore`. The measured reason for the
addition:

- that directory holds **252 images**;
- **vision chunks dominated wall-clock**, pushing a **947-chunk** run out to a
  **~4 h** projection;
- after excluding them, the run is **791 chunks over 1282 files**.

Note the two file counts differ: **1282** is the count for that run after the
Attachments exclusion, **1312** is the strict-ignore corpus count in the table
above. This file does not reconcile that 30-file difference (UNMEASURED which
path accounts for it). Both numbers are measured; neither was adjusted to match
the other.

**Widening coverage is a reviewed, deliberate edit to the ignore file.** There is
no flag for it. Procedure:

1. Copy the current file: `cp .graphifyignore .graphifyignore.bak-$(date +%Y%m%d)`
2. Move exactly one excluded path out, add a dated comment naming why, and re-run
   the corpus count before extracting.
3. Be explicit that this widens what is sent to a cloud model.
4. To undo: restore the `.bak` copy.

### 4.4 The vault `.gitignore` stale-pattern fix — APPLIED

**This fix has now been applied to the vault's `.gitignore`.** An earlier
revision of this file left the stale patterns in place; that is no longer the
state. What was changed, measured:

- **88** `wiki/sources/...` patterns were **re-anchored** to
  `/03 - Resources/LLM Wiki/sources/...` — they matched nothing useful as
  written.
- **20 additional never-enumerated sensitive filenames** were added. These were
  names that no earlier pass had listed, found by enumeration during the patch.
- Backup of the pre-patch file: **`/tmp/opencode/vault.gitignore.bak`**.

**Applied does not mean finished — this is the important part.** Ignore rules
only affect files git is not already tracking. They do **NOT** untrack
already-tracked files. The **29 already-tracked sensitive notes are still
tracked** and still require `git rm --cached <path>` each. **That `git rm
--cached` has NOT been done.** Until it is, the patched `.gitignore` protects
nothing for those 29 files — they remain in the index and in history.

Revert the `.gitignore` patch itself: `cp /tmp/opencode/vault.gitignore.bak <vault>/.gitignore`.

---

## 5. Measured performance

Single-chunk measurements on this machine, one ~4k-token chunk per run, taken
2026-10-01. **These are single-chunk numbers, not averages.** Treat them as
order-of-magnitude, and re-measure before relying on them for scheduling.

| Backend / model | Wall clock | Generation rate | Output correctness |
|---|---|---|---|
| Local `llama3.2:3b` | 240.1 s | 2.16 tok/s | **FAILED** — returned prose inside a code fence, not valid JSON |
| Local `qwen3:1.7b` | UNMEASURED | 10.5 tok/s | **FAILED** — emitted an empty response |
| Cloud `gpt-oss:120b-cloud` | **7.0 s** (4,053-token chunk) | **422.8 tok/s** | **VALID** — 20 nodes / 25 edges |

Derived from those measurements (arithmetic, not new measurements):

- Wall-clock speedup vs `llama3.2:3b`: 240.1 / 7.0 = **~34x**.
- Generation-rate ratio vs `qwen3:1.7b`: 422.8 / 10.5 = ~40x; vs `llama3.2:3b`:
  ~196x.
- Projected generation time for one 4,053-token chunk at `qwen3:1.7b`'s 10.5
  tok/s would be ~386 s. This is arithmetic only — that model returned nothing,
  so no end-to-end local wall clock was ever observed for it.

**Conclusion (measured): local models are not viable for this workload on this
machine.** Both failed on output correctness, not just speed. That is why §1's
cloud constraint is unavoidable rather than a shortcut.

### 5.1 Full-vault wall clock — WITHDRAWN, no parallel speedup

**The multi-worker table that used to be here was wrong. It is withdrawn, not
amended.** Reproduced below only so a future session does not mistake its
absence for an oversight; **every row except the 1-worker row is FALSE, and the
1-worker row is an unvalidated projection.** Do not use any of it.

| Workers | Projected serial-equivalent wall clock | Status |
|---|---|---|
| 1 (serial) | 1.67 h | WITHDRAWN — projection, never measured |
| 4 | 0.42 h | **FALSE** — no speedup exists |
| 8 | 0.21 h | **FALSE** — no speedup exists |

Those rows implied a parallel speedup that **does not exist against this
backend**. Measured directly on 2026-10-01:

- While an extraction was running, **4 identical `gpt-oss:120b-cloud` generate
  requests fired in parallel took 41 s wall clock.**
- A single request of the same payload takes **~8 s**, so 4 x 8 s = 32 s.
- 41 s against a 32 s serial baseline means the requests ran **essentially
  serially**, not concurrently.

**Therefore `graphify extract --max-concurrency 4` gives NO speedup here.**
Measured real throughput is **~6 chunks/min**, i.e. **~8-10 s per chunk,
regardless of the concurrency flag**. That is the number to schedule against.

Do not reinstate a worker table from memory. If you need a full-run wall clock,
**measure it** — do not project it from the single-chunk 7.0 s figure in §5,
which is a one-chunk sample, not an average.

#### The two distinct concurrency facts — do not conflate them

| Fact | Status | Detail |
|---|---|---|
| `label` / `cluster-only` **force concurrency to 1** when the backend is `ollama` | Stated by those subcommands' own `--help` text on this machine ("forced to 1 for ollama/claude-cli") | A hard CLI-side cap, applied before any request is made. §3.2, §3.3. |
| `extract` **exposes `--max-concurrency` with default 4** | Flag exists; `extract --help` does **not** repeat the forced-to-1 caveat | The flag is accepted, and it still yields no parallel speedup, because the cloud backend itself serialises the requests. §3.1. |

The second fact does not contradict the first: even where the flag is
un-capped, the backend queues. Setting it higher is not a way around the ~6
chunks/min ceiling.

#### What is still valid from the old projection

- **Chunk count, arithmetic from measured inputs:** the strict scope's
  **~2.86 M tokens** at 3,306 tokens/chunk estimated **866 chunks**. The run
  actually measured after the Attachments exclusion (§4.3.1) was **791 chunks
  over 1282 files**. Both figures are recorded; this file does not reconcile
  their difference (UNMEASURED).
- The wider scope (**~6.90 M tokens, ~2087 chunks**) projects to **~4.06 h
  serial** at the §5 chunk time. Arithmetic only. A serial projection is the
  *only* shape of projection this backend supports, given the measurements
  above.
- No rate limiting was observed across 12 consecutive calls — but 12 calls is
  not evidence of a quota.

---

## 6. Known traps — every one of these was actually hit

### 6.1 Missing `[ollama]` extra

Symptom: `the 'openai' package is required for this backend`. Fix:
`uv tool install --force "graphifyy[ollama]"`. The plain `graphifyy` package
installs and appears to work until the ollama backend is first invoked.

### 6.2 `think: false` is ignored on `/api/generate`

Symptom: with `think:false` requested, `gpt-oss` spends the entire output budget
on reasoning and returns an **empty response**.

Cause: the parameter is ignored on the `/api/generate` path by default.

Reliable configuration requires all three of:

1. `think:false`, **and**
2. explicit token caps stated **in the prompt text**, **and**
3. a high `num_predict`.

Omitting any one of the three reproduces the empty response.

### 6.3 `--model` is ignored by `cluster-only` and `label`

Symptom: both commands fall back to a hardcoded `qwen2.5-coder:7b` and fail with
a **404** on this machine, even when `--model gpt-oss:120b-cloud` was passed.

Fix: use the `OLLAMA_MODEL` environment variable. That **does** work. It is the
one place `OLLAMA_MODEL` is mandatory rather than optional.

### 6.4 Markdown extraction requires an LLM backend — **updated 2026-10-03**

There is **no local-only mode for `.md`**. `--code-only` skips docs entirely, so
it is not a substitute. Combined with §5 (local models unusable), the result is
that an "AST-only, free" knowledge graph of a markdown vault is **not
achievable** on this machine **via the cloud-LLM extraction path**. Plan for
cloud cost and cloud egress, or do not index the vault.

**2026-10-03 update: the subagent path changes this picture.** T7 in
`docs/code-plan/plans/2026-10-02-subagent-driven-vault-index.md` shows the
structural layer (documents, headings, wikilinks) needs **no model at all** —
it is a deterministic parse of frontmatter and markdown syntax. T8 shows the
semantic layer (concepts, rationale, cross-file links) can be run locally by
fan-out subagents against the vault, producing 271 chunk files that merge into
the same graph format. The subagent path is free (no LLM API calls), deterministic,
and was measured on 1,585 eligible files: 20,214 nodes / 18,812 links with
degree-0 1,358. Keep the original measurement above and add the subagent path
beside it rather than deleting it.

### 6.5 No `--no-graphifyignore`

See §4.1. `.graphifyignore` cannot be bypassed from the CLI; it wins over
`.gitignore` on conflict.

### 6.6 Not a trap, but commonly assumed — update is not free of surprises

`graphify update` is AST-only (no LLM), which means it will **not** pick up new
markdown semantics. After adding or editing prose, a full `extract` is required.
Use `update --force` after refactors that delete symbols, or the node count
regresses silently.

### 6.7 The cloud backend does not parallelise — `--max-concurrency` is not a speedup

**MEASURED 2026-10-01. This is the trap that produced the wrong numbers called
out in §5.1.**

Symptom: you pass `--max-concurrency 4`, the run takes just as long as
serial, and a worker-count projection on paper says it should be 4x faster.

Cause: the ollama **cloud** backend on this account serialises requests.
Measured while an extraction was running:

| Test | Result |
|---|---|
| 4 identical `gpt-oss:120b-cloud` generate requests fired in parallel | **41 s** wall clock |
| Single request, same payload | **~8 s** |
| Serial baseline (4 x 8 s) | **32 s** |

41 s against a 32 s baseline is essentially serial execution, not concurrency.

**Consequence: `--max-concurrency` gives NO speedup on `extract` against this
backend.** Measured real throughput is **~6 chunks/min (~8-10 s per chunk)
regardless of the flag.**

The precision that matters, and the mistake to avoid:

| | `label`, `cluster-only` | `extract` |
|---|---|---|
| `--max-concurrency` forced to 1 by the CLI | **YES**, stated in their `--help` ("forced to 1 for ollama/claude-cli") | **No** — the flag exists with default 4 and the help does not carry the caveat |
| Parallel speedup available | No (capped before requests are made) | **No anyway** — the backend queues the requests |

These are two different mechanisms with the same net result. Conflating them
produces the error this file already made once: treating "the flag is not
capped on extract" as "the flag works on extract". It does not.

---

## 7. Revert for every step

Nothing in this runbook writes a persistent setting by itself. The full revert
list:

| Step | Revert |
|---|---|
| Shell env vars | `unset G OLLAMA_HOST OLLAMA_API_KEY OLLAMA_MODEL` |
| `ollama serve` | Stop the process you started. Do not uninstall without explicit instruction. |
| `uv tool install "graphifyy[ollama]"` | `uv tool uninstall graphifyy` |
| `extract` output | `rm -rf <path>/graphify-out/` — generated only. Or `graphify uninstall --purge` (removes graphify-out/ plus platform config). |
| Generated sidecars next to `graph.json` (`.graphify_analysis.json`, `.graphify_labels.json`, `GRAPH_REPORT.md`, `graph.html`, `GRAPH_TREE.html`, `memory/`, `reflections/`) | All inside `graphify-out/` or auto-detected next to `graph.json`; delete after confirming the exact path with `ls` |
| `.graphifyignore` edit | Restore `cp .graphifyignore .graphifyignore.bak-<YYYYMMDD>` |
| Vault `.gitignore` stale-pattern fix (APPLIED, §4.4) | `cp /tmp/opencode/vault.gitignore.bak <vault>/.gitignore` |
| Obsidian notes created by `export obsidian` | No built-in revert. It refuses to overwrite existing notes and warns about what it skipped, so only the new notes must go. **List them explicitly and delete by name — never `rm -rf` a vault directory.** |
| `graphify hook install` | `graphify hook uninstall` |
| `graphify install --platform <p>` / `opencode install` / `codex install` / etc. | The matching `uninstall` subcommand (e.g. `graphify uninstall`, `graphify codex uninstall`) |
| `.graphifyignore` for **this** repo | Not changed by this runbook. It currently declares no cloud boundary; see §1. |

Guard for every destructive line above: confirm the target with `ls` first, and
never use recursive delete against a path you have not just listed. The machine's
standing rule is that only files created in the current session may be deleted.

---

## 8. Measured vs unmeasured — quick index

Measured on this machine: CLI path and version 0.9.73; the `[ollama]`-extra
failure string; local vs cloud chunk timings, rates and output correctness; the
`think:false` empty-response failure; the `--model` → 404 fallback in
`cluster-only`/`label` and the `OLLAMA_MODEL` fix; absence of
`--no-graphifyignore` and the merge precedence; markdown requiring an LLM
backend; `query` creating wikilink reference nodes; vault corpus counts under
each ignore scope; absence of any cloud boundary in this repo's
`.graphifyignore`; no 429 across 12 calls.

Also measured, added in the 2026-10-01 revision:

- **The cloud backend does not parallelise** — 4 parallel `gpt-oss:120b-cloud`
  generate requests took 41 s against a 32 s serial baseline, with a single
  request at ~8 s. Real throughput **~6 chunks/min (~8-10 s per chunk)
  regardless of `--max-concurrency`** (§5.1, §6.7).
- **`label`/`cluster-only` force concurrency to 1** for the ollama backend, per
  their own `--help` text — a separate fact from the serialisation above
  (§6.7).
- **`export obsidian --dir PATH` is the working export command**, not
  `--obsidian --obsidian-dir`; it **refuses to overwrite pre-existing files**,
  warning "skipped 1 pre-existing file(s) graphify did not create, to avoid
  overwriting your notes" (§3.6).
- **Vault `.gitignore` stale-pattern fix is APPLIED**: 88 `wiki/sources/...`
  patterns re-anchored to `/03 - Resources/LLM Wiki/sources/...`, 20 additional
  never-enumerated sensitive filenames added, pre-patch backup at
  `/tmp/opencode/vault.gitignore.bak`. **29 already-tracked sensitive notes are
  still tracked and still need `git rm --cached`, which has NOT been done**
  (§4.4).
- **`03 - Resources/Attachments/` added to the vault's `.graphifyignore`**:
  252 images there, vision chunks dominated wall clock, a 947-chunk run
  projected to ~4 h; after exclusion, 791 chunks over 1282 files (§4.3.1).
- **1227 is the file count inside `03 - Resources/LLM Wiki/sources/`,** not a
  count of all excluded notes. Verified vault figures: 3087 md files / 42.0 MB
  total; 1312 files / 11.4 MB / ~2.86 M tokens under the strict ignore
  (§1, §4.3).

UNMEASURED and marked inline above: cloud-provider retention of request bodies;
end-to-end local wall clock for `qwen3:1.7b`; whether a full strict-scope run
matches the 866-chunk arithmetic estimate or the 791-chunk measured run (§5.1);
the 30-file difference between the 1312-file strict-scope count and the
1282-file post-Attachments run count (§4.3.1); `--obsidian --obsidian-dir`
presence on v0.9.73 `extract --help` (§3.6); whether `export obsidian` ever
suffixes rather than skips on a name collision (§3.6).

**Withdrawn as measured-but-wrong:** the 1.67 h / 0.42 h / 8-worker wall-clock
projection table (§5.1). The speedup it implied does not exist on this backend.
Do not reinstate it from memory — re-measure if you need a full-run figure.
---

## 8. The 1,299 unattributable nodes — F7, decided with measurements

The vault's existing `graph.json` carries **6,155 nodes and 5,527 links**. Of
those nodes, **1,299 have a `source_file` that is `null` (1,269) or empty (30)**
and **1,185 of them are an endpoint of at least one edge**. By `file_type`:
`document` 769, `concept` 460, `code` 61, `paper` 9.

They fail `chunk-schema.mjs` (`source_file` must be a repo-relative path), so a
merged graph carrying them is not itself a valid chunk, and the failure
surfaces later as 1,299 validation errors with no indication of origin.
`vault-index-merge.mjs` previously counted them (`previousNodesUnusableSourceFile`)
and preserved them. F7 is the decision of what happens next, and it is now an
explicit option, `ghostPolicy`.

### 8.1 Measured, not assumed

Run against the real vault — the structural layer over its 3,390 markdown files
fed as one chunk into `merge()` with the real `graph.json` as `previous`:

| Policy | nodes out | re-attributed | ambiguous | unmatched | dropped | links orphaned |
|---|---|---|---|---|---|---|
| `reattribute` (default) | 27,849 | **453** | 297 | 549 | 0 | 0 |
| `drop` | 26,550 | 0 | 0 | 0 | **1,299** | **1,454** |

**The three numbers F7 asked for: 453 unique, 297 ambiguous, 549 no match.**

Two independent controls, because "unique match" is worthless if uniqueness is
easy:

- All **453** re-attributed `source_file` values **exist on disk** (`statSync`,
  file). Zero invented paths.
- **0 of 453** randomly-generated labels matched any title. The match is
  informative, not a coincidence of a 6,155-node pool.
- **408 of 453** rescued paths corroborate the ghost label (note title, H1 or
  filename). The 45 that do not are mostly concept ghosts pointing at a note
  that merely discusses the term — see §8.4.

The candidate pool is the **union** (previous + incoming chunks), keyed by
`file_type` + `foldLabel()`. Of the 453, **402** came from the new structural
layer and **51** from a previous node that already had a real path. The union
pool is deliberate: the graph's own earlier extraction is evidence about which
note a node belongs to, and ignoring it would discard 51 matches for no gain.

### 8.2 Why the default is `reattribute`

It is the only one of the two that **cannot destroy work**.

- `drop` deletes **1,299 nodes — 21.1% of the graph — and orphans 1,454 links,
  26.3% of all links**, because 1,185 of those nodes carry edges. A policy that
  loses a quarter of the graph on a defect in one field should require someone
  to type it.
- `reattribute` fills in 453 paths and touches nothing else. Its failure mode
  is a **wrong** path; `drop`'s failure mode is a **missing** one. A wrong path
  is visible in `ghostNodesReattributed` and re-checkable against disk; a
  missing path is invisible once written.

That 694 of the 769 `document` ghosts carry a label matching *some* real note
title is what makes this the recoverable option rather than the timid one:
ninety percent label overlap is not what garbage looks like. These are
note-title nodes that lost their path.

### 8.3 What `reattribute` refuses to do

An **ambiguous** match is counted (`ambiguousReattribution`), never guessed.
Measured: 297. Two notes share a title and the graph cannot say which one a
node came from; picking the first would write a provenance record
indistinguishable from an extracted one, which is the failure this codebase
treats as worst.

A match is unique only when **exactly one** union node has both the same
`file_type` and the same `foldLabel()`.

- **`file_type` is part of the key.** The structural layer emits `document`
  nodes only, so a type-free key would offer each of the 460 `concept` ghosts
  some document's title as an origin. 460 is the largest single class that
  cannot be safely re-attributed this way.
- **`foldLabel()`** is case-folded, accent-stripped (NFKD), and collapses every
  run of non-alphanumerics to one space, so `AI Tools List` = `ai-tools-list`
  and `Café Strategy` = `cafe strategy`. It is deliberately **not** the graph's
  own `norm_label`, which is assigned by a later pass with its own rules and is
  absent on 30 nodes.
- A label that folds to `''` matches nothing. A ghost with a blank label is
  reported, never attached to the first real title.

### 8.4 The honest limit: 846 stay unattributed

Under the default, **846 of 1,299 remain without a path** — 297 ambiguous, 549
with no match. This is the correct outcome, not a bug to route around:

| type | total | re-attributed | still unattributed | of which carry edges |
|---|---|---|---|---|
| `document` | 769 | 404 | 365 | 753 |
| `concept` | 460 | 48 | 412 | 387 |
| `code` | 61 | 1 | 60 | 36 |
| `paper` | 9 | 0 | 9 | 9 |

Two structural reasons:

1. **The 30 `""`/`null` `code` ghosts are AST artefacts**, e.g. ids like
   `scripts_watch_inbox_py_path` labelled `Path` or `Any`. These are Python
   symbol names, not note titles; a title match is the wrong instrument. 1,285
   of the 1,299 are `_origin: null` and 14 are `_origin: ast`.
2. **A concept ghost names a term, not a note.** The same concept legitimately
   appears in many notes, and 412 of the 460 either match several or none.

**Ghost ids do not decode to files.** All 1,299 were tested for it: reversing
each id against the vault's 3,390 paths resolved **0**. An id like
`scripts_watch_inbox_py_path` looks like `scripts/watch_inbox.py` + symbol
`Path`, but the vault holds markdown notes, not the `ai-skills` Python tree the
ghost ids were minted from. Ids are not a cheaper attribution route; only
label match works, and only sometimes.

**So re-attribution does not make the merged graph valid.** 846 nodes still fail
the peer validator. F7 removes 453 of 1,299 defects and makes the remaining 846
explicitly countable. Making the graph fully valid needs a re-extraction of
those nodes with a real path, which is a different piece of work.

### 8.5 API

```js
merge(chunks, { previous, ghostPolicy: 'reattribute' | 'drop' })
```

Default `'reattribute'`; an unrecognised value throws rather than falling back.
Report fields: `ghostNodes`, `ghostNodesDropped`, `linksOrphanedByGhosts`,
`ghostNodesReattributed`, `ambiguousReattribution`, `unmatchedReattribution`,
and `ghostPolicy` itself. Links orphaned by a drop are counted **both** in
`linksOrphanedByGhosts` (the cause) and `danglingLinksDropped` (the effect) —
the two describe different reasons, and neither hides the total cost.

`previous` is never mutated by either policy, so a `drop` is not permanent
across runs: re-merging the same `previous` under the default brings the nodes
back.
