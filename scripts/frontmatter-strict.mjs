// scripts/frontmatter-strict.mjs
//
// Strict YAML check for plan frontmatter.
//
// `parseUltraPlanYaml` in ultra-plan-runner.mjs is a hand-rolled YAML subset and
// deliberately lenient, so a plan can pass every runner check and still not be
// YAML. Measured on the Obsidian vault: 5 of 308 mirrors failed a real parser
// (`[token].astro` unquoted inside a flow list, nested double quotes, `\B` in a
// double-quoted Windows path). Obsidian shows such a block as raw red text
// instead of Properties.
//
// The template itself shows flow lists with bare paths (`[path/to/file1.ts]`),
// which is fine for ordinary paths and wrong for any path containing `[`, `]`,
// `{`, `}`, `,`, `:` or `#`. This check turns that into an error at validation
// time, with the line and the fix in the message.

import { parseDocument } from 'yaml';

export function strictYamlError(frontmatter) {
  if (typeof frontmatter !== 'string' || frontmatter.trim() === '') return null;
  const doc = parseDocument(frontmatter);
  if (doc.errors.length === 0) return null;
  const e = doc.errors[0];
  const first = String(e.message).split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
  const line = e.linePos?.[0]?.line;
  const at = line ? ` at frontmatter line ${line}` : '';
  return `${first}${at}. Quote every path or command that contains \`[ ] { } , : #\`, quotes or backslashes, `
    + 'for example `"apps/web/src/pages/csat/[token].astro"`.';
}
