. (Join-Path $PSScriptRoot 'Common.ps1')
try {
    $root = Assert-QBInstalledLocation
    $runtime = Get-QBInstalledRuntime $root
    Set-Location -LiteralPath $root
    # The launcher authenticates its own shutdown request. Never kill a PID found by port number.
    & $runtime.Node $runtime.Launcher --stop
    exit $LASTEXITCODE
} catch {
    Write-Host ('Stop request failed: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'No unrelated process was stopped and no study data was deleted.'
    exit 1
}
