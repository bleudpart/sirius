@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

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
    if "%SIRIUS_ANDROID_KEYSTORE%"=="" (
        echo [ERREUR] Signature Google Play absente.
        echo Definissez SIRIUS_ANDROID_KEYSTORE, SIRIUS_ANDROID_STORE_PASSWORD,
        echo SIRIUS_ANDROID_KEY_ALIAS et SIRIUS_ANDROID_KEY_PASSWORD.
        exit /b 1
    )
    echo [2/2] Generation de l'Android App Bundle signe pour Google Play...
    pushd android
    call gradlew.bat bundleRelease
    popd
    set "APK_PATH=android\app\build\outputs\bundle\release\app-release.aab"
) else if /i "%~1"=="release" (
    echo [2/2] Generation de l'APK release...
    pushd android
    call gradlew.bat assembleRelease
    popd
    set "APK_PATH=android\app\build\outputs\apk\release\app-release.apk"
) else (
    echo [2/2] Generation de l'APK debug...
    pushd android
    call gradlew.bat assembleDebug
    popd
    set "APK_PATH=android\app\build\outputs\apk\debug\app-debug.apk"
)
if errorlevel 1 (
    echo [ERREUR] Gradle n'a pas pu generer l'APK.
    pause
    exit /b 1
)

echo.
echo Fichier Android genere : %CD%\%APK_PATH%
start "" "%CD%\%APK_PATH%"
endlocal
