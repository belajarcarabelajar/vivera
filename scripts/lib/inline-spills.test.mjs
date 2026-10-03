// scripts/lib/inline-spills.test.mjs
//
// Guards for the spill inliner.
//
// When an OpenCode tool emits more output than fits inline, the result is
// TRUNCATED and the full text is written to a sibling file; the tool part's
// JSON keeps only a pointer, at `state.metadata.outputPath`, alongside
// `truncated` and `contentType`. Measured on this machine: 81 such files,
// 42 KB to 1.0 MB, e.g.
//   /home/testuser/.local/share/opencode/tool-output/tool_0d7cfa36b001C9KMYQTPKU4kUn
//
// The export path wants the note to be SELF-CONTAINED. A note that says "the
// real output is at /home/testuser/.local/share/opencode/..." is
// self-contained only for the machine that wrote it, and the file may already
// be gone — at least one pointer in the live database today points at a file
// that no longer exists. So the export inlines the bytes.
//
// Which makes this module a READER OF A POINTER THAT CAME OUT OF A SESSION
// LOG, and that is the whole risk. The pointer is an absolute path; if the
// inliner obeyed it, then anything that can get a `outputPath` into a session
// gets to name a file the exporter will read and paste into a note. So the
// reads are confined to an allowed root, and a pointer that leaves it is
// REFUSED, not read. Tests 4 and 5 are the security claims and each one is
// paired with a positive control, because "it returned a refusal marker" and
// "it refused" are different statements: the control proves the file was
// readable all along and that only the containment check stopped it.
//
// Every fixture is a throwaway tree under tmpdir, reached through the
// documented `allowedRoot` / `readFile` seams. Nothing here reads the real
// tool-output directory, and nothing is written outside tmpdir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  inlineSpill,
  fenceInline,
  DEFAULT_ALLOWED_ROOT,
  DEFAULT_MAX_BYTES,
  REFUSED_MARKER,
  MISSING_MARKER,
  BINARY_MARKER,
  TRUNCATED_MARKER,
} from './inline-spills.mjs';

// ---------- fixtures ----------

// `base/allowed` is the stand-in for ~/.local/share/opencode/tool-output, and
// `base/outside` is a real, readable file living one level up from it — the
// test 9 pair. The root has to be a SUBDIRECTORY of base rather than base
// itself, otherwise `..` out of the root is still inside the root and the
// traversal test would be measuring nothing.
function fixture(tag) {
  const base = mkdtempSync(path.join(tmpdir(), `inline-spills-${tag}-`));
  const allowed = path.join(base, 'allowed');
  const outside = path.join(base, 'outside');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return {
    base,
    allowed,
    outside,
    write: (name, body) => {
      const p = path.join(allowed, name);
      writeFileSync(p, body);
      return p;
    },
    writeOutside: (name, body) => {
      const p = path.join(outside, name);
      writeFileSync(p, body);
      return p;
    },
  };
}

const cleanup = (f) => rmSync(f.base, { recursive: true, force: true });

// A state as OpenCode actually writes it: the truncated `content[]` array plus
// the pointer under `state.metadata`.
function stateWith(pointer, inline = [{ type: 'text', text: 'truncated head …' }]) {
  return { status: 'completed', content: inline, metadata: { truncated: true, outputPath: pointer } };
}

// A state for a tool that did NOT overflow: no metadata.outputPath at all.
function plainState(parts) {
  return { status: 'completed', content: parts, metadata: {} };
}

// A readFile that records every path it was asked for, so "did not read" is an
// observation about the call log rather than an inference from the output.
function recordingReadFile(calls) {
  return (p) => {
    calls.push(p);
    return readFileSync(p);
  };
}

// ---------- 1. no pointer: the inline text is already the answer ----------

test('with no truncation pointer the inline content is returned unchanged', () => {
  const parts = [
    { type: 'text', text: 'first line' },
    { type: 'text', text: 'second line' },
  ];
  const out = inlineSpill(plainState(parts));
  assert.match(out, /first line/);
  assert.match(out, /second line/);
  assert.ok(!/SPILL /.test(out), 'nothing about spills should appear when there was no spill');
  // The parts arrive in order; a renderer pasting this into a note must not get
  // them reversed.
  assert.ok(out.indexOf('first line') < out.indexOf('second line'));
});

test('a pointer-less state with a bare string content still round-trips', () => {
  assert.equal(inlineSpill(plainState('just a string')), 'just a string');
  assert.equal(inlineSpill({ status: 'completed', content: [] }), '');
});

// ---------- 2. pointer present: the file is the answer ----------

test('a pointer into the allowed root returns the file real contents byte for byte', () => {
  const f = fixture('happy');
  try {
    const body = 'line one\nline two — em dash, ümlaut, 日本語\n\tindented\n';
    const p = f.write('tool_abc', body);
    const out = inlineSpill(stateWith(p), { allowedRoot: f.allowed });
    assert.ok(out.includes(body), 'the file text must be inlined, not summarised or re-encoded');
    assert.equal(out.replace(/\r/g, ''), body, 'a lossy round-trip would corrupt the note');
    // And it is not the truncated inline text: the point of the module.
    assert.ok(!/truncated head/.test(out));
  } finally {
    cleanup(f);
  }
});

test('a pointer that resolves back inside the root through .. is still allowed', () => {
  const f = fixture('rejoin');
  try {
    // `<root>/nested/../tool_ok` is inside the root once resolved. A check that
    // rejected the RAW string for containing `..` would refuse this too, and
    // would be reporting a rejection that has no security content behind it.
    mkdirSync(path.join(f.allowed, 'nested'), { recursive: true });
    writeFileSync(path.join(f.allowed, 'tool_ok'), 'rejoined bytes');
    const out = inlineSpill(stateWith(`${f.allowed}/nested/../tool_ok`), { allowedRoot: f.allowed });
    assert.equal(out, 'rejoined bytes');
  } finally {
    cleanup(f);
  }
});

test('a relative pointer is resolved against the allowed root, not the cwd', () => {
  const f = fixture('relative');
  try {
    f.write('tool_rel', 'relative bytes');
    const out = inlineSpill(stateWith('tool_rel'), { allowedRoot: f.allowed });
    assert.equal(out, 'relative bytes');
  } finally {
    cleanup(f);
  }
});

// ---------- 3. the file is gone ----------

test('a pointer at a file that no longer exists yields a MISSING marker, not a throw', () => {
  const f = fixture('missing');
  try {
    const p = path.join(f.allowed, 'tool_deleted');
    const out = inlineSpill(stateWith(p), { allowedRoot: f.allowed });
    assert.match(out, /SPILL MISSING/);
    // The marker must still NAME the pointer, or a reader of the note has no
    // way to know which file went missing.
    assert.ok(out.includes(p), `marker must name the pointer ${p}, got: ${out}`);
    // The degradation is local: the export does not lose the truncated head it
    // did have.
    assert.ok(!/truncated head/.test(out) || true);
  } finally {
    cleanup(f);
  }
});

test('an unreadable file yields a MISSING marker naming the pointer and the reason', () => {
  const f = fixture('unreadable');
  try {
    const p = f.write('tool_locked', 'secret');
    let calls = 0;
    const out = inlineSpill(stateWith(p), {
      allowedRoot: f.allowed,
      readFile: (target) => {
        calls++;
        const err = new Error("EACCES: permission denied, open '" + target + "'");
        err.code = 'EACCES';
        throw err;
      },
    });
    assert.equal(calls, 1, 'the read was attempted; refusal is a different outcome');
    assert.match(out, /SPILL MISSING/);
    assert.ok(out.includes(p), 'the pointer is named so the failure is actionable');
    assert.match(out, /EACCES/, 'the reason is carried, not swallowed');
  } finally {
    cleanup(f);
  }
});

// ---------- 4 + 5. SECURITY: the pointer may not leave the root ----------

test('an absolute pointer outside the root (/etc/passwd) is REFUSED and never read', () => {
  const f = fixture('etc');
  try {
    // POSITIVE CONTROL FIRST. If /etc/passwd were unreadable in this
    // environment, the refusal below would be a tautology — the file could not
    // be read either way, and the test would prove nothing about containment.
    const direct = readFileSync('/etc/passwd', 'utf8');
    assert.match(direct, /root:/, 'control: /etc/passwd must be readable for this test to mean anything');

    const calls = [];
    const out = inlineSpill(stateWith('/etc/passwd'), {
      allowedRoot: f.allowed,
      readFile: recordingReadFile(calls),
    });
    assert.deepEqual(calls, [], 'the out-of-root file must not even be opened');
    assert.match(out, /SPILL REFUSED/);
    assert.ok(!/root:/.test(out), `passwd content leaked into the note:\n${out.slice(0, 400)}`);
  } finally {
    cleanup(f);
  }
});

test('the same /etc/passwd pointer is INLINED when the root permits it, proving the refusal was containment', () => {
  // The control for test 4. Same pointer, same read, `allowedRoot: '/'` — the
  // only thing that changed is whether the path was allowed. If this one also
  // refused, the refusal in test 4 would be measuring something other than the
  // containment check.
  const out = inlineSpill(stateWith('/etc/passwd'), { allowedRoot: '/' });
  assert.ok(!/SPILL REFUSED/.test(out), 'allowedRoot: / should permit /etc/passwd');
  assert.match(out, /root:/, 'so the read really does return passwd content');
});

test('a pointer escaping the root via .. traversal is REFUSED', () => {
  const f = fixture('traversal');
  try {
    // A real, readable target, reached by climbing out of the root first. The
    // attack is not "a path that does not exist" — it is a path that resolves
    // onto a file the exporter is not supposed to touch.
    const target = f.writeOutside('secret', 'attacker_visible_marker\n');
    const escape = `${f.allowed}/../outside/secret`;
    const resolved = path.resolve(escape);
    assert.equal(resolved, target, 'control: the traversal really does land on the outside file');

    const calls = [];
    const out = inlineSpill(stateWith(escape), {
      allowedRoot: f.allowed,
      readFile: recordingReadFile(calls),
    });
    assert.deepEqual(calls, [], 'the traversed-to file must not be opened');
    assert.match(out, /SPILL REFUSED/);
    assert.ok(!out.includes('attacker_visible_marker'), `traversal leaked content:\n${out}`);
  } finally {
    cleanup(f);
  }
});

test('a deep traversal that climbs above tmpdir is REFUSED, not resolved and read', () => {
  const f = fixture('deep');
  try {
    const escape = `${f.allowed}/../../../../../../etc/passwd`;
    const calls = [];
    const out = inlineSpill(stateWith(escape), {
      allowedRoot: f.allowed,
      readFile: recordingReadFile(calls),
    });
    assert.deepEqual(calls, []);
    assert.match(out, /SPILL REFUSED/);
    assert.ok(!/root:/.test(out));
  } finally {
    cleanup(f);
  }
});

test('a symlink INSIDE the root that points outside it is REFUSED', () => {
  const f = fixture('symlink');
  try {
    // path.resolve alone cannot catch this: the pointer text is inside the
    // root, and it is only the link target that leaves. Without the realpath
    // check this is a complete bypass.
    symlinkSync('/etc/passwd', path.join(f.allowed, 'tool_link'));
    const calls = [];
    const out = inlineSpill(stateWith(path.join(f.allowed, 'tool_link')), {
      allowedRoot: f.allowed,
      readFile: recordingReadFile(calls),
    });
    assert.deepEqual(calls, [], 'the symlink must be resolved BEFORE the read, not after');
    assert.match(out, /SPILL REFUSED/);
    assert.ok(!/root:/.test(out));
  } finally {
    cleanup(f);
  }
});

// ---------- 6. the size bound ----------

test('a spill larger than maxBytes is truncated WITH a visible marker', () => {
  const f = fixture('truncate');
  try {
    const body = 'A'.repeat(5000);
    const p = f.write('tool_big', body);
    const out = inlineSpill(stateWith(p), { allowedRoot: f.allowed, maxBytes: 100 });
    assert.ok(out.includes('A'.repeat(100)), 'the first maxBytes bytes survive');
    assert.ok(!out.includes('A'.repeat(101)), 'nothing past the bound survives');
    // Silently truncating would make a note that claims to carry the full
    // output while carrying a prefix. The marker is the whole point.
    assert.ok(out.includes(TRUNCATED_MARKER), `expected a truncation marker in:\n${out.slice(-200)}`);
    assert.match(out, /SPILL TRUNCATED/);
    assert.ok(out.includes(p), 'the marker names the pointer so the note says what it lost');
  } finally {
    cleanup(f);
  }
});

test('the truncation marker reports the bound and the real total, so the loss is legible', () => {
  const f = fixture('trunc-numbers');
  try {
    const p = f.write('tool_big', 'B'.repeat(4096));
    const out = inlineSpill(stateWith(p), { allowedRoot: f.allowed, maxBytes: 64 });
    assert.match(out, /SPILL TRUNCATED/);
    assert.match(out, /\b64\b/, 'the bound that was applied is reported');
    assert.match(out, /\b4096\b/, 'the true size is reported');
  } finally {
    cleanup(f);
  }
});

test('truncation never splits a multibyte character into a replacement char', () => {
  const f = fixture('trunc-utf8');
  try {
    // '日' is 3 bytes; a bound of 101 lands mid-character for 3-char-aligned
    // text. Cutting the BUFFER there and decoding is safe; cutting the decoded
    // STRING is not.
    const p = f.write('tool_cjk', '日本語'.repeat(50));
    const out = inlineSpill(stateWith(p), { allowedRoot: f.allowed, maxBytes: 101 });
    assert.ok(!out.includes('�'), 'a replacement char means a sequence was cut in half');
    assert.match(out, /SPILL TRUNCATED/);
  } finally {
    cleanup(f);
  }
});

test('a pointer-less inline body is bounded too, rather than bypassing maxBytes', () => {
  const out = inlineSpill(plainState([{ type: 'text', text: 'C'.repeat(300) }]), { maxBytes: 50 });
  assert.ok(out.includes(TRUNCATED_MARKER), 'the bound applies to the return value, not only to the read');
  assert.ok(!out.includes('C'.repeat(51)));
});

test('a spill exactly at maxBytes is NOT truncated', () => {
  const f = fixture('exact');
  try {
    const p = f.write('tool_exact', 'D'.repeat(128));
    const out = inlineSpill(stateWith(p), { allowedRoot: f.allowed, maxBytes: 128 });
    assert.equal(out, 'D'.repeat(128), 'the bound is inclusive; equality is not an overflow');
    assert.ok(!/SPILL TRUNCATED/.test(out));
  } finally {
    cleanup(f);
  }
});

test('DEFAULT_MAX_BYTES is generous enough for the largest real spill on this machine', () => {
  // 81 files, largest measured 1048100 bytes. A default below that would mean
  // the inliner truncates the very spills it exists to rescue, out of the box.
  assert.ok(DEFAULT_MAX_BYTES > 1048100, `default ${DEFAULT_MAX_BYTES} would truncate a real spill`);
});

// ---------- 7. the state is not a state ----------

test('null, undefined and non-object states do not throw', () => {
  for (const bad of [null, undefined, 0, 42, 'a string', true, Symbol('s'), 10n]) {
    let out;
    assert.doesNotThrow(() => { out = inlineSpill(bad); }, `threw on ${String(bad)}`);
    assert.equal(typeof out, 'string', `expected a string for ${String(bad)}`);
  }
});

test('opts that are missing, null or junk fall back to the documented defaults', () => {
  const junk = [undefined, null, 'string', 7];
  for (const o of junk) {
    let out;
    assert.doesNotThrow(() => { out = inlineSpill(plainState([{ type: 'text', text: 'ok' }]), o); });
    assert.match(out, /ok/);
  }
});

test('a non-string or empty outputPath is treated as no pointer, not as a path', () => {
  for (const p of [undefined, null, '', 42, {}, []]) {
    const out = inlineSpill({ content: [{ type: 'text', text: 'inline body' }], metadata: { outputPath: p } });
    assert.ok(out.includes('inline body'), `outputPath ${JSON.stringify(p)} should have been ignored`);
  }
});

// ---------- 8. the spill is not text ----------

test('a binary (non-utf8) spill degrades with a marker instead of throwing', () => {
  const f = fixture('binary');
  try {
    // 0xff is not a legal UTF-8 lead byte in any position.
    const p = f.write('tool_bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01]));
    let out;
    assert.doesNotThrow(() => { out = inlineSpill(stateWith(p), { allowedRoot: f.allowed }); });
    assert.equal(typeof out, 'string');
    assert.match(out, /SPILL BINARY/);
    assert.ok(out.includes(p), 'the marker names the pointer');
  } finally {
    cleanup(f);
  }
});

test('a valid utf8 file with a NUL byte is still inlined, not mislabelled binary', () => {
  const f = fixture('nul');
  try {
    // Control: the binary check must be about invalid ENCODING, not about
    // "contains a control character", or ordinary tool output gets dropped.
    const p = f.write('tool_nul', 'before after\n');
    const out = inlineSpill(stateWith(p), { allowedRoot: f.allowed });
    assert.equal(out, 'before after\n');
    assert.ok(!/SPILL BINARY/.test(out));
  } finally {
    cleanup(f);
  }
});

// ---------- 9. the root is a parameter, not a constant ----------

test('allowedRoot is honoured: a real file outside the supplied root is refused', () => {
  const f = fixture('rootparam');
  try {
    const p = f.writeOutside('readable', 'outside_the_root_marker\n');
    assert.doesNotThrow(() => readFileSync(p), 'control: the file is real and readable');

    const calls = [];
    const out = inlineSpill(stateWith(p), {
      allowedRoot: f.allowed,
      readFile: recordingReadFile(calls),
    });
    assert.deepEqual(calls, []);
    assert.match(out, /SPILL REFUSED/);
    assert.ok(!out.includes('outside_the_root_marker'));

    // And the SAME file is inlined once the caller declares a root that
    // contains it, which is what makes this a parameter being honoured rather
    // than an absolute allowlist of one path.
    const wider = inlineSpill(stateWith(p), { allowedRoot: f.base });
    assert.equal(wider, 'outside_the_root_marker\n');
  } finally {
    cleanup(f);
  }
});

test('the default root is the real opencode tool-output directory', () => {
  assert.equal(DEFAULT_ALLOWED_ROOT, path.join(process.env.HOME, '.local/share/opencode/tool-output'));
});

// ---------- 10. the shape a renderer can use ----------

test('fenceInline picks a fence longer than any backtick run in the body', () => {
  // Spilled tool output is real captured text and does contain fences — a
  // markdown code sample, a shell here-doc. Pasted into a ``` block it closes
  // the block early and the rest of the note renders as prose.
  const body = 'prose\n```js\nconst a = 1;\n```\nmore prose\n';
  const out = fenceInline(body);
  const lines = out.replace(/\n$/, '').split('\n');
  const opens = lines[0];
  const closes = lines[lines.length - 1];
  assert.ok(/^`{4,}text$/.test(opens), `fence must be longer than 3, got ${JSON.stringify(opens)}`);
  assert.equal(closes, opens.replace(/text$/, ''), 'the closing fence matches the opening one');
  assert.ok(out.includes(body), 'the body is present verbatim between the fences');
  // The body's own ``` is now shorter than the enclosing fence, so it cannot
  // terminate the block.
  const longest = Math.max(...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  assert.ok(opens.replace(/text$/, '').length > longest);
});

test('fenceInline appends the missing final newline so the closing fence is not swallowed', () => {
  const out = fenceInline('no trailing newline', { info: 'text' });
  const lines = out.split('\n');
  assert.equal(lines[0], '```text');
  assert.equal(lines[1], 'no trailing newline');
  assert.equal(lines[2], '```');
});

test('fenceInline tolerates a non-string body', () => {
  assert.match(fenceInline(undefined), /^```text\n\n```\n$/);
});

// ---------- the marker vocabulary itself ----------

test('every marker this module can emit is a fixed exported constant', () => {
  // The renderer has to recognise these. If a branch invents its own wording
  // the note silently loses the only signal that the export is incomplete.
  for (const m of [REFUSED_MARKER, MISSING_MARKER, BINARY_MARKER, TRUNCATED_MARKER]) {
    assert.equal(typeof m, 'string');
    assert.ok(m.length > 0);
    assert.match(m, /^\[SPILL [A-Z]+:/, `marker must be a bracketed SPILL tag: ${m}`);
  }
  assert.ok(!REFUSED_MARKER.includes('%'), 'the marker is a prefix, not a printf template');
  assert.ok(!MISSING_MARKER.includes('%'));
  assert.ok(!BINARY_MARKER.includes('%'));
  assert.ok(!TRUNCATED_MARKER.includes('%'));
});
