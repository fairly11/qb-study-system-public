. (Join-Path $PSScriptRoot 'Common.ps1')
try {
    $root = Assert-QBInstalledLocation
    [void] (Get-QBInstalledRuntime $root)
    $spec = Get-QBAutostartSpec $root
    $shell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $spec.Path) {
        $existing = $shell.CreateShortcut($spec.Path)
        if (-not (Test-QBOwnShortcut $existing $spec)) { throw 'A different Startup shortcut has the same name. It was not changed.' }
        Write-Host 'QBStudyFriend login startup is already enabled.'
        exit 0
    }
    Write-Host 'Enable QBStudyFriend at login for this Windows user?'
    Write-Host 'It runs locally in a minimized window. The dashboard will not open automatically.'
    Write-Host 'You can undo this with autostart-off.cmd; your study history will remain.'
    $answer = Read-Host 'Type YES to enable, or press Enter to leave it disabled'
    if ($answer -cne 'YES') { Write-Host 'No changes made. Login startup remains disabled.'; exit 0 }
    if (Test-Path -LiteralPath $spec.Path) { throw 'A Startup shortcut appeared during confirmation. It was not changed.' }
    $shortcut = $shell.CreateShortcut($spec.Path)
    $shortcut.TargetPath = $spec.Target
    $shortcut.Arguments = $spec.Arguments
    $shortcut.WorkingDirectory = $spec.WorkingDirectory
    $shortcut.Description = $spec.Description
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    $verified = $shell.CreateShortcut($spec.Path)
    if (-not (Test-QBOwnShortcut $verified $spec)) { throw 'The saved Startup shortcut could not be verified.' }
    Write-Host 'Login startup enabled for this Windows user. No administrator rights were used.'
    exit 0
} catch {
    Write-Host ('Startup registration stopped: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
