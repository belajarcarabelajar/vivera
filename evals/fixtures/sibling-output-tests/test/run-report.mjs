import { join } from 'node:path';

// Runs the CLI the way a user does and returns its printed rows.
export function printedRows() {
  const cli = join(import.meta.dir, '..', 'bin', 'report.mjs');
  const r = Bun.spawnSync([process.execPath, cli], { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trimEnd().split('\n');
}
