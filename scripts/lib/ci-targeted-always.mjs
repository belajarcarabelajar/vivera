// Suites ci-targeted.mjs runs for every change, targeted or full. Kept apart so
// that file stays under the size gate.
export function copySuite(base) {
  return { name: 'copy-rules', cmd: ['bun', 'scripts/check-copy-rules.mjs', '--diff', base], reasons: ['always: commits and added lines since the base'] };
}

export function secretSuite(base) {
  return { name: 'secrets', cmd: ['bun', 'scripts/check-secrets.mjs', '--diff', base], reasons: ['always: commits and added lines since the base'] };
}
