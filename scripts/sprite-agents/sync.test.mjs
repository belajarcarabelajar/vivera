import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, isGenerated, syncDir } from './sync.mjs';

const GEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gen-sprite-agents.mjs');

let tmp;
let out;
let elsewhere;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-agents-sync-'));
  out = path.join(tmp, 'out');
  elsewhere = path.join(tmp, 'elsewhere');
  fs.mkdirSync(out);
  fs.mkdirSync(elsewhere);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const md = (name) => `---\nname: ${name}\n${MARKER} from test.\n---\n`;
const mine = '---\nname: mine\ndescription: written by hand\n---\n';
const at = (...parts) => path.join(out, ...parts);
const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (file) => fs.readFileSync(file, 'utf8');

describe('syncDir with a symlink on a managed path', () => {
  test('refuses a nested output whose directory is a link to a directory holding a hand-written file', () => {
    put(path.join(elsewhere, 'agent.md'), mine);
    fs.symlinkSync(elsewhere, at('chef'));
    const r = syncDir(out, new Map([['chef/agent.md', md('chef')]]));
    expect(r.refused).toEqual(['chef/agent.md']);
    expect(r.written).toEqual([]);
    expect(read(path.join(elsewhere, 'agent.md'))).toBe(mine);
  });

  test('refuses a linked directory even when the file behind the link carries the marker', () => {
    put(path.join(elsewhere, 'agent.md'), md('theirs'));
    fs.symlinkSync(elsewhere, at('chef'));
    const r = syncDir(out, new Map([['chef/agent.md', md('chef')]]));
    expect(r.refused).toEqual(['chef/agent.md']);
    expect(read(path.join(elsewhere, 'agent.md'))).toBe(md('theirs'));
  });

  test('refuses a linked directory that is empty, so nothing is created behind the link', () => {
    fs.symlinkSync(elsewhere, at('chef'));
    const r = syncDir(out, new Map([['chef/agent.md', md('chef')]]));
    expect(r.refused).toEqual(['chef/agent.md']);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  test('refuses a flat output that is a link to a file with the marker, and leaves the target alone', () => {
    put(path.join(elsewhere, 'real.md'), md('theirs'));
    fs.symlinkSync(path.join(elsewhere, 'real.md'), at('chef.md'));
    const r = syncDir(out, new Map([['chef.md', md('chef')]]));
    expect(r.refused).toEqual(['chef.md']);
    expect(r.written).toEqual([]);
    expect(read(path.join(elsewhere, 'real.md'))).toBe(md('theirs'));
  });

  test('refuses a link whose content already equals the output, in check mode too', () => {
    put(path.join(elsewhere, 'real.md'), md('chef'));
    fs.symlinkSync(path.join(elsewhere, 'real.md'), at('chef.md'));
    expect(syncDir(out, new Map([['chef.md', md('chef')]]), { check: true }).refused).toEqual(['chef.md']);
  });

  test('still writes the other outputs and keeps the output directory link itself allowed', () => {
    const linked = path.join(tmp, 'linked-out');
    fs.symlinkSync(out, linked);
    put(path.join(elsewhere, 'agent.md'), mine);
    fs.symlinkSync(elsewhere, at('chef'));
    const r = syncDir(linked, new Map([['chef/agent.md', md('chef')], ['hoggy/agent.md', md('hoggy')]]));
    expect(r.refused).toEqual(['chef/agent.md']);
    expect(r.written).toEqual(['hoggy/agent.md']);
    expect(read(at('hoggy', 'agent.md'))).toBe(md('hoggy'));
  });

  test('cleaning never follows a linked directory and never removes a link to a marked file', () => {
    put(path.join(elsewhere, 'agent.md'), md('theirs'));
    put(path.join(elsewhere, 'old.md'), md('old'));
    fs.symlinkSync(elsewhere, at('chef'));
    fs.symlinkSync(path.join(elsewhere, 'old.md'), at('old.md'));
    expect(syncDir(out, new Map()).removed).toEqual([]);
    expect(fs.existsSync(path.join(elsewhere, 'agent.md'))).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, 'old.md'))).toBe(true);
    expect(fs.lstatSync(at('old.md')).isSymbolicLink()).toBe(true);
  });
});

describe('syncDir with something that is not a file in the way', () => {
  test('a directory named like a flat output is refused with the others still written', () => {
    fs.mkdirSync(at('timid.md'));
    const r = syncDir(out, new Map([['chef.md', md('chef')], ['timid.md', md('timid')], ['staid.md', md('staid')]]));
    expect(r.refused).toEqual(['timid.md']);
    expect(r.inTheWay).toEqual(['timid.md']);
    expect(r.written.sort()).toEqual(['chef.md', 'staid.md']);
    expect(fs.statSync(at('timid.md')).isDirectory()).toBe(true);
  });

  test('a file named like the directory of a nested output is refused with the others still written', () => {
    put(at('chef'), 'a plain file\n');
    const r = syncDir(out, new Map([['chef/agent.md', md('chef')], ['hoggy/agent.md', md('hoggy')]]));
    expect(r.refused).toEqual(['chef/agent.md']);
    expect(r.inTheWay).toEqual(['chef/agent.md']);
    expect(r.written).toEqual(['hoggy/agent.md']);
    expect(read(at('chef'))).toBe('a plain file\n');
  });

  test('a dangling link named like an output is refused and not written through', () => {
    fs.symlinkSync(path.join(elsewhere, 'missing.md'), at('chef.md'));
    const r = syncDir(out, new Map([['chef.md', md('chef')], ['hoggy.md', md('hoggy')]]));
    expect(r.refused).toEqual(['chef.md']);
    expect(r.inTheWay).toEqual(['chef.md']);
    expect(r.written).toEqual(['hoggy.md']);
    expect(fs.existsSync(path.join(elsewhere, 'missing.md'))).toBe(false);
  });

  test('check mode reports the conflict as a refusal, not as drift, and does not throw', () => {
    fs.mkdirSync(at('timid.md'));
    const r = syncDir(out, new Map([['timid.md', md('timid')]]), { check: true });
    expect(r.refused).toEqual(['timid.md']);
    expect(r.drift).toEqual([]);
  });

  test('the CLI names the path, writes the rest, and exits 1 at the end', () => {
    put(at('chef'), 'a plain file\n');
    const r = Bun.spawnSync(['bun', GEN, '--target', 'antigravity', '--out', out]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`${at('chef', 'agent.md')}: something that is not a generated file is in the way, left untouched`);
    expect(r.stderr.toString()).not.toContain('EEXIST');
    expect(fs.existsSync(at('hoggy', 'agent.md'))).toBe(true);
    expect(read(at('chef'))).toBe('a plain file\n');
  });
});

describe('syncDir with a name that differs only by case', () => {
  test('refuses a hand-written file whose name differs by case, and writes no second file', () => {
    put(at('Chef.md'), mine);
    const r = syncDir(out, new Map([['chef.md', md('chef')]]));
    expect(r.refused).toEqual(['Chef.md']);
    expect(r.written).toEqual([]);
    expect(fs.readdirSync(out)).toEqual(['Chef.md']);
    expect(read(at('Chef.md'))).toBe(mine);
  });

  test('refuses a nested output whose existing file differs by case in the directory or the name', () => {
    put(at('Chef', 'agent.md'), mine);
    put(at('hoggy', 'Agent.md'), mine);
    const r = syncDir(out, new Map([['chef/agent.md', md('chef')], ['hoggy/agent.md', md('hoggy')]]), { nested: true });
    expect(r.refused.sort()).toEqual(['Chef/agent.md', 'hoggy/Agent.md']);
    expect(r.written).toEqual([]);
  });

  test('check mode refuses too and does not report the output as missing', () => {
    put(at('Chef.md'), mine);
    const r = syncDir(out, new Map([['chef.md', md('chef')]]), { check: true });
    expect(r.refused).toEqual(['Chef.md']);
    expect(r.drift).toEqual([]);
  });

  test('leaves a marked file of a different case alone instead of removing it as stale', () => {
    put(at('Chef.md'), md('Chef'));
    const r = syncDir(out, new Map([['chef.md', md('chef')]]));
    expect(r.refused).toEqual(['Chef.md']);
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(at('Chef.md'))).toBe(true);
  });

  test('an exact name that exists is judged on its own, so a generated file with a case sibling still updates', () => {
    put(at('chef.md'), md('old'));
    put(at('Chef.md'), mine);
    const r = syncDir(out, new Map([['chef.md', md('chef')]]));
    expect(r.refused).toEqual([]);
    expect(r.written).toEqual(['chef.md']);
  });
});

describe('isGenerated', () => {
  const check = (name, content) => {
    put(at(name), content);
    return isGenerated(at(name));
  };

  test('finds the marker on a line inside the leading frontmatter block', () => {
    expect(check('a.md', md('a'))).toBe(true);
  });

  test('does not take a marker in the body, or in a code fence, as a marker', () => {
    expect(check('body.md', `---\nname: mine\n---\n\n${MARKER} from my notes.\n`)).toBe(false);
    expect(check('fence.md', `---\nname: mine\n---\n\n\`\`\`text\n${MARKER} from a doc\n\`\`\`\n`)).toBe(false);
  });

  test('does not take a marker in a Markdown file without frontmatter', () => {
    expect(check('plain.md', `# Notes\n\n${MARKER} from a doc.\n`)).toBe(false);
  });

  test('does not take a marker when the frontmatter never closes', () => {
    expect(check('open.md', `---\nname: mine\n${MARKER} from test.\n`)).toBe(false);
  });

  test('wants the TOML marker on line 1', () => {
    expect(check('a.toml', `${MARKER} from test.\nname = "a"\n`)).toBe(true);
    expect(check('b.toml', `name = "a"\n${MARKER} from test.\n`)).toBe(false);
    expect(check('c.toml', `name = "a"\ndeveloper_instructions = '''\n${MARKER} from a doc\n'''\n`)).toBe(false);
  });

  test('allows one UTF-8 byte order mark before the first line', () => {
    expect(check('bom.toml', `﻿${MARKER} from test.\nname = "a"\n`)).toBe(true);
    expect(check('bom.md', `﻿${md('a')}`)).toBe(true);
    expect(check('bom-body.md', `﻿---\nname: mine\n---\n${MARKER} x\n`)).toBe(false);
  });

  test('reads a file saved with CRLF line endings', () => {
    expect(check('crlf.md', md('a').replaceAll('\n', '\r\n'))).toBe(true);
    expect(check('crlf.toml', `${MARKER} from test.\r\nname = "a"\r\n`)).toBe(true);
  });

  test('is false for an absent file and for a directory', () => {
    expect(isGenerated(at('absent.md'))).toBe(false);
    fs.mkdirSync(at('dir.md'));
    expect(isGenerated(at('dir.md'))).toBe(false);
  });

  test('a hand-written file with a fenced marker is refused, and cleaning leaves it', () => {
    const doc = `---\nname: chef\n---\n\n\`\`\`\n${MARKER} from a doc\n\`\`\`\n`;
    put(at('chef.md'), doc);
    expect(syncDir(out, new Map([['chef.md', md('chef')]])).refused).toEqual(['chef.md']);
    expect(syncDir(out, new Map()).removed).toEqual([]);
    expect(read(at('chef.md'))).toBe(doc);
  });
});
