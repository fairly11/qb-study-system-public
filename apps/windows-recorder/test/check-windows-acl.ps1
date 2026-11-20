param([Parameter(Mandatory = $true)][string] $PackageRoot)
$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).ProviderPath
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
. (Join-Path $PackageRoot 'scripts/Common.ps1')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'RUN_AS_NON_ELEVATED_USER'
}
$testBase = Join-Path ([IO.Path]::GetTempPath()) ('QBRecordAclRegression-' + [Guid]::NewGuid().ToString('N'))
$previousLocalAppData = $env:LOCALAPPDATA
$checks = 0
try {
    [void][IO.Directory]::CreateDirectory($testBase)
    $env:LOCALAPPDATA = $testBase
    $root = Get-QBInstallRoot
    $data = Join-Path $root 'data'
    [void][IO.Directory]::CreateDirectory($data)
    $file = Join-Path $data 'fixture.txt'
    [IO.File]::WriteAllText($file, 'acl regression fixture')
    foreach ($pass in 1..2) {
        Set-QBPrivateTreeAcl $root
        Assert-QBPrivateDataTree $root
        $checks++
        foreach ($item in @((Get-Item -LiteralPath $root)) + @(Get-ChildItem -LiteralPath $root -Recurse -Force)) {
            $acl = Get-Acl -LiteralPath $item.FullName
            if (-not $acl.AreAccessRulesProtected) { throw 'ACL_INHERITANCE_NOT_BLOCKED' }
            if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $identity.User.Value) {
                throw 'ACL_OWNER_CHANGED'
            }
            $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
            $actual = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
            $expected = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544' | Sort-Object -Unique)
            if (($actual -join ',') -cne ($expected -join ',') -or $rules.Count -ne 3) { throw 'ACL_IDENTITIES_CHANGED' }
            foreach ($rule in $rules) {
                if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') {
                    throw 'ACL_RIGHTS_CHANGED'
                }
            }
            $checks++
        }
    }
    # A file created after protection must remain writable and private.
    $newFile = Join-Path $data 'new-fixture.txt'
    [IO.File]::WriteAllText($newFile, 'new private file')
    Assert-QBPrivateDataTree $root
    $checks++
    # The guard must still reject an additional ordinary-user read grant.
    $acl = [IO.File]::GetAccessControl($newFile)
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, 'Read', 'Allow'))
    [IO.File]::SetAccessControl($newFile, $acl)
    $blocked = $false
    try { Assert-QBPrivateDataTree $root } catch {
        if ($_.Exception.Message -cne 'QB_PRIVACY_BLOCKED') { throw }
        $blocked = $true
    }
    if (-not $blocked) { throw 'ACL_BROAD_ACCESS_ACCEPTED' }
    $checks++
    Set-QBPrivateTreeAcl $root
    Assert-QBPrivateDataTree $root
    $checks++
    [PSCustomObject]@{ checks_passed = $checks; windows_acl_tested = $true; elevated = $false } | ConvertTo-Json -Compress
} finally {
    $env:LOCALAPPDATA = $previousLocalAppData
    if (Test-Path -LiteralPath $testBase) { Remove-Item -LiteralPath $testBase -Recurse -Force }
}
