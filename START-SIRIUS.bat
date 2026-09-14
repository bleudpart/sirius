@echo off
setlocal
chcp 65001 >nul
title SIRIUS - Demarrage local

cd /d "%~dp0"
set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "VENV=%BACKEND%\.venv"
set "PYTHON=%VENV%\Scripts\python.exe"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Python 3.12 est requis et doit etre accessible dans le PATH.
    pause
    exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Node.js et npm sont requis.
    pause
    exit /b 1
)

if not exist "%PYTHON%" (
    echo [INFO] Creation de backend\.venv...
    python -m venv "%VENV%"
    if errorlevel 1 (
        echo [ERREUR] Creation de l'environnement Python impossible.
        pause
        exit /b 1
    )
)

"%PYTHON%" -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
    echo [INFO] Installation des dependances backend locales...
    "%PYTHON%" -m pip install -r "%BACKEND%\requirements-local.txt"
    if errorlevel 1 (
        echo [ERREUR] Installation des dependances Python impossible.
        pause
        exit /b 1
    )
)

if not exist "%FRONTEND%\node_modules" (
    echo [INFO] Installation des dependances frontend...
    pushd "%FRONTEND%"
    call npm install
    set "NPM_EXIT=%ERRORLEVEL%"
    popd
    if not "%NPM_EXIT%"=="0" (
        echo [ERREUR] Installation des dependances frontend impossible.
        pause
        exit /b 1
    )
)

for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:":8001 .*LISTENING"') do set "BACKEND_PID=%%P"
if defined BACKEND_PID (
    echo [INFO] Backend deja actif sur le port 8001.
) else (
    echo [INFO] Demarrage du backend avec backend\.venv...
    start "SIRIUS Backend" cmd /k "cd /d ""%BACKEND%"" && ""%PYTHON%"" -m uvicorn server:app --host 127.0.0.1 --port 8001 --no-proxy-headers"
)

echo [INFO] Demarrage du frontend...
start "SIRIUS Frontend" cmd /k "cd /d ""%FRONTEND%"" && npm start"

echo.
echo SIRIUS est en cours de demarrage.
echo Backend :  http://127.0.0.1:8001
echo Frontend : http://localhost:3000
echo API docs : http://127.0.0.1:8001/docs
echo.
endlocal
