// scripts/container.test.mjs
//
// Structural tests for the container channel: Dockerfile, .dockerignore and
// .devcontainer/devcontainer.json. Docker, podman and hadolint are not installed on the machine that
// wrote these, so nothing here builds or runs an image: the tests read the files and compare them
// with the installer's own usage text. They need no network.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_PAYLOAD } from './lib/install-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// --- Dockerfile parsing: logical instructions, with comments and continuations folded ---------
function instructions(text) {
  const logical = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line) || (cur === '' && /^\s*$/.test(line))) continue;
    const m = line.match(/^(.*?)\\\s*$/);
    if (m) {
      cur += `${m[1]} `;
    } else {
      logical.push(`${cur}${line}`.trim());
      cur = '';
    }
  }
  return logical.map((raw) => {
    const sp = raw.search(/\s/);
    return { name: (sp < 0 ? raw : raw.slice(0, sp)).toUpperCase(), args: sp < 0 ? '' : raw.slice(sp + 1).trim(), raw };
  });
}

const dockerfile = instructions(read('Dockerfile'));
const named = (name) => dockerfile.filter((i) => i.name === name);
const installRun = () => dockerfile.findIndex((i) => i.name === 'RUN' && i.args.includes('install.sh'));

// The stages, each with the alias it was given (`FROM image AS alias`).
function stages() {
  const out = [];
  for (const i of dockerfile) {
    if (i.name === 'FROM') {
      const m = i.args.match(/^(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?$/i);
      out.push({ image: m[1], alias: m[2], body: [] });
    } else out.at(-1)?.body.push(i);
  }
  return out;
}

// `--flag` words of every ./install.sh call in one shell command line.
function installerCalls(cmd) {
  return cmd
    .split(/&&|;|\|\|/)
    .filter((seg) => seg.includes('install.sh'))
    .map((seg) => seg.slice(seg.indexOf('install.sh')));
}
const flagsOf = (calls) => calls.flatMap((c) => c.match(/--[a-z][a-z-]*/g) ?? []);

const help = (() => {
  const r = Bun.spawnSync(['bash', './install.sh', '-h'], { cwd: ROOT });
  return { status: r.exitCode, text: r.stdout.toString() };
})();
const devcontainer = JSON.parse(read('.devcontainer/devcontainer.json'));

// --- A small .dockerignore matcher: rooted at the context, * within a segment, ** across segments,
// ? one character, ! to re-include, the last matching line wins, and a match on a directory takes
// everything under it. It approximates Docker's rules for the plain paths used here; it is not Docker.
function patternRegex(pattern) {
  const p = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      re += '.*';
      i += p[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(/.*)?$`);
}
function ignoreLines() {
  return read('.dockerignore')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}
function ignored(file, lines) {
  let result = false;
  for (const line of lines) {
    const negated = line.startsWith('!');
    if (patternRegex(negated ? line.slice(1) : line).test(file)) result = !negated;
  }
  return result;
}

// Every file or link under one payload entry, as context-relative paths. lstat, so a symlink is a
// path of its own and is never followed.
function filesUnder(rel) {
  const abs = path.join(ROOT, rel);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) return [];
  if (!st.isDirectory()) return [rel];
  return fs.readdirSync(abs).flatMap((name) => filesUnder(`${rel}/${name}`));
}

describe('Dockerfile: the base image', () => {
  test('the first FROM has an explicit tag with a version number, and the tag is not latest', () => {
    const first = stages()[0].image;
    const m = first.match(/^([^:@\s]+):([^:@\s]+)$/);
    expect(m).not.toBeNull();
    expect(m[2]).not.toBe('latest');
    expect(m[2]).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('every FROM that names an image rather than an earlier stage is pinned the same way', () => {
    const seen = new Set();
    for (const s of stages()) {
      if (!seen.has(s.image)) expect(s.image).toMatch(/^[^:@\s]+:\d+\.\d+\.\d+\S*$/);
      if (s.alias) seen.add(s.alias);
    }
  });

  test('the Bun version in the tag is the one package.json pins', () => {
    const pinned = JSON.parse(read('package.json')).packageManager.replace(/^bun@/, '');
    expect(stages()[0].image.split(':')[1].startsWith(pinned)).toBe(true);
  });

  test('the base is the Debian variant, because the Dockerfile uses apt-get and useradd', () => {
    expect(stages()[0].image).toMatch(/^oven\/bun:\S+-debian$/);
  });
});

describe('Dockerfile: what it must not do', () => {
  test('has no pipe into a shell, no curl, no wget, and no ADD of a URL', () => {
    for (const i of dockerfile) {
      expect({ line: i.raw, pipe: /\|\s*(ba|da|z)?sh\b/.test(i.raw) }).toEqual({ line: i.raw, pipe: false });
      expect({ line: i.raw, net: /\b(curl|wget)\b/.test(i.raw) }).toEqual({ line: i.raw, net: false });
      expect({ line: i.raw, add: i.name === 'ADD' && /^https?:/i.test(i.args.replace(/^--\S+\s+/, '')) }).toEqual({ line: i.raw, add: false });
    }
  });

  test('never uses a floating tag anywhere', () => {
    expect(dockerfile.some((i) => /:latest\b/.test(i.raw) || /=latest\b/.test(i.raw))).toBe(false);
  });
});

describe('Dockerfile: user and layout', () => {
  test('a user other than root is set before the install.sh RUN, and the last USER is not root', () => {
    const at = installRun();
    expect(at).toBeGreaterThan(-1);
    const users = dockerfile.map((i, idx) => ({ ...i, idx })).filter((i) => i.name === 'USER');
    expect(users.length).toBeGreaterThan(0);
    const before = users.filter((u) => u.idx < at);
    expect(before.length).toBeGreaterThan(0);
    expect(['root', '0']).not.toContain(before.at(-1).args.split(':')[0]);
    expect(['root', '0']).not.toContain(users.at(-1).args.split(':')[0]);
  });

  test('the user is created with a home directory and is the one the USER line names', () => {
    const create = named('RUN').find((i) => /\buseradd\b/.test(i.args));
    expect(create).toBeDefined();
    expect(create.args).toMatch(/(--create-home|\s-m\b)/);
    const m = create.args.match(/useradd\b[^&]*?(\S+)\s*(?:&&|$)/);
    expect(m[1]).toBe('vivera');
    expect(named('USER').at(-1).args).toBe('vivera');
  });

  test('WORKDIR is /opt/vivera and the repo is copied there owned by the user', () => {
    expect(named('WORKDIR').map((i) => i.args)).toContain('/opt/vivera');
    const copy = named('COPY').filter((i) => !/--from=/.test(i.args));
    expect(copy.length).toBeGreaterThan(0);
    expect(copy.at(-1).args).toBe('--chown=vivera:vivera . /opt/vivera');
  });

  test('the directory the copy lands in is created for the user before WORKDIR, so bun install can write there', () => {
    const create = named('RUN').find((i) => /\buseradd\b/.test(i.args));
    expect(create.args).toMatch(/install -d -o vivera -g vivera \/opt\/vivera/);
  });

  test('the default command is bash', () => {
    expect(named('CMD').at(-1).args).toBe('["bash"]');
  });
});

describe('Dockerfile: apt', () => {
  const apt = named('RUN').filter((i) => /apt-get/.test(i.args));

  test('there is an apt step, and it installs git and ca-certificates', () => {
    const install = apt.find((i) => /apt-get install/.test(i.args));
    expect(install).toBeDefined();
    expect(install.args).toMatch(/\bgit\b/);
    expect(install.args).toMatch(/\bca-certificates\b/);
  });

  test('every apt-get install uses --no-install-recommends and cleans the lists in the same RUN', () => {
    for (const i of apt.filter((r) => /apt-get install/.test(r.args))) {
      expect(i.args).toContain('--no-install-recommends');
      expect(i.args).toContain('rm -rf /var/lib/apt/lists');
      expect(i.args).toMatch(/\s-y\b/);
    }
  });

  test('apt-get update and apt-get install share one RUN, so a stale package index is never cached', () => {
    for (const i of apt.filter((r) => /apt-get update/.test(r.args))) expect(i.args).toMatch(/apt-get install/);
  });
});

describe('Dockerfile: the install step', () => {
  test('the install RUN installs dependencies from the lockfile without running dependency scripts, then runs the installer', () => {
    const i = dockerfile[installRun()];
    expect(i.args).toMatch(/bun install --frozen-lockfile --ignore-scripts/);
    expect(i.args.indexOf('bun install')).toBeLessThan(i.args.indexOf('install.sh'));
    expect(fs.existsSync(path.join(ROOT, 'bun.lock'))).toBe(true);
  });

  test('the install RUN uses the tier and the target the plan names', () => {
    const calls = installerCalls(dockerfile[installRun()].args);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/--tier standard\b/);
    expect(calls[0]).toMatch(/--only agents\b/);
  });

  test('the checkout stays where it is installed from, so no copy mode is asked for', () => {
    expect(flagsOf(installerCalls(dockerfile[installRun()].args))).not.toContain('--copy');
  });
});

describe('.dockerignore', () => {
  const lines = ignoreLines();

  test('lists .git, node_modules, and docs/code-plan', () => {
    for (const want of ['.git', 'node_modules', 'docs/code-plan']) expect(lines).toContain(want);
  });

  test('lists graphify-out and diagrams, which the installer does not read', () => {
    expect(lines).toContain('graphify-out');
    expect(lines).toContain('diagrams');
    for (const rel of INSTALL_PAYLOAD) expect(rel.startsWith('diagrams')).toBe(false);
  });

  test('keeps every file of the installer payload in the build context', () => {
    const present = INSTALL_PAYLOAD.filter((rel) => fs.lstatSync(path.join(ROOT, rel), { throwIfNoEntry: false }));
    expect(present.length).toBeGreaterThan(8);
    for (const rel of present) {
      const files = filesUnder(rel);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) expect({ file: f, ignored: ignored(f, lines) }).toEqual({ file: f, ignored: false });
    }
  });

  test('keeps the files the dependency install needs', () => {
    for (const f of ['package.json', 'bun.lock']) expect({ file: f, ignored: ignored(f, lines) }).toEqual({ file: f, ignored: false });
  });

  test('excludes what it lists: .git, node_modules, and a file under docs/code-plan', () => {
    expect(ignored('.git/HEAD', lines)).toBe(true);
    expect(ignored('node_modules/yaml/package.json', lines)).toBe(true);
    expect(ignored('docs/code-plan/plans/x.md', lines)).toBe(true);
    expect(ignored('docs/README.md', lines)).toBe(false);
  });

  test('has no catch-all pattern and no re-include that could undo an exclusion by accident', () => {
    for (const l of lines) {
      expect(['*', '**', '/']).not.toContain(l);
      expect(l.startsWith('!')).toBe(false);
    }
  });
});

describe('.devcontainer/devcontainer.json', () => {
  test('is strict JSON with a name, a build from the Dockerfile, and the vivera user', () => {
    expect(typeof devcontainer.name).toBe('string');
    expect(devcontainer.name.length).toBeGreaterThan(0);
    expect(devcontainer.build.dockerfile).toBe('../Dockerfile');
    expect(devcontainer.build.context).toBe('..');
    expect(devcontainer.remoteUser).toBe('vivera');
    expect(read('.devcontainer/devcontainer.json')).not.toMatch(/^\s*\/\//m);
  });

  test('the dockerfile and context paths resolve, from the .devcontainer directory, to the real files', () => {
    const dir = path.join(ROOT, '.devcontainer');
    expect(path.resolve(dir, devcontainer.build.dockerfile)).toBe(path.join(ROOT, 'Dockerfile'));
    expect(fs.existsSync(path.resolve(dir, devcontainer.build.dockerfile))).toBe(true);
    expect(path.resolve(dir, devcontainer.build.context)).toBe(ROOT);
  });

  test('remoteUser is the user the Dockerfile creates', () => {
    expect(named('USER').at(-1).args).toBe(devcontainer.remoteUser);
  });

  test('the build stops at a stage that has no installer RUN, so the mounted checkout is linked once, by postCreateCommand', () => {
    const target = stages().find((s) => s.alias === devcontainer.build.target);
    expect(target).toBeDefined();
    expect(target.body.some((i) => i.args.includes('install.sh'))).toBe(false);
    expect(target.body.some((i) => i.name === 'USER' && i.args === devcontainer.remoteUser)).toBe(true);
  });

  test('postCreateCommand installs from the lockfile and updates the install from the mounted workspace', () => {
    expect(devcontainer.postCreateCommand).toBe('bun install --frozen-lockfile && ./install.sh --tier standard --update --only agents');
  });
});

describe('parity with the installer', () => {
  test('bash ./install.sh -h exits 0 from the repo root and prints the flags and targets', () => {
    expect(help.status).toBe(0);
    expect(help.text).toContain('--tier');
    expect(help.text).toContain('Targets, in install order:');
  });

  test('every installer flag in the Dockerfile and in postCreateCommand is in the installer usage text', () => {
    const calls = [...installerCalls(dockerfile[installRun()].args), ...installerCalls(devcontainer.postCreateCommand)];
    const flags = flagsOf(calls);
    expect(flags.length).toBeGreaterThan(3);
    for (const flag of flags) expect({ flag, listed: help.text.includes(flag) }).toEqual({ flag, listed: true });
  });

  test('both commands name --tier, with a tier the installer lists', () => {
    for (const calls of [installerCalls(dockerfile[installRun()].args), installerCalls(devcontainer.postCreateCommand)]) {
      const tier = calls.join(' ').match(/--tier (\S+)/);
      expect(tier).not.toBeNull();
      expect(help.text).toMatch(new RegExp(`--tier minimal\\|standard\\|full`));
      expect(['minimal', 'standard', 'full']).toContain(tier[1]);
    }
  });

  test('the --only ids are targets the installer lists', () => {
    const line = help.text.split('\n').find((l) => l.startsWith('Targets, in install order:'));
    const valid = line.replace('Targets, in install order:', '').split(',').map((s) => s.trim());
    for (const calls of [installerCalls(dockerfile[installRun()].args), installerCalls(devcontainer.postCreateCommand)]) {
      const only = calls.join(' ').match(/--only (\S+)/);
      expect(only).not.toBeNull();
      for (const id of only[1].split(',')) expect(valid).toContain(id);
    }
  });

  test('the Dockerfile and postCreateCommand ask for the same tier and target', () => {
    const pick = (cmds, re) => cmds.join(' ').match(re)[1];
    const docker = installerCalls(dockerfile[installRun()].args);
    const dev = installerCalls(devcontainer.postCreateCommand);
    expect(pick(docker, /--tier (\S+)/)).toBe(pick(dev, /--tier (\S+)/));
    expect(pick(docker, /--only (\S+)/)).toBe(pick(dev, /--only (\S+)/));
  });
});
