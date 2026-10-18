import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNC = path.join(ROOT, 'scripts', 'plan-sync.mjs');

// Each stub records its argv to a file and exits with a chosen code, so a test
// can prove what the real CLIs would have been called with without touching the
// vault or GitHub.
function fixture({ publishExit = 0, issueExit = 0 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-sync-'));
  const stub = (name, code) => {
    const file = path.join(dir, `${name}.mjs`);
    const log = path.join(dir, `${name}.args.json`);
    writeFileSync(file, `import { writeFileSync } from 'node:fs';\n`
      + `writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`
      + `process.exit(${code});\n`, 'utf8');
    return { file, log };
  };
  const publish = stub('publish', publishExit);
  const issue = stub('issue', issueExit);
  const plan = path.join(dir, 'plan.md');
  writeFileSync(plan, '# plan\n', 'utf8');
  return { dir, plan, publish, issue };
}

function run(f, args) {
  const r = spawnSync(process.execPath, [SYNC, ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PLAN_SYNC_PUBLISH_CMD: f.publish.file, PLAN_SYNC_ISSUE_CMD: f.issue.file },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const argsOf = (stub) => (existsSync(stub.log) ? JSON.parse(readFileSync(stub.log, 'utf8')) : null);

test('both steps pass: exit 0 and one exit line per step', () => {
  const f = fixture();
  try {
    const r = run(f, [f.plan]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^publish: exit 0$/m);
    assert.match(r.out, /^issue-sync: exit 0$/m);
    assert.ok(r.out.indexOf('publish: exit') < r.out.indexOf('issue-sync: exit'), 'publish runs first');
    assert.deepEqual(argsOf(f.publish), [f.plan]);
    assert.deepEqual(argsOf(f.issue), [f.plan]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('--project is passed to the issue sync only', () => {
  const f = fixture();
  try {
    const r = run(f, [f.plan, '--project', 'ai-skills']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(argsOf(f.publish), [f.plan]);
    assert.deepEqual(argsOf(f.issue), ['--project', 'ai-skills', f.plan]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a failed publish is the overall exit and the issue sync still reports', () => {
  const f = fixture({ publishExit: 1, issueExit: 4 });
  try {
    const r = run(f, [f.plan]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^publish: exit 1$/m);
    assert.match(r.out, /^issue-sync: exit 4$/m);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a failed issue sync alone sets the overall exit', () => {
  const f = fixture({ issueExit: 3 });
  try {
    const r = run(f, [f.plan]);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /^publish: exit 0$/m);
    assert.match(r.out, /^issue-sync: exit 3$/m);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('usage errors exit 2 and run neither step', () => {
  const f = fixture();
  try {
    for (const args of [[], ['--project'], [f.plan, '--bogus'], [f.plan, f.plan]]) {
      const r = run(f, args);
      assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.out}`);
      assert.match(r.out, /usage/i);
    }
    assert.equal(argsOf(f.publish), null);
    assert.equal(argsOf(f.issue), null);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
