@echo off
setlocal EnableExtensions

rem ===========================================================================
rem  Opens the Windows Firewall for the phone gateway.
rem ---------------------------------------------------------------------------
rem  WHY THIS IS NEEDED
rem    Windows Firewall blocks inbound connections by default, and nothing has
rem    ever asked it to allow the gateway's port. The phone's packets are
rem    dropped before they reach the gateway - which the phone reports as
rem    "connection refused".
rem
rem  This adds ONE inbound TCP allow rule for the gateway port, on the private
rem  and domain profiles only (a home or office WiFi is "private"; public
rem  networks such as cafe WiFi are not opened). It does NOT touch DSH's own
rem  port 3080 - that one stays loopback-only.
rem
rem  Adding a firewall rule requires administrator rights, so this script
rem  re-launches itself elevated and you will see a UAC prompt.
rem
rem  NOTE: ASCII-only on purpose - see 启动网关.cmd for the full explanation.
rem ===========================================================================

set "PORT=%~1"
if "%PORT%"=="" set "PORT=3081"

rem ---- already elevated? ----
net session >nul 2>&1
if %ERRORLEVEL%==0 goto elevated

echo.
echo This needs administrator rights to change the firewall.
echo A UAC prompt will appear - click Yes.
echo.
powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList '%PORT%'"
exit /b 0

:elevated
echo.
echo === Mingyue DSH gateway - firewall rule ===
echo port: %PORT%
echo.

netsh advfirewall firewall delete rule name="Mingyue DSH gateway" >nul 2>&1

netsh advfirewall firewall add rule ^
  name="Mingyue DSH gateway" ^
  dir=in action=allow protocol=TCP localport=%PORT% ^
  profile=private,domain ^
  description="Mingyue DSH phone gateway (LAN only; DSH itself stays on 127.0.0.1)"

if %ERRORLEVEL%==0 (
  echo.
  echo   [OK] Inbound TCP %PORT% is now allowed on private/domain networks.
  echo        Start the gateway, then open the address on your phone.
) else (
  echo.
  echo   [!] Failed. In an elevated Command Prompt, run:
  echo       netsh advfirewall firewall add rule name="Mingyue DSH gateway" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain
)

echo.
echo Current rules named "Mingyue DSH gateway":
netsh advfirewall firewall show rule name="Mingyue DSH gateway" | findstr /i "Rule Enabled Action LocalPort Profile"
echo.
pause
exit /b 0
