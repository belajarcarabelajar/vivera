#!/usr/bin/env bun
// Prints one status row per checked item, in the form `[tag] name`.
export const ITEMS = [
  ['ok', 'config'],
  ['ok', 'cache'],
];

export function rows(items = ITEMS) {
  return items.map(([tag, name]) => `[${tag}] ${name}`);
}

if (import.meta.main) console.log(rows().join('\n'));
