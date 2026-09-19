@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1

rem ===========================================================================
rem  Gateway network self-check - thin launcher.
rem ---------------------------------------------------------------------------
rem  All the actual logic lives in net-check.js, because cmd.exe shreds
rem  parentheses and redirection inside `for /f`, and Chinese output is safe
rem  from Node but not from a batch file's parser.
rem
rem  NOTE: ASCII-only on purpose. See 启动网关.cmd for the full explanation.
rem ===========================================================================

set "HERE=%~dp0"

set "NODE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo [!] node.exe was not found on PATH.
  echo     Install Node.js, or run this from a terminal where node resolves.
  echo.
  pause
  exit /b 1
)

if not exist "%HERE%net-check.js" (
  echo [!] net-check.js is missing next to this launcher.
  echo.
  pause
  exit /b 1
)

"%NODE%" "%HERE%net-check.js"
echo.
pause
exit /b 0
