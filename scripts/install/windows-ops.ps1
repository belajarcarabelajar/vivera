# Dot-sourced by install.ps1 after windows-core.ps1 (never run on its own): choosing the targets, and the
# actions: install, -Update prune, -Check, -Uninstall. It has no param block and no top-level statements.

function Test-Detected($T) {
    if ($T.Always) { return $true }
    foreach ($d in $T.Dirs) { if (Test-Path -LiteralPath (Join-Rel $HomeDir $d) -PathType Container) { return $true } }
    foreach ($c in $T.Cmds) { if (Get-Command -Name $c -ErrorAction SilentlyContinue) { return $true } }
    return $false
}

# Every id of a list, each element split on commas: -Only claude,opencode (an array, as typed at a prompt) and
# -File install.ps1 -Only "claude,opencode" (one string) both work.
function Split-List($List) {
    foreach ($item in @($List)) {
        if ($null -ne $item) { foreach ($part in ([string]$item).Split(',')) { $part.Trim() } }
    }
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
    $parent = Get-ParentDir $Dest
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

# Removes <Dir> only when it is empty, and never a directory of this checkout, a symlinked one, or one that lives
# behind a symlinked directory.
function Remove-IfEmpty([string]$Dir) {
    $item = Get-ItemOrNull $Dir
    if (($null -eq $item) -or (-not $item.PSIsContainer) -or (Test-Reparse $item)) { return $false }
    if (Test-InsideCheckout (Join-Path $Dir 'x')) { return $false }
    if (Test-BehindLinkedDir (Join-Path $Dir 'x')) { return $false }
    if (@(Get-ChildItem -LiteralPath $Dir -Force).Count -ne 0) { return $false }
    if (Test-Proceed $Dir 'remove the empty directory') { Remove-Item -LiteralPath $Dir -Force; return $true }
    return $false
}

# A marker holds "source=<checkout>" and one "entry <name> ps-sha256:<hex>" line per entry placed in its
# directory (a package entry) or beside it (a lone file, by sidecar). Rewritten only when it differs.
function Set-Marker([string]$Path, [string[]]$Dests) {
    $text = "source=$RepoDir"
    foreach ($d in $Dests) {
        $digest = Get-EntryDigest $d
        if ($digest -ne '') { $text += "`n" + 'entry ' + (Get-LeafName $d) + ' ' + $digest }
    }
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and ([System.IO.File]::ReadAllText($Path).TrimEnd() -ceq $text)) { return }
    if (Test-Proceed $Path 'write the marker') {
        [System.IO.File]::WriteAllText($Path, $text + "`n", (New-Object System.Text.UTF8Encoding($false)))
    }
}

function Invoke-Place($Entry) {
    $dest = $Entry.Dest
    $state = Get-DestState $Entry.Src $dest $Entry.IsDir
    if ($state -eq 'inrepo') { Write-Host "[SKIP] $dest is inside this checkout; left alone"; return }
    if ($state -eq 'viadir') { Write-Host "[SKIP] $dest is reached through a symlinked directory; left alone"; return }
    if ($state -eq 'ok') { $script:Placed.Add($dest); return }
    $script:Changed++
    if ($state -eq 'absent') {
        if (Test-Proceed $dest 'copy') { Copy-Entry $Entry.Src $dest $Entry.IsDir; $script:Placed.Add($dest); Write-Host "[OK] Copied: $dest" }
        return
    }
    # modified or foreign: it is moved aside first, then the copy goes in; if the copy fails it is put back.
    $backup = Get-BackupPath $dest
    if (-not (Test-Proceed $dest "back up to $backup, then copy")) { return }
    Move-Path $dest $backup
    try {
        Copy-Entry $Entry.Src $dest $Entry.IsDir
    } catch {
        $reason = $_.Exception.Message
        Remove-Tree $dest
        Move-Path $backup $dest
        throw "could not place $dest, and your file was put back ($reason)"
    }
    $script:Placed.Add($dest)
    Write-Host "[BACKUP] $dest moved to $backup"
    Write-Host "[OK] Copied: $dest"
}

function Install-Target($T) {
    if ($T.Kind -eq 'none') { Write-Host "[SKIP] $($T.Id): its skills come from the .agents\skills directory; no skills target"; return }
    $entries = @(Get-TargetEntries $T)
    $script:Changed = 0
    $script:Placed.Clear()
    foreach ($e in $entries) { Invoke-Place $e }
    if ($script:DryRunOn) { Write-Host "[DRY-RUN] Would mark each directory it filled for $($T.Id) with $MarkerName"; return }
    # Markers go in only now, so every entry above was judged before any of them was marked.
    $byMarker = [ordered]@{}
    foreach ($d in $script:Placed) {
        if ($T.Kind -eq 'file') { $m = $d + $MarkerName } else { $m = Join-Path (Get-ParentDir $d) $MarkerName }
        if (-not $byMarker.Contains($m)) { $byMarker[$m] = New-Object System.Collections.Generic.List[string] }
        $byMarker[$m].Add($d)
    }
    foreach ($m in @($byMarker.Keys)) {
        if (Test-InsideCheckout $m) { continue }
        Set-Marker $m @($byMarker[$m])
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
    $parent = Get-ParentDir (Join-Rel $HomeDir $T.Rel)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { return }
    foreach ($d in @(Get-ChildItem -LiteralPath $parent -Directory -Filter 'sucp-*' -Force)) {
        if (Test-Reparse $d) { continue }
        if (Test-Path -LiteralPath (Join-Path (Join-Path $RepoDir 'skills') $d.Name)) { continue }
        if (Test-InsideCheckout (Join-Path $d.FullName 'SKILL.md')) { continue }
        if (Test-Path -LiteralPath (Join-Path $d.FullName $MarkerName) -PathType Leaf) { $d.FullName }
    }
}

# A stale phase skill loses its SKILL.md only while that is exactly what the installer placed: its digest still
# equals the one the marker recorded, with the same algorithm tag. An edited SKILL.md, one that is not a plain
# file, or one with no usable record is the user's: the directory stays with a KEEP line. The directory goes
# only when that left it empty.
function Invoke-Prune($Selected) {
    foreach ($t in $Selected) {
        foreach ($dir in @(Get-StalePhaseDirs $t)) {
            $skill = Join-Path $dir 'SKILL.md'
            if ($null -ne (Get-ItemOrNull $skill)) {
                $current = Get-EntryDigest $skill
                if (($current -eq '') -or ($current -cne (Get-RecordedDigest $skill))) {
                    $script:Kept++
                    Write-Host "[KEEP] $dir (modified copy of a skill this checkout no longer has)"
                    continue
                }
            }
            if ($script:DryRunOn) { Write-Host "[DRY-RUN] Would prune $dir"; continue }
            Remove-File $skill
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
            elseif ($state -eq 'viadir') { Write-Host "[foreign] $($e.Dest) (behind a symlinked directory; left alone)" }
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
    $script:KeptDirs[(Get-ParentDir $Dest)] = $true
    Write-Host "[KEEP] $Dest ($Why)"
}

# A copy goes only while it is identical to its source; one that differs is yours now.
function Uninstall-Entry($Entry) {
    $dest = $Entry.Dest
    if (Test-InsideCheckout $dest) { $script:Kept++; Write-Host "[KEEP] $dest (inside this checkout)"; return }
    $item = Get-ItemOrNull $dest
    if ($null -eq $item) { return }
    # A real file of another tree, reached through a symlinked directory: never removed through the link.
    if ((-not (Test-Reparse $item)) -and (Test-BehindLinkedDir $dest)) { Add-Kept $dest 'behind a symlinked directory'; return }
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
            Move-Path $backup $dest
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
        $dirs = @($entries | ForEach-Object { Get-ParentDir $_.Dest } | Select-Object -Unique)
        # A marker stays only in a directory that still holds a kept copy.
        foreach ($d in $dirs) {
            if ((-not $script:KeptDirs.ContainsKey($d)) -and (-not (Test-InsideCheckout (Join-Path $d $MarkerName)))) { Remove-File (Join-Path $d $MarkerName) }
        }
        # Only empty directories go, down to the skills directory that held the package. Harness roots such as
        # .claude or .gemini are never touched, nor the skills directory the Antigravity CLI ships itself.
        foreach ($d in $dirs) { [void](Remove-IfEmpty $d) }
        if ($t.Id -ne 'antigravity-builtin') { [void](Remove-IfEmpty (Get-ParentDir (Join-Rel $HomeDir $t.Rel))) }
    }
    $head = if ($script:DryRunOn) { '==> Vivera uninstall dry run (counts are what would happen):' } else { '==> Vivera uninstalled:' }
    Write-Host "$head $($script:Removed) copies removed, $($script:Restored) restored, $($script:Kept) kept"
}
