param(
    [string]$HostUrl = $env:SONAR_HOST_URL,
    [string]$Token = $env:SONAR_TOKEN,
    [switch]$SkipBuildChecks
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

if (-not $HostUrl) {
    throw "SONAR_HOST_URL est requis. Exemple: `$env:SONAR_HOST_URL='http://localhost:9000'"
}
if (-not $Token) {
    throw "SONAR_TOKEN est requis. Ne le stocke pas dans le dépôt; définis-le dans la session PowerShell."
}

$scanner = Get-Command sonar-scanner -ErrorAction SilentlyContinue
if (-not $scanner) {
    $scanner = Get-Command sonar-scanner.bat -ErrorAction SilentlyContinue
}
if (-not $scanner) {
    throw "SonarScanner CLI introuvable dans le PATH. Installe SonarScanner ou ajoute son dossier bin au PATH."
}

Write-Host "== Git diff check =="
git diff --check

if (-not $SkipBuildChecks) {
    Write-Host "== Python compile =="
    python -m py_compile backend/server.py backend/sirius_brain.py backend/version_info.py

    Write-Host "== Frontend build =="
    npm --prefix frontend run build
}

Write-Host "== SonarQube scan =="
& $scanner.Source "-Dsonar.host.url=$HostUrl" "-Dsonar.token=$Token"
