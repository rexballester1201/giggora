@echo off
REM ===========================================================================
REM  Giggora - stop everything.
REM
REM  Stops and removes the containers. NOTHING IS DELETED: the chain, its
REM  history, the validator keys, the indexed database and the faucet ledger
REM  all survive, and run.bat brings the containers back around them.
REM
REM  Equivalent to: npm run stack:down
REM
REM  This file will never delete data. To wipe the database you have to type
REM  the command yourself - see RUN.md.
REM ===========================================================================

setlocal
pushd "%~dp0"
title Giggora - stopping

echo.
echo   ==========================================
echo    G I G G O R A   -   s t o p p i n g
echo   ==========================================
echo.

where docker >nul 2>&1
if errorlevel 1 (
  echo   "docker" is not on your PATH, so nothing of Giggora's can be running.
  goto :DONE
)

docker info >nul 2>&1
if errorlevel 1 (
  echo   The Docker engine is not running, so Giggora is already stopped.
  goto :DONE
)

echo   Stopping all Giggora services...
echo.

docker compose -p giggora --profile explorer down
if errorlevel 1 (
  echo.
  echo   docker compose reported a problem. The output above says why.
  echo   To see what is still running:  docker ps
  goto :FAILED
)

echo.
echo   Stopped.
echo.
echo   Nothing was deleted. Still on disk:
echo     - the chain and its full history
echo     - the validator private keys
echo     - the indexed database and the faucet ledger
echo.
echo   run.bat picks up exactly where this left off.
echo.

:DONE
popd
pause
exit /b 0

:FAILED
echo.
popd
pause
exit /b 1
