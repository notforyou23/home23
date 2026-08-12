#!/bin/bash
# Home23 disk guard: bounded cleanup for generated brain backups.
# Does nothing while free space is healthy. Never touches live ledgers or queues.
set -euo pipefail

ROOT="${HOME23_ROOT:-/Users/jtr/_JTR23_/release/home23}"
DATA_MOUNT="${HOME23_DATA_MOUNT:-/System/Volumes/Data}"
BRAIN_ROOTS=(
  "$ROOT/instances/jerry/brain"
  "$ROOT/instances/forrest/brain"
)
THRESHOLD_GIB=10
MIN_AGE_HOURS=24
MAX_REMOVALS=2
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/disk-maintenance.log"
mkdir -p "$LOG_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"; }

free_kb="$(df -kP "$DATA_MOUNT" | awk 'NR==2 {print $4}')"
if [[ ! "$free_kb" =~ ^[0-9]+$ ]]; then
  log "ERROR unable to read free space for $DATA_MOUNT"
  exit 1
fi
threshold_kb=$((THRESHOLD_GIB * 1024 * 1024))
free_gib="$(awk -v kb="$free_kb" 'BEGIN {printf "%.2f", kb/1024/1024}')"

if (( free_kb >= threshold_kb )); then
  log "OK free=${free_gib}GiB threshold=${THRESHOLD_GIB}GiB action=none"
  exit 0
fi

log "PRESSURE free=${free_gib}GiB threshold=${THRESHOLD_GIB}GiB action=prune-old-generated-backups"
removed=0
for brain in "${BRAIN_ROOTS[@]}"; do
  backup_dir="$brain/backups"
  [[ -d "$backup_dir" ]] || continue
  while IFS= read -r candidate; do
    (( removed >= MAX_REMOVALS )) && break 2
    [[ -n "$candidate" ]] || continue
    # Only backup directories with a manifest are eligible; newest backup is protected.
    [[ -f "$candidate/backup-manifest.json" ]] || continue
    rm -rf -- "$candidate"
    log "REMOVED generated_backup=$candidate"
    removed=$((removed + 1))
  done < <(find "$backup_dir" -mindepth 1 -maxdepth 1 -type d -name 'backup-*' -mmin +$((MIN_AGE_HOURS * 60)) -print | sort)
done

log "DONE removed=$removed"
exit 0
