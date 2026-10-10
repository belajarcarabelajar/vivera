#!/usr/bin/env bun
// scripts/mermaid-batch.mjs
//
// Renders .mmd files with renderMermaidBatch so render-diagrams.sh and
// validate-skill.mjs share one batch-and-bisect fallback.
//
// Usage: bun scripts/mermaid-batch.mjs --mmdc <bin> [-- <mmdc args...>] < list
//   stdin: .mmd paths, one per line. Each SVG is written to <file>.svg beside
//   its .mmd. stdout: exactly one line `rendered=<n> errors=<m>`.
//   Exit: 0 all rendered, 1 any block failed, 2 usage error.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { renderMermaidBatch } from './validate-lib.mjs';

function usage(msg) {
  process.stderr.write(`mermaid-batch: ${msg}\nusage: bun scripts/mermaid-batch.mjs --mmdc <bin> [-- <mmdc args...>] < list-of-mmd-paths\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
const mmdcArgs = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const mmdcAt = own.indexOf('--mmdc');
const mmdc = mmdcAt === -1 ? undefined : own[mmdcAt + 1];
if (!mmdc) usage('missing --mmdc <bin>');

const files = fs.readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
if (files.length === 0) usage('no .mmd paths on stdin');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-batch-'));
let rendered = 0;
let errors = 0;
try {
  const blocks = files.map((f) => fs.readFileSync(f, 'utf8'));
  const { results } = renderMermaidBatch(blocks, { mmdc, args: mmdcArgs, tmpDir });
  results.forEach((r, i) => {
    if (r.ok) {
      fs.writeFileSync(files[i].replace(/\.mmd$/, '') + '.svg', r.svg);
      rendered++;
    } else {
      process.stderr.write(`  ❌ FAILED: ${files[i]}\n      ${r.error}\n`);
      errors++;
    }
  });
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

process.stdout.write(`rendered=${rendered} errors=${errors}\n`);
process.exit(errors > 0 ? 1 : 0);
