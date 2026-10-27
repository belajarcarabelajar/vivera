// scripts/install-ps1.test.mjs
//
// Structural tests for install.ps1 and its two dot-sourced parts, scripts/install/windows-core.ps1 and
// windows-ops.ps1: the file safety rules, and the target table, markers, tags and exit codes compared with
// the bash installer (scripts/install/*.sh). They only READ the files. What the script does when it runs is
// in scripts/install-ps1-run.test.mjs, which needs PowerShell and skips without it. INSTALL_PS1_ROOT points
// both suites at another copy of the tree (how a mutant is tried without editing the real files).

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.INSTALL_PS1_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LIB_DIR = path.join(ROOT, 'scripts', 'install');
// Sorted: readdirSync order depends on the filesystem (tmpfs gave windows-ops before windows-core).
const FILES = ['install.ps1', ...fs.readdirSync(LIB_DIR).filter((f) => /^windows-.*\.ps1$/.test(f)).sort().map((f) => `scripts/install/${f}`)];
const bytes = fs.readFileSync(path.join(ROOT, 'install.ps1'));
const ps1 = bytes.toString('utf8');
const all = FILES.map(read).join('\n');

// The script files without comment lines and block comments, so a rule is not tripped by prose about it.
const stripComments = (text) =>
  text
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
const code = stripComments(all);
const codeLines = code.split('\n');
const linesWith = (re) => codeLines.filter((l) => re.test(l));

describe('install.ps1: file hygiene', () => {
  test('the script is split into install.ps1 and exactly the two windows-*.ps1 parts', () => {
    expect(FILES).toEqual(['install.ps1', 'scripts/install/windows-core.ps1', 'scripts/install/windows-ops.ps1']);
    expect(bytes.length).toBeGreaterThan(2000);
  });

  test('every file is ASCII only (every byte below 128), LF only, and has no byte order mark', () => {
    for (const f of FILES) {
      const b = fs.readFileSync(path.join(ROOT, f));
      const bad = [];
      b.forEach((x, i) => {
        if (x >= 128 || x === 13) bad.push(i);
      });
      expect({ f, bad: bad.slice(0, 5) }).toEqual({ f, bad: [] });
      expect({ f, bom: [...b.subarray(0, 3)].join() === '239,187,191' }).toEqual({ f, bom: false });
    }
  });

  test('the header says it is NOT VERIFIED ON WINDOWS and never ran there, and lists the known limits', () => {
    const header = ps1.slice(0, ps1.indexOf('[CmdletBinding'));
    expect(header).toContain('NOT VERIFIED ON WINDOWS');
    expect(header).toContain('never been executed on Windows');
    expect(header).toContain('Known limits');
    for (const limit of ['OneDrive', 'put back only for the entry being placed', 'pristine', 'refreshes a pristine copy with no backup', '~\\.bun\\bin', 'tiers.tsv is not read', 'exit 1 (PowerShell', 'ps-sha256']) {
      expect({ limit, said: header.includes(limit) }).toEqual({ limit, said: true });
    }
    // The old bullet said a differing managed copy is always moved aside; that stopped being true with W2.
    expect(header).not.toContain('ALWAYS moved to a backup');
  });

  test('install.ps1 dot-sources both parts from beside itself ($PSScriptRoot), with two-argument Join-Path', () => {
    expect(code).toContain("'windows-core.ps1', 'windows-ops.ps1'");
    expect(code).toMatch(/\. \$libFile/);
    expect(code).toContain("Join-Path (Join-Path $RepoDir 'scripts') 'install'");
  });

  test('windows-core.ps1 and windows-ops.ps1 hold only functions: no param block and no top-level statement', () => {
    for (const f of FILES.slice(1)) {
      const text = stripComments(read(f));
      expect({ f, param: /\bparam\(/.test(text) }).toEqual({ f, param: false });
      const top = text.split('\n').filter((l) => /^\S/.test(l) && !/^(function |\}|\))/.test(l));
      expect({ f, top }).toEqual({ f, top: [] });
    }
  });

  test('the header documents the -File run with a bypass for this one process, and Unblock-File', () => {
    const header = ps1.slice(0, ps1.indexOf('param('));
    expect(header).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1');
    expect(header).toContain('Unblock-File');
  });

  test('no line is longer than 240 characters, the target table rows being the longest', () => {
    for (const f of FILES) expect({ f, long: read(f).split('\n').filter((l) => l.length > 240) }).toEqual({ f, long: [] });
  });

  test('every file stays under 500 lines', () => {
    for (const f of FILES) expect({ f, ok: read(f).trimEnd().split('\n').length <= 500 }).toEqual({ f, ok: true });
  });
});

describe('install.ps1: strictness and parameters', () => {
  test('sets the error preference to Stop and strict mode to version 3.0, not Latest', () => {
    expect(code).toContain("$ErrorActionPreference = 'Stop'");
    expect(code).toContain('Set-StrictMode -Version 3.0');
    expect(code).not.toMatch(/Set-StrictMode\s+-Version\s+Latest/i);
  });

  test('is an advanced script that supports ShouldProcess, and calls ShouldProcess', () => {
    expect(code).toMatch(/\[CmdletBinding\(SupportsShouldProcess\)\]/);
    expect(code).toContain('ShouldProcess(');
  });

  test('has a param block with the parameters of the bash installer', () => {
    const block = code.slice(code.indexOf('param('), code.indexOf(')\n', code.indexOf('[switch]$Help')) + 1);
    expect(block).toMatch(/\[ValidateSet\('minimal', 'standard', 'full'\)\]\s*\[string\]\$Tier = 'standard'/);
    for (const name of ['Only', 'Skip']) expect(block).toMatch(new RegExp(`\\[string\\[\\]\\]\\$${name} = @\\(\\)`));
    for (const name of ['DryRun', 'Check', 'Update', 'Uninstall', 'Help']) expect(block).toMatch(new RegExp(`\\[switch\\]\\$${name}\\b`));
  });

  test('the tiers are the ones install.sh accepts', () => {
    expect(read('install.sh')).toMatch(/minimal\|standard\|full/);
  });

  test('refuses more than one of -Check, -Update, -Uninstall with exit 2', () => {
    expect(code).toContain('Choose one of -Check, -Update, -Uninstall');
  });

  test('takes the home directory from USERPROFILE, falls back to the profile folder, and rejects an empty value', () => {
    expect(code).toContain('$Env:USERPROFILE');
    expect(code).toContain("[Environment]::GetFolderPath('UserProfile')");
    expect(code).toMatch(/IsNullOrEmpty\(\$HomeDir\)/);
  });

  test('takes the checkout from the directory of the script', () => {
    expect(code).toContain('$PSScriptRoot');
  });

  test('ends with an explicit exit', () => {
    expect(ps1.trimEnd().split('\n').at(-1).trim()).toMatch(/^exit \d$/);
  });
});

describe('install.ps1: what it must not contain', () => {
  test('no Invoke-Expression and no iex anywhere, comments included', () => {
    expect(ps1).not.toMatch(/Invoke-Expression/i);
    expect(ps1).not.toMatch(/\biex\b/i);
  });

  test('no download of code: no Invoke-WebRequest, Invoke-RestMethod, irm, or Net.WebClient', () => {
    expect(code).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|\birm\b|\biwr\b|Net\.WebClient|Start-BitsTransfer/i);
  });

  test('no Remove-Item with -Recurse, so nothing removes a user directory wholesale', () => {
    expect(linesWith(/Remove-Item/).filter((l) => /-Recurse/i.test(l))).toEqual([]);
  });

  test('every Copy-Item, Remove-Item, Test-Path, Get-Item and Get-ChildItem call uses -LiteralPath', () => {
    for (const cmd of ['Copy-Item', 'Remove-Item', 'Test-Path', 'Get-Item', 'Get-ChildItem']) {
      const calls = linesWith(new RegExp(`\\b${cmd}\\b`));
      expect(calls.length).toBeGreaterThan(0);
      for (const l of calls) expect({ cmd, line: l.trim(), literal: /-LiteralPath/.test(l) }).toEqual({ cmd, line: l.trim(), literal: true });
    }
  });

  test('F5: nothing moves with Move-Item (its -Destination is a wildcard pattern in 5.1); Move-Path uses the literal .NET moves', () => {
    expect(linesWith(/\bMove-Item\b/)).toEqual([]);
    expect(code).toContain('[System.IO.File]::Move($From, $To)');
    expect(code).toContain('[System.IO.Directory]::Move($From, $To)');
    expect(linesWith(/\bMove-Path\b/).length).toBeGreaterThanOrEqual(4);
  });

  test('no Split-Path -LiteralPath (it takes no -Parent or -Leaf: a parameter-set error, measured under PowerShell 7.6.6)', () => {
    expect(linesWith(/Split-Path/)).toEqual([]);
    expect(code).toContain('[System.IO.Path]::GetDirectoryName($Path)');
    expect(code).toContain('[System.IO.Path]::GetFileName($Path)');
  });

  test('Copy-Item always names an explicit destination', () => {
    for (const l of linesWith(/\bCopy-Item\b/)) expect(l).toMatch(/-Destination\s+\$\w+/);
  });

  test('no symbolic link, junction, or hard link is made', () => {
    expect(code).not.toMatch(/-ItemType\s+(SymbolicLink|Junction|HardLink)/i);
    expect(code).not.toMatch(/\bmklink\b|\bln\s+-s\b/i);
  });

  test('Join-Path is only given two arguments, since Windows PowerShell 5.1 takes no more', () => {
    expect(code).not.toMatch(/-AdditionalChildPath/i);
    // Three bare arguments in a row (a variable or a quoted string each) would be a 3.0-and-later form.
    const arg = String.raw`(?:\$\w+|'[^']*'|"[^"]*")`;
    const three = new RegExp(String.raw`Join-Path\s+${arg}\s+${arg}\s+(?:${arg}|\()`);
    for (const l of linesWith(/\bJoin-Path\b/)) expect({ line: l.trim(), three: three.test(l) }).toEqual({ line: l.trim(), three: false });
  });

  test('does not change a persistent execution policy', () => {
    expect(code).not.toMatch(/Set-ExecutionPolicy/i);
  });

  test('never touches the registry or the machine-wide environment', () => {
    expect(code).not.toMatch(/\bHKLM:|\bHKCU:|SetEnvironmentVariable|New-ItemProperty|Set-ItemProperty/i);
  });

  test('writes the marker without a byte order mark', () => {
    expect(code).toContain('UTF8Encoding($false)');
    expect(code).not.toMatch(/Set-Content|Out-File|Add-Content/i);
  });
});

// Mistakes a PowerShell parser would reject or Windows PowerShell 5.1 would not run, found by reading,
// because no PowerShell was available to parse the file. These are heuristics, not a parser.
describe('install.ps1: pitfalls a read can catch', () => {
  const noHereStrings = code.replace(/@'[\s\S]*?\n'@/g, '').replace(/@"[\s\S]*?\n"@/g, '');
  const noSingleQuoted = noHereStrings.replace(/'(?:[^']|'')*'/g, "''");
  const bare = noSingleQuoted.replace(/"(?:[^"`]|`.)*"/g, '""');

  test('every brace, bracket, and parenthesis is closed once strings and comments are set aside', () => {
    for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
      const opens = bare.split(open).length - 1;
      const closes = bare.split(close).length - 1;
      expect({ open, opens, closes }).toEqual({ open, opens, closes: opens });
    }
  });

  test('a variable is never followed by a colon inside a double-quoted string, which the parser reads as a drive', () => {
    const allowed = new Set(['script', 'env', 'global', 'local', 'private', 'using']);
    const bad = [...noSingleQuoted.matchAll(/\$([A-Za-z_]\w*):/g)].map((m) => m[1]).filter((n) => !allowed.has(n.toLowerCase()));
    expect(bad).toEqual([]);
  });

  test('uses no operator or syntax that only PowerShell 7 has', () => {
    expect(bare).not.toMatch(/&&|\|\||\?\?|\?\.|ForEach-Object\s+-Parallel|\$IsWindows|\bclean\s*\{/);
  });

  test('reads the script-level cmdlet once, so a helper function can ask ShouldProcess', () => {
    expect(code).toMatch(/\$script:Cmdlet = \$PSCmdlet/);
    expect(code).toMatch(/\$script:Cmdlet\.ShouldProcess\(/);
  });

  test('every exit in the code names its code, a single digit', () => {
    const exits = [...bare.matchAll(/\bexit\b(.{0,3})/g)];
    expect(exits.length).toBeGreaterThan(4);
    for (const m of exits) expect(m[1]).toMatch(/^ \d(\W|$)/);
  });

  test('comment-based help sits before the param block, and the file starts with it', () => {
    expect(ps1.startsWith('<#\n.SYNOPSIS')).toBe(true);
    expect(ps1.indexOf('#>')).toBeLessThan(ps1.indexOf('[CmdletBinding'));
  });
});

// What each fix is made of, read from the text. The behaviour is proved in install-ps1-run.test.mjs.
describe('install.ps1: the fixes F1, F2, F3 and F6, read from the text', () => {
  const fn = (name) => {
    const start = all.indexOf(`function ${name}`);
    expect({ name, found: start > -1 }).toEqual({ name, found: true });
    return all.slice(start, all.indexOf('\n}\n', start));
  };

  test('F3: -Only and -Skip are string arrays, and every element is split on commas', () => {
    expect(fn('Split-List')).toMatch(/\.Split\(','\)/);
    expect(fn('Split-List')).toMatch(/foreach \(\$item in @\(\$List\)\)/);
    expect(code).not.toMatch(/\[string\]\$(Only|Skip)\b/);
  });

  test('F1: a real file behind a linked directory is a state of its own (viadir), and install, check, uninstall and the empty-dir guard honour it', () => {
    expect(fn('Test-BehindLinkedDir')).toMatch(/Test-Reparse/);
    expect(fn('Get-DestState')).toMatch(/viadir/);
    expect(fn('Invoke-Place')).toMatch(/viadir/);
    expect(fn('Invoke-Check')).toMatch(/viadir/);
    expect(fn('Uninstall-Entry')).toMatch(/Test-BehindLinkedDir/);
    expect(fn('Remove-IfEmpty')).toMatch(/Test-BehindLinkedDir/);
  });

  test('F1: the bash installer words it the same way (left alone, KEEP behind a symlinked directory)', () => {
    expect(read('scripts/install/place.sh')).toContain('is reached through a symlinked directory; left alone');
    expect(code).toContain('is reached through a symlinked directory; left alone');
    expect(read('scripts/install/uninstall.sh')).toContain('(behind a symlinked directory)');
    expect(code).toContain("'behind a symlinked directory'");
    expect(read('scripts/install/check.sh')).toContain('(behind a symlinked directory; left alone)');
    expect(code).toContain('(behind a symlinked directory; left alone)');
  });

  test('F2: -Update prunes a stale SKILL.md only on a digest that equals the record, with the bash KEEP wording', () => {
    const prune = fn('Invoke-Prune');
    expect(prune).toContain('Get-RecordedDigest');
    expect(prune).toContain('Get-EntryDigest');
    expect(prune).toMatch(/-cne \(Get-RecordedDigest/);
    expect(prune).toContain('(modified copy of a skill this checkout no longer has)');
    expect(read('scripts/install/update.sh')).toContain('(modified copy of a skill this checkout no longer has)');
    expect(prune.indexOf('[KEEP]')).toBeLessThan(prune.indexOf('Remove-File $skill'));
  });

  test('F2: the digest carries its own tag, so a bash record (sha256:) is never read as proof', () => {
    expect(code).toContain("$DigestTag = 'ps-sha256:'");
    expect(read('scripts/install/lib.sh')).toContain('HASH_ALGO="sha256"');
    expect(fn('Get-RecordedDigest')).toMatch(/'entry ' \+ \(Get-LeafName \$Dest\) \+ ' '/);
  });

  test('F6: a dry run says so at the end, for install and for -Update', () => {
    expect(code).toContain("'==> Vivera dry run: nothing was written'");
    expect(code).toContain("'==> Vivera update dry run: nothing was written'");
  });

  test('W1 and W2: a managed copy is identical, pristine or modified by the recorded digest, and install, check and uninstall all read that', () => {
    const state = fn('Get-ManagedState');
    expect(state).toContain('identical');
    expect(state).toMatch(/Get-EntryDigest/);
    expect(state).toMatch(/-ceq \(Get-RecordedDigest/);
    expect(state).toMatch(/\(\$current -ne ''\)/);
    expect(fn('Get-DestState')).toContain('Get-ManagedState');
    const un = fn('Uninstall-Entry');
    expect(un).toContain('Get-ManagedState');
    expect(un).not.toContain('Test-SameContent');
    expect(un).toContain('modified copy: it stays as it is; .\\install.ps1 -Update replaces it after backing yours up');
    expect(read('scripts/install/uninstall.sh')).toContain('modified copy: it stays as it is; ./install.sh --update --copy replaces it after backing yours up');
    const place = fn('Invoke-Place');
    expect(place).toContain("'pristine'");
    expect(place.indexOf("'pristine'")).toBeLessThan(place.indexOf('Get-BackupPath'));
    expect(fn('Invoke-Check')).toContain("'pristine'");
    expect(fn('Get-RecordedDigest')).toMatch(/\$count -eq 1/);
  });

  test('W3: an absent destination behind a linked directory, and a link behind one, are viadir; the skips are counted for the last line', () => {
    expect(fn('Test-BehindLinkedAncestor')).toMatch(/Test-BehindLinkedDir \(Join-Path \$p 'x'\)/);
    const state = fn('Get-DestState');
    expect(state).toContain('Test-BehindLinkedAncestor');
    expect(state.indexOf('Test-BehindLinkedDir $Dest')).toBeLessThan(state.indexOf('Test-Reparse'));
    expect(state).not.toMatch(/-not \(Test-Reparse \$item\)\) -and \(Test-BehindLinkedDir/);
    expect(fn('Uninstall-Entry')).not.toMatch(/-not \(Test-Reparse \$item\)\) -and \(Test-BehindLinkedDir/);
    expect(fn('Invoke-Place').match(/Add-Skipped/g)?.length).toBe(2);
    expect(fn('Write-FinalLine')).toContain('Vivera finished with');
    expect(read('scripts/install/place.sh')).toContain('Vivera finished with $LEFT_ALONE $word left alone (see the [SKIP] lines above)');
  });

  test('W4: Get-ItemOrNull returns $null only for a plain not-found, and fails with "cannot inspect <path>: <reason>" for anything else', () => {
    const get = fn('Get-ItemOrNull');
    expect(get).not.toMatch(/catch \{ return \$null \}/);
    expect(get).toContain('ObjectNotFound');
    expect(get).toContain('Test-EntryPresent');
    expect(get).toContain('throw "cannot inspect ${Path}: $($err.Exception.Message)"');
    // The .NET attribute lookup does not follow links, so a link Get-Item cannot read still counts as present.
    expect(fn('Test-EntryPresent')).toContain('[System.IO.File]::GetAttributes($Path)');
    expect(fn('Test-EntryPresent')).toContain('FileNotFoundException');
    expect(fn('Test-EntryPresent')).toContain('DirectoryNotFoundException');
    expect(ps1).toContain('"[FAIL] $reason"');
  });

  test('W5: an empty id is refused with exit 2 by name, and one trailing empty piece is dropped as read -a does in bash', () => {
    expect(fn('Split-List')).toMatch(/\$parts\.Count -gt 1/);
    expect(code).toContain('Unknown target: <empty id in -$name ');
    expect(read('install.sh')).toContain('IFS=\',\' read -r -a ids');
  });

  test('Test-UnderPath reads both separators, so the guards also work on a Linux run', () => {
    expect(fn('Test-UnderPath')).toContain(".Replace('/', '\\')");
  });
});

// --- Parity with the bash installer ----------------------------------------------------------
const targetsSh = read('scripts/install/targets.sh');
function body(text, name) {
  const start = text.indexOf(`${name}() {`);
  expect(start).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('\n}\n', start));
}
const bashIds = body(targetsSh, 'target_ids').match(/printf '%s\\n' (.+)/)[1].trim().split(/\s+/);
const bashDirs = {};
for (const m of body(targetsSh, 'target_skills_dir').matchAll(/^\s+([a-z | -]+)\) echo "(?:\$HOME\/)?([^"]*)" ;;/gm)) {
  for (const id of m[1].split('|').map((s) => s.trim())) bashDirs[id] = m[2];
}
const bashKinds = {};
for (const m of body(targetsSh, 'target_kind').matchAll(/^\s+([a-z | -]+)\) echo "(file|none|package)" ;;/gm)) {
  for (const id of m[1].split('|').map((s) => s.trim())) bashKinds[id] = m[2];
}
const bashDetect = {};
for (const m of body(targetsSh, 'target_detected').matchAll(/^\s+([a-z | -]+)\) (.+) ;;$/gm)) {
  const rule = m[2];
  for (const id of m[1].split('|').map((s) => s.trim())) {
    bashDetect[id] = {
      always: rule === 'return 0',
      dirs: [...rule.matchAll(/\$HOME\/([^"]+)"/g)].map((x) => x[1]),
      cmds: [...rule.matchAll(/tool_available (\S+)/g)].map((x) => x[1]),
    };
  }
}
const row = (id) => ps1.split('\n').find((l) => l.includes(`Id = '${id}'`));
const backslash = (p) => p.replaceAll('/', '\\');

describe('install.ps1: the target table matches scripts/install/targets.sh', () => {
  test('lists the same ids in the same order', () => {
    const ids = [...ps1.matchAll(/Id = '([a-z-]+)'/g)].map((m) => m[1]);
    expect(ids).toEqual(bashIds);
    expect(bashIds.length).toBe(10);
  });

  test('each target has the same kind', () => {
    for (const id of bashIds) expect({ id, ok: row(id).includes(`Kind = '${bashKinds[id]}'`) }).toEqual({ id, ok: true });
  });

  test('each target has the same relative directory, with backslashes', () => {
    for (const id of bashIds) {
      const rel = backslash(bashDirs[id] ?? '');
      expect({ id, rel, ok: row(id).includes(`Rel = '${rel}'`) }).toEqual({ id, rel, ok: true });
    }
    expect(ps1).toContain('.gemini\\antigravity-cli\\builtin\\skills\\super-ultra-code-plan');
  });

  test('each target is detected by the same directories and CLIs, and the baseline targets always', () => {
    for (const id of bashIds) {
      const d = bashDetect[id];
      expect({ id, defined: d !== undefined }).toEqual({ id, defined: true });
      const r = row(id);
      expect({ id, always: r.includes('Always = $true') }).toEqual({ id, always: d.always });
      for (const dir of d.dirs) expect({ id, dir, ok: r.includes(`'${backslash(dir)}'`) }).toEqual({ id, dir, ok: true });
      for (const cmd of d.cmds) expect({ id, cmd, ok: r.includes(`'${cmd}'`) }).toEqual({ id, cmd, ok: true });
    }
  });

  test('codex, cursor and copilot have no skills target, as in bash', () => {
    for (const id of ['codex', 'cursor', 'copilot']) expect(bashKinds[id]).toBe('none');
  });
});

describe('install.ps1: markers, backups, entries, tags, and exit codes match the bash installer', () => {
  const libSh = read('scripts/install/lib.sh');
  const placeSh = read('scripts/install/place.sh');
  const checkSh = read('scripts/install/check.sh');
  const uninstallSh = read('scripts/install/uninstall.sh');

  test('the managed marker and the backup infix are the bash names, and the marker holds source=<checkout>', () => {
    expect(placeSh).toContain('source=$REPO_DIR');
    expect(libSh).toContain('.vivera-bak-');
    expect(ps1).toContain("'.vivera-managed'");
    expect(ps1).toContain("'.vivera-bak-'");
    expect(code).toMatch(/"source=\$RepoDir"/);
  });

  test('the backup stamp is a UTC yyyyMMddTHHmmssZ stamp, with -N appended while the name is taken', () => {
    expect(libSh).toContain('%Y%m%dT%H%M%SZ');
    expect(code).toContain("'yyyyMMdd\\THHmmss\\Z'");
    expect(code).toMatch(/\$\{stamp\}-\$\{n\}/);
    expect(code).toContain('VIVERA_NOW');
  });

  test('the entries are the ones package_entries makes', () => {
    const entries = body(libSh, 'package_entries');
    for (const name of ['SKILL.md', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json', 'require-exit-code.mjs', 'sucp-*']) {
      expect({ name, bash: entries.includes(name) }).toEqual({ name, bash: true });
      expect({ name, ps1: code.includes(`'${name}'`) }).toEqual({ name, ps1: true });
    }
    expect(code).toContain("'Super Ultra Code Plan Implementation.md'");
    expect(code).toContain("'skills'");
    expect(targetsSh).toContain('Super Ultra Code Plan Implementation.md');
  });

  test('the check tags and summary lines are the bash ones', () => {
    for (const tag of ['[ok]', '[missing]', '[stale]', '[foreign]']) {
      expect({ tag, bash: checkSh.includes(tag) }).toEqual({ tag, bash: true });
      expect({ tag, ps1: code.includes(tag) }).toEqual({ tag, ps1: true });
    }
    expect(code).toContain('check: CURRENT');
    expect(code).toMatch(/check: \$\w+ problem\(s\)/);
    expect(code).toContain('check: nothing to check');
  });

  test('the install and uninstall tags are the bash ones', () => {
    for (const tag of ['[BACKUP]', '[SKIP]', '[DRY-RUN]']) expect({ tag, ps1: code.includes(tag), bash: placeSh.includes(tag) }).toEqual({ tag, ps1: true, bash: true });
    for (const tag of ['[REMOVED]', '[RESTORED]', '[KEEP]']) expect({ tag, ps1: code.includes(tag), bash: uninstallSh.includes(tag) }).toEqual({ tag, ps1: true, bash: true });
  });

  test('the exit codes are 0, 1 and 2, and 2 is the usage error as in bash', () => {
    expect(code).toMatch(/exit 0\b/);
    expect(code).toMatch(/exit 1\b/);
    expect(code).toMatch(/exit 2\b/);
    expect(read('install.sh')).toContain('exit 2');
    expect(code).toContain('Unknown target:');
    expect(code).toContain('Valid targets:');
    expect(read('install.sh')).toContain('Unknown target:');
  });

  test('says that sprite agents are not rendered, at any tier', () => {
    expect(code).toMatch(/\[SKIP\] sprite agents/);
  });

  test('a managed copy that differs is moved aside, never discarded, and a link is never kept as ours', () => {
    expect(code).toMatch(/modified/);
    expect(code).toMatch(/ReparsePoint/);
  });
});
