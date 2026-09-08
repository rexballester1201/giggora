@echo off
REM ===========================================================================
REM  Giggora - start everything.
REM
REM  Double-click this file. It brings up the chain (4 validators + RPC node),
REM  Postgres, the database migrations, the indexer, the explorer API, the
REM  explorer website and the faucet - ten containers in all.
REM
REM  Equivalent to: npm run stack
REM  To stop:       stop.bat
REM ===========================================================================

setlocal enabledelayedexpansion
pushd "%~dp0"
title Giggora - starting

echo.
echo   ==========================================
echo    G I G G O R A   -   s t a r t i n g
echo   ==========================================
echo.

REM --- 1. Is the docker command even installed? -----------------------------
where docker >nul 2>&1
if errorlevel 1 (
  echo   ERROR: "docker" was not found on your PATH.
  echo.
  echo   Install Docker Desktop from https://www.docker.com/products/docker-desktop/
  echo   then run this file again.
  goto :FAILED
)

REM --- 2. Is the Docker engine actually running? ----------------------------
REM  Docker Desktop takes a while after login and the CLI exists long before
REM  the engine answers, so this waits for the ENGINE rather than the command.
echo   Checking Docker...
docker info >nul 2>&1
if not errorlevel 1 goto :DOCKER_UP

echo   Docker is not running. Starting Docker Desktop...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
  start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
) else (
  echo.
  echo   ERROR: Could not find Docker Desktop to start it.
  echo   Start it yourself from the Start menu, wait for the whale icon to
  echo   settle, then run this file again.
  goto :FAILED
)

echo   Waiting for the Docker engine (this can take a minute or two)...
set /a DOCKER_TRIES=0
:WAIT_DOCKER
set /a DOCKER_TRIES+=1
ping -n 6 127.0.0.1 >nul
docker info >nul 2>&1
if not errorlevel 1 goto :DOCKER_UP
if !DOCKER_TRIES! GEQ 36 (
  echo.
  echo   ERROR: Docker did not come up after three minutes.
  echo.
  echo   If Docker Desktop shows an error dialog, this repository has a fixer
  echo   for the usual Windows cause ^(stale socket files^):
  echo     powershell -ExecutionPolicy Bypass -File scripts\fix-docker.ps1
  goto :FAILED
)
echo     still waiting... ^(!DOCKER_TRIES! of 36^)
goto :WAIT_DOCKER

:DOCKER_UP
echo   Docker is ready.
echo.

REM --- 3. Has the chain ever been created? ----------------------------------
if not exist "blockchain\genesis\genesis.json" (
  echo   ERROR: No genesis found - this chain has not been created yet.
  echo.
  echo   Run this once, in Git Bash, then try again:
  echo     npm install
  echo     bash scripts/create-genesis.sh
  goto :FAILED
)

REM --- 4. Bring everything up ----------------------------------------------
echo   Starting all services...
echo   ^(The first run builds two images and takes a few minutes. Later runs
echo    are about 40 seconds.^)
echo.

docker compose --profile explorer up -d --build
if errorlevel 1 (
  echo.
  echo   ERROR: docker compose failed. The output above says why.
  goto :FAILED
)

REM --- 5. Wait until the websites actually answer ---------------------------
echo.
echo   Waiting for the websites to come up...

set /a TRIES=0
:WAIT_WEB
set /a TRIES+=1
ping -n 6 127.0.0.1 >nul
curl -s -o nul --max-time 3 http://localhost:3000
if errorlevel 1 goto :NOT_YET
curl -s -o nul --max-time 3 http://localhost:4200
if errorlevel 1 goto :NOT_YET
goto :ALL_UP

:NOT_YET
if !TRIES! GEQ 30 goto :SLOW
echo     still starting... ^(!TRIES! of 30^)
goto :WAIT_WEB

:SLOW
echo.
echo   The containers are running but the websites have not answered yet.
echo   The chain sometimes needs an extra moment to reach agreement.
echo   Give it a minute, then open the addresses below. If they still do not
echo   load, run:  npm run stack:status
goto :SHOW_URLS

:ALL_UP
echo   Everything is up.

:SHOW_URLS
echo.
echo   ==========================================
echo.
echo     Explorer      http://localhost:3000
echo     Faucet        http://localhost:4200
echo.
echo     JSON-RPC      http://localhost:8545
echo     Explorer API  http://localhost:4100
echo.
echo   ==========================================
echo.
echo   These are reachable from this computer only, not from your network.
echo.
echo   To stop:   stop.bat
echo   To check:  npm run monitor
echo.

REM  Opens the explorer. Deliberately NOT a prompt: `choice` also reads stdin
REM  and misbehaves when this file is run from anything but a console.
start "" http://localhost:3000

:DONE
echo.
popd
pause
exit /b 0

:FAILED
echo.
popd
pause
exit /b 1
