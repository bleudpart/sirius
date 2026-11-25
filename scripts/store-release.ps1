<#
.SYNOPSIS
  Construit le MSIX Microsoft Store de ΣIRIUS et l'envoie en certification.

.DESCRIPTION
  À lancer après avoir construit et testé la version (npm run electron:build).
  1. Construit et vérifie le MSIX depuis frontend\dist\win-unpacked (scripts\build_store_msix.py).
  2. Sauf avec -NoSubmit, l'envoie au Store avec msstore : la soumission est créée à partir
     de la dernière soumission publiée (fiche et options comprises), puis envoyée en certification.

  msstore doit avoir été configuré une fois avec :
    msstore reconfigure --tenantId <TENANT> --sellerId <SELLER> --clientId <CLIENT> --clientSecret <SECRET>
#>
param(
  [switch]$NoSubmit
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$productId = '9N8X1F9QN3RZ'
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

python (Join-Path $PSScriptRoot 'build_store_msix.py')
if ($LASTEXITCODE -ne 0) { throw 'Construction du MSIX Store impossible.' }

$version = (Get-Content (Join-Path $root 'frontend\package.json') -Raw | ConvertFrom-Json).version
$package = Join-Path $root "frontend\dist\SIRIUS-$version.0-store.msix"
if (-not (Test-Path $package)) { throw "Paquet introuvable : $package" }

if ($NoSubmit) {
  Write-Host "Paquet prêt, non envoyé : $package"
  return
}

if (-not (Get-Command msstore -ErrorAction SilentlyContinue)) {
  throw 'msstore est absent : winget install "Microsoft Store Developer CLI".'
}
msstore info *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'msstore n''est pas configuré : lancer msstore reconfigure (voir docs\windows-code-signing.md).'
}

Write-Host "Envoi de $package au Microsoft Store ($productId)..."
msstore publish $package -id $productId
if ($LASTEXITCODE -ne 0) {
  throw 'Envoi refusé par msstore. Une soumission est peut-être déjà en certification : vérifier Partner Center.'
}
Write-Host "Envoyé en certification. Suivi : msstore submission status $productId"
