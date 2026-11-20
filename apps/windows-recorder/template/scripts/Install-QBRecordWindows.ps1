# Run as the current user, without administrator privileges. No execution policy is saved.
. (Join-Path $PSScriptRoot 'Common.ps1')
$stage = $null
try {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Do not run as administrator. Close this window and double-click install.cmd normally.'
    }
    $destination = Get-QBInstallRoot
    if (Test-Path -LiteralPath $destination) {
        throw 'QBRecordWindows already exists. Installation stopped without overwriting programs, settings or study history.'
    }
    $packageRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'app\launcher.mjs') -PathType Leaf)) {
        throw 'The package is incomplete. Extract the entire ZIP first; do not run from inside a ZIP viewer.'
    }
    $release = Read-QBNodeRelease $packageRoot (Get-QBWindowsPlatform)
    $directories = @('app', 'scripts', 'browser-extension', 'collector', 'docs', 'licenses')
    $files = @('node-release.json', 'CHECKSUMS.sha256', 'RELEASE.json', 'THIRD_PARTY_NOTICES.json',
        'install.cmd', 'start.cmd', 'stop.cmd', 'autostart-on.cmd', 'autostart-off.cmd', 'README.txt', 'SOURCE-MANIFEST.json')
    foreach ($relative in @($directories + $files)) {
        $item = Join-Path $packageRoot $relative
        if (-not (Test-Path -LiteralPath $item)) { throw ('The package is missing: ' + $relative) }
        Assert-QBNoReparsePoint $item
    }
    Assert-QBPackageChecksums $packageRoot @($directories + $files)

    $stage = Join-Path $env:LOCALAPPDATA ('QBRecordWindows-setup-' + [Guid]::NewGuid().ToString('N'))
    [void] [IO.Directory]::CreateDirectory($stage)
    Set-QBPrivateAcl $stage $true
    $payload = Join-Path $stage 'payload'
    [void] [IO.Directory]::CreateDirectory($payload)
    Set-QBPrivateAcl $payload $true
    foreach ($relative in @($directories + $files)) {
        Copy-Item -LiteralPath (Join-Path $packageRoot $relative) -Destination $payload -Recurse
    }
    Assert-QBPackageChecksums $payload @($directories + $files)
    [void] [IO.Directory]::CreateDirectory((Join-Path $payload 'data'))

    Write-Host ('Downloading official Node ' + $release.Version + ' for ' + (Get-QBWindowsPlatform) + '...')
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    $archive = Join-Path $stage $release.Archive
    $sumsFile = Join-Path $stage 'SHASUMS256.txt'
    Invoke-WebRequest -UseBasicParsing -Uri ($release.BaseUrl + 'SHASUMS256.txt') -OutFile $sumsFile -TimeoutSec 120
    Invoke-WebRequest -UseBasicParsing -Uri ($release.BaseUrl + $release.Archive) -OutFile $archive -TimeoutSec 300
    $pattern = '^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($release.Archive) + '$'
    $official = @(Get-Content -LiteralPath $sumsFile | ForEach-Object {
        if ($_ -match $pattern) { $Matches[1].ToLowerInvariant() }
    })
    if ($official.Count -ne 1 -or $official[0] -cne $release.Sha256) {
        throw 'The official checksum does not match the pinned release. Installation stopped.'
    }
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $release.Sha256) { throw 'The downloaded Node ZIP failed checksum verification.' }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $prefix = $release.Directory + '/'
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not $name.StartsWith($prefix, [StringComparison]::Ordinal) -or $name.Contains(':') -or
                @($name.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count -gt 0) {
                throw 'The Node archive contains an unexpected path.'
            }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw 'The Node archive contains a symbolic link.'
            }
        }
    } finally { $zip.Dispose() }
    $expanded = Join-Path $stage 'expanded'
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $expanded)
    [void] [IO.Directory]::CreateDirectory((Join-Path $payload 'runtime'))
    [IO.Directory]::Move((Join-Path $expanded $release.Directory), (Join-Path $payload 'runtime\node'))
    $node = Join-Path $payload 'runtime\node\node.exe'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'The verified Node ZIP does not contain node.exe.' }
    $version = & $node --version
    if ($LASTEXITCODE -ne 0 -or ($version -join '').Trim() -cne $release.Version) {
        throw 'Node cannot run on this Windows computer or its version does not match.'
    }
    Set-QBPrivateTreeAcl $payload
    # Directory.Move fails if the destination appeared while downloading. It never merges folders.
    [IO.Directory]::Move($payload, $destination)
    Write-Host ''
    Write-Host ('Installed: ' + $destination)
    Write-Host 'Next: double-click start.cmd in this package or in the installed folder.'
    Write-Host 'The dashboard connects this recorder to your existing Notion. Automatic login startup is OFF.'
    Write-Host 'To enable it later, run autostart-on.cmd and explicitly type YES.'
    exit 0
} catch {
    Write-Host ('Installation stopped: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Existing study history and settings were not overwritten.'
    exit 1
} finally {
    # Only this invocation creates this random staging directory; never remove the installed folder.
    if ($null -ne $stage -and (Test-Path -LiteralPath $stage)) {
        try { Remove-Item -LiteralPath $stage -Recurse -Force } catch {
            Write-Host ('Temporary setup files remain at: ' + $stage)
        }
    }
}
