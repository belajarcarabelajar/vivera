import { expect, test } from 'bun:test';
import { printedRows } from './run-report.mjs';

// Dashboards parse these rows, so every row must carry a known tag.
test('every printed row starts with a known tag', () => {
  for (const row of printedRows()) expect(row).toMatch(/^\[(ok|warn)\] \S/);
});
