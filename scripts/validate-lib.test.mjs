// scripts/validate-lib.test.mjs
//
// Tests for the validation library. All functions except renderMermaidBatch
// are pure; that one is driven by a fake mmdc in a temp dir, so no Chromium runs.
//
// The key invariants being tested:
// 1. findMissingTerms correctly identifies missing terms
// 2. checkSnippetContract combines shared and phase-specific terms
// 3. checkTinyFishLadder enforces the TinyFish requirement
// 4. checkBannedRuntime catches banned patterns
// 5. Mermaid fence extraction matches the renderer's awk patterns
// 6. renderMermaidBatch maps batch output to blocks and falls back per block

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBAGENT_CONTRACT_TERMS,
  TINYFISH_LADDER_NEED,
  BANNED_RUNTIME_SNIPPETS,
  SNIPPET_CONTRACTS,
  REQUIRED_SNIPPETS,
  RENDERER_OPEN_AWK,
  RENDERER_CLOSE_AWK,
  findMissingTerms,
  checkSnippetContract,
  checkTinyFishLadder,
  checkBannedRuntime,
  hasStrictMermaidFence,
  extractMermaidBlocksStrict,
} from './validate-lib.mjs';
import * as lib from './validate-lib.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------- findMissingTerms ----------

test('findMissingTerms returns empty when all terms present', () => {
  const body = 'This has SUBAGENT-FIRST and TASK-CHUNKING';
  const result = findMissingTerms(body, ['SUBAGENT-FIRST', 'TASK-CHUNKING']);
  assert.deepEqual(result, []);
});

test('findMissingTerms returns missing terms', () => {
  const body = 'This has only SUBAGENT-FIRST';
  const result = findMissingTerms(body, ['SUBAGENT-FIRST', 'TASK-CHUNKING']);
  assert.deepEqual(result, ['TASK-CHUNKING']);
});

test('findMissingTerms is case-sensitive', () => {
  const body = 'This has subagent-first lowercase';
  const result = findMissingTerms(body, ['SUBAGENT-FIRST']);
  assert.deepEqual(result, ['SUBAGENT-FIRST']);
});

test('findMissingTerms handles empty body', () => {
  const result = findMissingTerms('', ['TERM']);
  assert.deepEqual(result, ['TERM']);
});

test('findMissingTerms handles empty terms', () => {
  const result = findMissingTerms('body', []);
  assert.deepEqual(result, []);
});

// ---------- checkSnippetContract ----------

test('checkSnippetContract combines shared and extra terms', () => {
  // The contract is shared terms PLUS the extra ones, so a body that carries
  // both must come back with nothing missing — and one missing either side
  // must be reported (the two tests below).
  const body = [...SUBAGENT_CONTRACT_TERMS, 'todowrite'].join(' ');
  const result = checkSnippetContract(body, ['todowrite']);
  assert.deepEqual(result, []);
});

test('checkSnippetContract reports missing shared terms', () => {
  const body = 'Has only todowrite';
  const result = checkSnippetContract(body, ['todowrite']);
  assert.ok(result.includes('SUBAGENT-FIRST'));
});

test('checkSnippetContract reports missing extra terms', () => {
  const body = 'Has SUBAGENT-FIRST';
  const result = checkSnippetContract(body, ['todowrite']);
  assert.ok(result.includes('todowrite'));
});

// ---------- checkTinyFishLadder ----------

test('checkTinyFishLadder returns empty when all terms present', () => {
  const body = 'Use TinyFish search and fetch_content';
  const result = checkTinyFishLadder(body);
  assert.deepEqual(result, []);
});

test('checkTinyFishLadder reports missing terms', () => {
  const body = 'Use TinyFish but missing others';
  const result = checkTinyFishLadder(body);
  assert.ok(result.includes('search'));
  assert.ok(result.includes('fetch_content'));
});

// ---------- checkBannedRuntime ----------

test('checkBannedRuntime returns empty when no banned patterns', () => {
  const body = 'This is clean text';
  const result = checkBannedRuntime(body);
  assert.deepEqual(result, []);
});

test('checkBannedRuntime catches node scripts/', () => {
  const body = 'Run node scripts/foo.mjs to do something';
  const result = checkBannedRuntime(body);
  assert.ok(result.includes('node scripts/'));
});

test('checkBannedRuntime catches npm install', () => {
  const body = 'Run npm install to install deps';
  const result = checkBannedRuntime(body);
  assert.ok(result.includes('npm install'));
});

test('checkBannedRuntime catches npm test', () => {
  const body = 'Run npm test to test';
  const result = checkBannedRuntime(body);
  assert.ok(result.includes('npm test'));
});

test('checkBannedRuntime catches npx', () => {
  const body = 'Run npx something';
  const result = checkBannedRuntime(body);
  assert.ok(result.includes('npx '));
});

// ---------- hasStrictMermaidFence ----------

test('hasStrictMermaidFence returns true for valid fence', () => {
  const content = '```mermaid\ngraph TD\n```';
  assert.equal(hasStrictMermaidFence(content), true);
});

test('hasStrictMermaidFence returns false for no fence', () => {
  const content = 'no mermaid here';
  assert.equal(hasStrictMermaidFence(content), false);
});

test('hasStrictMermaidFence returns false for loose fence', () => {
  // Loose fence with extra chars should not match
  const content = '```mermaid {extra}\ngraph TD\n```';
  assert.equal(hasStrictMermaidFence(content), false);
});

test('hasStrictMermaidFence allows trailing whitespace', () => {
  const content = '```mermaid  \ngraph TD\n```';
  assert.equal(hasStrictMermaidFence(content), true);
});

// ---------- extractMermaidBlocksStrict ----------

test('extractMermaidBlocksStrict extracts a simple block', () => {
  const content = '```mermaid\ngraph TD\nA-->B\n```';
  const blocks = extractMermaidBlocksStrict(content);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].includes('graph TD'));
});

test('extractMermaidBlocksStrict extracts multiple blocks', () => {
  const content = '```mermaid\ngraph TD\n```\ntext\n```mermaid\ngraph LR\n```';
  const blocks = extractMermaidBlocksStrict(content);
  assert.equal(blocks.length, 2);
});

test('extractMermaidBlocksStrict drops unclosed blocks', () => {
  const content = '```mermaid\ngraph TD\nno close';
  const blocks = extractMermaidBlocksStrict(content);
  assert.equal(blocks.length, 0);
});

test('extractMermaidBlocksStrict ignores loose fences', () => {
  const content = '```mermaid {extra}\ngraph TD\n```';
  const blocks = extractMermaidBlocksStrict(content);
  assert.equal(blocks.length, 0);
});

test('extractMermaidBlocksStrict handles empty blocks', () => {
  const content = '```mermaid\n```';
  const blocks = extractMermaidBlocksStrict(content);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0], '');
});

test('extractMermaidBlocksStrict trims whitespace', () => {
  const content = '```mermaid\n  graph TD  \n```';
  const blocks = extractMermaidBlocksStrict(content);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].includes('graph TD'));
});

// ---------- Constants ----------

test('SUBAGENT_CONTRACT_TERMS is non-empty', () => {
  assert.ok(SUBAGENT_CONTRACT_TERMS.length > 0);
});

test('TINYFISH_LADDER_NEED contains required terms', () => {
  assert.ok(TINYFISH_LADDER_NEED.includes('TinyFish'));
  assert.ok(TINYFISH_LADDER_NEED.includes('search'));
  assert.ok(TINYFISH_LADDER_NEED.includes('fetch_content'));
});

test('BANNED_RUNTIME_SNIPPETS contains banned patterns', () => {
  assert.ok(BANNED_RUNTIME_SNIPPETS.includes('node scripts/'));
  assert.ok(BANNED_RUNTIME_SNIPPETS.includes('npm install'));
  assert.ok(BANNED_RUNTIME_SNIPPETS.includes('npm test'));
  assert.ok(BANNED_RUNTIME_SNIPPETS.includes('npx '));
});

test('SNIPPET_CONTRACTS has entries for all required snippets', () => {
  for (const snippet of REQUIRED_SNIPPETS) {
    assert.ok(SNIPPET_CONTRACTS[snippet], `Missing contract for ${snippet}`);
  }
});

// The exported constants are awk programs (`/…/`), not JS regex sources, so the
// test strips the awk delimiters before compiling. The question is whether the
// pattern BETWEEN the slashes matches the fence; that the slashes agree with
// render-diagrams.sh is pinned separately in validate-skill.test.mjs.
const awkToRe = (awk) => new RegExp(awk.replace(/^\/|\/$/g, ''));

test('RENDERER_OPEN_AWK matches mermaid open fence', () => {
  const re = awkToRe(RENDERER_OPEN_AWK);
  assert.equal(re.test('```mermaid'), true);
  assert.equal(re.test('```mermaid '), true);
  assert.equal(re.test('```mermaid\t'), true);
  assert.equal(re.test('```mermaid {extra}'), false);
});

test('RENDERER_CLOSE_AWK matches mermaid close fence', () => {
  const re = awkToRe(RENDERER_CLOSE_AWK);
  assert.equal(re.test('```'), true);
  assert.equal(re.test('``` '), true);
  assert.equal(re.test('```mermaid'), false);
});

// ---------- renderMermaidBatch (fake mmdc, no Chromium) ----------
//
// The fake mirrors the two mmdc modes the batch relies on: a .md input renders
// each fenced block to <out>-<n>.svg, a .mmd input renders to <out>. Each SVG
// embeds its source so the test can prove block n landed in result n.

function makeFakeMmdc(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-mmdc-'));
  const bin = path.join(dir, 'fake-mmdc.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'fs';
import path from 'path';
const MODE = ${JSON.stringify(mode)};
const argv = process.argv.slice(2);
const inp = argv[argv.indexOf('-i') + 1];
const out = argv[argv.indexOf('-o') + 1];
fs.appendFileSync(path.join(import.meta.dirname, 'calls.log'), argv.join(' ') + '\\n');
const text = fs.readFileSync(inp, 'utf8');
if (inp.endsWith('.md')) {
  if (MODE === 'batch-fail' || MODE === 'partial-write') { process.stderr.write('Error: batch parse failed\\nstack\\n'); process.exit(1); }
  const blocks = [];
  let buf = null;
  for (const line of text.split('\\n')) {
    if (buf === null && /^\`\`\`mermaid[ \\t]*$/.test(line)) { buf = []; continue; }
    if (buf !== null && /^\`\`\`[ \\t]*$/.test(line)) { blocks.push(buf.join('\\n')); buf = null; continue; }
    if (buf !== null) buf.push(line);
  }
  const base = out.replace(/\\.md$/, '');
  blocks.forEach((b, i) => {
    if (MODE === 'missing' && i === 1) return;
    fs.writeFileSync(base + '-' + (i + 1) + '.svg', '<svg>' + b + '</svg>');
  });
  process.exit(0);
}
if (text.includes('BROKEN')) { if (MODE === 'partial-write') fs.writeFileSync(out, '<svg>partial</svg>'); process.stderr.write('Parse error on line 2: BROKEN\\nExpecting NODE\\n'); process.exit(1); }
fs.writeFileSync(out, '<svg>' + text + '</svg>');
`);
  fs.chmodSync(bin, 0o755);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-batch-'));
  const loggedCalls = () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n');
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };
  return { bin, tmpDir, loggedCalls, cleanup };
}

const BLOCKS = ['flowchart TB\n  A1-->B1', 'flowchart TB\n  A2-->B2', 'flowchart TB\n  A3-->B3'];

test('renderMermaidBatch renders every block in one mmdc call and maps out-<n>.svg to block n', () => {
  const fake = makeFakeMmdc('ok');
  try {
    const { results, calls } = lib.renderMermaidBatch(BLOCKS, { mmdc: fake.bin, args: ['-b', 'transparent'], tmpDir: fake.tmpDir });
    assert.equal(calls, 1);
    assert.equal(fake.loggedCalls().length, 1);
    assert.match(fake.loggedCalls()[0], /^-b transparent -i \S+\.md -o \S+out\.md$/);
    assert.equal(results.length, BLOCKS.length);
    results.forEach((r, i) => {
      assert.equal(r.ok, true);
      assert.equal(r.svg, `<svg>${BLOCKS[i]}</svg>`);
    });
  } finally {
    fake.cleanup();
  }
});

test('renderMermaidBatch falls back per block when the batch exits non-zero and names the failing block', () => {
  const fake = makeFakeMmdc('batch-fail');
  const blocks = [BLOCKS[0], 'flowchart TB\n  BROKEN -->', BLOCKS[2]];
  try {
    const { results, calls } = lib.renderMermaidBatch(blocks, { mmdc: fake.bin, args: ['-b', 'transparent'], tmpDir: fake.tmpDir });
    assert.equal(calls, 1 + blocks.length);
    assert.equal(fake.loggedCalls().length, 1 + blocks.length);
    assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
    assert.equal(results[1].error, 'Parse error on line 2: BROKEN');
    assert.equal(results[0].svg, `<svg>${blocks[0]}</svg>`);
    assert.equal(results[2].svg, `<svg>${blocks[2]}</svg>`);
  } finally {
    fake.cleanup();
  }
});

test('renderMermaidBatch falls back per block when the batch exits 0 but an out-<n>.svg is missing', () => {
  const fake = makeFakeMmdc('missing');
  try {
    const { results, calls } = lib.renderMermaidBatch(BLOCKS, { mmdc: fake.bin, tmpDir: fake.tmpDir });
    assert.equal(calls, 1 + BLOCKS.length);
    assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
    results.forEach((r, i) => assert.equal(r.svg, `<svg>${BLOCKS[i]}</svg>`));
  } finally {
    fake.cleanup();
  }
});

test('renderMermaidBatch fails a block whose single render exits non-zero even if it wrote an SVG', () => {
  const fake = makeFakeMmdc('partial-write');
  const blocks = [BLOCKS[0], 'flowchart TB\n  BROKEN -->'];
  try {
    const { results } = lib.renderMermaidBatch(blocks, { mmdc: fake.bin, tmpDir: fake.tmpDir });
    assert.deepEqual(results.map((r) => r.ok), [true, false]);
    assert.equal(results[1].error, 'Parse error on line 2: BROKEN');
  } finally {
    fake.cleanup();
  }
});
