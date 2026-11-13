@echo off
setlocal
title Gif Studio
cd /d "%~dp0"

rem ---- Node.js runs the small local server ----
where node >nul 2>nul
if errorlevel 1 (
  echo Gif Studio needs Node.js, and it is not installed.
  echo.
  choice /m "Install it now with winget"
  if errorlevel 2 goto :nonode
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  echo.
  echo Done. Close this window and double-click "Start Gif Studio.bat" again.
  pause
  exit /b
)

rem ---- ffmpeg does the actual video work ----
if exist "%~dp0ffmpeg\ffmpeg.exe" goto :run
if exist "%~dp0ffmpeg\bin\ffmpeg.exe" goto :run
where ffmpeg >nul 2>nul
if not errorlevel 1 goto :run
echo Gif Studio needs ffmpeg, and it is not installed.
echo.
choice /m "Install it now with winget"
if errorlevel 2 goto :noffmpeg
winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
echo.
echo Done. Close this window and double-click "Start Gif Studio.bat" again.
pause
exit /b

:run
node server.js --open %*
if errorlevel 1 pause
exit /b

:nonode
echo Get it from https://nodejs.org (the LTS version), then start Gif Studio again.
pause
exit /b

:noffmpeg
echo Get it from https://www.gyan.dev/ffmpeg/builds/ and either put ffmpeg.exe and
echo ffprobe.exe in a folder called "ffmpeg" next to this file, or add it to PATH.
pause
exit /b
