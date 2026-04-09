#!/bin/bash
# Legacy wrapper preserved for compatibility. The primary launcher is LAUNCH_COSMO.sh.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/LAUNCH_COSMO.sh"

if [ ! -x "$LAUNCHER" ]; then
    echo "Error: Expected launcher at $LAUNCHER" >&2
    exit 1
fi

echo "==============================================="
echo "🧠  START_ALL.sh has been unified with LAUNCH_COSMO.sh"
echo "==============================================="
echo "Launching COSMO via interactive launcher..."
echo
exec "$LAUNCHER" "$@"
