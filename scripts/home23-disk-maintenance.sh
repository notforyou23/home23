#!/bin/bash
# Home23 disk guard: bounded cleanup for generated brain backups.
# Does nothing while free space is healthy. Never touches live ledgers or queues.
# Prunes only backups stored on the pressured volume, oldest first, and always
# keeps each brain's newest KEEP_NEWEST backups.
set -euo pipefail

# App root: HOME23_ROOT when set, otherwise the parent of this script's directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HOME23_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# macOS keeps user data on /System/Volumes/Data; elsewhere default to /.
# HOME23_DATA_MOUNT overrides both.
DEFAULT_DATA_MOUNT="/"
[[ -d /System/Volumes/Data ]] && DEFAULT_DATA_MOUNT="/System/Volumes/Data"
DATA_MOUNT="${HOME23_DATA_MOUNT:-$DEFAULT_DATA_MOUNT}"
BRAIN_ROOTS=(
  "$ROOT/instances/jerry/brain"
  "$ROOT/instances/forrest/brain"
)
THRESHOLD_GIB="${HOME23_DISK_GUARD_THRESHOLD_GIB:-10}"
MIN_AGE_HOURS=24
MAX_REMOVALS=2
KEEP_NEWEST=2
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/disk-maintenance.log"
mkdir -p "$LOG_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"; }

# Device number of a path. GNU stat first: its `-f` means file-system status,
# where %d is a free-inode count rather than a device.
device_of() { stat -c %d "$1" 2>/dev/null || stat -f %d "$1"; }

if [[ ! "$THRESHOLD_GIB" =~ ^[0-9]+$ ]]; then
  log "ERROR threshold must be whole GiB: $THRESHOLD_GIB"
  exit 1
fi
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
data_device="$(device_of "$DATA_MOUNT")"
removed=0
for brain in "${BRAIN_ROOTS[@]}"; do
  backup_dir="$brain/backups"
  [[ -d "$backup_dir" ]] || continue
  # Resolve a relocated (symlinked) backups folder so find sees its contents.
  real_dir="$(cd -P "$backup_dir" && pwd -P)"
  if [[ "$(device_of "$real_dir")" != "$data_device" ]]; then
    log "SKIP backups=$backup_dir reason=other-volume"
    continue
  fi
  # Only backup directories with a manifest count; names sort oldest first.
  backups=()
  while IFS= read -r candidate; do
    [[ -f "$candidate/backup-manifest.json" ]] && backups+=("$candidate")
  done < <(find "$real_dir" -mindepth 1 -maxdepth 1 -type d -name 'backup-*' -print | sort)
  prunable=$((${#backups[@]} - KEEP_NEWEST))
  for (( i = 0; i < prunable; i++ )); do
    (( removed >= MAX_REMOVALS )) && break 2
    candidate="${backups[$i]}"
    [[ -n "$(find "$candidate" -maxdepth 0 -mmin +$((MIN_AGE_HOURS * 60)) -print)" ]] || continue
    rm -rf -- "$candidate"
    log "REMOVED generated_backup=$candidate"
    removed=$((removed + 1))
  done
done

log "DONE removed=$removed"
exit 0
