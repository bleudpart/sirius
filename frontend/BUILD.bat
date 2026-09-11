@echo off
chcp 65001 >nul
title SIRIUS - Compilation Windows
color 0B

echo.
echo  ============================================================
echo            S . I . R . I . U . S   -   BUILD WINDOWS
echo  ============================================================
echo.
echo   Ce script compile SIRIUS en application Windows (.exe).
echo   Prerequis : Node.js et Python 3.12 installes.
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
    exit /b
)

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERREUR] Node.js n'est pas installe.
    echo  Telechargez la version LTS : https://nodejs.org
    echo.
    pause
    exit /b
)

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERREUR] Python n'est pas installe.
    echo  Telechargez Python 3.12 : https://www.python.org/downloads/
    echo.
    pause
    exit /b
)

set "PM="
where yarn >nul 2>nul && set "PM=yarn"

if not defined PM (
    echo  Yarn non detecte. Tentative via Corepack...
    call corepack enable >nul 2>nul
    call corepack prepare yarn@1.22.22 --activate >nul 2>nul
    where yarn >nul 2>nul && set "PM=yarn"
)

if not defined PM (
    echo  Tentative via npm...
    call npm install -g yarn >nul 2>nul
    where yarn >nul 2>nul && set "PM=yarn"
)

if not defined PM (
    set "PM=npm"
    echo  Yarn indisponible : utilisation de npm.
)

echo  Gestionnaire utilise : %PM%
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "SIRIUS_VERSION=%%v"
echo.
echo  [1/4] Installation des dependances (quelques minutes)...
echo.
if "%PM%"=="yarn" (
    call yarn install
) else (
    call npm ci
)
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Installation des dependances echouee.
    pause
    exit /b
)

call python -m pip install -r "..\backend\requirements.txt" -r "..\backend\requirements-build.txt"
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Installation des dependances Python echouee.
    pause
    exit /b
)

echo.
echo  [2/4] Compilation du HUD React...
echo.
if "%PM%"=="yarn" (
    call yarn build
) else (
    call npm run build
)
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Compilation React echouee.
    pause
    exit /b
)

echo.
echo  [3/4] Compilation du backend autonome...
echo.
if "%PM%"=="yarn" (
    call yarn backend:build
) else (
    call npm run backend:build
)
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Compilation du backend echouee.
    pause
    exit /b
)

echo.
echo  [4/4] Generation de l'installeur Windows (.exe)...
echo.
if "%PM%"=="yarn" (
    call yarn electron-builder --win nsis portable
) else (
    call npx electron-builder --win nsis portable
)
if %errorlevel% neq 0 (
    echo.
    echo  [ERREUR] Generation de l'executable echouee.
    pause
    exit /b
)

echo.
echo  ============================================================
echo                       TERMINE !
echo  ============================================================
echo.
echo   Votre application est dans le dossier : dist\
echo     - "SIRIUS Setup %SIRIUS_VERSION%.exe"     = installeur classique
echo     - "SIRIUS-portable-%SIRIUS_VERSION%.exe"  = version portable
echo.
start "" "dist"
pause
