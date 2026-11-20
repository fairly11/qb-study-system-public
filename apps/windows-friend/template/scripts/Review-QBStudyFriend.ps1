param(
    [Parameter(Mandatory = $true)][ValidateSet('status', 'prepare', 'begin', 'remaining', 'register')][string] $Action,
    [string] $Value
)
. (Join-Path $PSScriptRoot 'Common.ps1')
try {
    $root = Assert-QBInstalledLocation
    Assert-QBPrivateDataTree $root
    $runtime = Get-QBInstalledRuntime $root
    $runner = Join-Path $root 'app\review-runner.mjs'
    $arguments = @($runner, $Action)
    if (-not [string]::IsNullOrWhiteSpace($Value)) { $arguments += $Value }
    & $runtime.Node @arguments
    exit $LASTEXITCODE
} catch {
    # Never print a secret, session URL, configuration, or raw exception.
    Write-Output '{"event_code":"REVIEW_ENTRY_UNAVAILABLE"}'
    exit 1
}
