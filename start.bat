@echo off
cd /d "%~dp0"

where bun >nul 2>nul
if %errorlevel%==0 (
  bun main.js
  goto :eof
)
where node >nul 2>nul
if %errorlevel%==0 (
  node main.js
  goto :eof
)
echo [X] Need Bun or Node.js. Run setup.bat first.
pause