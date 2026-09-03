@echo off
setlocal
title UwU - setup
cd /d "%~dp0"

echo ^(^._.^) UwU setup...

rem 1. install deps (bun preferred, npm fallback)
where bun >nul 2>nul
if %errorlevel%==0 (
  echo using bun install
  bun install
  goto :patch
)
where npm >nul 2>nul
if %errorlevel%==0 (
  echo using npm install
  call npm install
  goto :patch
)
echo [X] Need Bun ^(https://bun.sh^) or Node.js ^(https://nodejs.org^).
echo     Install one and re-run setup.bat
pause
exit /b 1

:patch
rem 2. protocol fix
where python3 >nul 2>nul
if %errorlevel%==0 (
  python3 fix-26.2-protocol.py
  goto :done
)
where python >nul 2>nul
if %errorlevel%==0 (
  python fix-26.2-protocol.py
  goto :done
)
echo [!] python not found - skipping protocol fix.

:done
echo.
echo setup done. Next:
echo   1. copy keys.example.json keys.json  and paste your API key
echo   2. edit uwu.json - set "beloved" + (optional) "auth_password"
echo   3. double-click start.bat
pause