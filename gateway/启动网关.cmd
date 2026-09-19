@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Switch the console to UTF-8 so the Node gateway's Chinese output renders,
rem and so the (non-ASCII) install path prints correctly. Safe here because
rem this file itself is pure ASCII: only the *output* code page changes.
chcp 65001 >nul 2>&1

rem ===========================================================================
rem  Mingyue DSH phone gateway - one-click launcher
rem ---------------------------------------------------------------------------
rem  Start Start-DSH.cmd FIRST, then double-click this file.
rem
rem  Starts the LAN-facing gateway only. DSH itself keeps listening on
rem  127.0.0.1, because `dsh web` deliberately refuses to bind 0.0.0.0 (that
rem  would expose remote code execution to the network). The gateway is the
rem  single door, and it forwards nothing until the caller proves it knows the
rem  launch token.
rem
rem  The gateway asks for the token itself (Node prints the prompt); leave it
rem  empty to skip, and sign in later with a ?token=... address on the phone.
rem
rem  Options are passed straight through, e.g.:
rem    qidong-wang-guan.cmd --port 3082
rem
rem  NOTE: this file is deliberately ASCII-only. cmd.exe parses batch files with
rem  a code page that depends on the console environment, so non-ASCII bytes
rem  desynchronise the parser and shred the script into stray commands. Chinese
rem  text lives in the Node output (real Unicode) and in the .md docs.
rem ===========================================================================

set "PORT="
set "EXTRA="

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--port" (
  set "PORT=%~2"
  shift
  shift
  goto parse
)
set "EXTRA=%EXTRA% %~1"
shift
goto parse

:parsed
if not defined PORT set "PORT=3081"

set "HERE=%~dp0"
echo ============================================================
echo   Mingyue DSH phone gateway
echo   port %PORT%
echo   folder %HERE%
echo ============================================================
echo.

rem ---- is the port already taken? ----
set "TAKEN="
for /f "usebackq tokens=*" %%L in (`netstat -an ^| findstr /i /c:"LISTENING" ^| findstr /c:":%PORT% "`) do set "TAKEN=1"
if defined TAKEN (
  echo [!] Something is already listening on port %PORT%.
  echo     If the gateway is already running, close that window first,
  echo     or run this file again with:  --port 3082
  echo.
  pause
  exit /b 1
)

rem ---- locate node ----
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

if not exist "%HERE%gateway.js" (
  echo [!] gateway.js is missing next to this launcher.
  echo     Expected: %HERE%gateway.js
  echo.
  pause
  exit /b 1
)

rem ---- has the firewall been opened for this port? ----
set "FWRULE="
for /f "usebackq tokens=*" %%L in (`netsh advfirewall firewall show rule name^="Mingyue DSH gateway" 2^>nul ^| findstr /i /c:"LocalPort"`) do set "FWRULE=1"
if not defined FWRULE (
  echo [!] No inbound firewall rule found for the gateway.
  echo     Windows Firewall blocks inbound by default, so the phone will say
  echo     "connection refused" before it ever reaches here.
  echo     Double-click the firewall script in this folder ^(it asks for admin^).
  echo.
)

title Mingyue DSH gateway - port %PORT%
echo [i] node    : %NODE%
echo [i] gateway : %HERE%gateway.js
echo [i] DSH     : http://127.0.0.1:3080  ^(must already be running^)
echo.

"%NODE%" "%HERE%gateway.js" --port %PORT%%EXTRA%
set "RC=%ERRORLEVEL%"

echo.
echo ------------------------------------------------------------
if not "%RC%"=="0" (
  echo [!] The gateway exited with code %RC%.
  echo     If it said DSH is not answering, start Start-DSH.cmd first.
) else (
  echo [i] The gateway stopped.
)
echo.
pause
exit /b %RC%
