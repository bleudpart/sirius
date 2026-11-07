[CmdletBinding()]
param(
    [ValidateSet('Prepare', 'Sign', 'Verify', 'Cleanup')]
    [string]$Action = 'Verify',
    [string]$TargetPath,
    [string]$ReportPath,
    [string[]]$Exclude = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-WindowsSignTool {
    $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $tools = @(Get-ChildItem -LiteralPath $sdk -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($tools.Count -eq 0) { throw 'SignTool x64 introuvable : installer le Windows SDK.' }
    return $tools[0]
}

function Get-SigningStateDirectory {
    if (-not $env:RUNNER_TEMP) { throw 'RUNNER_TEMP requis pour Prepare/Cleanup.' }
    return Join-Path $env:RUNNER_TEMP 'sirius-windows-signing'
}

function Initialize-CodeSigning {
    foreach ($name in @('WINDOWS_CERTIFICATE_PFX_BASE64', 'WINDOWS_CERTIFICATE_PASSWORD', 'WINDOWS_CERTIFICATE_THUMBPRINT', 'GITHUB_ENV')) {
        if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Variable requise absente : $name" }
    }
    $thumbprint = ($env:WINDOWS_CERTIFICATE_THUMBPRINT -replace '\s', '').ToUpperInvariant()
    if ($thumbprint -notmatch '^[A-F0-9]{40}$') { throw 'Empreinte attendue invalide.' }
    $tool = Get-WindowsSignTool
    $state = Get-SigningStateDirectory
    if (Test-Path -LiteralPath $state) { throw 'Etat de signature preexistant : nettoyer avant de recommencer.' }
    $null = New-Item -ItemType Directory -Path $state
    $pfx = Join-Path $state 'certificate.pfx'
    $bytes = [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_PFX_BASE64)
    $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
    $certificate = $null
    try {
        [IO.File]::WriteAllBytes($pfx, $bytes)
        $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
            $bytes, $password, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
        if ($certificate.Thumbprint -ne $thumbprint -or -not $certificate.HasPrivateKey) {
            throw 'Le PFX ne contient pas la cle privee du certificat attendu.'
        }
        $now = Get-Date
        if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) { throw 'Certificat pas encore valide ou expire.' }
        $eku = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
        if ($eku.Count -ne 1 -or '1.3.6.1.5.5.7.3.3' -notin @($eku[0].EnhancedKeyUsages | ForEach-Object { $_.Value })) {
            throw 'Le certificat doit autoriser explicitement Code Signing.'
        }
        $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
        try {
            $chain.ChainPolicy.RevocationMode = 'Online'
            if (-not $chain.Build($certificate)) { throw 'Chaine du certificat non approuvee ou revoquee.' }
        } finally { $chain.Dispose() }
        $publisher = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        if (-not $publisher -or $publisher -match '[\r\n]') { throw 'Nom public de l editeur invalide.' }
        $storePath = "Cert:\CurrentUser\My\$thumbprint"
        if (Test-Path -LiteralPath $storePath) { throw 'Ce certificat existe deja : ne pas utiliser Prepare sur votre magasin personnel.' }
        [IO.File]::WriteAllText((Join-Path $state 'thumbprint.txt'), $thumbprint)
        $imported = @(Import-PfxCertificate -FilePath $pfx -Password $password -CertStoreLocation 'Cert:\CurrentUser\My')
        if (-not ($imported | Where-Object { $_.Thumbprint -eq $thumbprint -and $_.HasPrivateKey })) {
            throw 'Import de la cle privee echoue.'
        }
        @(
            "SIRIUS_SIGNTOOL_PATH=$tool"
            "SIRIUS_SIGNING_THUMBPRINT=$thumbprint"
            "SIRIUS_SIGNING_PUBLISHER=$publisher"
        ) | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
        Write-Host 'Certificat importe ; cle non exportable ; SignTool Windows SDK configure.'
    } finally {
        if ($certificate) { $certificate.Dispose() }
        $password.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
        if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
    }
}

function Remove-CodeSigning {
    $state = Get-SigningStateDirectory
    $marker = Join-Path $state 'thumbprint.txt'
    if (Test-Path -LiteralPath $marker) {
        $thumbprint = [IO.File]::ReadAllText($marker)
        if ($thumbprint -notmatch '^[A-F0-9]{40}$') { throw 'Etat de nettoyage invalide.' }
        $certificatePath = "Cert:\CurrentUser\My\$thumbprint"
        if (Test-Path -LiteralPath $certificatePath) { Remove-Item -LiteralPath $certificatePath -DeleteKey -Force }
        Remove-Item -LiteralPath $marker -Force
    }
    $pfx = Join-Path $state 'certificate.pfx'
    if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
    if (Test-Path -LiteralPath $state) { Remove-Item -LiteralPath $state -Force }
}

function Get-CodeFiles([string]$Target, [string[]]$ExcludedNames = @()) {
    if (-not $Target) { throw 'TargetPath requis.' }
    $item = Get-Item -LiteralPath $Target
    $extensions = @('.exe', '.msi', '.dll', '.pyd')
    $excluded = @($ExcludedNames | ForEach-Object { $_ -split ',' } | Where-Object { $_ } |
        ForEach-Object { (Join-Path $item.FullName $_.Trim()).ToLowerInvariant() })
    $files = @(if ($item.PSIsContainer) {
        Get-ChildItem -LiteralPath $item.FullName -Recurse -File |
            Where-Object { $_.Extension.ToLowerInvariant() -in $extensions -and $_.FullName.ToLowerInvariant() -notin $excluded } |
            Sort-Object FullName
    } else { $item | Where-Object { $_.Extension.ToLowerInvariant() -in $extensions } })
    if ($files.Count -eq 0) { throw "Aucun executable Windows a traiter : $Target" }
    return $files
}

function Invoke-SignTool([string[]]$Arguments) {
    if (-not $env:SIRIUS_SIGNTOOL_PATH) { $env:SIRIUS_SIGNTOOL_PATH = Get-WindowsSignTool }
    if (-not (Test-Path -LiteralPath $env:SIRIUS_SIGNTOOL_PATH -PathType Leaf)) {
        throw 'SIRIUS_SIGNTOOL_PATH doit designer SignTool du Windows SDK.'
    }
    & $env:SIRIUS_SIGNTOOL_PATH @Arguments
    if ($LASTEXITCODE -ne 0) { throw "SignTool a echoue (code $LASTEXITCODE)." }
}

function Get-EmbeddedSignerThumbprint([string]$FilePath) {
    # Ignores Windows catalogs: redistributed Microsoft DLLs may also be catalog-signed.
    try { $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($FilePath) }
    catch { throw "Aucune signature Authenticode integree : $FilePath" }
    $certificate2 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certificate)
    try { return $certificate2.Thumbprint } finally { $certificate2.Dispose(); $certificate.Dispose() }
}

function Assert-CodeSignature([string]$FilePath) {
    if ($env:SIRIUS_SIGNING_THUMBPRINT -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Empreinte de signature absente ou invalide.' }
    # Without /a, SignTool checks only embedded signatures (trust chain and RFC3161 timestamp).
    Invoke-SignTool -Arguments @('verify', '/pa', '/all', '/tw', $FilePath) | Out-Host
    $expected = $env:SIRIUS_SIGNING_THUMBPRINT.ToUpperInvariant()
    $signature = Get-AuthenticodeSignature -LiteralPath $FilePath
    $valid = $signature.Status -eq 'Valid' -and (Get-EmbeddedSignerThumbprint $FilePath) -eq $expected
    if ($signature.SignatureType -ne 'Catalog') {
        $valid = $valid -and $signature.SignerCertificate -and
            $signature.SignerCertificate.Thumbprint -eq $expected -and $signature.TimeStamperCertificate
    }
    if (-not $valid) {
        throw "Signature invalide, mauvais editeur ou horodatage absent : $FilePath"
    }
}

function Invoke-CodeSigning([string]$Target, [bool]$Sign, [string]$Report, [string[]]$ExcludedNames = @()) {
    if ($env:SIRIUS_SIGNING_THUMBPRINT -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Empreinte de signature absente ou invalide.' }
    $files = @(Get-CodeFiles $Target $ExcludedNames)
    $root = Get-Item -LiteralPath $Target
    $records = @()
    foreach ($file in $files) {
        if ($Sign) {
            Invoke-SignTool -Arguments @('sign', '/s', 'My', '/sha1', $env:SIRIUS_SIGNING_THUMBPRINT,
                '/fd', 'SHA256', '/tr', 'https://timestamp.digicert.com', '/td', 'SHA256', '/d', 'SIRIUS', $file.FullName) | Out-Host
        }
        Assert-CodeSignature $file.FullName
        if ($Report) {
            $relative = if ($root.PSIsContainer) { $file.FullName.Substring($root.FullName.TrimEnd('\').Length + 1) } else { $file.Name }
            $records += [ordered]@{
                file = $relative.Replace('\', '/')
                status = 'Valid'
                timestamp = $true
                thumbprint = $env:SIRIUS_SIGNING_THUMBPRINT
                sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    }
    if ($Report) {
        [ordered]@{ verified_files = $files.Count; signatures = $records } |
            ConvertTo-Json -Depth 5 | Out-File -LiteralPath $Report -Encoding utf8
    }
    Write-Host "$($files.Count) signatures et horodatages verifies."
}

if ($MyInvocation.InvocationName -ne '.') {
    switch ($Action) {
        'Prepare' { Initialize-CodeSigning }
        'Cleanup' { Remove-CodeSigning }
        'Sign' { Invoke-CodeSigning $TargetPath $true $ReportPath $Exclude }
        'Verify' { Invoke-CodeSigning $TargetPath $false $ReportPath }
    }
}
