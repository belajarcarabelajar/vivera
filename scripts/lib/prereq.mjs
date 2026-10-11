import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const TIERS = ['minimal', 'standard', 'full'];

const TIER_RANK = { minimal: 0, standard: 1, full: 2 };
// `never` ranks above every tier, so no tier ever requires that tool.
const FROM_RANK = { standard: 1, full: 2, never: 99 };

export function tierRank(tier) {
  if (!Object.hasOwn(TIER_RANK, tier)) {
    throw new Error(`unknown tier "${tier}" (expected ${TIERS.join(', ')})`);
  }
  return TIER_RANK[tier];
}

// Spaces and tabs only, on purpose: the bash reader (scripts/install/prereq.sh) trims the same two
// characters, and a different notion of "blank" is exactly how the two would disagree.
const trimBlanks = (s) => s.replace(/^[ \t]+|[ \t]+$/g, '');

// ONE normalization, mirrored line for line by check_tier_prereqs in scripts/install/prereq.sh:
// drop a UTF-8 BOM at the start of a line and every CR, trim spaces and tabs from the line, skip a
// blank line or one whose first character is #, then split at the first two tabs into tool,
// required_from and loss (everything after the second tab, itself trimmed, and optional). A missing
// tool or required_from, an unknown required_from and a duplicate tool are refused, naming the line.
export function parseTierTable(text) {
  const rows = [];
  const seen = new Set();
  text.split('\n').forEach((raw, i) => {
    const line = trimBlanks(raw.replace(/^\uFEFF/, '').replaceAll('\r', ''));
    if (line === '' || line.startsWith('#')) return;
    const n = i + 1;
    const first = line.indexOf('\t');
    const second = first === -1 ? -1 : line.indexOf('\t', first + 1);
    const tool = trimBlanks(first === -1 ? line : line.slice(0, first));
    const from = first === -1 ? '' : trimBlanks(second === -1 ? line.slice(first + 1) : line.slice(first + 1, second));
    const loss = second === -1 ? '' : trimBlanks(line.slice(second + 1));
    if (tool === '' || from === '') {
      throw new Error(`tiers.tsv line ${n}: a row needs a tool and a required_from, separated by a tab`);
    }
    if (!Object.hasOwn(FROM_RANK, from)) {
      throw new Error(`tiers.tsv line ${n}: unknown required_from "${from}" (expected ${Object.keys(FROM_RANK).join(', ')})`);
    }
    if (seen.has(tool)) {
      throw new Error(`tiers.tsv line ${n}: duplicate tool "${tool}"`);
    }
    seen.add(tool);
    rows.push({ tool, from, loss });
  });
  return rows;
}

export function requiredAt(rows, tier) {
  const rank = tierRank(tier);
  return rows.filter((r) => rank >= FROM_RANK[r.from]).map((r) => r.tool);
}

export function checkPrereqs({ tier, rows, has }) {
  const required = new Set(requiredAt(rows, tier));
  const errors = [];
  const warnings = [];
  for (const { tool, from, loss } of rows) {
    if (has(tool)) continue;
    if (required.has(tool)) {
      errors.push(`${tool} is required at tier ${tier} and was not found; without it: ${loss}`);
    } else {
      const note = from === 'never' ? '' : ` (required from tier ${from})`;
      warnings.push(`${tool} was not found${note}; without it: ${loss}`);
    }
  }
  return { errors, warnings };
}

// A tool counts as present only when `--version` exits 0. Several of these
// tools install under ~/.local/bin or ~/.bun/bin, which a non-login shell may
// not have on PATH, so those two directories are tried after PATH.
export function hasTool(tool) {
  const home = process.env.HOME || os.homedir();
  const candidates = [tool, path.join(home, '.local', 'bin', tool), path.join(home, '.bun', 'bin', tool)];
  for (const cmd of candidates) {
    let r;
    try {
      r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    } catch {
      continue;
    }
    if (r.error || r.status !== 0) continue;
    // Some tools print the version on stderr, which the old shell check merged in.
    const first = `${r.stdout ?? ''}`.trim().split('\n')[0] || `${r.stderr ?? ''}`.trim().split('\n')[0];
    return first || `${tool} (no version output)`;
  }
  return null;
}

export function loadTierTable() {
  return parseTierTable(fs.readFileSync(new URL('../install/tiers.tsv', import.meta.url), 'utf8'));
}
