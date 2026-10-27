// scripts/docs-stepper.test.mjs
//
// The step-by-step walkthrough of the lifecycle diagram. The page lists steps
// as <li data-nodes="..."> inside <ol data-stepper="lifecycle">, and docs.js
// highlights those nodes in the inlined hero SVG. These tests pin the three
// contracts that can drift apart: the Mermaid source, the step list in the
// pages, and the element ids in the committed SVGs. The DOM wiring itself is
// checked by hand in a browser.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MMD = 'docs/diagrams-src/lifecycle.mmd';
const EN = 'docs/guide/pipeline-execution-lifecycle.md';
const ID = 'apps/docs/content/id/pipeline-execution-lifecycle.md';
const SVGS = ['diagrams/lifecycle.svg', 'diagrams/lifecycle-dark.svg'];

// A node is defined where its id is followed by a shape opener; quoted labels
// are dropped first so text inside a label never counts as a definition.
function mmdNodes(text) {
  const ids = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/"[^"]*"/g, '""');
    if (/^\s*(flowchart|accTitle|accDescr)\b/.test(line)) continue;
    for (const m of line.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\(\[|\[|\{\{|\{|\()/g)) ids.add(m[1]);
  }
  return [...ids];
}

function steps(text) {
  const block = text.match(/<ol data-stepper="lifecycle">([\s\S]*?)<\/ol>/);
  if (!block) return null;
  return [...block[1].matchAll(/<li data-nodes="([^"]*)">/g)].map((m) => m[1].trim().split(/\s+/));
}

function loadDocsJs() {
  const win = {};
  const doc = {
    readyState: 'complete',
    documentElement: { lang: 'en' },
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {},
  };
  new Function('window', 'document', read('apps/docs/assets/docs.js'))(win, doc);
  return win;
}

const nodes = mmdNodes(read(MMD));
const enSteps = steps(read(EN));

describe('lifecycle stepper source contract', () => {
  test('the Mermaid source defines the 30 lifecycle nodes', () => {
    expect(nodes.length).toBe(30);
    expect(nodes).toContain('Start');
    expect(nodes).toContain('Compact');
  });

  test('the EN page has an 8-step data-stepper list', () => {
    expect(enSteps).not.toBeNull();
    expect(enSteps.length).toBe(8);
  });

  test('every data-nodes id is a node of lifecycle.mmd', () => {
    const unknown = enSteps.flat().filter((id) => !nodes.includes(id));
    expect(unknown).toEqual([]);
  });

  test('every node of lifecycle.mmd appears in exactly one step', () => {
    const flat = enSteps.flat();
    const counts = nodes.map((id) => [id, flat.filter((x) => x === id).length]);
    expect(counts.filter(([, n]) => n !== 1)).toEqual([]);
  });

  for (const svg of SVGS) {
    test(`${svg} holds a flowchart-<id>- element for every step id`, () => {
      const text = read(svg);
      const missing = enSteps.flat().filter((id) => !new RegExp(`id="[^"]*flowchart-${id}-\\d+"`).test(text));
      expect(missing).toEqual([]);
    });
  }

  // Parity with the Indonesian twin: same ids, same order.
  test('the ID twin lists the same ids in the same order', () => {
    expect(steps(read(ID))).toEqual(enSteps);
  });
});

describe('stepTargets in docs.js', () => {
  const stepTargets = loadDocsJs().viveraDocs?.stepTargets;
  const svgIds = [...read(SVGS[0]).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

  test('step 2 lights its three nodes and only the edges between them', () => {
    const got = stepTargets(svgIds, ['DesignReport', 'Brainstorm', 'Gate1']);
    expect([...got.on].sort()).toEqual([
      'my-svg-L_Brainstorm_Gate1_0',
      'my-svg-L_DesignReport_Brainstorm_0',
      'my-svg-L_Gate1_Brainstorm_0',
      'my-svg-flowchart-Brainstorm-11',
      'my-svg-flowchart-DesignReport-9',
      'my-svg-flowchart-Gate1-17',
    ]);
    // 30 nodes and 39 edges in the diagram, minus the six that are on.
    expect(got.off.length).toBe(63);
    expect(got.off).toContain('my-svg-L_PathArch_Brainstorm_0');
    expect(got.off).toContain('my-svg-flowchart-Start-0');
    expect(got.off).not.toContain('my-svg');
    expect(got.off).not.toContain('my-svg_flowchart-v2-pointEnd');
  });

  test('an edge with one end outside the step is off', () => {
    const got = stepTargets(svgIds, ['Start', 'Classify', 'PathSpike', 'PathBounded', 'PathArch']);
    expect([...got.on].sort()).toEqual([
      'my-svg-L_Classify_PathArch_0',
      'my-svg-L_Classify_PathBounded_0',
      'my-svg-L_Classify_PathSpike_0',
      'my-svg-L_Start_Classify_0',
      'my-svg-flowchart-Classify-1',
      'my-svg-flowchart-PathArch-7',
      'my-svg-flowchart-PathBounded-5',
      'my-svg-flowchart-PathSpike-3',
      'my-svg-flowchart-Start-0',
    ]);
    expect(got.off).toContain('my-svg-L_PathSpike_DesignReport_0');
    expect(got.off).toContain('my-svg-L_PathBounded_WritePlan_0');
  });

  test('unprefixed edge label keys are classified like edge paths', () => {
    const keys = ['my-svg-flowchart-Start-0', 'my-svg-flowchart-Classify-1', 'my-svg-flowchart-PathSpike-3',
      'L_Start_Classify_0', 'L_Classify_PathSpike_0'];
    expect(stepTargets(keys, ['Start', 'Classify'])).toEqual({
      on: ['my-svg-flowchart-Start-0', 'my-svg-flowchart-Classify-1', 'L_Start_Classify_0'],
      off: ['my-svg-flowchart-PathSpike-3', 'L_Classify_PathSpike_0'],
    });
  });
});

// A hand-made element tree with only the members the sanitizer touches, the
// same ones a parsed SVG element has in the browser. Bun has no DOM.
function el(localName, attrs = {}, children = []) {
  const node = {
    localName,
    parent: null,
    children,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    removeAttribute(name) { node.attributes = node.attributes.filter((a) => a.name !== name); },
    remove() { node.parent.children = node.parent.children.filter((c) => c !== node); },
    querySelectorAll(sel) {
      if (sel !== '*') throw new Error(`fake supports only '*', got ${sel}`);
      const out = [];
      const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); });
      walk(node);
      return out;
    },
  };
  children.forEach((c) => { c.parent = node; });
  return node;
}

function names(node) {
  return [node.localName, ...node.children.flatMap(names)];
}

describe('sanitizeSvg in docs.js', () => {
  const sanitizeSvg = loadDocsJs().viveraDocs?.sanitizeSvg;

  test('sanitize drops scripts, on* handlers and javascript: links, keeps labels and safe links', () => {
    const label = el('foreignObject', { width: '40' }, [el('div', { class: 'labelBkg' })]);
    const inner = el('rect', { OnClick: 'alert(1)', class: 'basic' });
    const bad = el('a', { 'xlink:href': '  JavaScript:alert(1)' });
    const good = el('a', { href: 'https://example.com/' });
    const root = el('svg', { onload: 'alert(1)', id: 'my-svg' }, [
      el('style'),
      el('script', {}, []),
      el('g', { class: 'node' }, [inner, bad, good, label]),
    ]);

    sanitizeSvg(root);

    expect(names(root)).not.toContain('script');
    expect(root.attributes.map((a) => a.name)).toEqual(['id']);
    expect(inner.attributes.map((a) => a.name)).toEqual(['class']);
    expect(bad.attributes).toEqual([]);
    expect(good.attributes).toEqual([{ name: 'href', value: 'https://example.com/' }]);
    expect(names(root)).toContain('foreignObject');
    expect(names(root)).toContain('div');
    expect(names(root)).toContain('style');
  });
});
