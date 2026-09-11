@echo off
setlocal
chcp 65001 >nul
title SIRIUS - Release automatique GitHub

cd /d "%~dp0frontend"

if not exist "package.json" (
    echo [ERREUR] Lancez ce fichier depuis le projet SIRIUS complet.
    pause
    exit /b 1
)

if "%GH_TOKEN%"=="" (
    echo [ERREUR] GH_TOKEN est requis pour publier sur GitHub Releases.
    echo Exemple :
    echo set GH_TOKEN=ghp_votre_token
    echo RELEASE-SIRIUS-AUTO.bat
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Node.js/npm est requis.
    pause
    exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Python est requis pour compiler le backend.
    pause
    exit /b 1
)

echo [1/4] Incrementation automatique du numero de version...
call npm run version:bump
if errorlevel 1 goto fail

echo.
echo [2/4] Build du HUD React...
call npm run build
if errorlevel 1 goto fail

echo.
echo [3/4] Build du backend autonome...
call npm run backend:build
if errorlevel 1 goto fail

echo.
echo [4/4] Publication GitHub Releases...
call npx electron-builder --win nsis portable --publish always
if errorlevel 1 goto fail

echo.
echo Release publiee. Les applications installees verifieront GitHub au demarrage puis toutes les 4 h.
echo Quand la mise a jour est telechargee, SIRIUS propose un redemarrage automatique.
pause
exit /b 0

:fail
echo.
echo [ERREUR] Release interrompue.
pause
exit /b 1
