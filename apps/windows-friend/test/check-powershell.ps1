param([Parameter(Mandatory = $true)][string] $PackageRoot)
$ErrorActionPreference = 'Stop'
$count = 0
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'scripts') -Filter '*.ps1') {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw ('POWERSHELL_PARSE_FAILED: ' + $file.Name) }
    $count++
}
. (Join-Path $PackageRoot 'scripts/Common.ps1')
foreach ($platform in @('win-x64', 'win-arm64')) {
    $release = Read-QBNodeRelease $PackageRoot $platform
    if ($release.Version -cne 'v24.21.0' -or $release.BaseUrl -cne 'https://nodejs.org/dist/v24.21.0/' -or $release.Sha256.Length -ne 64) {
        throw 'POWERSHELL_PINNED_RUNTIME_FAILED'
    }
    $count++
}
Assert-QBNoReparsePoint $PackageRoot
$count++
$roots = @(Get-ChildItem -LiteralPath $PackageRoot -Force | ForEach-Object { $_.Name })
Assert-QBPackageChecksums $PackageRoot $roots
$count++
$rejected = $false
try { [void](Read-QBNodeRelease $PackageRoot 'win-x86') } catch { $rejected = $true }
if (-not $rejected) { throw 'POWERSHELL_UNSUPPORTED_ARCH_ACCEPTED' }
$count++
[PSCustomObject]@{ checks_passed = $count; windows_device_tested = $false; scope = 'Parser and portable validation only; Windows installer/ACL were not executed.' } | ConvertTo-Json -Compress
