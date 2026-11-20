param([Parameter(Mandatory = $true)][string] $Root)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'Common.ps1')
    Assert-QBPrivateDataTree $Root
    Write-Output 'QB_PRIVACY_OK'
    exit 0
} catch {
    # Do not print an exception, path, ACL contents, configuration or credentials.
    Write-Output 'QB_PRIVACY_BLOCKED'
    exit 1
}
