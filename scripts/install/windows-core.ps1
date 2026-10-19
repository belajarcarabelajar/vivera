# Dot-sourced by install.ps1 (never run on its own): path helpers, content digests, markers, and how a
# destination is judged. It has no param block and no top-level statements: install.ps1 sets $HomeDir,
# $RepoDir, $MarkerName and the other script variables before any function here is called.

# Split-Path -LiteralPath takes no -Parent or -Leaf: measured under PowerShell 7.6.6 ("Parameter set cannot be
# resolved"), so the .NET calls do it, on every PowerShell version.
function Get-ParentDir([string]$Path) { return [System.IO.Path]::GetDirectoryName($Path) }
function Get-LeafName([string]$Path) { return [System.IO.Path]::GetFileName($Path) }

function Join-Rel([string]$Base, [string]$Rel) {
    $p = $Base
    foreach ($part in $Rel.Split('\')) { if ($part -ne '') { $p = Join-Path $p $part } }
    return $p
}

# Anything .NET can see at <Path> without following a link counts as present: only a plain "not found" is absent.
# Used when Get-Item reports not found, because it may say so for a link whose target is gone (Windows PowerShell
# 5.1: UNVERIFIED; PowerShell 7 on Linux returns the link) and a path that cannot be told apart must not read as free.
function Test-EntryPresent([string]$Path) {
    try { [void][System.IO.File]::GetAttributes($Path); return $true } catch {
        $e = $_.Exception
        if ($null -ne $e.InnerException) { $e = $e.InnerException }
        return (-not (($e -is [System.IO.FileNotFoundException]) -or ($e -is [System.IO.DirectoryNotFoundException])))
    }
}

# The item at <Path>, or $null when nothing is there. A path that exists but cannot be inspected (access denied, a
# link Get-Item cannot read) is NOT "absent": it throws "cannot inspect <path>: <reason>", so nothing is written to it.
function Get-ItemOrNull([string]$Path) {
    try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop } catch {
        $err = $_
        if (($err.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) -and (-not (Test-EntryPresent $Path))) { return $null }
        throw "cannot inspect ${Path}: $($err.Exception.Message)"
    }
}
function Test-Reparse($Item) { return [bool]($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) }

# Both separators count, so the same test also runs on Linux, where paths use '/'.
function Test-UnderPath([string]$Path, [string]$Root) {
    $p = $Path.Replace('/', '\').TrimEnd('\')
    $r = $Root.Replace('/', '\').TrimEnd('\')
    if ($p.Equals($r, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $p.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

# True when <Dest> is a file of this checkout itself (its directory is in the checkout, or a link on the way
# points into it): then it is the source, and it is never touched.
function Test-InsideCheckout([string]$Dest) {
    $p = Get-ParentDir $Dest
    if (Test-UnderPath $p $RepoDir) { return $true }
    while ($p -and ($p.Length -gt $HomeDir.Length) -and (Test-UnderPath $p $HomeDir)) {
        $item = Get-ItemOrNull $p
        if (($null -ne $item) -and (Test-Reparse $item)) {
            foreach ($target in @($item.Target)) { if ($target -and (Test-UnderPath ([string]$target) $RepoDir)) { return $true } }
        }
        $p = Get-ParentDir $p
    }
    return $false
}

# True when <Dest> is under the profile and a directory between the profile and <Dest> is a symlink or junction,
# so that <Dest> physically lives in another tree (a dotfiles repo). The profile directory itself does not count.
function Test-BehindLinkedDir([string]$Dest) {
    if (-not (Test-UnderPath $Dest $HomeDir)) { return $false }
    $p = Get-ParentDir $Dest
    while ($p -and ($p.Length -gt $HomeDir.Length) -and (Test-UnderPath $p $HomeDir)) {
        $item = Get-ItemOrNull $p
        if (($null -ne $item) -and (Test-Reparse $item)) { return $true }
        $p = Get-ParentDir $p
    }
    return $false
}

# Test-BehindLinkedDir for a <Dest> whose directory may not exist yet: the nearest entry that does exist decides,
# because whatever is created below a linked directory lands in the other tree (behind_symlinked_ancestor in lib.sh).
function Test-BehindLinkedAncestor([string]$Dest) {
    $p = Get-ParentDir $Dest
    while ($p -and ($null -eq (Get-ItemOrNull $p))) { $p = Get-ParentDir $p }
    if (-not $p) { return $false }
    return (Test-BehindLinkedDir (Join-Path $p 'x'))
}

function Get-RelFiles([string]$Root) {
    $base = $Root.TrimEnd('\')
    foreach ($f in @(Get-ChildItem -LiteralPath $base -Recurse -File -Force)) { $f.FullName.Substring($base.Length + 1) }
}

function Get-Sha256Hex([string]$Path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Test-SameFile([string]$A, [string]$B) {
    if (-not (Test-Path -LiteralPath $A -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath $B -PathType Leaf)) { return $false }
    return ((Get-Sha256Hex $A) -eq (Get-Sha256Hex $B))
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

# "ps-sha256:<hex>" of a plain file's bytes, or of a directory's lines "<file sha256>  <relative path, with />",
# sorted by ordinal comparison and each ended by LF. Empty for a link or anything missing. The tag differs from
# the "sha256:" the bash installer writes on purpose: the two digests are not claimed to be byte for byte equal,
# so a record made by one installer never counts as proof for the other (it reads as modified, which is safe).
function Get-EntryDigest([string]$Path) {
    $item = Get-ItemOrNull $Path
    if (($null -eq $item) -or (Test-Reparse $item)) { return '' }
    if (-not $item.PSIsContainer) { return ($DigestTag + (Get-Sha256Hex $Path)) }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($rel in @(Get-RelFiles $Path)) { $lines.Add((Get-Sha256Hex (Join-Path $Path $rel)) + '  ' + $rel.Replace('\', '/')) }
    $sorted = $lines.ToArray()
    [Array]::Sort($sorted, [System.StringComparer]::Ordinal)
    $text = ''
    foreach ($l in $sorted) { $text += $l + "`n" }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash((New-Object System.Text.UTF8Encoding($false)).GetBytes($text)) } finally { $sha.Dispose() }
    return ($DigestTag + (($bytes | ForEach-Object { $_.ToString('x2') }) -join ''))
}

# The digest the marker recorded for <Dest> ("entry <name> <tag>:<hex>"), or an empty string. Exactly one record
# across both marker places counts, as in recorded_digest of lib.sh: a repeated or malformed one vouches for nothing.
function Get-RecordedDigest([string]$Dest) {
    $prefix = 'entry ' + (Get-LeafName $Dest) + ' '
    $count = 0
    $found = ''
    foreach ($marker in @((Join-Path (Get-ParentDir $Dest) $MarkerName), ($Dest + $MarkerName))) {
        $m = Get-ItemOrNull $marker
        if (($null -eq $m) -or $m.PSIsContainer -or (Test-Reparse $m)) { continue }
        foreach ($line in [System.IO.File]::ReadAllLines($marker)) {
            if ($line.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
                $count++
                $rest = $line.Substring($prefix.Length)
                if ($rest.IndexOf(' ') -lt 0) { $found = $rest }
            }
        }
    }
    if ($count -eq 1) { return $found }
    return ''
}

# A copy the installer made: its directory holds a marker (a package entry) or a sidecar marker sits beside it.
function Test-Managed([string]$Dest) {
    if (Test-Path -LiteralPath (Join-Path (Get-ParentDir $Dest) $MarkerName) -PathType Leaf) { return $true }
    return (Test-Path -LiteralPath ($Dest + $MarkerName) -PathType Leaf)
}

# What a managed copy is, judged against its source (managed_state in lib.sh): identical (same content), pristine
# (not the source's content, but exactly the digest the marker recorded when it was placed: merely outdated, nobody
# edited it) or modified (anything else, which includes a copy with no usable record and one recorded with the bash
# "sha256:" tag, because that digest is not claimed to equal this one). The digest only ever decides pristine.
function Get-ManagedState([string]$Src, [string]$Dest, [bool]$IsDir) {
    if (Test-SameContent $Src $Dest $IsDir) { return 'identical' }
    $current = Get-EntryDigest $Dest
    if (($current -ne '') -and ($current -ceq (Get-RecordedDigest $Dest))) { return 'pristine' }
    return 'modified'
}

# One of: inrepo; viadir (anything behind a symlinked or junctioned directory, absent or not, a link there too: it
# belongs to another tree, and a copy written there would be refused by the next run); absent; ok (a managed copy,
# same content); pristine (a managed copy that is only outdated: refreshed with no backup); modified (a managed copy
# someone edited: moved aside); foreign (no marker, or a symlink or junction at the destination: moved aside).
function Get-DestState([string]$Src, [string]$Dest, [bool]$IsDir) {
    if (Test-InsideCheckout $Dest) { return 'inrepo' }
    $item = Get-ItemOrNull $Dest
    if ($null -eq $item) {
        if (Test-BehindLinkedAncestor $Dest) { return 'viadir' }
        return 'absent'
    }
    if (Test-BehindLinkedDir $Dest) { return 'viadir' }
    if ((Test-Reparse $item) -or (-not (Test-Managed $Dest))) { return 'foreign' }
    $managed = Get-ManagedState $Src $Dest $IsDir
    if ($managed -eq 'identical') { return 'ok' }
    return $managed
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
    $parent = Get-ParentDir $Dest
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { return $null }
    $prefix = (Get-LeafName $Dest) + $BackupInfix
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

# Move-Item -Destination reads [ and ] as a wildcard in Windows PowerShell 5.1, and a path with them is legal on
# Windows. The .NET calls take the paths literally, so a file or directory is renamed exactly where it says.
function Move-Path([string]$From, [string]$To) {
    $item = Get-ItemOrNull $From
    if ($null -eq $item) { throw "cannot move $From, it is gone" }
    if ($item.PSIsContainer) { [System.IO.Directory]::Move($From, $To) } else { [System.IO.File]::Move($From, $To) }
}

# The entries one target makes: Src (in this checkout), Dest (under the profile), IsDir.
function Get-TargetEntries($T) {
    $dir = Join-Rel $HomeDir $T.Rel
    if ($T.Kind -eq 'file') {
        [pscustomobject]@{ Src = $MasterFile; Dest = (Join-Path $dir $MasterName); IsDir = $false }
    } elseif ($T.Kind -eq 'package') {
        $sibling = Get-ParentDir $dir
        [pscustomobject]@{ Src = $MasterFile; Dest = (Join-Path $dir 'SKILL.md'); IsDir = $false }
        # Phase skills are siblings of the orchestrator, so each harness finds them by name.
        foreach ($phase in @(Get-ChildItem -LiteralPath (Join-Path $RepoDir 'skills') -Directory -Filter 'sucp-*' | Sort-Object Name)) {
            [pscustomobject]@{ Src = (Join-Path $phase.FullName 'SKILL.md'); Dest = (Join-Path (Join-Path $sibling $phase.Name) 'SKILL.md'); IsDir = $false }
            $refs = Join-Path $phase.FullName 'references'
            if (Test-Path -LiteralPath $refs -PathType Container) {
                [pscustomobject]@{ Src = $refs; Dest = (Join-Path (Join-Path $sibling $phase.Name) 'references'); IsDir = $true }
            }
        }
        [pscustomobject]@{ Src = (Join-Path $RepoDir 'templates'); Dest = (Join-Path $dir 'templates'); IsDir = $true }
        [pscustomobject]@{ Src = (Join-Path $RepoDir 'examples'); Dest = (Join-Path $dir 'examples'); IsDir = $true }
        [pscustomobject]@{ Src = (Join-Path $RepoDir 'mermaid.config.json'); Dest = (Join-Path $dir 'mermaid.config.json'); IsDir = $false }
        [pscustomobject]@{ Src = (Join-Path $RepoDir 'mermaid.dark.config.json'); Dest = (Join-Path $dir 'mermaid.dark.config.json'); IsDir = $false }
        # The Stop hook in the orchestrator's frontmatter runs this script from the installed package.
        [pscustomobject]@{ Src = (Join-Path (Join-Path (Join-Path $RepoDir '.claude') 'hooks') 'require-exit-code.mjs'); Dest = (Join-Path $dir 'require-exit-code.mjs'); IsDir = $false }
    }
}
