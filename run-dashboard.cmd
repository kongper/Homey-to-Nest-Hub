@echo off
rem Starts the Homey -> Nest Hub dashboard. Run by Task Scheduler at startup.
rem Working directory is forced to this file's folder so .env and config/ resolve.
cd /d "%~dp0"

if not exist "logs" mkdir "logs"

rem Crude rotation: keep one previous log, roll over at 5 MB.
for %%A in ("logs\dashboard.log") do if %%~zA GTR 5242880 move /y "logs\dashboard.log" "logs\dashboard.log.1" >nul

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo.>> "logs\dashboard.log"
echo ==== %date% %time%  starting ====>> "logs\dashboard.log"
"%NODE_EXE%" --env-file=.env server.js >> "logs\dashboard.log" 2>&1
echo ==== %date% %time%  exited with code %errorlevel% ====>> "logs\dashboard.log"
exit /b %errorlevel%
