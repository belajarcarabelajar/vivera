import { expect, test } from 'bun:test';
import { printedRows } from './run-report.mjs';

test('report prints the config row first', () => {
  expect(printedRows()[0]).toBe('[ok] config');
});
