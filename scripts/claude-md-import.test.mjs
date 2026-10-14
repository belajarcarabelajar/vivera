// scripts/claude-md-import.test.mjs
//
// Claude Code reads AGENTS.md only when no CLAUDE.md exists in the working
// directory or above it, so on a machine with a CLAUDE.md in a parent
// directory the `@AGENTS.md` import in the root CLAUDE.md is the only way
// AGENTS.md reaches Claude Code. Imports count only outside code spans and
// fenced blocks (https://code.claude.com/docs/en/memory, read 2026-10-14).
// AGENTS.md line 1 must send readers to the runbook, not to install.sh,
// which never installs graphify.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const CLAUDE_MD = new URL('../CLAUDE.md', import.meta.url);
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url);

export function importsAgentsMd(text) {
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opener) {
      if (fence === null) fence = opener[1][0];
      else if (opener[1][0] === fence) fence = null;
      continue;
    }
    if (fence === null && line.trim() === '@AGENTS.md') return true;
  }
  return false;
}

export function agentsNotePointsToRunbook(firstLine) {
  return firstLine.includes('docs/graphify-integration.md') && !firstLine.includes('install.sh');
}

const OLD_LINE_1 = 'Note: the graphify rules below apply when the `graphify` CLI and `graphify-out/graph.json` exist (run `graphify update .` to build the graph; see install.sh to install the CLI). If they are absent, skip the graphify steps and use normal file reading.';

describe('root CLAUDE.md imports AGENTS.md', () => {
  test('the real CLAUDE.md has the import on a line of its own', () => {
    expect(importsAgentsMd(readFileSync(CLAUDE_MD, 'utf8'))).toBe(true);
  });

  test('text without the import is rejected', () => {
    expect(importsAgentsMd('# Project\n\nSee AGENTS.md for the rules.\n')).toBe(false);
  });

  test('an import only inside a fenced block is rejected', () => {
    expect(importsAgentsMd('# Project\n\n```\n@AGENTS.md\n```\n')).toBe(false);
  });

  test('an import inside a code span is rejected', () => {
    expect(importsAgentsMd('# Project\n\n`@AGENTS.md`\n')).toBe(false);
  });
});

describe('AGENTS.md line 1 points to the graphify runbook', () => {
  test('the real line 1 names the runbook and not install.sh', () => {
    const [firstLine] = readFileSync(AGENTS_MD, 'utf8').split('\n');
    expect(agentsNotePointsToRunbook(firstLine)).toBe(true);
  });

  test('the old line 1 that sent readers to install.sh is rejected', () => {
    expect(agentsNotePointsToRunbook(OLD_LINE_1)).toBe(false);
  });

  test('a line naming the runbook and install.sh together is rejected', () => {
    expect(agentsNotePointsToRunbook('see docs/graphify-integration.md or install.sh to install the CLI')).toBe(false);
  });
});
