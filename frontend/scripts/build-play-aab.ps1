# Construit l'AAB signé pour Google Play (fr.sirius_assistant.app).
# Les secrets sont saisis en masqué et ne restent que dans ce processus.
$ErrorActionPreference = "Stop"
$frontend = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $frontend "package.json") -Raw | ConvertFrom-Json).version

Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Choisissez votre clé d'importation Play (.jks ou .keystore)"
$dialog.Filter = "Clé Android (*.jks;*.keystore)|*.jks;*.keystore|Tous les fichiers (*.*)|*.*"
if ($dialog.ShowDialog() -ne "OK") { throw "Aucune clé choisie." }

function Read-Secret($prompt) {
  $secure = Read-Host $prompt -AsSecureString
  [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$env:SIRIUS_ANDROID_KEYSTORE = $dialog.FileName
$env:SIRIUS_ANDROID_STORE_PASSWORD = Read-Secret "Mot de passe du fichier de clé"
$env:SIRIUS_ANDROID_KEY_ALIAS = Read-Host "Alias de la clé (souvent 'upload' ou 'key0')"
$keyPassword = Read-Secret "Mot de passe de la clé (Entrée = identique)"
$env:SIRIUS_ANDROID_KEY_PASSWORD = if ($keyPassword) { $keyPassword } else { $env:SIRIUS_ANDROID_STORE_PASSWORD }
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr" }

try {
  Push-Location $frontend
  npm run mobile:build
  if ($LASTEXITCODE) { throw "Échec de la compilation web mobile." }
  npx cap sync android
  if ($LASTEXITCODE) { throw "Échec de cap sync." }
  Push-Location android
  .\gradlew.bat :app:clean :app:bundleRelease --no-configuration-cache
  if ($LASTEXITCODE) { throw "Échec de la construction de l'AAB." }
  Pop-Location
  $target = Join-Path $frontend "dist\SIRIUS-$version.aab"
  Copy-Item "android\app\build\outputs\bundle\release\app-release.aab" $target -Force
  Write-Host "`nAAB prêt : $target" -ForegroundColor Green
  $keytool = Join-Path $env:JAVA_HOME "bin\keytool.exe"
  $sha1 = & $keytool -list -v -keystore $env:SIRIUS_ANDROID_KEYSTORE -alias $env:SIRIUS_ANDROID_KEY_ALIAS -storepass:env SIRIUS_ANDROID_STORE_PASSWORD 2>$null | Select-String "SHA1:"
  Write-Host "Empreinte de la clé utilisée -> $($sha1.Line.Trim())"
  Write-Host "Elle doit être identique à Play Console > Test et publication > Intégrité de l'appli > Certificat de la clé d'importation (SHA-1)."
  Write-Host "Envoyez-le dans Play Console > ΣIRIUS > Tests internes > Créer une release."
} finally {
  Pop-Location
  Remove-Item Env:SIRIUS_ANDROID_STORE_PASSWORD, Env:SIRIUS_ANDROID_KEY_PASSWORD, Env:SIRIUS_ANDROID_KEY_ALIAS, Env:SIRIUS_ANDROID_KEYSTORE -ErrorAction SilentlyContinue
}
