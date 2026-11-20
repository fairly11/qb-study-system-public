param([Parameter(Mandatory = $true)][string] $PackageRoot)
$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).ProviderPath
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
$originalArchitecture = $env:PROCESSOR_ARCHITECTURE
$originalWowArchitecture = $env:PROCESSOR_ARCHITEW6432
try {
    foreach ($testCase in @(
        @{ Architecture = 'AMD64'; WowArchitecture = ''; Expected = 'win-x64' },
        @{ Architecture = 'ARM64'; WowArchitecture = ''; Expected = 'win-arm64' },
        @{ Architecture = 'x86'; WowArchitecture = 'AMD64'; Expected = 'win-x64' },
        @{ Architecture = 'x86'; WowArchitecture = 'ARM64'; Expected = 'win-arm64' }
    )) {
        $env:PROCESSOR_ARCHITECTURE = $testCase.Architecture
        $env:PROCESSOR_ARCHITEW6432 = $testCase.WowArchitecture
        if ((Get-QBWindowsPlatform) -cne $testCase.Expected) { throw 'POWERSHELL_ARCH_DETECTION_FAILED' }
        $count++
    }
    $env:PROCESSOR_ARCHITECTURE = 'x86'
    $env:PROCESSOR_ARCHITEW6432 = ''
    $rejected = $false
    try { [void](Get-QBWindowsPlatform) } catch { $rejected = $true }
    if (-not $rejected) { throw 'POWERSHELL_UNSUPPORTED_ARCH_ACCEPTED' }
    $count++
} finally {
    $env:PROCESSOR_ARCHITECTURE = $originalArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $originalWowArchitecture
}
foreach ($forbidden in @('review.cmd', 'scripts/Review-QBRecordWindows.ps1', 'app/review-runner.mjs', 'collector/dist/review.mjs')) {
    if (Test-Path -LiteralPath (Join-Path $PackageRoot $forbidden)) { throw 'POWERSHELL_REVIEW_PUBLISHER_BUNDLED' }
}
$count++
[PSCustomObject]@{ checks_passed = $count; windows_device_tested = $false; scope = 'Parser and portable validation only; Windows installer/ACL were not executed.' } | ConvertTo-Json -Compress
