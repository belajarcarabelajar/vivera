// scripts/lib/file-size-stale.mjs
//
// Stale ceilings for scripts/check-file-size.mjs: which ones a mode reports, and the report.

export const BASELINE_REL = 'scripts/file-size-baseline.json';
const REWRITE_CMD = 'bun scripts/check-file-size.mjs --write-baseline';

// `stale` comes from staleCeilings over the judged entries. --all reports all of it.
// --staged judges only staged paths, so every unstaged path looks "gone" there; it
// reports the staged paths that shrank below their ceiling, which the hook used to
// pass and the next --all run failed (rule L90). Other modes report none.
export function staleToReport(stale, mode) {
  if (mode === '--all') return stale;
  if (mode === '--staged') return stale.filter((s) => s.reason !== 'gone');
  return [];
}

export function renderStale(stale, baselineName) {
  const lines = [`[size-gate] stale ceilings in ${baselineName}:`];
  for (const s of stale) {
    const now = s.reason === 'gone'
      ? 'no longer judged (removed, binary, symlink, or -size-gate)'
      : s.reason === 'within-limit' ? `now ${s.bytes} bytes, within the limit` : `now ${s.bytes} bytes`;
    lines.push(`  ${s.path}: ceiling ${s.ceiling} bytes, ${now}`);
  }
  lines.push(`Lower them with: ${REWRITE_CMD}, then stage ${BASELINE_REL}`);
  return lines.join('\n');
}
