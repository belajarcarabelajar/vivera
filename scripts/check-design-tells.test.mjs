import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkText, checkDiff, expandPaths, parseDeclarations, stripeFromDeclaration, namesState, main, STATE_WORDS } from './check-design-tells.mjs';
import { readSkillText } from './skill-corpus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The regression these lock.
//
// On 2026-10-16 the Snipset website carried 31 decorative left stripes while the
// "colored left stripe" tell had been prose in sucp-rules all along. The owner
// found the first one in a screenshot of a CTA card. So the tests below assert
// three things: the rule is still written down and names this gate, the gate
// catches the exact stripe that shipped plus every other shape of it, and it stays
// quiet on the stripes that mark a real state, because a gate that fires on those
// is a gate people learn to ignore.

const rules = (v) => v.map((x) => x.rule);

test('catches the exact inline stripe that shipped on every Snipset solutions page', () => {
  const astro = [
    '<section class="section">',
    '  <div class="glass-card animate-on-scroll" style="padding: 40px; border-left: 4px solid var(--accent-primary);">',
    '    <h2>Study faster, pay once</h2>',
    '  </div>',
    '</section>',
  ].join('\n');
  const v = checkText(astro, { where: 'students.astro' });
  assert.deepEqual(rules(v), ['left stripe: border']);
  assert.equal(v[0].where, 'students.astro:2');
  assert.match(v[0].detail, /border-left: 4px solid var\(--accent-primary\)/);
});

test('catches every shape of a left stripe, not only that one', () => {
  const css = [
    '.card { border-left: 3px solid var(--accent-primary); }',
    '.row { border-inline-start: 0.25rem solid red; }',
    '.panel { border-left-width: 4px; border-left-style: solid; }',
    '.tile { box-shadow: 0 1px 2px rgba(0,0,0,.2), inset 3px 0 0 #f8a232; }',
    '.testimonial-card::before {',
    "  content: '';",
    '  position: absolute;',
    '  top: 0;',
    '  left: 0;',
    '  width: 4px;',
    '  height: 100%;',
    '  background: linear-gradient(180deg, red, blue);',
    '}',
    '.bar:after { position: absolute; inset: 0; width: 4px; }',
    '.thick { border-left: thick solid currentColor; }',
    '.defaulted { border-left: solid red; }',
  ].join('\n');
  const v = checkText(css, { where: 'x.css' });
  assert.deepEqual(rules(v), [
    'left stripe: border',
    'left stripe: border',
    'left stripe: border',
    'left stripe: inset shadow',
    'left stripe: pseudo-element',
    'left stripe: pseudo-element',
    'left stripe: border',
    'left stripe: border',
  ]);
  assert.equal(v[4].where, 'x.css:10', 'the pseudo-element hit anchors on its width line');
  assert.match(v[4].detail, /\.testimonial-card::before is a 4px wide full-height bar/);

  const tsx = [
    'const Card = styled.div`',
    '  border-left: 4px solid ${(p) => p.theme.accent};',
    '`;',
    "const style = { borderLeft: '3px solid red', boxShadow: 'inset 2px 0 0 red' };",
    '<div className="rounded-lg border-l-4 border-orange-500" />',
  ].join('\n');
  assert.deepEqual(rules(checkText(tsx, { where: 'Card.tsx' })), [
    'left stripe: border',
    'left stripe: border',
    'left stripe: inset shadow',
    'left stripe: tailwind border-l',
  ]);
});

test('does NOT flag a stripe that marks a state, nor a border that is not a stripe', () => {
  // Every selector here is a real one from the Snipset surfaces the first sweep
  // kept, plus the shapes the rule explicitly leaves alone.
  const css = [
    '.roadmap-card.active { border-left: 3px solid var(--accent-primary); }',
    '.shell-nav--wide .shell-nav__item[aria-current="page"] { box-shadow: inset 3px 0 0 var(--accent-primary); }',
    '.settings-warning-panel { border-left: 3px solid var(--accent-warning); }',
    '.doc-callout { border-left: 4px solid var(--callout-info-border); }',
    '.notes-editor-scroll .tiptap blockquote { border-left: 3px solid var(--accent-primary); }',
    '.qa-item.qa-status-fail { border-left-color: var(--accent-error); border-left-width: 4px; }',
    '.sx-banner { border-left: 4px solid var(--sx-banner-tone); }',
    '.csat-alert { border-left-width: 4px; }',
    '.cert-error { border-left: 4px solid var(--accent-error); }',
    '.site-search-option a { border-inline-start: 2px solid transparent; }',
    '.roadmap-card.active { .inner { border-left: 3px solid red; } }',
    '@media (max-width: 600px) { .toast { border-left: 4px solid red; } }',
    '.alert::before { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; }',
    '.divider { border-left: 1px solid var(--border-subtle); }',
    '.table th { border-top: 3px solid var(--accent-primary); }',
    '.right-bar { box-shadow: inset -3px 0 0 red; }',
    '.unknown { border-left: var(--rule-width) solid red; }',
    '.hairline { border-left: thin solid red; }',
    '.icon::before { position: absolute; left: 0; top: 0; width: 4px; height: 4px; }',
    '.wide::before { position: absolute; left: 0; height: 100%; width: 40px; }',
    '.reset { border-left: none; }',
  ].join('\n');
  const v = checkText(css, { where: 'kept.css' });
  assert.deepEqual(v, [], JSON.stringify(v, null, 2));

  const astro = [
    '<div class="qa-item" data-status="pass" style="border-left: 4px solid green;"></div>',
    '<li aria-current="page" style="border-left: 3px solid var(--accent-primary);"></li>',
  ].join('\n');
  assert.deepEqual(checkText(astro, { where: 'kept.astro' }), []);
});

test('in JSX the context runs from the nearest opening tag, and a comment right above it counts', () => {
  // Both shapes are real: the first sweep of Snipset's web app flagged a markdown
  // blockquote and a notes callout because only two lines above the hit were read.
  const quote = [
    '<blockquote',
    '  key={k}',
    '  style={{',
    '    margin: 0,',
    '    padding: "8px 12px",',
    '    borderLeft: "3px solid rgba(255,255,255,0.25)",',
    '  }}',
    '>',
  ].join('\n');
  assert.deepEqual(checkText(quote, { where: 'SafeFormattedText.tsx' }), []);
  const callout = [
    '{/* Notes Callout */}',
    '{payload?.notes && (',
    '  <div',
    '    style={{',
    '      padding: "10px 14px",',
    '      borderLeft: "3px solid var(--accent-primary)",',
    '    }}',
    '  >',
  ].join('\n');
  assert.deepEqual(checkText(callout, { where: 'VaultBackupCodesModal.tsx' }), []);
  const card = [
    '<div className="alert">x</div>',
    '<div',
    '  className="card"',
    '  style={{',
    '    borderLeft: "4px solid red",',
    '  }}',
    '>',
  ].join('\n');
  const v = checkText(card, { where: 'Card.tsx' });
  assert.deepEqual(rules(v), ['left stripe: border'], 'an earlier sibling naming a state does not exempt the next element');
  assert.equal(v[0].where, 'Card.tsx:5');
});

test('a nested block without a state in any enclosing selector is still caught', () => {
  const css = '@media (max-width: 900px) {\n  .card {\n    border-left: 4px solid red;\n  }\n}\n';
  const v = checkText(css, { where: 'nested.css' });
  assert.deepEqual(rules(v), ['left stripe: border']);
  assert.equal(v[0].where, 'nested.css:3');
});

test('a waiver needs a reason; with one it exempts the line, without one it is a violation', () => {
  const withReason = [
    '.highlight-col {',
    '  /* design-tells: allow column rule on the Snipset column of a comparison table */',
    '  border-left: 2px solid var(--accent-primary);',
    '}',
    '.other { border-left: 3px solid red; /* design-tells: allow same-line form */ }',
  ].join('\n');
  assert.deepEqual(checkText(withReason, { where: 'w.css' }), []);

  const bare = '.card {\n  /* design-tells: allow */\n  border-left: 4px solid red;\n}\n';
  const v = checkText(bare, { where: 'b.css' });
  assert.deepEqual(rules(v), ['waiver without reason']);
  assert.equal(v[0].where, 'b.css:3');
});

test('the parser keeps a declaration whole across comments and quoted strings', () => {
  const css = ".a::before { content: '};'; /* border-left: 9px solid red; */ border-left: 3px solid red; }\n.b { color: red }";
  const decls = parseDeclarations(css);
  assert.deepEqual(decls.map((d) => [d.prop, d.value, d.line, d.selectors.join(' ')]), [
    ['content', "'};'", 1, '.a::before'],
    ['border-left', '3px solid red', 1, '.a::before'],
    ['color', 'red', 2, '.b'],
  ]);
  assert.equal(stripeFromDeclaration('border-left', '2px solid red !important'), 'left stripe: border');
  assert.equal(stripeFromDeclaration('border-left', '0'), null);
  assert.ok(namesState('.qa_item.qa_status_pass'), 'an underscore is a boundary too');
  assert.ok(!namesState('.notes-list'), '`notes` is not `note`');
  assert.ok(!namesState('.highlight-col'), 'a table column emphasis names no state; it needs a waiver');
  assert.ok(STATE_WORDS.includes('blockquote'));
});

test('a file type the gate does not read returns nothing', () => {
  assert.deepEqual(checkText('border-left: 4px solid red;', { where: 'notes.md' }), []);
});

// Hooks and signing are disabled per call so a global git config cannot make the
// fixture depend on this host.
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const fixtureDirs = [];
after(() => {
  for (const d of fixtureDirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

function fixtureRepo() {
  const dir = tmpDir('design-tells-diff-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  const put = (rel, lines) => fs.writeFileSync(path.join(dir, rel), lines.join('\n') + '\n');
  // The base already has a stripe: history nobody will rewrite must not block a branch.
  put('styles.css', ['.old { border-left: 4px solid red; }', '.plain { color: red; }']);
  put('notes.md', ['border-left: 4px solid red;']);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  put('styles.css', ['.old { border-left: 4px solid red; }', '.plain { color: red; }', '.added { border-left: 3px solid red; }', '.ok.active { border-left: 3px solid red; }']);
  put('notes.md', ['border-left: 4px solid red;', 'border-left: 5px solid red;']);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'feat: branch lines');
  // Untracked on top: a new file never appears in `git diff`, so it is read whole.
  put('new.astro', ['<div class="card" style="border-left: 4px solid red;"></div>']);
  return dir;
}

test('--diff reports only the lines the branch adds, in checked file types, plus untracked files', () => {
  const r = checkDiff({ base: 'main', cwd: fixtureRepo() });
  assert.deepEqual(r.violations.map((v) => v.where), ['styles.css:3', 'new.astro:1'], JSON.stringify(r.violations));
  assert.equal(r.files, 2, 'notes.md is not a stylesheet-bearing file');
  assert.equal(r.addedLines, 3);
  assert.equal(r.mergeBase.length, 40);
});

test('a diff.mnemonicPrefix git config does not hide an added stripe', () => {
  const dir = tmpDir('design-tells-prefix-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'diff.mnemonicPrefix', 'true');
  const put = (lines) => fs.writeFileSync(path.join(dir, 'styles.css'), lines.join('\n') + '\n');
  put(['.plain { color: red; }']);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  // design-tells: allow fixture text for the gate under test, not a stylesheet of this repository
  put(['.plain { color: red; }', '.added { border-left: 4px solid var(--accent-primary); }']);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'feat: add a stripe');
  const r = spawnSync('bun', [path.join(ROOT, 'scripts', 'check-design-tells.mjs'), '--diff', 'main'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /styles\.css:2 {2}\[left stripe: border\]/);
});

test('--diff refuses a base it cannot resolve', () => {
  assert.throws(() => checkDiff({ base: 'no-such-ref-for-test', cwd: fixtureRepo() }), /no-such-ref-for-test/);
  assert.throws(() => checkDiff({ base: '--output=x', cwd: fixtureRepo() }), /invalid --diff base/);
});

test('a directory argument is walked, skipping node_modules and build output', () => {
  const dir = tmpDir('design-tells-walk-');
  fs.mkdirSync(path.join(dir, 'src', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'dist'));
  fs.writeFileSync(path.join(dir, 'src', 'a.css'), '.x { border-left: 4px solid red; }\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.md'), 'border-left: 4px solid red;\n');
  fs.writeFileSync(path.join(dir, 'src', 'node_modules', 'v.css'), '.x { border-left: 4px solid red; }\n');
  fs.writeFileSync(path.join(dir, 'src', 'dist', 'v.css'), '.x { border-left: 4px solid red; }\n');
  assert.deepEqual(expandPaths(['src'], { root: dir }), [path.join('src', 'a.css')]);
});

test('the rule is still written down in the master skill and names this gate', () => {
  const skill = readSkillText(ROOT, 'skills/sucp-rules/SKILL.md');
  assert.match(skill, /colored left stripe/, 'the named tell left the master skill');
  assert.match(skill, /check-design-tells\.mjs/, 'the master skill no longer points at the gate');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /design:check/, 'README no longer documents the gate');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['design:check'], 'bun scripts/check-design-tells.mjs');
});

// The CLI is exercised once for real: a green suite that only calls the exported
// functions has already hidden a dead CLI in this repository (MEMORY.md L12).
test('CLI: exit 1 on a stripe, 0 on a clean file, 2 on a usage error', () => {
  const dir = tmpDir('design-tells-cli-');
  fs.writeFileSync(path.join(dir, 'bad.css'), '.card { border-left: 4px solid red; }\n');
  fs.writeFileSync(path.join(dir, 'good.css'), '.card.active { border-left: 4px solid red; }\n');
  const script = path.join(ROOT, 'scripts', 'check-design-tells.mjs');
  const run = (...args) => spawnSync('bun', [script, ...args], { cwd: dir, encoding: 'utf8' });
  const bad = run('bad.css');
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /bad\.css:1 {2}\[left stripe: border\]/);
  const good = run('good.css');
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /Design tells clean: 1 file\(s\)/);
  assert.equal(run().status, 2);
  assert.equal(run('--diff').status, 2);
  assert.equal(main(['--nope', 'x.css']), 2);
});

test('CLI: --diff runs against the repository of the working directory', () => {
  const repo = fixtureRepo();
  const r = spawnSync('bun', [path.join(ROOT, 'scripts', 'check-design-tells.mjs'), '--diff', 'main'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /styles\.css:3/);
  assert.match(r.stderr, /new\.astro:1/);
  assert.doesNotMatch(r.stderr, /styles\.css:1/, 'the base stripe is not the branch\'s doing');
});
