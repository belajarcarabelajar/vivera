#!/usr/bin/env bash
# Validate one chunk AND its cross-chunk link endpoints.
#
# Contract section 6 alone cannot see a link that points into another chunk:
# validateChunk only reports crossChunk/dangling when knownNodeIds is passed,
# and the bare command omits it. Measured on rem-086: two endpoints resolved
# correctly, and section 6 reported crossChunk 0 anyway.
#
# Usage: verify-chunk.sh <batch-id, e.g. rem-090>
set -uo pipefail
# Repo root, detected from the script's own location rather than hard-coded, so
# the script works in any checkout or worktree of the repo, from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.." || exit 1
ID="${1:?usage: verify-chunk.sh <batch-id>}"
F="vault-index/semantic/chunk-${ID}.json"

bun -e "
import { validateChunk } from './scripts/lib/chunk-schema.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'vault-index/semantic';
const known = new Set();
for (const name of readdirSync(dir)) {
  if (!/^chunk(-rem)?-\d+\.json\$/.test(name)) continue;
  for (const n of JSON.parse(readFileSync(join(dir, name), 'utf8')).nodes ?? []) known.add(n.id);
}
const chunk = JSON.parse(readFileSync('$F', 'utf8'));
const local = new Set((chunk.nodes ?? []).map((n) => n.id));
const r = validateChunk(chunk, { knownNodeIds: known });

// Endpoints outside this chunk that exist nowhere at all -- the case bare
// section 6 structurally cannot report.
const ghost = [];
for (const l of chunk.links ?? []) {
  for (const e of [l.source, l.target]) {
    if (!local.has(e) && !known.has(e) && !ghost.includes(e)) ghost.push(e);
  }
}
console.log(JSON.stringify({
  ok: r.ok,
  errors: r.errors,
  nodes: chunk.nodes?.length ?? 0,
  links: chunk.links?.length ?? 0,
  crossChunk: r.stats?.crossChunk ?? 0,
  dangling: r.stats?.dangling ?? 0,
  unresolvedEndpoint: ghost,
}, null, 2));
process.exit(r.ok && ghost.length === 0 ? 0 : 1);
"
