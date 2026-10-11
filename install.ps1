<#
.SYNOPSIS
Plants the Vivera skill package on Windows by COPYING it into each harness directory.

.DESCRIPTION
NOT VERIFIED ON WINDOWS: this script has never been executed on Windows or under Windows PowerShell 5.1.
It was parsed and run under PowerShell 7.6.6 on Linux (scripts/install-ps1-run.test.mjs, a temp profile),
which proves the flow and the StrictMode safety but not NTFS junctions, 5.1 behaviour, or OneDrive. Treat
the first run on Windows as a trial: start with -DryRun, then -Check.

The Windows twin of install.sh in copy mode. Symbolic links need administrator rights or Developer
Mode, so this script never makes one: it copies, and marks each copied directory with a .vivera-managed
file ("source=<this checkout>" and one "entry <name> ps-sha256:<hex>" line per copy it placed). Anything
already there that is not a Vivera copy (a file, a directory, a symlink, a junction), and a copy someone
edited, is moved to <name>.vivera-bak-<UTC yyyyMMddTHHmmssZ> first: nothing you wrote is deleted. A copy that
is merely outdated (still exactly what this script placed) is refreshed without a backup. Anything reached
through a linked directory (a dotfiles repo behind ~\.claude\skills), a link there and a destination that does
not exist yet included, is left alone and counted on the last line, as is anything inside this checkout. Sprite agents are NOT rendered here (the generator needs bun):
use ./install.sh from WSL or Git Bash. -Tier is accepted and ignored: skills only at every tier.

Run it with a bypass that lasts for this one process, and never change the machine's policy:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DryRun
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1

It runs only from a checkout: it dot-sources scripts\install\windows-core.ps1 and windows-ops.ps1 beside it.
A zip downloaded in a browser carries a block mark: run Unblock-File on the extracted install.ps1 and on
those two files after you have read them. Do not run it by piping a download into the shell.

.NOTES
Exit codes: 0 success or current, 1 failure or -Check found a problem, 2 usage error or -Check had
nothing to check. PowerShell itself exits 1, not 2, when it rejects a parameter before this script starts
(a -Tier value outside the set, or a switch given twice).

Known limits (documented, not fixed):
- OneDrive cloud placeholders are reparse points that Windows PowerShell 5.1 may report and PowerShell 7 does
  not. A profile directory kept in OneDrive may therefore read as a link (UNVERIFIED).
- A copy that fails half way is put back only for the entry being placed; the directory marker is written
  after the whole package, so an aborted run leaves unmarked copies, and the next run moves them aside.
- A managed copy is identical to its source, pristine (it differs, but equals the digest its marker recorded:
  outdated, never edited) or modified (anything else, a record with another tag or a repeated one included).
  -Update refreshes a pristine copy with no backup and moves a modified one to a backup; -Uninstall removes an
  identical or pristine copy and keeps a modified one. The judgement is the bash installer's (managed_state).
- Tools are found on PATH only. The bash installer also probes ~\.bun\bin; a harness whose CLI lives only there
  is not detected: name it with -Only.
- -Tier is accepted and ignored: tiers.tsv is not read, and no tier installs anything but skills.
- The digests in the markers are "ps-sha256:" and are not claimed to equal the bash "sha256:" ones, so a
  record made by one installer is never trusted by the other: its copy reads as modified (backed up, kept).
- Parameter-binding errors exit 1 (PowerShell's own), not 2.
- Test-UnderPath compares paths ignoring case, which is right on Windows and only approximate on Linux.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('minimal', 'standard', 'full')]
    [string]$Tier = 'standard',
    [string[]]$Only = @(),
    [string[]]$Skip = @(),
    [switch]$DryRun,
    [switch]$Check,
    [switch]$Update,
    [switch]$Uninstall,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$MarkerName = '.vivera-managed'
$BackupInfix = '.vivera-bak-'
$DigestTag = 'ps-sha256:'
$MasterName = 'Super Ultra Code Plan Implementation.md'
# Read once here: a helper function would see its own $PSCmdlet, not the script's.
$script:Cmdlet = $PSCmdlet
# -WhatIf is a dry run too: ShouldProcess would skip each write, but the closing lines would still claim one.
$script:DryRunOn = $DryRun.IsPresent -or [bool]$WhatIfPreference
$script:Changed = 0; $script:Removed = 0; $script:Restored = 0; $script:Kept = 0
$script:Skipped = 0; $script:TargetSkipped = 0
$script:KeptDirs = @{}
$script:Placed = New-Object System.Collections.Generic.List[string]

# One row per harness, in install order, as in the target table of scripts/install/targets.sh. Rel is
# relative to the user profile; a CLI on PATH also counts as detected.
$Targets = @(
    [pscustomobject]@{ Id = 'ai-config'; Kind = 'file'; Rel = '.config\ai'; Dirs = @(); Cmds = @(); Always = $true },
    [pscustomobject]@{ Id = 'agents'; Kind = 'package'; Rel = '.agents\skills\super-ultra-code-plan'; Dirs = @(); Cmds = @(); Always = $true },
    [pscustomobject]@{ Id = 'antigravity'; Kind = 'package'; Rel = '.gemini\config\skills\super-ultra-code-plan'; Dirs = @('.gemini'); Cmds = @('agy'); Always = $false },
    [pscustomobject]@{ Id = 'antigravity-cli'; Kind = 'package'; Rel = '.gemini\antigravity-cli\skills\super-ultra-code-plan'; Dirs = @('.gemini\antigravity-cli'); Cmds = @('agy'); Always = $false },
    [pscustomobject]@{ Id = 'antigravity-builtin'; Kind = 'package'; Rel = '.gemini\antigravity-cli\builtin\skills\super-ultra-code-plan'; Dirs = @('.gemini\antigravity-cli\builtin\skills'); Cmds = @(); Always = $false },
    [pscustomobject]@{ Id = 'opencode'; Kind = 'package'; Rel = '.config\opencode\skills\super-ultra-code-plan'; Dirs = @('.config\opencode'); Cmds = @('opencode'); Always = $false },
    [pscustomobject]@{ Id = 'claude'; Kind = 'package'; Rel = '.claude\skills\super-ultra-code-plan'; Dirs = @('.claude'); Cmds = @(); Always = $false },
    [pscustomobject]@{ Id = 'codex'; Kind = 'none'; Rel = ''; Dirs = @('.codex'); Cmds = @('codex'); Always = $false },
    [pscustomobject]@{ Id = 'cursor'; Kind = 'none'; Rel = ''; Dirs = @('.cursor'); Cmds = @('cursor-agent'); Always = $false },
    [pscustomobject]@{ Id = 'copilot'; Kind = 'none'; Rel = ''; Dirs = @('.copilot'); Cmds = @('copilot'); Always = $false }
)

function Write-Err([string]$Message) { [Console]::Error.WriteLine($Message) }
function Stop-Usage([string]$Message) { Write-Err $Message; Write-Err 'Run install.ps1 -Help for the usage.'; exit 2 }

function Show-Usage {
    Write-Host @'
Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Tier minimal|standard|full]
       [-Only ID,ID] [-Skip ID,ID] [-DryRun] [-Check | -Update | -Uninstall] [-Help]
  -Tier T       accepted and ignored, for parity with install.sh; this script installs skills only, at every tier
  -Only ID,ID   act on only these targets, even when the harness is not detected
  -Skip ID,ID   leave these targets out; wins over -Only
  -DryRun       print what would be done and write nothing
  -Check        report whether the install is current and change nothing (exit 0 current, 1 problems, 2 nothing)
  -Update       bring the copies in line with this checkout and prune phase skills it no longer has
  -Uninstall    remove the copies this script made (only while unchanged) and put the newest backup back
It copies, never links. Anything there that is not a Vivera copy is moved to <name>.vivera-bak-<time>. No sprite
agents (use ./install.sh from WSL or Git Bash). Always installed: .config\ai and .agents\skills; other harnesses
when detected (a directory under your profile or a CLI on PATH) or named with -Only. Exit codes: 0, 1, 2 (usage).
'@
    Write-Host ('Targets, in install order: ' + ((@($Targets | ForEach-Object { $_.Id })) -join ', '))
}

if ($Help) { Show-Usage; exit 0 }

$RepoDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($RepoDir)) { Stop-Usage 'Run install.ps1 from a file, so the checkout can be found.' }
$RepoDir = $RepoDir.TrimEnd('\')
# Two-argument Join-Path only (Windows PowerShell 5.1), and no '\' inside a name, so this also runs on Linux.
$LibDir = Join-Path (Join-Path $RepoDir 'scripts') 'install'
foreach ($lib in @('windows-core.ps1', 'windows-ops.ps1')) {
    $libFile = Join-Path $LibDir $lib
    if (-not (Test-Path -LiteralPath $libFile -PathType Leaf)) {
        Write-Err "install.ps1: $libFile is missing; the checkout is incomplete"
        exit 1
    }
    . $libFile
}

if (@(@($Check.IsPresent, $Update.IsPresent, $Uninstall.IsPresent) | Where-Object { $_ }).Count -gt 1) {
    Stop-Usage 'Choose one of -Check, -Update, -Uninstall'
}
foreach ($name in @('Only', 'Skip')) {
    if ($PSBoundParameters.ContainsKey($name) -and (@(Split-List $PSBoundParameters[$name] | Where-Object { $_ -ne '' }).Count -eq 0)) { Stop-Usage "Missing value for -$name" }
}
$validIds = @($Targets | ForEach-Object { $_.Id })
foreach ($name in @('Only', 'Skip')) {
    # Not wrapped in @(): the cmdlet hands the array over as one object, and wrapping would nest it.
    $given = Get-Variable -Name $name -ValueOnly
    foreach ($id in @(Split-List $given)) {
        if ($validIds -notcontains $id) {
            # An empty id is exit 2 in bash too; naming the list tells which one it is in.
            if ($id -eq '') { Write-Err ("Unknown target: <empty id in -$name " + ($given -join ' ') + '>') } else { Write-Err "Unknown target: $id" }
            Write-Err ('Valid targets: ' + ($validIds -join ', '))
            Stop-Usage 'Choose target ids from the list above.'
        }
    }
}

$HomeDir = $Env:USERPROFILE
if ([string]::IsNullOrEmpty($HomeDir)) { $HomeDir = [Environment]::GetFolderPath('UserProfile') }
if ([string]::IsNullOrEmpty($HomeDir)) { Stop-Usage 'The user profile directory is empty; set USERPROFILE.' }
$HomeDir = $HomeDir.TrimEnd('\')
$MasterFile = Join-Path $RepoDir $MasterName

try {
    if (-not (Test-Path -LiteralPath $MasterFile -PathType Leaf)) {
        Write-Err "install.ps1: $MasterName is not next to the script; the checkout is incomplete"
        exit 1
    }
    if ($Check) {
        Write-Host '==> Checking the Vivera install'
    } elseif ($Uninstall) {
        Write-Host '==> Removing the Vivera install'
    } else {
        Write-Host '==> Sowing Vivera (Windows, copy mode)'
        Write-Host "    Source: $MasterFile"
        Write-Host "    Tier: $Tier (accepted and ignored; skills only at every tier)"
    }
    $selected = @(Get-SelectedTargets)
    if ($Check) {
        Invoke-Check $selected
    } elseif ($Uninstall) {
        Invoke-Uninstall $selected
    } elseif ($Update) {
        Invoke-InstallAll $selected
        Invoke-Prune $selected
        Write-FinalLine '==> Vivera updated: the copies match this checkout' '==> Vivera update dry run: nothing was written'
    } else {
        Invoke-InstallAll $selected
        Write-FinalLine '==> Vivera farm planted: the skill package is installed as copies' '==> Vivera dry run: nothing was written'
    }
} catch {
    $reason = $_.Exception.Message
    # A path that exists but could not be inspected stops the run as a [FAIL] line, never as "absent".
    if ($reason.StartsWith('cannot inspect ', [System.StringComparison]::Ordinal)) { Write-Err "[FAIL] $reason" } else { Write-Err "install.ps1: $reason" }
    exit 1
}
exit 0
