#!/bin/bash
# Cron entry point: retain the installed PM2/Node lookup conventions.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
PM2_BIN=${PM2_BIN:-/opt/homebrew/bin/pm2}
[ -x "$PM2_BIN" ] || PM2_BIN=$(command -v pm2)
export PM2_BIN
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd) || exit 1
exec node "$SCRIPT_DIR/lib/observatory-deadman.mjs"
