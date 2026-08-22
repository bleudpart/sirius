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
echo   Prerequis : Node.js installe (https://nodejs.org)
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
echo.
echo  [1/3] Installation des dependances (quelques minutes)...
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

echo.
echo  [2/3] Compilation du HUD React...
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
echo  [3/3] Generation de l'installeur Windows (.exe)...
echo.
if "%PM%"=="yarn" (
    call yarn electron:build
) else (
    call npm run electron:build
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
echo     - "SIRIUS Setup 1.0.0.exe"     = installeur classique
echo     - "SIRIUS-portable-1.0.0.exe"  = version portable
echo.
start "" "dist"
pause
