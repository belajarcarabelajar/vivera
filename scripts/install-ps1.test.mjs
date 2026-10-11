// scripts/install-ps1.test.mjs
//
// Structural tests for install.ps1, the Windows copy-mode installer. PowerShell was not available on
// the machine that wrote it, so the script was never run and these tests only read it: they check the
// file's safety rules and compare its target table, markers, tags and exit codes with the bash
// installer (scripts/install/*.sh). When pwsh or powershell is on PATH, two more tests parse the file
// and run -Help; they are skipped otherwise.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS1_PATH = path.join(ROOT, 'install.ps1');
const bytes = fs.readFileSync(PS1_PATH);
const ps1 = bytes.toString('utf8');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The script without comment lines and block comments, so a rule is not tripped by prose about it.
const code = ps1
  .replace(/<#[\s\S]*?#>/g, '')
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
const codeLines = code.split('\n');
const linesWith = (re) => codeLines.filter((l) => re.test(l));

describe('install.ps1: file hygiene', () => {
  test('exists and is ASCII only, every byte below 128', () => {
    expect(bytes.length).toBeGreaterThan(2000);
    const bad = [];
    bytes.forEach((b, i) => {
      if (b >= 128) bad.push(i);
    });
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('has no byte order mark', () => {
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  test('the header says NOT VERIFIED and that it was never executed', () => {
    const header = ps1.slice(0, ps1.indexOf('param('));
    expect(header).toContain('NOT VERIFIED');
    expect(header.toLowerCase()).toContain('never executed');
  });

  test('the header documents the -File run with a bypass for this one process, and Unblock-File', () => {
    const header = ps1.slice(0, ps1.indexOf('param('));
    expect(header).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1');
    expect(header).toContain('Unblock-File');
  });

  test('no line is longer than 240 characters, the target table rows being the longest', () => {
    expect(ps1.split('\n').filter((l) => l.length > 240)).toEqual([]);
  });

  test('stays under 500 lines', () => {
    expect(ps1.trimEnd().split('\n').length).toBeLessThanOrEqual(500);
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
    for (const name of ['Only', 'Skip']) expect(block).toMatch(new RegExp(`\\[string\\]\\$${name}\\b`));
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

  test('every Copy-Item, Move-Item, Remove-Item, Test-Path, Get-Item and Get-ChildItem call uses -LiteralPath', () => {
    for (const cmd of ['Copy-Item', 'Move-Item', 'Remove-Item', 'Test-Path', 'Get-Item', 'Get-ChildItem', 'Get-FileHash']) {
      const calls = linesWith(new RegExp(`\\b${cmd}\\b`));
      expect(calls.length).toBeGreaterThan(0);
      for (const l of calls) expect({ cmd, line: l.trim(), literal: /-LiteralPath/.test(l) }).toEqual({ cmd, line: l.trim(), literal: true });
    }
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
    expect(bashIds.length).toBe(11);
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
    for (const name of ['SKILL.md', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json', 'sucp-*']) {
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

// --- Run with PowerShell, when the machine has it --------------------------------------------
const shell = Bun.which('pwsh') ?? Bun.which('powershell');
if (!shell) console.log('install-ps1.test: pwsh and powershell are not on PATH; the parse and -Help tests are skipped');

describe('install.ps1: with PowerShell on PATH', () => {
  test.skipIf(!shell)('parses with no syntax error', () => {
    const script = `$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$t, [ref]$e); if ($e.Count -gt 0) { $e | ForEach-Object { $_.Message }; exit 1 }; exit 0`;
    const r = Bun.spawnSync([shell, '-NoProfile', '-NonInteractive', '-Command', script, PS1_PATH]);
    expect({ status: r.exitCode, out: r.stdout.toString() }).toEqual({ status: 0, out: '' });
  });

  test.skipIf(!shell)('-Help prints the usage and exits 0', () => {
    const r = Bun.spawnSync([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1_PATH, '-Help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain('Usage');
  });
});
