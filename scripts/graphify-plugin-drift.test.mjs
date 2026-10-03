// scripts/graphify-plugin-drift.test.mjs
//
// Guards for the detector that answers: does `.opencode/plugins/graphify.js`
// still hold what a human decided it should hold, and if not, what changed?
//
// The three files `graphify install --project` writes are not equally safe to let
// it write. The `AGENTS.md` section is strictly better after a reinstall, so
// `scripts/agents-md-current.mjs` tells you to take the installer's version. The
// plugin is the opposite: on 2026-10-02 the installer overwrote the committed
// file in ai-skills with a regression, and the human-written parts of it were
// knowledge nobody could re-derive. So for this one, DRIFT IS THE WARNING and
// identical-is-not-the-goal.
//
// That asymmetry is why the fixtures below are synthetic and deliberately
// DIFFERENT from the real installed plugin. A guard tested only against a
// matching pair would pass on a detector that returns `{ current: true }` for
// everything, so each substantive difference has a test that pins the category by
// name, and the identical-pair test is only trusted because its neighbours fail.
//
// The live test at the bottom is the exception, and it asserts the repo's TRUE
// state rather than an aspiration: this file is deliberately not identical to
// what the installer would write, and it stays that way only while the NOTE and
// the `{ id, setup }` shape survive. Its job is to go RED the moment somebody
// runs `graphify install --project` and the adaptation is silently reverted —
// which is the entire failure this module exists to catch.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DRIFT,
  PLUGIN_RELATIVE_PATH,
  PLUGIN_SOURCE,
  checkPlugin,
  discoverPluginSource,
  exportShape,
  extractVendoredPlugin,
  headerContradictsCode,
  localPlugin,
  vendoredPlugin,
} from './graphify-plugin-drift.mjs';

// ---------- host capability ----------
//
// Everything below that reads the INSTALLED graphify — the discovery test and
// the two live tests at the bottom — has no subject on a host where graphify is
// not installed: `PLUGIN_SOURCE` falls back to one machine's uv layout, and the
// discovery test would assert that a path under it exists. The gate is asked
// once here and shared, so the file still runs on a machine without graphify
// while the synthetic-fixture tests above keep running everywhere.
const installedPresent = existsSync(PLUGIN_SOURCE);

// ---------- fixtures ----------

// Every test builds its own tree. `bun test` does not guarantee file order
// within a file, so a shared mutable fixture would turn one test's edit into
// another test's mystery.
const madeDirs = [];

after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A synthetic `install.py` carrying one `_OPENCODE_PLUGIN_JS` literal.
 *
 * Shaped like the real one — the constant, a `"""\` continuation, the plugin, the
 * closing delimiter, then the path constants — so the extractor is exercised
 * against the actual layout without depending on installed wording. A decoy
 * `_KILO_PLUGIN_JS` is included by default because the real module has one and
 * anchoring on the delimiter instead of the name would return it.
 */
function makeInstallPy(plugin, { withKilo = true } = {}) {
  // Concatenated, never `.join('\n')`-ed. The payload already ends in a newline,
  // so a join inserts a second one INSIDE the literal — and the extractor is
  // byte-exact. A fixture that smuggles an extra `\n` into the reference
  // produces a failure about the fixture that teaches nothing about the module.
  // The literal is written here exactly as the installer writes it: `"""`, a
  // backslash continuation, the payload, then `"""` with nothing between.
  const kilo =
    withKilo
      ? '_KILO_PLUGIN_JS = """\\\n' +
        '// graphify Kilo plugin\n' +
        'export const GraphifyPlugin = async ({ directory }) => {};\n' +
        '"""\n' +
        '_KILO_PLUGIN_PATH = Path(".kilo") / "plugins" / "graphify.js"\n'
      : '';

  return (
    '# generated fixture, not real graphify\n' +
    'from pathlib import Path\n' +
    '\n' +
    kilo +
    '_OPENCODE_PLUGIN_JS = """\\\n' +
    plugin +
    '"""\n' +
    '_OPENCODE_PLUGIN_PATH = Path(".opencode") / "plugins" / "graphify.js"\n'
  );
}

/** The vendored 0.9.x plugin, as it exists on disk today, comment bug included. */
const SYNTHETIC_VENDORED = [
  '// graphify OpenCode plugin',
  '// Injects a knowledge graph reminder before bash tool calls when the graph exists.',
  '//',
  '// IMPORTANT: keep the reminder string free of backticks and $(...) constructs.',
  '// The hook prepends `echo "<reminder>" && <cmd>` to the user\'s bash command;',
  '// backticks inside the double-quoted echo trigger bash command substitution.',
  'import { existsSync } from "fs";',
  'import { join } from "path";',
  '',
  'export const GraphifyPlugin = async ({ directory }) => {',
  '  let reminded = false;',
  '',
  '  return {',
  '    "tool.execute.before": async (input, output) => {',
  '      if (reminded) return;',
  '      if (!existsSync(join(directory, "graphify-out", "graph.json"))) return;',
  '',
  '      if (input.tool === "bash") {',
  '        // \';\' not \'&&\' — Windows PowerShell 5.1 rejects \'&&\' as a statement',
  '        // separator, breaking the first bash command of the session (#1646).',
  '        output.args.command =',
  '          \'echo "[graphify] knowledge graph at graphify-out/." ; \' +',
  '          output.args.command;',
  '        reminded = true;',
  '      }',
  '    },',
  '  };',
  '};',
  '',
].join('\n');

/** The committed ai-skills adaptation: default object, NOTE intact, `;` comment. */
const SYNTHETIC_LOCAL = [
  '// graphify OpenCode plugin (V2)',
  '// Injects a knowledge graph reminder before bash tool calls when the graph exists.',
  '//',
  '// IMPORTANT: keep the reminder string free of backticks and $(...) constructs.',
  '// The hook prepends `echo "<reminder>" ; <cmd>` to the user\'s bash command;',
  '// backticks inside the double-quoted echo trigger bash command substitution.',
  'import { existsSync } from "fs";',
  'import { join } from "path";',
  '',
  '// NOTE: no runtime import from "@opencode/plugin" here on purpose.',
  '// A bare .js file under .opencode/plugins/ has no node_modules to resolve it',
  '// from, so `import { Plugin } from "@opencode/plugin"` fails with',
  '// "Cannot find package". OpenCode v2 only requires a default export with an',
  '// `id` and a `setup` function, so a plain object is enough.',
  '',
  'const REMINDER =',
  '  "[graphify] knowledge graph at graphify-out/.";',
  '',
  'export default {',
  '  id: "graphify",',
  '  async setup(ctx) {',
  '    let reminded = false;',
  '',
  '    await ctx.tool.hook("execute.before", (event) => {',
  '      if (reminded) return;',
  '      if (event.tool !== "bash") return;',
  '',
  '      const directory = ctx.location.directory;',
  '      if (!directory) return;',
  '      if (!existsSync(join(directory, "graphify-out", "graph.json"))) return;',
  '',
  '      const input = event.input;',
  '      if (!input || typeof input.command !== "string") return;',
  '',
  '      // \';\' not \'&&\' — Windows PowerShell 5.1 rejects \'&&\' as a statement',
  '      // separator, breaking the first bash command of the session (#1646).',
  '      input.command = \'echo "\' + REMINDER + \'" ; \' + input.command;',
  '      reminded = true;',
  '    });',
  '  },',
  '};',
  '',
].join('\n');

/** A temp project root holding one plugin file. */
function makeRepo(localContent) {
  const root = mkdtempSync(join(tmpdir(), 'graphify-plugin-drift-'));
  madeDirs.push(root);
  if (localContent !== null) {
    mkdirSync(join(root, '.opencode', 'plugins'), { recursive: true });
    writeFileSync(join(root, PLUGIN_RELATIVE_PATH), localContent, 'utf8');
  }
  return root;
}

// ---------- extraction: the reference must be the real reference ----------

test('extractVendoredPlugin drops the line continuation so the value starts at the plugin', () => {
  const extracted = extractVendoredPlugin(makeInstallPy('// first line\n// second line\n'));

  assert.equal(extracted, '// first line\n// second line\n');
  assert.doesNotMatch(extracted, /^\n/, 'a retained continuation would offset every comparison by one character');
  assert.doesNotMatch(extracted, /\\/, 'no backslash may survive into the extracted text');
});

test('extractVendoredPlugin anchors on the constant name, not on the delimiter', () => {
  // The real install.py defines `_KILO_PLUGIN_JS` first, with the same `"""` and
  // the same `GraphifyPlugin` factory. A scan anchored on the delimiter returns
  // the Kilo plugin — same shape, different platform, silently wrong, and
  // indistinguishable to every test that only checks the shape.
  const withKilo = extractVendoredPlugin(makeInstallPy('// the opencode one\n'));
  assert.equal(withKilo, '// the opencode one\n');

  // Positive control for the control: with the decoy present, the decoy's own
  // text is genuinely in the file, so the assertion above is not vacuous.
  const source = makeInstallPy('// the opencode one\n');
  assert.match(source, /_KILO_PLUGIN_JS/);
  assert.match(source, /graphify Kilo plugin/);
});

test('extractVendoredPlugin does not close on a """ that is itself escaped', () => {
  // The JS payload contains double quotes. If a `\"` were mistaken for the
  // closing delimiter, extraction would silently truncate to the first line of
  // the payload and every drift verdict would be computed against a fragment.
  const extracted = extractVendoredPlugin(makeInstallPy('const a = "x";\nconst b = "y";\n'));
  assert.equal(extracted, 'const a = "x";\nconst b = "y";\n');
});

test('extractVendoredPlugin refuses an escape it cannot undo instead of guessing', () => {
  // Passing `\|` through unchanged would make the extracted plugin differ from
  // the real one by characters invisible in any diff, and every verdict built on
  // it would be confidently wrong. A loud failure at extraction is the cheap
  // outcome, so it throws.
  const source = '_OPENCODE_PLUGIN_JS = """\\\nconst re = /a\\|b/;\n"""\n';
  assert.throws(() => extractVendoredPlugin(source), /graphify-plugin-drift/);
});

test('extractVendoredPlugin throws when the constant is absent rather than returning some other plugin', () => {
  assert.throws(() => extractVendoredPlugin('_KILO_PLUGIN_JS = """\\\nkilo\n"""\n'), /graphify-plugin-drift/);
  assert.throws(() => extractVendoredPlugin('const nothing = 1;\n'), /graphify-plugin-drift/);
  assert.throws(() => extractVendoredPlugin(42), /graphify-plugin-drift/);
});

test('extractVendoredPlugin throws on an unterminated literal', () => {
  assert.throws(() => extractVendoredPlugin('_OPENCODE_PLUGIN_JS = """\\\nno end here\n'), /graphify-plugin-drift/);
});

test('vendoredPlugin reads a fixture install.py through sourcePath', () => {
  const root = makeRepo(null);
  const src = join(root, 'install.py');
  writeFileSync(src, makeInstallPy('// fixture plugin\n'), 'utf8');

  assert.equal(vendoredPlugin({ sourcePath: src }), '// fixture plugin\n');
});

test('vendoredPlugin throws naming the path when install.py cannot be read', () => {
  const root = makeRepo(null);
  const missing = join(root, 'no-such-install.py');

  assert.throws(() => vendoredPlugin({ sourcePath: missing }), /graphify-plugin-drift/);
  assert.throws(() => vendoredPlugin({ sourcePath: missing }), /no-such-install\.py/);
});

test(
  'discoverPluginSource resolves an existing install.py under the uv tool layout',
  { skip: installedPresent ? false : `graphify is not installed; looked at ${PLUGIN_SOURCE}` },
  () => {
    const found = discoverPluginSource();
    assert.ok(existsSync(found), `expected an existing install.py, looked at ${found}`);
    assert.match(found, /site-packages[\\/]graphify[\\/]install\.py$/);
  },
);

// ---------- shape and contradiction classifiers ----------

test('exportShape names the two shapes and admits when it does not recognise one', () => {
  assert.equal(exportShape('export default {\n  id: "graphify",\n  async setup(ctx) {},\n};'), 'default-object');
  assert.equal(exportShape('export const GraphifyPlugin = async ({ directory }) => ({ ... });'), 'named-async-fn');
  // `unknown` has to exist, or an unrecognised shape gets filed under a known one
  // and the drift report names the wrong change.
  assert.equal(exportShape('module.exports = function () {};'), 'unknown');
  assert.equal(exportShape(''), 'unknown');
  assert.equal(exportShape(null), 'unknown');
});

test('headerContradictsCode fires on && in a comment while the code uses ;', () => {
  assert.equal(headerContradictsCode(SYNTHETIC_VENDORED), true);
});

test('headerContradictsCode stays silent on the comment that rules && out', () => {
  // This is the false positive that would kill the guard. The committed local
  // file mentions `&&` exactly once, in `// ';' not '&&'`, which is the comment
  // that explains why `;` is correct. A detector that matches `&&` in any comment
  // fires on the CORRECT file, reports it as drift, and gets ignored.
  assert.match(SYNTHETIC_LOCAL, /not '&&'/, 'the fixture must actually contain the negating comment');
  assert.equal(headerContradictsCode(SYNTHETIC_LOCAL), false);
});

test('headerContradictsCode needs both halves, not just a mention of &&', () => {
  const commentOnly = ['// prepends with &&', 'const a = "x" ; " + y;'].join('\n');
  const codeOnly = ['// no separator claimed here', 'const a = "x" ; " + y;'].join('\n');

  assert.equal(headerContradictsCode(commentOnly), true);
  assert.equal(headerContradictsCode(codeOnly), false);
  assert.equal(headerContradictsCode(''), false);
  assert.equal(headerContradictsCode(undefined), false);
});

// ---------- checkPlugin ----------

test('a local file identical to the vendored plugin is current with empty drift', () => {
  const root = makeRepo(SYNTHETIC_VENDORED);
  const result = checkPlugin(root, { vendored: SYNTHETIC_VENDORED });

  assert.equal(result.current, true);
  assert.deepEqual(result.drift, []);
  assert.equal(result.found, SYNTHETIC_VENDORED);
  assert.match(result.recommendation, /nothing to do/i);
});

test('a local file missing the @opencode/plugin NOTE drifts by name', () => {
  const stripped = SYNTHETIC_LOCAL.replace(/\/\/ NOTE:[\s\S]*?is enough\.\n/, '');
  assert.doesNotMatch(stripped, /@opencode\/plugin/, 'the fixture must actually have lost the NOTE');

  const root = makeRepo(stripped);
  const result = checkPlugin(root, { vendored: SYNTHETIC_VENDORED });

  assert.equal(result.current, false);
  assert.ok(
    result.drift.some((d) => d.startsWith(DRIFT.NOTE_MISSING)),
    `expected a ${DRIFT.NOTE_MISSING} drift, got:\n${result.drift.join('\n')}`,
  );
  const noteDrift = result.drift.find((d) => d.startsWith(DRIFT.NOTE_MISSING));
  assert.match(noteDrift, /@opencode\/plugin/);
  assert.match(noteDrift, /node_modules/);
});

test('the two export shapes differing drifts by name', () => {
  // This is the regression that was reverted on 2026-10-02 and that
  // `graphify install --project` re-applies on the next run: an unverified swap
  // from `{ id, setup }` to a `GraphifyPlugin` async factory.
  const root = makeRepo(SYNTHETIC_LOCAL);
  const result = checkPlugin(root, { vendored: SYNTHETIC_VENDORED });

  assert.equal(result.current, false);
  const shapeDrift = result.drift.find((d) => d.startsWith(DRIFT.SHAPE));
  assert.ok(shapeDrift, `expected a ${DRIFT.SHAPE} drift, got:\n${result.drift.join('\n')}`);
  assert.match(shapeDrift, /default-object/);
  assert.match(shapeDrift, /named-async-fn/);
});

test('a vendored file whose comment says && while its code uses ; drifts by name', () => {
  const root = makeRepo(SYNTHETIC_LOCAL);
  const result = checkPlugin(root, { vendored: SYNTHETIC_VENDORED });

  const contradiction = result.drift.find((d) => d.startsWith(DRIFT.CONTRADICTION));
  assert.ok(contradiction, `expected a ${DRIFT.CONTRADICTION} drift, got:\n${result.drift.join('\n')}`);
  assert.match(contradiction, /&&/);
  assert.match(contradiction, /;/);

  // Negative: with a vendored text whose comment agrees with its code, the same
  // local file must not produce this category.
  const fixed = SYNTHETIC_VENDORED.replace('&& <cmd>', '; <cmd>');
  const clean = checkPlugin(root, { vendored: fixed });
  assert.ok(
    !clean.drift.some((d) => d.startsWith(DRIFT.CONTRADICTION)),
    'a comment that agrees with the code must not be reported as a contradiction',
  );
});

test('drift is never empty while the two texts disagree', () => {
  // Otherwise a caller that reads only the count sees a clean bill of health on
  // a repo whose plugin changed underneath it.
  const root = makeRepo('// entirely different\n');
  const result = checkPlugin(root, { vendored: SYNTHETIC_VENDORED });

  assert.equal(result.current, false);
  assert.ok(result.drift.length > 0);
  assert.ok(result.drift.some((d) => d.startsWith(DRIFT.TEXT)));
  assert.match(result.drift.find((d) => d.startsWith(DRIFT.TEXT)), /line \d+ differs/);
});

test('an absent local plugin reports found: false instead of crashing', () => {
  const root = makeRepo(null);
  const result = checkPlugin(root, { vendored: SYNTHETIC_VENDORED });

  assert.equal(result.found, null);
  assert.equal(result.current, false);
  assert.ok(result.drift.length > 0);
  assert.match(result.drift[0], /absent/i);
  assert.match(result.recommendation, /graphify install/);
  assert.equal(localPlugin(root), null);
});

test('checkPlugin never writes: the local file is byte-identical afterwards', () => {
  // The whole failure being guarded against is a silent overwrite. A checker that
  // "repairs" drift cannot then report that it found any, so the absence of a
  // write path is part of the contract and has to be asserted, not assumed.
  const root = makeRepo(SYNTHETIC_LOCAL);
  const file = join(root, PLUGIN_RELATIVE_PATH);
  const pluginsDir = join(root, '.opencode', 'plugins');
  const before = readFileSync(file);
  const entriesBefore = readdirSync(pluginsDir).sort();

  const result = checkPlugin(root, { vendored: SYNTHETIC_VENDORED });
  assert.equal(result.current, false, 'this fixture is expected to drift');
  assert.ok(result.drift.length > 0);

  const after = readFileSync(file);
  assert.deepEqual(after, before, 'checkPlugin modified the local plugin file');
  assert.equal(readFileSync(file, 'utf8'), SYNTHETIC_LOCAL);

  // Nothing created either: no sibling files in the plugin directory, and no
  // `.opencode/opencode.json` from a "helpful" install step.
  assert.deepEqual(readdirSync(pluginsDir).sort(), entriesBefore);
  assert.equal(existsSync(join(root, '.opencode', 'opencode.json')), false);
  assert.deepEqual(readdirSync(join(root, '.opencode')).sort(), ['plugins']);
});

test('checkPlugin is idempotent, so a report can be rendered and re-diffed', () => {
  const root = makeRepo(SYNTHETIC_LOCAL);
  const a = checkPlugin(root, { vendored: SYNTHETIC_VENDORED });
  const b = checkPlugin(root, { vendored: SYNTHETIC_VENDORED });

  assert.deepEqual(b.drift, a.drift);
  assert.equal(b.current, a.current);
});

test('line-ending differences alone are not drift', () => {
  // git's `core.autocrlf` is per-machine. Without normalisation the same repo is
  // "current" on Linux and drifting on Windows, which trains everyone to ignore
  // the signal.
  const root = makeRepo(SYNTHETIC_VENDORED.replace(/\n/g, '\r\n'));
  const result = checkPlugin(root, { vendored: SYNTHETIC_VENDORED });

  assert.equal(result.current, true);
  assert.deepEqual(result.drift, []);
});

// ---------- the installed plugin, used for real ----------

// Reading the installed source is not a drift assertion — it cannot go stale in
// a way that means anything, because it IS the reference. It is skipped when
// graphify is not installed so this file still runs on a machine without it.
test(
  'the installed install.py yields an extractable plugin (skipped when graphify is absent)',
  { skip: installedPresent ? false : `graphify is not installed; looked at ${PLUGIN_SOURCE}` },
  () => {
    const extracted = vendoredPlugin();
    assert.ok(extracted.length > 0);
    assert.match(extracted, /graphify OpenCode plugin/);
    assert.doesNotMatch(extracted, /\\/, 'no Python continuation should survive extraction');
    assert.equal(extractVendoredPlugin(readFileSync(PLUGIN_SOURCE, 'utf8')), extracted);
  },
);

// ---------- live: the real repo's adapted plugin ----------

// The live check targets the machine's real vivera checkout, not the copy of
// the repo this file runs from; $AI_SKILLS_ROOT names it explicitly for
// non-default layouts, and $HOME/vivera is the documented location.
const AI_SKILLS = process.env.AI_SKILLS_ROOT ?? join(homedir(), 'vivera');
const live = existsSync(AI_SKILLS) && installedPresent ? test : test.skip;

live('the plugin is V2 on both sides, and the installer says why', () => {
  // The premise of this test inverted on 2026-10-02 and the old assertions had
  // to invert with it. It used to read: "the installer writes a regression, so
  // the committed file must NOT match it." That was true because the vendored
  // `_OPENCODE_PLUGIN_JS` still shipped the V1 named export. It has since been
  // patched to V2 — a default export carrying `id` and `setup` — so the
  // installer is no longer the thing to guard against.
  //
  // Asserting `current === true` here would be wrong for a different reason
  // now: identity is no longer the signal. The committed file carries a Revert
  // block the vendored constant has no reason to know about, so it never
  // should be byte-identical. The assertions below are the ones that carry
  // meaning under either premise.
  const result = checkPlugin(AI_SKILLS);

  // The committed file exists and is V2. V1 does not merely drift, it fails to
  // load: PluginModule.LoadError, "Plugin must export a default definition with
  // an id and an effect or setup function" (err_908e90d2). Every plugin on this
  // machine was that shape until today.
  assert.ok(result.found, 'the committed plugin is missing entirely');
  assert.equal(exportShape(result.found), 'default-object', 'the committed plugin is back to the V1 named export');

  // The NOTE is institutional knowledge a future session cannot re-derive, so
  // its absence is the assertion that matters most on this side.
  assert.match(
    result.found,
    /@opencode\/plugin/,
    'the NOTE explaining why there is no runtime import from @opencode/plugin has been deleted',
  );

  // The other side, and the reason this test still earns its place. The
  // installer was patched in the uv venv, not upstream — 0.9.73 is still the
  // latest release and still ships V1. So `uv tool upgrade graphifyy` restores
  // the broken template, and a later `graphify install --project` writes it over
  // the working file on all four plugin paths. That is the tripwire now, and it
  // is an assertion about the VENDORED shape rather than the local one.
  assert.equal(
    exportShape(result.vendored),
    'default-object',
    'the installed graphify ships the V1 named export again — the venv patch was lost to an upgrade, so `graphify install --project` would revert every plugin on this machine',
  );

  // Same story for the #1646 header contradiction, which lived in the vendored
  // comment. It is asserted directly rather than through checkPlugin, because
  // checkPlugin reports it as drift and a patched installer correctly reports
  // none: the absence of a warning is not evidence of a fix.
  assert.ok(
    !headerContradictsCode(result.vendored),
    'the vendored header claims "&&" again while its own code prepends with ";"',
  );

  // Shape and contradiction are now both expected to be ABSENT, and a detector
  // that stopped reporting them would be indistinguishable from one that had
  // nothing to report. So assert the negative explicitly.
  const categories = result.drift.map((d) => d.split(':')[0]);
  assert.ok(
    !categories.includes(DRIFT.SHAPE),
    `shape drift reported but both sides are V2:\n${result.drift.join('\n')}`,
  );
  assert.ok(
    !categories.includes(DRIFT.CONTRADICTION),
    `contradiction reported but the vendored header was fixed:\n${result.drift.join('\n')}`,
  );
  assert.ok(
    !categories.includes(DRIFT.NOTE_MISSING),
    'the NOTE is present, so reporting it missing is a false alarm',
  );

  // The Revert block is the committed file's one deliberate difference, and the
  // detector should still name it — a detector that reports nothing here is a
  // detector that reports nothing anywhere.
  assert.ok(
    categories.includes(DRIFT.TEXT),
    `no first-differing-line reported, but the files are not identical:\n${result.drift.join('\n')}`,
  );
});

live('the extractor agrees with Python on the installed constant (skipped when python3 is absent)', () => {
  // The positive control for the whole reference path. Everything this module
  // compares against comes out of a hand-written Python-literal parser; if that
  // parser is wrong, every verdict is confidently wrong and no other test in
  // this file would notice. Python is the only authority on its own string
  // literals, so Python is asked — and the question is skipped, not asserted,
  // on a machine without it.
  const probe = spawnSync(
    'python3',
    [
      '-c',
      'import ast,sys;src=open(sys.argv[1]).read();' +
        'print(next(n.value.value for n in ast.parse(src).body ' +
        'if isinstance(n,ast.Assign) and getattr(n.targets[0],"id",None)=="_OPENCODE_PLUGIN_JS"),end="")',
      PLUGIN_SOURCE,
    ],
    { encoding: 'utf8' },
  );

  if (probe.error || probe.status !== 0) {
    assert.fail(`python3 could not read the constant from ${PLUGIN_SOURCE}: ${probe.error?.message ?? probe.stderr}`);
  }

  assert.equal(
    vendoredPlugin(),
    probe.stdout,
    'the extracted vendored plugin differs from what Python itself evaluates the constant to',
  );
});
