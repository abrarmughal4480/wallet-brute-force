@echo off
setlocal

cd /d "%~dp0"
title Wallet AI - OKX Launcher

echo Starting OKX automation...
echo Working directory: %CD%
echo.

where pnpm >nul 2>nul
if %ERRORLEVEL%==0 (
  pnpm run okx
) else (
  echo pnpm not found. Trying npm instead...
  npm run okx
)

echo.
echo Process finished with exit code %ERRORLEVEL%.
pause
endlocal
