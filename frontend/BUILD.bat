@echo off
setlocal
chcp 65001 >nul
title SIRIUS - Compilation Windows
color 0B

echo.
echo  ============================================================
echo            S . I . R . I . U . S   -   BUILD WINDOWS
echo  ============================================================
echo.
echo   Ce script compile SIRIUS en application Windows (.exe).
echo   Prerequis : Node.js 22+ et Python 3.12 deja installes.
echo   Astuce : CREER-INSTALLATEUR-SIRIUS.bat (racine du projet) installe
echo   automatiquement Node.js et Python s'ils manquent.
echo.
echo  ------------------------------------------------------------
echo.

cd /d "%~dp0"

if not exist "package.json" (
    echo  [ERREUR] Fichiers du projet introuvables.
    echo.
    echo  Vous avez sans doute lance BUILD.bat depuis l'interieur du ZIP.
    echo  Extrayez d'abord TOUT le ZIP dans un dossier, ouvrez ce dossier,
    echo  puis relancez BUILD.bat depuis la.
    echo.
    pause
    exit /b 1
)

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERREUR] Node.js n'est pas installe.
    echo  Telechargez la version LTS : https://nodejs.org
    echo.
    pause
    exit /b 1
)

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERREUR] Python n'est pas installe.
    echo  Telechargez Python 3.12 : https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

rem Conserver le manifeste neutre pour les mises a jour du verrou npm.
set "COREPACK_ENABLE_AUTO_PIN=0"
set "YARN_CMD="
set "YARN_VERSION="
for /f "delims=" %%v in ('yarn --version 2^>nul') do set "YARN_VERSION=%%v"
if "%YARN_VERSION%"=="1.22.22" set "YARN_CMD=yarn"

if not defined YARN_CMD (
    echo  Yarn 1.22.22 non detecte. Tentative via npm...
    call npx --yes yarn@1.22.22 --version >nul 2>nul
    if not errorlevel 1 set "YARN_CMD=npx --yes yarn@1.22.22"
)

if defined YARN_CMD (
    echo  Gestionnaire utilise : Yarn 1.22.22
) else (
    echo  Yarn indisponible : utilisation de npm et du verrou package-lock.json.
)

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "SIRIUS_VERSION=%%v"
echo.
echo  [1/4] Installation des dependances (quelques minutes)...
echo.
if defined YARN_CMD (
    call %YARN_CMD% install
) else (
    call npm ci --legacy-peer-deps
)
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Installation des dependances echouee.
    pause
    exit /b 1
)

call python -m pip install -r "..\backend\requirements.txt" -r "..\backend\requirements-build.txt"
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Installation des dependances Python echouee.
    pause
    exit /b 1
)

rem Le backend embarque son propre Chromium (agent web) : le build s'arrete s'il manque.
call python -m playwright install chromium
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Installation de Chromium ^(agent web^) echouee.
    pause
    exit /b 1
)

echo.
echo  [2/4] Compilation du HUD React...
echo.
if defined YARN_CMD (
    call %YARN_CMD% build
) else (
    call npm run build
)
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Compilation React echouee.
    pause
    exit /b 1
)

echo.
echo  [3/4] Compilation du backend autonome...
echo.
if defined YARN_CMD (
    call %YARN_CMD% backend:build
) else (
    call npm run backend:build
)
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Compilation du backend echouee.
    pause
    exit /b 1
)

echo.
echo  Verification du frontend embarque...
echo.
call python "..\scripts\verify_packaged_frontend.py"
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Le paquet backend embarque est perime ou incomplet ^(frontend ou Chromium, voir ci-dessus^).
    echo  Le paquet est refuse pour eviter de distribuer un installeur defectueux.
    pause
    exit /b 1
)

echo.
echo  [4/4] Generation de l'installeur Windows (.exe)...
echo.
if defined YARN_CMD (
    call %YARN_CMD% electron-builder --win nsis portable
) else (
    call npx electron-builder --win nsis portable
)
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Generation de l'executable echouee.
    pause
    exit /b 1
)

echo.
echo  ============================================================
echo                       TERMINE !
echo  ============================================================
echo.
echo   Votre application est dans le dossier : dist\
echo     - "ΣIRIUS-Windows-%SIRIUS_VERSION%.exe"   = installeur Windows a distribuer
echo     - "ΣIRIUS-Portable-%SIRIUS_VERSION%.exe"  = version portable
echo.
start "" "dist"
pause
