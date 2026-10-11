<#
.SYNOPSIS
Plants the Vivera skill package on Windows by COPYING it into each harness directory.

.DESCRIPTION
NOT VERIFIED: this script was never executed. PowerShell (pwsh and powershell.exe) was absent on the
machine where it was written, so it has only been read and checked by structural tests
(scripts/install-ps1.test.mjs). Treat the first run as a trial: start with -DryRun, then -Check.

The Windows twin of install.sh in copy mode. Symbolic links need administrator rights or Developer
Mode, so this script never makes one: it copies, and marks each copied directory with a .vivera-managed
file ("source=<this checkout>"). Anything already there that is not a Vivera copy (a file, a directory, a
symlink, a junction), and a copy that differs from its source, is moved to <name>.vivera-bak-<UTC
yyyyMMddTHHmmssZ> first: nothing you wrote is deleted. Sprite agents are NOT rendered here (the generator
needs bun): use ./install.sh from WSL or Git Bash. -Tier is accepted for parity; skills only at every tier.

Run it with a bypass that lasts for this one process, and never change the machine's policy:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DryRun
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1

A zip downloaded in a browser carries a block mark: run Unblock-File on the extracted install.ps1
after you have read it. Do not run it by piping a download into the shell.

.NOTES
Exit codes: 0 success or current, 1 failure or -Check found a problem, 2 usage error or -Check had
nothing to check. PowerShell itself exits 1 when it rejects a -Tier value before this script starts.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('minimal', 'standard', 'full')]
    [string]$Tier = 'standard',
    [string]$Only = '',
    [string]$Skip = '',
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
$MasterName = 'Super Ultra Code Plan Implementation.md'
# Read once here: a helper function would see its own $PSCmdlet, not the script's.
$script:Cmdlet = $PSCmdlet
$script:DryRunOn = $DryRun.IsPresent
$script:Changed = 0; $script:Removed = 0; $script:Restored = 0; $script:Kept = 0
$script:KeptDirs = @{}

# One row per harness, in install order, as in the target table of scripts/install/targets.sh. Rel is
# relative to the user profile; a CLI on PATH also counts as detected.
$Targets = @(
    [pscustomobject]@{ Id = 'ai-config'; Kind = 'file'; Rel = '.config\ai'; Dirs = @(); Cmds = @(); Always = $true },
    [pscustomobject]@{ Id = 'agents'; Kind = 'package'; Rel = '.agents\skills\super-ultra-code-plan'; Dirs = @(); Cmds = @(); Always = $true },
    [pscustomobject]@{ Id = 'antigravity'; Kind = 'package'; Rel = '.gemini\config\skills\super-ultra-code-plan'; Dirs = @('.gemini'); Cmds = @('agy'); Always = $false },
    [pscustomobject]@{ Id = 'antigravity-cli'; Kind = 'package'; Rel = '.gemini\antigravity-cli\skills\super-ultra-code-plan'; Dirs = @('.gemini\antigravity-cli'); Cmds = @('agy'); Always = $false },
    [pscustomobject]@{ Id = 'antigravity-builtin'; Kind = 'package'; Rel = '.gemini\antigravity-cli\builtin\skills\super-ultra-code-plan'; Dirs = @('.gemini\antigravity-cli\builtin\skills'); Cmds = @(); Always = $false },
    [pscustomobject]@{ Id = 'gemini-cli'; Kind = 'package'; Rel = '.gemini\skills\super-ultra-code-plan'; Dirs = @(); Cmds = @('gemini'); Always = $false },
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
  -Tier T       accepted for parity with install.sh; this script installs skills only, at every tier
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

function Join-Rel([string]$Base, [string]$Rel) {
    $p = $Base
    foreach ($part in $Rel.Split('\')) { if ($part -ne '') { $p = Join-Path $p $part } }
    return $p
}

function Get-ItemOrNull([string]$Path) {
    try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { return $null }
}
function Test-Reparse($Item) { return [bool]($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) }
function Test-UnderPath([string]$Path, [string]$Root) {
    $p = $Path.TrimEnd('\')
    $r = $Root.TrimEnd('\')
    if ($p.Equals($r, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $p.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

# True when <Dest> is a file of this checkout itself (its directory is in the checkout, or a link on the way
# points into it): then it is the source, and it is never touched.
function Test-InsideCheckout([string]$Dest) {
    $p = Split-Path -LiteralPath $Dest -Parent
    if (Test-UnderPath $p $RepoDir) { return $true }
    while ($p -and ($p.Length -gt $HomeDir.Length) -and (Test-UnderPath $p $HomeDir)) {
        $item = Get-ItemOrNull $p
        if (($null -ne $item) -and (Test-Reparse $item)) {
            foreach ($target in @($item.Target)) { if ($target -and (Test-UnderPath ([string]$target) $RepoDir)) { return $true } }
        }
        $p = Split-Path -LiteralPath $p -Parent
    }
    return $false
}

function Get-RelFiles([string]$Root) {
    $base = $Root.TrimEnd('\')
    foreach ($f in @(Get-ChildItem -LiteralPath $base -Recurse -File -Force)) { $f.FullName.Substring($base.Length + 1) }
}

function Test-SameFile([string]$A, [string]$B) {
    if (-not (Test-Path -LiteralPath $A -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath $B -PathType Leaf)) { return $false }
    return ((Get-FileHash -Algorithm SHA256 -LiteralPath $A).Hash -eq (Get-FileHash -Algorithm SHA256 -LiteralPath $B).Hash)
}

# Same content: SHA-256 for a file; for a directory the same set of relative files, each with the same hash.
function Test-SameContent([string]$Src, [string]$Dest, [bool]$IsDir) {
    if (-not $IsDir) { return (Test-SameFile $Src $Dest) }
    if (-not (Test-Path -LiteralPath $Dest -PathType Container)) { return $false }
    $left = @(Get-RelFiles $Src | Sort-Object)
    if (($left -join '|') -ne (@(Get-RelFiles $Dest | Sort-Object) -join '|')) { return $false }
    foreach ($rel in $left) { if (-not (Test-SameFile (Join-Path $Src $rel) (Join-Path $Dest $rel))) { return $false } }
    return $true
}

# A copy the installer made: its directory holds a marker (a package entry) or a sidecar marker sits beside it.
function Test-Managed([string]$Dest) {
    if (Test-Path -LiteralPath (Join-Path (Split-Path -LiteralPath $Dest -Parent) $MarkerName) -PathType Leaf) { return $true }
    return (Test-Path -LiteralPath ($Dest + $MarkerName) -PathType Leaf)
}

# One of: inrepo, absent, ok (a managed copy, same content), modified (a managed copy that differs: moved
# aside), foreign (no marker, or any symlink or junction: moved aside).
function Get-DestState([string]$Src, [string]$Dest, [bool]$IsDir) {
    if (Test-InsideCheckout $Dest) { return 'inrepo' }
    $item = Get-ItemOrNull $Dest
    if ($null -eq $item) { return 'absent' }
    if ((Test-Reparse $item) -or (-not (Test-Managed $Dest))) { return 'foreign' }
    if (Test-SameContent $Src $Dest $IsDir) { return 'ok' }
    return 'modified'
}

# <Dest>.vivera-bak-<UTC yyyyMMddTHHmmssZ>, with -1, -2, ... appended until the name is free.
function Get-BackupPath([string]$Dest) {
    $stamp = [Environment]::GetEnvironmentVariable('VIVERA_NOW')
    if ([string]::IsNullOrEmpty($stamp)) { $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd\THHmmss\Z', [System.Globalization.CultureInfo]::InvariantCulture) }
    $candidate = "$Dest$BackupInfix$stamp"
    $n = 1
    while ($null -ne (Get-ItemOrNull $candidate)) {
        $candidate = "$Dest$BackupInfix${stamp}-${n}"
        $n++
    }
    return $candidate
}

# The newest backup beside <Dest>: the later stamp, then the larger N compared as a number.
function Get-NewestBackup([string]$Dest) {
    $parent = Split-Path -LiteralPath $Dest -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { return $null }
    $prefix = (Split-Path -LiteralPath $Dest -Leaf) + $BackupInfix
    $best = $null
    $bestStamp = ''
    $bestN = -1
    foreach ($c in @(Get-ChildItem -LiteralPath $parent -Force)) {
        if (-not $c.Name.StartsWith($prefix, [System.StringComparison]::Ordinal)) { continue }
        # A name that only starts like a backup (a stray note) is not one.
        if ($c.Name.Substring($prefix.Length) -match '^(\d{8}T\d{6}Z)(-(\d+))?$') {
            $n = 0
            if ($Matches.ContainsKey(3)) { $n = [int]$Matches[3] }
            $cmp = [string]::CompareOrdinal($Matches[1], $bestStamp)
            if (($cmp -gt 0) -or (($cmp -eq 0) -and ($n -gt $bestN))) { $best = $c.FullName; $bestStamp = $Matches[1]; $bestN = $n }
        }
    }
    return $best
}

# The entries one target makes: Src (in this checkout), Dest (under the profile), IsDir.
function Get-TargetEntries($T) {
    $dir = Join-Rel $HomeDir $T.Rel
    if ($T.Kind -eq 'file') {
        [pscustomobject]@{ Src = $MasterFile; Dest = (Join-Path $dir $MasterName); IsDir = $false }
    } elseif ($T.Kind -eq 'package') {
        $sibling = Split-Path -LiteralPath $dir -Parent
        [pscustomobject]@{ Src = $MasterFile; Dest = (Join-Path $dir 'SKILL.md'); IsDir = $false }
        # Phase skills are siblings of the orchestrator, so each harness finds them by name.
        foreach ($phase in @(Get-ChildItem -LiteralPath (Join-Path $RepoDir 'skills') -Directory -Filter 'sucp-*' | Sort-Object Name)) {
            [pscustomobject]@{ Src = (Join-Path $phase.FullName 'SKILL.md'); Dest = (Join-Path (Join-Path $sibling $phase.Name) 'SKILL.md'); IsDir = $false }
        }
        [pscustomobject]@{ Src = (Join-Path $RepoDir 'templates'); Dest = (Join-Path $dir 'templates'); IsDir = $true }
        [pscustomobject]@{ Src = (Join-Path $RepoDir 'examples'); Dest = (Join-Path $dir 'examples'); IsDir = $true }
        [pscustomobject]@{ Src = (Join-Path $RepoDir 'mermaid.config.json'); Dest = (Join-Path $dir 'mermaid.config.json'); IsDir = $false }
        [pscustomobject]@{ Src = (Join-Path $RepoDir 'mermaid.dark.config.json'); Dest = (Join-Path $dir 'mermaid.dark.config.json'); IsDir = $false }
    }
}

function Test-Detected($T) {
    if ($T.Always) { return $true }
    foreach ($d in $T.Dirs) { if (Test-Path -LiteralPath (Join-Rel $HomeDir $d) -PathType Container) { return $true } }
    foreach ($c in $T.Cmds) { if (Get-Command -Name $c -ErrorAction SilentlyContinue) { return $true } }
    return $false
}

function Split-List([string]$List) {
    if (-not [string]::IsNullOrWhiteSpace($List)) { foreach ($part in $List.Split(',')) { $part.Trim() } }
}

# The targets to act on, in table order: exactly the -Only ids when given, otherwise every detected one; then -Skip.
function Get-SelectedTargets {
    $onlyIds = @(Split-List $Only)
    $skipIds = @(Split-List $Skip)
    foreach ($t in $Targets) {
        if ($onlyIds.Count -gt 0) { if ($onlyIds -notcontains $t.Id) { continue } } elseif (-not (Test-Detected $t)) { continue }
        if ($skipIds -contains $t.Id) { continue }
        $t
    }
}

function Test-Proceed([string]$Target, [string]$Action) {
    if ($script:DryRunOn) { Write-Host "[DRY-RUN] Would ${Action}: $Target"; return $false }
    return $script:Cmdlet.ShouldProcess($Target, $Action)
}

function Copy-One([string]$Src, [string]$Dest) {
    $parent = Split-Path -LiteralPath $Dest -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath $Src -Destination $Dest -Force
}

# One file at a time to explicit destinations: a directory is never nested in an existing one or flattened.
function Copy-Entry([string]$Src, [string]$Dest, [bool]$IsDir) {
    if (-not $IsDir) { Copy-One $Src $Dest; return }
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    foreach ($rel in @(Get-RelFiles $Src)) { Copy-One (Join-Path $Src $rel) (Join-Path $Dest $rel) }
}

# Removes <Path>: its files one by one, then the emptied directories deepest first, never in one recursive call.
function Remove-Tree([string]$Path) {
    $item = Get-ItemOrNull $Path
    if ($null -eq $item) { return }
    if (-not $item.PSIsContainer) { Remove-Item -LiteralPath $Path -Force; return }
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)
    foreach ($f in $files) { Remove-Item -LiteralPath $f.FullName -Force }
    $dirs = @(Get-ChildItem -LiteralPath $Path -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending)
    foreach ($d in $dirs) { Remove-Item -LiteralPath $d.FullName -Force }
    Remove-Item -LiteralPath $Path -Force
}

function Remove-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    if (Test-Proceed $Path 'remove') { Remove-Item -LiteralPath $Path -Force }
}

# Removes <Dir> only when it is empty, and never a directory of this checkout or a symlinked one.
function Remove-IfEmpty([string]$Dir) {
    $item = Get-ItemOrNull $Dir
    if (($null -eq $item) -or (-not $item.PSIsContainer) -or (Test-Reparse $item)) { return $false }
    if (Test-InsideCheckout (Join-Path $Dir 'x')) { return $false }
    if (@(Get-ChildItem -LiteralPath $Dir -Force).Count -ne 0) { return $false }
    if (Test-Proceed $Dir 'remove the empty directory') { Remove-Item -LiteralPath $Dir -Force; return $true }
    return $false
}

# One line marks a package directory (or a lone file, by sidecar) as ours. Rewritten only when it differs.
function Set-Marker([string]$Path) {
    $line = "source=$RepoDir"
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and ([System.IO.File]::ReadAllText($Path).TrimEnd() -eq $line)) { return }
    if (Test-Proceed $Path 'write the marker') {
        [System.IO.File]::WriteAllText($Path, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
    }
}

function Invoke-Place($Entry) {
    $dest = $Entry.Dest
    $state = Get-DestState $Entry.Src $dest $Entry.IsDir
    if ($state -eq 'inrepo') { Write-Host "[SKIP] $dest is inside this checkout; left alone"; return }
    if ($state -eq 'ok') { return }
    $script:Changed++
    if ($state -eq 'absent') {
        if (Test-Proceed $dest 'copy') { Copy-Entry $Entry.Src $dest $Entry.IsDir; Write-Host "[OK] Copied: $dest" }
        return
    }
    # modified or foreign: it is moved aside first, then the copy goes in; if the copy fails it is put back.
    $backup = Get-BackupPath $dest
    if (-not (Test-Proceed $dest "back up to $backup, then copy")) { return }
    Move-Item -LiteralPath $dest -Destination $backup
    try {
        Copy-Entry $Entry.Src $dest $Entry.IsDir
    } catch {
        $reason = $_.Exception.Message
        Remove-Tree $dest
        Move-Item -LiteralPath $backup -Destination $dest
        throw "could not place $dest, and your file was put back ($reason)"
    }
    Write-Host "[BACKUP] $dest moved to $backup"
    Write-Host "[OK] Copied: $dest"
}

function Install-Target($T) {
    if ($T.Kind -eq 'none') { Write-Host "[SKIP] $($T.Id): its skills come from the .agents\skills directory; no skills target"; return }
    $entries = @(Get-TargetEntries $T)
    $script:Changed = 0
    foreach ($e in $entries) { Invoke-Place $e }
    if ($script:DryRunOn) { Write-Host "[DRY-RUN] Would mark each directory it filled for $($T.Id) with $MarkerName"; return }
    # Markers go in only now, so every entry above was judged before any of them was marked.
    $markers = @($entries | ForEach-Object { Join-Path (Split-Path -LiteralPath $_.Dest -Parent) $MarkerName } | Select-Object -Unique)
    if ($T.Kind -eq 'file') { $markers = @($entries[0].Dest + $MarkerName) }
    foreach ($m in $markers) {
        if (Test-InsideCheckout $m) { continue }
        if (Test-Path -LiteralPath (Split-Path -LiteralPath $m -Parent) -PathType Container) { Set-Marker $m }
    }
    if ($script:Changed -eq 0) { Write-Host "[OK] Already current: $($T.Id)" } else { Write-Host "[OK] Copied skill package: $($T.Id)" }
}

function Invoke-InstallAll($Selected) {
    foreach ($t in $Selected) { Install-Target $t }
    Write-Host '[SKIP] sprite agents: install.ps1 installs skills only; the generator needs bun, so use ./install.sh from WSL or Git Bash'
}

# Phase-skill directories of a package target that this checkout no longer has: ours (they carry a marker),
# not a link, not inside this checkout. -Check reports them and -Update prunes them.
function Get-StalePhaseDirs($T) {
    if ($T.Kind -ne 'package') { return }
    $parent = Split-Path -LiteralPath (Join-Rel $HomeDir $T.Rel) -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { return }
    foreach ($d in @(Get-ChildItem -LiteralPath $parent -Directory -Filter 'sucp-*' -Force)) {
        if (Test-Reparse $d) { continue }
        if (Test-Path -LiteralPath (Join-Path (Join-Path $RepoDir 'skills') $d.Name)) { continue }
        if (Test-InsideCheckout (Join-Path $d.FullName 'SKILL.md')) { continue }
        if (Test-Path -LiteralPath (Join-Path $d.FullName $MarkerName) -PathType Leaf) { $d.FullName }
    }
}

function Invoke-Prune($Selected) {
    foreach ($t in $Selected) {
        foreach ($dir in @(Get-StalePhaseDirs $t)) {
            if ($script:DryRunOn) { Write-Host "[DRY-RUN] Would prune $dir"; continue }
            Remove-File (Join-Path $dir 'SKILL.md')
            Remove-File (Join-Path $dir $MarkerName)
            if (Remove-IfEmpty $dir) { Write-Host "[PRUNED] $dir" } else { Write-Host "[PRUNED] files removed from $dir; the directory stays, it holds other files" }
        }
    }
}

function Invoke-Check($Selected) {
    $problems = 0
    $checked = 0
    foreach ($t in $Selected) {
        if ($t.Kind -eq 'none') { Write-Host "[skip] $($t.Id): no skills target"; continue }
        foreach ($e in @(Get-TargetEntries $t)) {
            $checked++
            $state = Get-DestState $e.Src $e.Dest $e.IsDir
            if (($state -eq 'ok') -or (($state -eq 'inrepo') -and (Test-SameContent $e.Src $e.Dest $e.IsDir))) {
                Write-Host "[ok] $($e.Dest)"
                continue
            }
            $problems++
            if ($state -eq 'absent') { Write-Host "[missing] $($e.Dest)" }
            elseif ($state -eq 'modified') { Write-Host "[stale] $($e.Dest) (the copy differs from $($e.Src); -Update moves it aside)" }
            elseif ($state -eq 'inrepo') { Write-Host "[foreign] $($e.Dest) (inside this checkout, not the expected file)" }
            else { Write-Host "[foreign] $($e.Dest) (not a vivera copy; -Update would move it aside)" }
        }
        foreach ($s in @(Get-StalePhaseDirs $t)) {
            Write-Host "[stale] $s (a skill this checkout no longer has; -Update prunes it)"
            $problems++
        }
    }
    if ($checked -eq 0) { Write-Host 'check: nothing to check (no selected target has skills)'; exit 2 }
    if ($problems -eq 0) { Write-Host 'check: CURRENT'; exit 0 }
    Write-Host "check: $problems problem(s)"
    exit 1
}

function Add-Kept([string]$Dest, [string]$Why) {
    $script:Kept++
    $script:KeptDirs[(Split-Path -LiteralPath $Dest -Parent)] = $true
    Write-Host "[KEEP] $Dest ($Why)"
}

# A copy goes only while it is identical to its source; one that differs is yours now.
function Uninstall-Entry($Entry) {
    $dest = $Entry.Dest
    if (Test-InsideCheckout $dest) { $script:Kept++; Write-Host "[KEEP] $dest (inside this checkout)"; return }
    $item = Get-ItemOrNull $dest
    if ($null -eq $item) { return }
    if ((Test-Reparse $item) -or (-not (Test-Managed $dest))) { Add-Kept $dest 'not a vivera copy'; return }
    if (-not (Test-SameContent $Entry.Src $dest $Entry.IsDir)) { Add-Kept $dest 'modified copy'; return }
    $backup = Get-NewestBackup $dest
    $script:Removed++
    if ($backup) { $script:Restored++ }
    if (Test-Proceed $dest 'remove') {
        Remove-Tree $dest
        Remove-File ($dest + $MarkerName)
        Write-Host "[REMOVED] $dest"
        if ($backup -and (Test-Proceed $backup 'restore')) {
            Move-Item -LiteralPath $backup -Destination $dest
            Write-Host "[RESTORED] $dest from $backup"
        }
    } elseif ($backup) {
        Test-Proceed $backup 'restore' | Out-Null
    }
}

function Invoke-Uninstall($Selected) {
    foreach ($t in $Selected) {
        if ($t.Kind -eq 'none') { continue }
        $entries = @(Get-TargetEntries $t)
        foreach ($e in $entries) { Uninstall-Entry $e }
        if ($t.Kind -ne 'package') { continue }
        $dirs = @($entries | ForEach-Object { Split-Path -LiteralPath $_.Dest -Parent } | Select-Object -Unique)
        # A marker stays only in a directory that still holds a kept copy.
        foreach ($d in $dirs) {
            if ((-not $script:KeptDirs.ContainsKey($d)) -and (-not (Test-InsideCheckout (Join-Path $d $MarkerName)))) { Remove-File (Join-Path $d $MarkerName) }
        }
        # Only empty directories go, down to the skills directory that held the package. Harness roots such as
        # .claude or .gemini are never touched, nor the skills directory the Antigravity CLI ships itself.
        foreach ($d in $dirs) { [void](Remove-IfEmpty $d) }
        if ($t.Id -ne 'antigravity-builtin') { [void](Remove-IfEmpty (Split-Path -LiteralPath (Join-Rel $HomeDir $t.Rel) -Parent)) }
    }
    $head = if ($script:DryRunOn) { '==> Vivera uninstall dry run (counts are what would happen):' } else { '==> Vivera uninstalled:' }
    Write-Host "$head $($script:Removed) copies removed, $($script:Restored) restored, $($script:Kept) kept"
}

if ($Help) { Show-Usage; exit 0 }
if (@(@($Check.IsPresent, $Update.IsPresent, $Uninstall.IsPresent) | Where-Object { $_ }).Count -gt 1) {
    Stop-Usage 'Choose one of -Check, -Update, -Uninstall'
}
foreach ($name in @('Only', 'Skip')) {
    if ($PSBoundParameters.ContainsKey($name) -and [string]::IsNullOrWhiteSpace($PSBoundParameters[$name])) { Stop-Usage "Missing value for -$name" }
}
$validIds = @($Targets | ForEach-Object { $_.Id })
foreach ($id in (@(Split-List $Only) + @(Split-List $Skip))) {
    if ($validIds -notcontains $id) {
        Write-Err "Unknown target: $id"
        Write-Err ('Valid targets: ' + ($validIds -join ', '))
        Stop-Usage 'Choose target ids from the list above.'
    }
}

$HomeDir = $Env:USERPROFILE
if ([string]::IsNullOrEmpty($HomeDir)) { $HomeDir = [Environment]::GetFolderPath('UserProfile') }
if ([string]::IsNullOrEmpty($HomeDir)) { Stop-Usage 'The user profile directory is empty; set USERPROFILE.' }
$HomeDir = $HomeDir.TrimEnd('\')
$RepoDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($RepoDir)) { Stop-Usage 'Run install.ps1 from a file, so the checkout can be found.' }
$RepoDir = $RepoDir.TrimEnd('\')
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
        Write-Host "    Tier: $Tier (skills only at every tier)"
    }
    $selected = @(Get-SelectedTargets)
    if ($Check) {
        Invoke-Check $selected
    } elseif ($Uninstall) {
        Invoke-Uninstall $selected
    } elseif ($Update) {
        Invoke-InstallAll $selected
        Invoke-Prune $selected
        Write-Host '==> Vivera updated: the copies match this checkout'
    } else {
        Invoke-InstallAll $selected
        Write-Host '==> Vivera farm planted: the skill package is installed as copies'
    }
} catch {
    Write-Err "install.ps1: $($_.Exception.Message)"
    exit 1
}
exit 0
