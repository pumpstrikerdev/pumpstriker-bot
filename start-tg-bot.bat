@echo off
REM ===================================================================
REM  Pumpstriker Bots - TG BOT: wallets, execution, position monitor
REM  Listens on http://127.0.0.1:3748/v1/events for the Engine's events
REM  (signals, cancels, alerts) and delivers the cards to your Telegram chat.
REM
REM  Start the Engine FIRST, then this bot (both read the same
REM  SIGNAL_SHARED_SECRET; after changing it, restart the Engine first).
REM
REM  NOTE: this calls node against node_modules directly instead of
REM  `npx` / `npm run`. npm's Windows .cmd shims expand %%dp0%% on a line
REM  where `&` is still a command separator, so any path containing an
REM  ampersand splits mid-string and the binary is never found. Calling node
REM  directly is immune, and survives a rename.
REM ===================================================================
cd /d "%~dp0"
echo Working dir: %CD%

if not exist "node_modules\tsx\dist\cli.mjs" (
  echo.
  echo Dependencies missing. See README.md - Install section.
  echo.
  pause
  exit /b 1
)
if not exist ".env" (
  echo.
  echo No .env found. Copy .env.example to .env and fill it in.
  echo.
  pause
  exit /b 1
)

echo Starting Pumpstriker Bots TG Bot (port 3748)...
echo If you see "Bot events endpoint: http://127.0.0.1:3748/v1/events" the Engine link is live.
echo Press Ctrl+C to stop.
echo ============================================================
echo.
node ".\node_modules\tsx\dist\cli.mjs" src\bot\bot.ts
echo.
echo TG bot stopped.
pause
