@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if /i "%~1"=="play" call :check_signing
if errorlevel 1 exit /b 1
if /i "%~1"=="release" call :check_signing
if errorlevel 1 exit /b 1

echo Recherche du JDK Android Studio...
if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" (
    set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
) else if exist "%LOCALAPPDATA%\Programs\Android Studio\jbr\bin\java.exe" (
    set "JAVA_HOME=%LOCALAPPDATA%\Programs\Android Studio\jbr"
) else if not exist "%JAVA_HOME%\bin\java.exe" (
    echo [ERREUR] JDK introuvable.
    echo Ouvrez Android Studio et installez son Android SDK/JDK.
    pause
    exit /b 1
)

set "PATH=%JAVA_HOME%\bin;%PATH%"
echo JDK utilise : %JAVA_HOME%
java -version
if errorlevel 1 exit /b 1

echo.
echo [1/2] Compilation et synchronisation Capacitor...
call npm run mobile:sync
if errorlevel 1 (
    echo [ERREUR] La compilation React ou la synchronisation Android a echoue.
    pause
    exit /b 1
)

echo.
if /i "%~1"=="play" (
    echo [2/2] Generation de l'Android App Bundle signe pour Google Play...
    pushd android
    call gradlew.bat bundleRelease
    if errorlevel 1 (
        popd
        echo [ERREUR] Gradle n'a pas pu generer le bundle signe.
        exit /b 1
    )
    popd
    set "APK_PATH=android\app\build\outputs\bundle\release\app-release.aab"
) else if /i "%~1"=="release" (
    echo [2/2] Generation de l'APK release...
    pushd android
    call gradlew.bat assembleRelease
    if errorlevel 1 (
        popd
        echo [ERREUR] Gradle n'a pas pu generer l'APK signe.
        exit /b 1
    )
    popd
    set "APK_PATH=android\app\build\outputs\apk\release\app-release.apk"
) else (
    echo [2/2] Generation de l'APK debug...
    pushd android
    call gradlew.bat assembleDebug
    if errorlevel 1 (
        popd
        echo [ERREUR] Gradle n'a pas pu generer l'APK debug.
        exit /b 1
    )
    popd
    set "APK_PATH=android\app\build\outputs\apk\debug\app-debug.apk"
)
if not exist "%APK_PATH%" (
    echo [ERREUR] Le fichier Android attendu est introuvable.
    exit /b 1
)

echo.
echo Fichier Android genere : %CD%\%APK_PATH%
start "" "%CD%\%APK_PATH%"
endlocal
exit /b 0

:check_signing
for %%V in (SIRIUS_ANDROID_KEYSTORE SIRIUS_ANDROID_STORE_PASSWORD SIRIUS_ANDROID_KEY_ALIAS SIRIUS_ANDROID_KEY_PASSWORD) do (
    if not defined %%V (
        echo [ERREUR] Signature Android absente : %%V.
        exit /b 1
    )
)
if not exist "%SIRIUS_ANDROID_KEYSTORE%" (
    echo [ERREUR] Le fichier SIRIUS_ANDROID_KEYSTORE est introuvable.
    exit /b 1
)
exit /b 0
