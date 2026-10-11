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

export function parseTierTable(text) {
  const rows = [];
  const seen = new Set();
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const n = i + 1;
    const cols = line.split('\t');
    if (cols.length < 3) {
      throw new Error(`tiers.tsv line ${n}: expected 3 tab-separated columns, found ${cols.length}`);
    }
    const [tool, from, loss] = cols.map((c) => c.trim());
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
