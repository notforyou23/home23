#!/bin/bash
# Chrome CDP launcher for Home23 web_browse tool
# Runs headless Chrome with DevTools Protocol on port 9222 for agent-driven browsing.

set -e

PORT="${CDP_PORT:-9222}"
USER_DATA_DIR="${CDP_USER_DATA_DIR:-$HOME/.home23/chrome-cdp}"

CHROME_BIN=""
for p in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "$(command -v google-chrome 2>/dev/null)" \
  "$(command -v chromium 2>/dev/null)"
do
  if [ -n "$p" ] && [ -x "$p" ]; then CHROME_BIN="$p"; break; fi
done

if [ -z "$CHROME_BIN" ]; then
  echo "chrome-cdp: no Chrome/Chromium binary found" >&2
  exit 1
fi

mkdir -p "$USER_DATA_DIR"

echo "chrome-cdp: launching $CHROME_BIN on port $PORT (user-data-dir=$USER_DATA_DIR)"
exec "$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=MediaRouter,OptimizationHints \
  --disable-sync \
  --disable-background-networking \
  --disable-translate \
  --disable-crash-reporter \
  --password-store=basic \
  --use-mock-keychain \
  --headless=new \
  about:blank
