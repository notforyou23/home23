#!/bin/bash
# Autoresearch loop — shell wrapper
# Loader passes params via HOME23_SKILL_PARAMS env var.
# Returns JSON to stdout.
set -e

SKILL_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/autoresearch_loop.js"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

cd "$PROJECT_ROOT"
exec node "$SKILL_SCRIPT"
