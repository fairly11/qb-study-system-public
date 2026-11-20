Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Remove inherited Node preload/debug flags before even the first version check.
# This affects only this PowerShell process and its children, never saved settings.
[Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, [EnvironmentVariableTarget]::Process)

function Get-QBInstallRoot {
    if ($env:OS -ne 'Windows_NT') { throw 'Windows 11 is required.' }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is unavailable.'
    }
    return [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'QBRecordWindows'))
}

function Assert-QBInstalledLocation {
    $root = Get-QBInstallRoot
    $actual = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    if (-not [string]::Equals($root, $actual, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Run this command from the installed QBRecordWindows\scripts folder. Run install.cmd first.'
    }
    return $root
}

function Get-QBWindowsPlatform {
    $arch = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($arch)) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ([string]::IsNullOrWhiteSpace($arch)) { throw 'Windows architecture could not be detected.' }
    switch ($arch.ToUpperInvariant()) {
        'AMD64' { return 'win-x64' }
        'ARM64' { return 'win-arm64' }
        default { throw 'Only 64-bit Windows x64 and ARM64 are supported.' }
    }
}

function Assert-QBPackageChecksums([string] $Root, [string[]] $CopiedRoots) {
    $hashes = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in Get-Content -LiteralPath (Join-Path $Root 'CHECKSUMS.sha256') -Encoding UTF8) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^([a-fA-F0-9]{64})[ \t]+\*?(.+)$') { throw 'Invalid CHECKSUMS.sha256 entry.' }
        $hash = $Matches[1].ToLowerInvariant()
        $name = $Matches[2].Replace('\', '/')
        if ($name.StartsWith('/') -or $name.Contains(':') -or
            @($name.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' -or $_ -eq '' }).Count -gt 0 -or $hashes.ContainsKey($name)) {
            throw 'Unsafe or duplicate path in CHECKSUMS.sha256.'
        }
        $hashes.Add($name, $hash)
    }
    foreach ($relative in $CopiedRoots) {
        if ($relative -eq 'CHECKSUMS.sha256') { continue }
        $item = Get-Item -LiteralPath (Join-Path $Root $relative) -Force
        $members = @($item)
        if ($item.PSIsContainer) { $members = @(Get-ChildItem -LiteralPath $item.FullName -Force -Recurse -File) }
        foreach ($member in $members) {
            $name = $member.FullName.Substring($Root.Length + 1).Replace('\', '/')
            if (-not $hashes.ContainsKey($name)) { throw ('Missing checksum for package file: ' + $name) }
            $actual = (Get-FileHash -LiteralPath $member.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -cne $hashes[$name]) { throw ('Package checksum mismatch: ' + $name) }
        }
    }
}

function Read-QBNodeRelease([string] $Root, [string] $Platform) {
    $file = Join-Path $Root 'node-release.json'
    $release = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($release.version -notmatch '^v24\.[0-9]+\.[0-9]+$') { throw 'Invalid pinned Node 24 version.' }
    $entry = $release.artifacts.PSObject.Properties[$Platform]
    if ($null -eq $entry) { throw 'The pinned Node release does not support this Windows architecture.' }
    $artifact = $entry.Value
    $expectedArchive = 'node-' + $release.version + '-' + $Platform + '.zip'
    if ($artifact.archive -cne $expectedArchive -or $artifact.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw 'Invalid pinned Node artifact.'
    }
    return [PSCustomObject]@{
        Version = $release.version
        Archive = $expectedArchive
        Sha256 = $artifact.sha256.ToLowerInvariant()
        Directory = $expectedArchive.Substring(0, $expectedArchive.Length - 4)
        BaseUrl = 'https://nodejs.org/dist/' + $release.version + '/'
    }
}

function Assert-QBNoReparsePoint([string] $Path) {
    $pending = [Collections.Generic.Stack[object]]::new()
    $pending.Push((Get-Item -LiteralPath $Path -Force))
    while ($pending.Count -gt 0) {
        $item = $pending.Pop()
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Symbolic links and directory junctions are not accepted in the installation payload.'
        }
        # Check each directory before visiting its children; never descend into a junction.
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Push($child) }
        }
    }
}

function Set-QBPrivateAcl([string] $Path, [bool] $Directory) {
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $identities = @($owner, ([Security.Principal.SecurityIdentifier]::new('S-1-5-18')),
        ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')))
    if ($Directory) { $acl = New-Object Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object Security.AccessControl.FileSecurity }
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in $identities) {
        if ($Directory) {
            $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, 'None', 'Allow')
        } else {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow')
        }
        [void] $acl.AddAccessRule($rule)
    }
    # Windows PowerShell's Set-Acl provider can request audit privileges when
    # reapplying a protected DACL. Persist only this descriptor's changed owner
    # and access rules; no audit rules or elevated privileges are required.
    if ($Directory) { [IO.Directory]::SetAccessControl($Path, $acl) }
    else { [IO.File]::SetAccessControl($Path, $acl) }
}

function Set-QBPrivateTreeAcl([string] $Root) {
    Assert-QBNoReparsePoint $Root
    Set-QBPrivateAcl $Root $true
    foreach ($item in Get-ChildItem -LiteralPath $Root -Force -Recurse) {
        Set-QBPrivateAcl $item.FullName $item.PSIsContainer
    }
}

function Assert-QBPrivateDataTree([string] $Root) {
    $expected = Get-QBInstallRoot
    if (-not [string]::Equals([IO.Path]::GetFullPath($Root), $expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'QB_PRIVACY_BLOCKED'
    }
    Assert-QBNoReparsePoint $Root
    $data = Join-Path $Root 'data'
    if (-not (Test-Path -LiteralPath $data -PathType Container)) { throw 'QB_PRIVACY_BLOCKED' }
    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($ownerSid, 'S-1-5-18', 'S-1-5-32-544')
    $items = @((Get-Item -LiteralPath $Root), (Get-Item -LiteralPath $data)) + @(Get-ChildItem -LiteralPath $data -Force -Recurse)
    foreach ($item in $items) {
        $acl = Get-Acl -LiteralPath $item.FullName
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $ownerSid) { throw 'QB_PRIVACY_BLOCKED' }
        if ($item.FullName -eq $Root -and -not $acl.AreAccessRulesProtected) { throw 'QB_PRIVACY_BLOCKED' }
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if ($rules.Count -eq 0) { throw 'QB_PRIVACY_BLOCKED' }
        $ownAccess = $false
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $allowed -notcontains $rule.IdentityReference.Value) {
                throw 'QB_PRIVACY_BLOCKED'
            }
            if ($rule.IdentityReference.Value -ceq $ownerSid) { $ownAccess = $true }
        }
        if (-not $ownAccess) { throw 'QB_PRIVACY_BLOCKED' }
    }
}

function Get-QBPortConflicts {
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return @($listeners | Where-Object { $_.Port -eq 8765 -or $_.Port -eq 8766 } | ForEach-Object { $_.Port } | Sort-Object -Unique)
}

function Get-QBInstalledRuntime([string] $Root) {
    Assert-QBNoReparsePoint (Join-Path $Root 'runtime')
    $node = Join-Path $Root 'runtime\node\node.exe'
    $launcher = Join-Path $Root 'app\launcher.mjs'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw 'The installed runtime is incomplete. No data has been changed.'
    }
    $release = Read-QBNodeRelease $Root (Get-QBWindowsPlatform)
    $version = & $node --version
    if ($LASTEXITCODE -ne 0 -or ($version -join '').Trim() -cne $release.Version) {
        throw 'The installed Node version does not match node-release.json.'
    }
    return [PSCustomObject]@{ Node = $node; Launcher = $launcher }
}

function Get-QBAutostartSpec([string] $Root) {
    $startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    if ([string]::IsNullOrWhiteSpace($startup)) { throw 'The current user Startup folder is unavailable.' }
    return [PSCustomObject]@{
        Path = Join-Path $startup 'QBRecordWindows.lnk'
        Target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'scripts\Start-QBRecordWindows.ps1') + '" -Autostart'
        WorkingDirectory = $Root
        Description = 'QBRecordWindows current-user startup'
    }
}

function Test-QBOwnShortcut($Shortcut, $Spec) {
    return [string]::Equals($Shortcut.TargetPath, $Spec.Target, [StringComparison]::OrdinalIgnoreCase) -and
        $Shortcut.Arguments -ceq $Spec.Arguments -and
        [string]::Equals($Shortcut.WorkingDirectory, $Spec.WorkingDirectory, [StringComparison]::OrdinalIgnoreCase) -and
        $Shortcut.Description -ceq $Spec.Description
}
