@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1

rem ===========================================================================
rem  Phone tunnel launcher (ngrok)
rem ---------------------------------------------------------------------------
rem  Use this when the phone CANNOT reach this PC over the local network -
rem  e.g. the phone is on mobile data and the PC is on a campus wired network.
rem  The PC dials out to ngrok and the phone opens the resulting public URL,
rem  so no app has to be installed on the phone at all.
rem
rem  Requirements:
rem    * Start-DSH.cmd running (the agent)
rem    * 启动网关.cmd running (the door in front of it)
rem    * a free ngrok account - the script walks you through it
rem
rem  NOTE: ASCII-only on purpose. See 启动网关.cmd for the full explanation.
rem ===========================================================================

set "HERE=%~dp0"

set "NODE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo [!] node.exe was not found on PATH.
  echo.
  pause
  exit /b 1
)

if not exist "%HERE%start-tunnel.js" (
  echo [!] start-tunnel.js is missing next to this launcher.
  echo.
  pause
  exit /b 1
)
if not exist "%HERE%ngrok.exe" (
  echo [!] ngrok.exe is missing next to this launcher.
  echo     Re-download it, or run this from the folder that has it.
  echo.
  pause
  exit /b 1
)

title Mingyue DSH tunnel
"%NODE%" "%HERE%start-tunnel.js" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [!] tunnel exited with code %RC%
  echo.
  pause
)
exit /b %RC%
