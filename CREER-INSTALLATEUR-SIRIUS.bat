@echo off
chcp 65001 >nul
title SIRIUS - Creation de l'installateur Windows
color 0B

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-installer.ps1" %*
set "SIRIUS_EXIT=%errorlevel%"

if not "%SIRIUS_EXIT%"=="0" (
    echo.
    echo  [ERREUR] La creation de l'installateur a echoue ^(code %SIRIUS_EXIT%^).
    echo  Relisez les messages ci-dessus pour identifier l'etape en echec.
)

echo.
pause
exit /b %SIRIUS_EXIT%
