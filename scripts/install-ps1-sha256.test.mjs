// scripts/install-ps1-sha256.test.mjs
//
// install.ps1 hashes every file it places (Get-Sha256Hex in scripts/install/windows-core.ps1) for its markers
// and same-file checks. In Windows PowerShell 5.1 several commands are functions of the Utility *script*
// module rather than binary cmdlets, and they vanish when the module does not load: when Bun started
// powershell.exe in the platforms.yml suites, "The term 'Get-FileHash' is not recognized" (runs 40440396551
// to 40450528002), while install.ps1 started straight from a pwsh prompt worked (run 40450528002). So the
// installer calls none of them, and the hash it computes instead must equal SHA-256 of the file's bytes.

import { afterAll, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.INSTALL_PS1_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['install.ps1', ...fs.readdirSync(path.join(ROOT, 'scripts', 'install')).filter((f) => /^windows-.*\.ps1$/.test(f)).map((f) => `scripts/install/${f}`)];
const shell = process.env.PWSH ?? Bun.which('pwsh') ?? Bun.which('powershell');
const quote = (s) => `'${s.replace(/'/g, "''")}'`;

// Functions, not cmdlets, of Microsoft.PowerShell.Utility in Windows PowerShell 5.1 (its .psm1).
const SCRIPT_MODULE_FUNCTIONS = ['Get-FileHash', 'New-TemporaryFile', 'New-Guid', 'Format-Hex', 'Import-PowerShellDataFile', 'ConvertFrom-SddlString'];

describe('install.ps1 calls no Windows PowerShell 5.1 script-module function', () => {
  for (const rel of FILES) {
    test(rel, () => {
      const code = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
      const found = SCRIPT_MODULE_FUNCTIONS.filter((f) => new RegExp(`(^|[^\\w-])${f}(?![\\w-])`, 'i').test(code));
      expect(found).toEqual([]);
    });
  }
});

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-sha256-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
const samples = { 'plain.txt': 'hello\n', 'empty.txt': '', '[brackets] and *.txt': 'wildcards stay literal\r\n', 'binary.bin': Buffer.from([0, 255, 13, 10, 128]) };
for (const [name, data] of Object.entries(samples)) fs.writeFileSync(path.join(base, name), data);

describe.skipIf(!shell)('Get-Sha256Hex is the lowercase SHA-256 of the file bytes', () => {
  for (const [name, data] of Object.entries(samples)) {
    test(JSON.stringify(name), () => {
      const want = crypto.createHash('sha256').update(data).digest('hex');
      const script = `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest; . ${quote(path.join(ROOT, 'scripts', 'install', 'windows-core.ps1'))}; Get-Sha256Hex ${quote(path.join(base, name))}`;
      const r = Bun.spawnSync([shell, '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, NO_COLOR: '1' } });
      expect({ code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }).toEqual({ code: 0, out: want, err: '' });
    });
  }
});
