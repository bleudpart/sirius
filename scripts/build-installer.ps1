[CmdletBinding()]
param(
    # Publie la release sur GitHub au lieu de seulement generer les fichiers locaux.
    [switch]$Publish,
    # Ne tente aucune installation automatique de Node.js / Python.
    [switch]$SkipPrerequisites
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $repoRoot 'frontend'
$backendDir = Join-Path $repoRoot 'backend'
$venvDir = Join-Path $backendDir '.venv-build'

$requiredNodeMajor = 20
$pythonWingetId = 'Python.Python.3.12'
$nodeWingetId = 'OpenJS.NodeJS.20'

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor Gray
}

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = $repoRoot,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    Write-Info "$FilePath $($Arguments -join ' ')"
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -NoNewWindow -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "$FailureMessage (code $($process.ExitCode))"
    }
}

# Les installeurs winget modifient le PATH de la session parente uniquement :
# on le recharge depuis le registre pour utiliser node/python sans rouvrir un terminal.
function Update-SessionPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ';'
}

function Test-Winget {
    return [bool](Get-Command winget -ErrorAction SilentlyContinue)
}

function Install-WithWinget {
    param(
        [Parameter(Mandatory = $true)][string]$PackageId,
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [Parameter(Mandatory = $true)][string]$ManualUrl
    )

    if ($SkipPrerequisites) {
        throw "$DisplayName est absent et -SkipPrerequisites a ete demande. Installez-le depuis $ManualUrl"
    }
    if (-not (Test-Winget)) {
        throw "$DisplayName est absent et winget n'est pas disponible sur ce PC. Installez-le manuellement depuis $ManualUrl puis relancez ce script."
    }

    Write-Info "Installation automatique de $DisplayName via winget (quelques minutes)..."
    $arguments = @(
        'install', '--id', $PackageId, '--exact',
        '--silent', '--accept-package-agreements', '--accept-source-agreements'
    )
    $process = Start-Process -FilePath 'winget' -ArgumentList $arguments -NoNewWindow -Wait -PassThru
    # 0 = installe, -1978335189 (0x8A15002B) = deja installe / rien a faire.
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne -1978335189) {
        throw "Installation automatique de $DisplayName echouee (code $($process.ExitCode)). Installez-le depuis $ManualUrl"
    }
    Update-SessionPath
}

function Get-NodeMajorVersion {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return 0 }
    try {
        $version = (& node --version) -replace '^v', ''
        return [int]($version.Split('.')[0])
    } catch {
        return 0
    }
}

function Resolve-BuildPython {
    # PyInstaller et les dependances du backend sont valides sur Python 3.10 -> 3.12.
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $candidates += , @('py', @('-3.12'))
        $candidates += , @('py', @('-3.11'))
        $candidates += , @('py', @('-3.10'))
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        $candidates += , @('python', @())
    }

    foreach ($candidate in $candidates) {
        $exe = $candidate[0]
        $prefix = $candidate[1]
        try {
            $raw = & $exe @prefix -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        } catch {
            continue
        }
        if ($LASTEXITCODE -ne 0 -or -not $raw) { continue }
        $parts = "$raw".Trim().Split('.')
        $major = [int]$parts[0]
        $minor = [int]$parts[1]
        if ($major -eq 3 -and $minor -ge 10 -and $minor -le 12) {
            return [pscustomobject]@{ Exe = $exe; Prefix = $prefix; Version = "$major.$minor" }
        }
    }
    return $null
}

Write-Host ''
Write-Host ' ============================================================' -ForegroundColor DarkCyan
Write-Host '        S . I . R . I . U . S   -   INSTALLATEUR WINDOWS' -ForegroundColor White
Write-Host ' ============================================================' -ForegroundColor DarkCyan
Write-Info 'Ce script prepare tout (Node.js, Python, dependances) puis genere'
Write-Info "l'installeur .exe autonome a distribuer aux utilisateurs."

if (-not (Test-Path (Join-Path $frontendDir 'package.json'))) {
    throw "Projet SIRIUS introuvable : lancez ce script depuis le depot complet (dossier contenant frontend\ et backend\)."
}

Write-Step '1/6 - Verification de Node.js'
if ((Get-NodeMajorVersion) -lt $requiredNodeMajor) {
    Install-WithWinget -PackageId $nodeWingetId -DisplayName "Node.js LTS" -ManualUrl 'https://nodejs.org'
}
$nodeMajor = Get-NodeMajorVersion
if ($nodeMajor -lt $requiredNodeMajor) {
    throw "Node.js $requiredNodeMajor+ est requis (detecte : $nodeMajor). Fermez puis rouvrez la fenetre et relancez le script."
}
Write-Info "Node.js v$((& node --version) -replace '^v', '') detecte."

Write-Step '2/6 - Verification de Python 3.10 a 3.12'
$python = Resolve-BuildPython
if (-not $python) {
    Install-WithWinget -PackageId $pythonWingetId -DisplayName 'Python 3.12' -ManualUrl 'https://www.python.org/downloads/'
    $python = Resolve-BuildPython
}
if (-not $python) {
    throw "Python 3.10 a 3.12 est requis pour compiler le backend. Fermez puis rouvrez la fenetre et relancez le script."
}
Write-Info "Python $($python.Version) detecte."

Write-Step '3/6 - Environnement Python isole et dependances backend'
if (-not (Test-Path (Join-Path $venvDir 'Scripts\python.exe'))) {
    Write-Info "Creation de l'environnement virtuel $venvDir"
    $pythonPrefix = $python.Prefix
    & $python.Exe @pythonPrefix -m venv $venvDir
    if ($LASTEXITCODE -ne 0) {
        throw "Creation de l'environnement virtuel Python echouee."
    }
}
$venvPython = Join-Path $venvDir 'Scripts\python.exe'
$venvScripts = Join-Path $venvDir 'Scripts'

Invoke-Step -FilePath $venvPython -Arguments @('-m', 'pip', 'install', '--upgrade', 'pip') `
    -FailureMessage 'Mise a jour de pip echouee.'
Invoke-Step -FilePath $venvPython -Arguments @(
    '-m', 'pip', 'install',
    '-r', (Join-Path $backendDir 'requirements.txt'),
    '-r', (Join-Path $backendDir 'requirements-build.txt')
) -FailureMessage 'Installation des dependances Python echouee.'

# PyInstaller est appele via `python -m PyInstaller` par le script npm : on place le venv
# en tete du PATH pour que ce soit celui du venv, jamais un Python systeme incomplet.
$env:Path = "$venvScripts;$env:Path"
$env:VIRTUAL_ENV = $venvDir

Write-Step '4/6 - Dependances et compilation du HUD React'
$npmCli = Join-Path (Split-Path (Get-Command node).Source) 'npm.cmd'
if (-not (Test-Path $npmCli)) { $npmCli = 'npm.cmd' }

$installArgs = @('install', '--legacy-peer-deps')
Invoke-Step -FilePath $npmCli -Arguments $installArgs -WorkingDirectory $frontendDir `
    -FailureMessage 'Installation des dependances Node echouee.'
Invoke-Step -FilePath $npmCli -Arguments @('run', 'build') -WorkingDirectory $frontendDir `
    -FailureMessage 'Compilation du HUD React echouee.'

Write-Step '5/6 - Compilation du backend autonome (sans Python chez l utilisateur)'
Invoke-Step -FilePath $npmCli -Arguments @('run', 'backend:build') -WorkingDirectory $frontendDir `
    -FailureMessage 'Compilation du backend echouee.'

Write-Step '6/6 - Generation de l installeur Windows'
$sourceBundles = Get-ChildItem -Path (Join-Path $frontendDir 'build\static\js') -Filter 'main.*.js' -File |
    Where-Object { $_.Name -notlike '*.map' }
$embeddedBundles = Get-ChildItem -Path (Join-Path $backendDir 'dist\sirius-backend\_internal\frontend\build\static\js') -Filter 'main.*.js' -File |
    Where-Object { $_.Name -notlike '*.map' }
if ($sourceBundles.Count -ne 1 -or $embeddedBundles.Count -ne 1) {
    throw 'Verification du bundle impossible : un unique main.*.js est requis dans le frontend et le backend embarque.'
}
$sourceHash = (Get-FileHash -LiteralPath $sourceBundles[0].FullName -Algorithm SHA256).Hash
$embeddedHash = (Get-FileHash -LiteralPath $embeddedBundles[0].FullName -Algorithm SHA256).Hash
if ($sourceBundles[0].Name -ne $embeddedBundles[0].Name -or $sourceHash -ne $embeddedHash) {
    throw "Le HUD embarque ne correspond pas au build courant : $($sourceBundles[0].Name) / $($embeddedBundles[0].Name)."
}
Write-Info "HUD embarque verifie : $($sourceBundles[0].Name) ($sourceHash)"
$builderArgs = @('exec', '--', 'electron-builder', '--win', 'nsis', 'portable')
if ($Publish) {
    if (-not $env:GH_TOKEN) {
        throw "GH_TOKEN est requis pour publier la release GitHub. Definissez-le puis relancez avec -Publish."
    }
    $builderArgs += @('--publish', 'always')
}
Invoke-Step -FilePath $npmCli -Arguments $builderArgs -WorkingDirectory $frontendDir `
    -FailureMessage "Generation de l'installeur echouee."

$distDir = Join-Path $frontendDir 'dist'
$version = (Get-Content (Join-Path $frontendDir 'package.json') -Raw | ConvertFrom-Json).version

Write-Host ''
Write-Host ' ============================================================' -ForegroundColor Green
Write-Host '                        TERMINE' -ForegroundColor Green
Write-Host ' ============================================================' -ForegroundColor Green
Write-Host ''
Write-Info "Version generee : $version"
Write-Info "Dossier : $distDir"
Get-ChildItem -Path $distDir -Filter '*.exe' -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "      - $($_.Name)" -ForegroundColor White }
Write-Host ''
Write-Info "Distribuez ΣIRIUS-Windows-$version.exe : il contient le HUD et le backend."
Write-Info "L'utilisateur final n'a besoin ni de Python, ni de Node.js, ni de MongoDB."

if (Test-Path $distDir) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $distDir | Out-Null
}
