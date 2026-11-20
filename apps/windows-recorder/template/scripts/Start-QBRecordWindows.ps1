param([switch] $Autostart)
. (Join-Path $PSScriptRoot 'Common.ps1')
try {
    $root = Assert-QBInstalledLocation
    $runtime = Get-QBInstalledRuntime $root
    $conflicts = @(Get-QBPortConflicts)
    if ($conflicts.Count -gt 0) {
        if (-not $Autostart) {
            # The launcher reopens only its own authenticated instance, never an arbitrary local service.
            Set-Location -LiteralPath $root
            & $runtime.Node $runtime.Launcher --open
            exit $LASTEXITCODE
        }
        throw ('Local port(s) already in use: ' + ($conflicts -join ', ') + '. No existing process was stopped. If QBRecordWindows is already running, use its dashboard.')
    }
    Set-Location -LiteralPath $root
    Write-Host 'Starting QBRecordWindows. Keep this window open while studying.'
    Write-Host 'Dashboard: http://127.0.0.1:8766'
    if ($Autostart) { & $runtime.Node $runtime.Launcher --no-browser }
    else { & $runtime.Node $runtime.Launcher }
    exit $LASTEXITCODE
} catch {
    Write-Host ('Start stopped: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
