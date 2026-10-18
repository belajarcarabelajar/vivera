import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dir, '..');

function readRepoFile(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`missing repository file: ${rel}`);
  return fs.readFileSync(abs, 'utf8');
}

/** The body of a Markdown section, from its heading line to the next heading of the same or a higher level. */
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`missing heading: ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)[0].length <= level);
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('T4 docs', () => {
  test('the README pre-commit section documents the size gate', () => {
    const body = section(readRepoFile('README.md'), '### The pre-commit hook');
    for (const term of ['size:check', '5,000 tokens', '-size-gate', 'scripts/file-size-baseline.json']) {
      expect({ term, found: body.includes(term) }).toEqual({ term, found: true });
    }
    expect(body).not.toContain('Every path exits 0');
  });

  test('the README install row no longer ties the hook to graphify', () => {
    const row = readRepoFile('README.md').split('\n').find((l) => l.startsWith('| Enables the git hook |'));
    expect(row).toBeDefined();
    expect(row).not.toContain('only when `graphify` is installed');
  });

  test('the README scripts tree lists the checker and its baseline', () => {
    const readme = readRepoFile('README.md');
    expect(readme).toMatch(/[│├└─ ]+check-file-size\.mjs\s+#/);
    expect(readme).toMatch(/[│├└─ ]+file-size-baseline\.json\s+#/);
  });

  test('the debt sweep no longer says every hook path exits 0', () => {
    const sweep = readRepoFile('skills/sucp-debt-sweep/SKILL.md');
    expect(sweep).not.toContain('every path exits 0');
    expect(sweep).toContain('size gate');
  });

  test('the sucp-plan File-size trigger names the mechanical gate', () => {
    const line = readRepoFile('skills/sucp-plan/SKILL.md').split('\n').find((l) => l.startsWith('File-size trigger:'));
    expect(line).toBeDefined();
    expect(line).toContain('bun run size:check');
  });
});

describe('F3 workflow', () => {
  const workflow = () => readRepoFile('.github/workflows/ci.yml');

  test('the manual workflow runs the size check over every tracked file', () => {
    expect(workflow()).toMatch(/^\s+run: bun scripts\/check-file-size\.mjs --all$/m);
  });

  test('the workflow stays manual-dispatch only', () => {
    const on = workflow().match(/^on:\n((?:[ \t]+.*\n)+)/m);
    expect(on).not.toBeNull();
    expect(on[1]).toContain('workflow_dispatch');
    expect(on[1]).not.toMatch(/\b(push|pull_request)\b/);
  });
});
