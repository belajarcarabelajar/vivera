// scripts/lib/escape-re.mjs
//
// One regex-escape helper for every script that builds a RegExp from a task id,
// a path or a prefix, so the copies cannot drift apart.

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
