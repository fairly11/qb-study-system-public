. (Join-Path $PSScriptRoot 'Common.ps1')
try {
    $root = Assert-QBInstalledLocation
    $spec = Get-QBAutostartSpec $root
    if (-not (Test-Path -LiteralPath $spec.Path)) { Write-Host 'Login startup is already disabled. Study history is unchanged.'; exit 0 }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($spec.Path)
    if (-not (Test-QBOwnShortcut $shortcut $spec)) { throw 'A different Startup shortcut has the same name. It was not removed.' }
    Remove-Item -LiteralPath $spec.Path
    Write-Host 'Login startup disabled. Programs, settings and study history are unchanged.'
    Write-Host 'A currently running instance continues until you run stop.cmd.'
    exit 0
} catch {
    Write-Host ('Startup removal stopped: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
