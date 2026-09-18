@echo off
setlocal

set "ROOT=%~dp0"
set "SIRIUS_EXE="

for %%P in (
  "%LOCALAPPDATA%\Programs\SIRIUS\SIRIUS.exe"
  "%LOCALAPPDATA%\SIRIUS\SIRIUS.exe"
  "%ProgramFiles%\SIRIUS\SIRIUS.exe"
  "%ProgramFiles(x86)%\SIRIUS\SIRIUS.exe"
  "%ROOT%frontend\dist\win-unpacked\SIRIUS.exe"
  "%ROOT%SIRIUS.exe"
) do (
  if not defined SIRIUS_EXE if exist "%%~P" set "SIRIUS_EXE=%%~P"
)

if not defined SIRIUS_EXE (
  for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$keys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'; Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'SIRIUS' -and $_.InstallLocation } | Select-Object -First 1 -ExpandProperty InstallLocation"`) do (
    if exist "%%~P\SIRIUS.exe" set "SIRIUS_EXE=%%~P\SIRIUS.exe"
  )
)

if defined SIRIUS_EXE (
  start "" "%SIRIUS_EXE%"
  exit /b 0
)

echo SIRIUS n'est pas installe sur cet ordinateur.
echo Lancez ΣIRIUS-Windows-*.exe ou utilisez ΣIRIUS-Portable-*.exe.
pause
exit /b 1
