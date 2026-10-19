import { expect, test } from 'bun:test';
import { add, divide } from './math.mjs';

test('add sums two numbers', () => {
  expect(add(2, 3)).toBe(5);
});

test('divide splits a by b', () => {
  expect(divide(9, 3)).toBe(3);
});

test('divide refuses a zero divisor', () => {
  expect(() => divide(1, 0)).toThrow('division by zero');
});
