$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-code-signing.ps1"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Fails([scriptblock]$Operation, [string]$MessagePattern = '') {
    $failed = $false
    try { & $Operation } catch {
        $failed = $true
        if ($MessagePattern) {
            Assert-True ($_.Exception.Message -match $MessagePattern) "Erreur inattendue : $($_.Exception.Message)"
        }
    }
    Assert-True $failed 'Une verification invalide a ete acceptee.'
}

$previousThumbprint = $env:SIRIUS_SIGNING_THUMBPRINT
$previousTool = $env:SIRIUS_SIGNTOOL_PATH
$nativeSignTool = ${function:Invoke-SignTool}
$nativeEmbeddedSigner = ${function:Get-EmbeddedSignerThumbprint}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("sirius-signing-tests-" + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $temporary
$env:SIRIUS_SIGNING_THUMBPRINT = 'A' * 40
$script:signature = [pscustomobject]@{
    Status = 'Valid'
    SignatureType = 'Authenticode'
    SignerCertificate = [pscustomobject]@{ Thumbprint = $env:SIRIUS_SIGNING_THUMBPRINT }
    TimeStamperCertificate = [pscustomobject]@{ Thumbprint = 'B' * 40 }
}
$script:embeddedThumbprint = $env:SIRIUS_SIGNING_THUMBPRINT
$script:toolCalls = @()

function Invoke-SignTool([string[]]$Arguments) { $script:toolCalls += ,$Arguments }
function Get-AuthenticodeSignature { param([string]$LiteralPath) return $script:signature }
function Get-EmbeddedSignerThumbprint([string]$FilePath) { return $script:embeddedThumbprint }

try {
    foreach ($name in @('app.exe', 'package.msi', 'library.dll', 'module.pyd', 'ignore.txt')) {
        [IO.File]::WriteAllText((Join-Path $temporary $name), 'test fixture, not executable')
    }
    $null = New-Item -ItemType Directory -Path (Join-Path $temporary 'backend')
    [IO.File]::WriteAllText((Join-Path $temporary 'backend\worker.exe'), 'fixture')
    Assert-True (@(Get-CodeFiles $temporary).Count -eq 5) 'Le contenu natif imbrique doit etre couvert.'
    $remaining = @(Get-CodeFiles $temporary @('app.exe'))
    Assert-True ($remaining.Count -eq 4 -and -not ($remaining | Where-Object Name -eq 'app.exe')) 'L exe principal exclu ne doit pas etre signe avant resedit.'
    Assert-True (@(Get-CodeFiles $temporary @('backend\worker.exe,library.dll')).Count -eq 3) 'Les exclusions relatives separees par virgule doivent etre respectees.'
    Assert-True (@(Get-CodeFiles (Join-Path $temporary 'app.exe')).Count -eq 1) 'Un fichier unique doit etre accepte.'
    Assert-Fails { Get-CodeFiles (Join-Path $temporary 'ignore.txt') }
    Assert-Fails { Get-CodeFiles (Join-Path $temporary 'missing.exe') }

    $report = Join-Path $temporary 'report.json'
    Invoke-CodeSigning $temporary $true $report
    $sign = @($script:toolCalls | Where-Object { $_[0] -eq 'sign' })
    $verify = @($script:toolCalls | Where-Object { $_[0] -eq 'verify' })
    Assert-True ($sign.Count -eq 5 -and $verify.Count -eq 5) 'Chaque fichier doit etre signe puis verifie.'
    Assert-True (($sign[0] -join ' ') -match '/fd SHA256 /tr https://timestamp.digicert.com /td SHA256') 'SHA256 et RFC3161 obligatoires.'
    Assert-True (($verify[0] -join ' ') -match '/pa /all /tw') 'Verifier toutes les signatures et exiger l horodatage.'
    Assert-True (-not ($sign[0] -contains '/p')) 'Le mot de passe ne doit pas etre passe en ligne de commande.'
    $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    Assert-True ($result.verified_files -eq 5) 'Rapport incomplet.'
    Assert-True (@($result.signatures | Where-Object { $_.file -eq 'backend/worker.exe' }).Count -eq 1) 'Chemins relatifs requis.'

    $script:signature.Status = 'HashMismatch'
    Assert-Fails { Assert-CodeSignature (Join-Path $temporary 'app.exe') }
    $script:signature.Status = 'Valid'
    $script:signature.TimeStamperCertificate = $null
    Assert-Fails { Assert-CodeSignature (Join-Path $temporary 'app.exe') }
    $script:signature.TimeStamperCertificate = [pscustomobject]@{ Thumbprint = 'B' * 40 }
    $script:signature.SignerCertificate.Thumbprint = 'C' * 40
    Assert-Fails { Assert-CodeSignature (Join-Path $temporary 'app.exe') }

    # DLL Microsoft aussi presentes dans le catalogue Windows : seule la signature integree compte.
    $script:signature.SignatureType = 'Catalog'
    $script:signature.TimeStamperCertificate = $null
    Assert-CodeSignature (Join-Path $temporary 'library.dll')
    $script:embeddedThumbprint = 'C' * 40
    Assert-Fails { Assert-CodeSignature (Join-Path $temporary 'library.dll') }
    $script:embeddedThumbprint = $env:SIRIUS_SIGNING_THUMBPRINT
    $script:signature.SignatureType = 'Authenticode'
    Set-Item -Path Function:\Get-EmbeddedSignerThumbprint -Value $nativeEmbeddedSigner
    Assert-Fails { Get-EmbeddedSignerThumbprint (Join-Path $temporary 'app.exe') } 'Aucune signature Authenticode integree'
    $env:SIRIUS_SIGNING_THUMBPRINT = ''
    Assert-Fails { Invoke-CodeSigning $temporary $true '' }
    Set-Item -Path Function:\Invoke-SignTool -Value $nativeSignTool
    $env:SIRIUS_SIGNTOOL_PATH = $env:ComSpec
    Assert-Fails { Invoke-SignTool -Arguments @('/c', 'exit', '1') }
    Assert-Fails { Invoke-SignTool -Arguments @('/c', 'exit', '2') }

    $environmentNames = @('RUNNER_TEMP', 'GITHUB_ENV', 'WINDOWS_CERTIFICATE_PFX_BASE64', 'WINDOWS_CERTIFICATE_PASSWORD', 'WINDOWS_CERTIFICATE_THUMBPRINT')
    $savedEnvironment = @{}
    foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }
    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    $certificate = $null
    try {
        $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
            'CN=SIRIUS untrusted test fixture', $rsa,
            [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $oids = [System.Security.Cryptography.OidCollection]::new()
        $null = $oids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
        $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false))
        $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))
        $env:WINDOWS_CERTIFICATE_PASSWORD = [guid]::NewGuid().ToString()
        $pfxBytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $env:WINDOWS_CERTIFICATE_PASSWORD)
        $env:WINDOWS_CERTIFICATE_PFX_BASE64 = [Convert]::ToBase64String($pfxBytes)
        [Array]::Clear($pfxBytes, 0, $pfxBytes.Length)
        $env:WINDOWS_CERTIFICATE_THUMBPRINT = $certificate.Thumbprint
        $env:RUNNER_TEMP = $temporary
        $env:GITHUB_ENV = Join-Path $temporary 'github-env.txt'
        function Get-WindowsSignTool { return $env:ComSpec }
        Assert-Fails { Initialize-CodeSigning } 'Chaine du certificat non approuvee'
        $state = Get-SigningStateDirectory
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $state 'certificate.pfx'))) 'Le PFX doit etre supprime meme si la chaine est refusee.'
        Assert-True (-not (Test-Path -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)")) 'Un certificat non approuve ne doit pas etre importe.'
        Remove-CodeSigning
        Assert-True (-not (Test-Path -LiteralPath $state)) 'Le dossier temporaire doit etre nettoye.'
    } finally {
        if ($certificate) { $certificate.Dispose() }
        $rsa.Dispose()
        foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
    }
    Write-Host 'Tests PowerShell de signature reussis (sans certificat ni modification du magasin Windows).'
} finally {
    $env:SIRIUS_SIGNING_THUMBPRINT = $previousThumbprint
    $env:SIRIUS_SIGNTOOL_PATH = $previousTool
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
