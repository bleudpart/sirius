@echo off
setlocal
chcp 65001 >nul
title SIRIUS - Test mobile temporaire

cd /d "%~dp0"

where cloudflared >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] cloudflared n'est pas installe.
    echo.
    echo Installez-le depuis :
    echo https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
    echo.
    where winget >nul 2>nul
    if not errorlevel 1 (
        echo Installation rapide possible :
        echo winget install --id Cloudflare.cloudflared
    )
    echo.
    echo Puis relancez ce fichier.
    pause
    exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Python est requis pour le backend.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Node.js et npm sont requis pour le frontend.
    pause
    exit /b 1
)

echo Demarrage du backend SIRIUS sur le port 8001...
start "SIRIUS Backend" cmd /k "cd /d ""%~dp0backend"" && python -m uvicorn server:app --host 127.0.0.1 --port 8001 --no-proxy-headers"

echo Demarrage du frontend SIRIUS sur le port 3000...
start "SIRIUS Frontend" cmd /k "cd /d ""%~dp0frontend"" && npm start"

echo.
echo Verification du backend...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 24;$i++){try{$r=Invoke-WebRequest -Uri 'http://127.0.0.1:8001/docs' -UseBasicParsing -TimeoutSec 5; if($r.StatusCode -ge 200){$ok=$true; break}}catch{Start-Sleep -Seconds 5}}; if(-not $ok){exit 1}"
if errorlevel 1 (
    echo [ERREUR] Backend indisponible sur http://127.0.0.1:8001
    pause
    exit /b 1
)

echo Verification du frontend...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 36;$i++){try{$r=Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 5; if($r.StatusCode -ge 200){$ok=$true; break}}catch{Start-Sleep -Seconds 5}}; if(-not $ok){exit 1}"
if errorlevel 1 (
    echo [ERREUR] Frontend indisponible sur http://127.0.0.1:3000
    pause
    exit /b 1
)

echo.
echo L'URL HTTPS de test va apparaitre ci-dessous.
echo Partagez uniquement cette URL avec vos testeurs.
echo Appuyez sur Ctrl+C pour fermer le tunnel.
echo.
cloudflared tunnel --url http://127.0.0.1:3000

endlocal
