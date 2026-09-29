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

# The engine publishes a final generated name only after writing its manifest.
# Manual copies and unfinished .tmp directories are never cleanup candidates.
generated_backup='^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}\.[0-9]{3}Z-[0-9]+-[a-f0-9-]{36}$'
safe_backup_root() {
  [[ ! -L "$ROOT/instances" && ! -L "${brain%/brain}" && ! -L "$brain" && ! -L "$backup_dir" && -d "$backup_dir" ]]
}
completed_backup() {
  [[ "${1##*/}" =~ $generated_backup && ! -L "$1" && -d "$1" && ! -L "$1/backup-manifest.json" && -f "$1/backup-manifest.json" ]]
}

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
  # The engine owns retention at external destinations. Never follow links to
  # relocated brains or backups, even when they share the pressured volume.
  safe_backup_root || continue
  if [[ "$(device_of "$backup_dir")" != "$data_device" ]]; then
    log "SKIP backups=$backup_dir reason=other-volume"
    continue
  fi
  # Globbed timestamped names sort oldest first. Protect the newest completed
  # backups before checking age, including when every backup is old.
  backups=()
  for candidate in "$backup_dir"/backup-*; do
    completed_backup "$candidate" && backups+=("$candidate")
  done
  prunable=$((${#backups[@]} - KEEP_NEWEST))
  for (( i = 0; i < prunable; i++ )); do
    (( removed >= MAX_REMOVALS )) && break 2
    candidate="${backups[$i]}"
    safe_backup_root || break
    completed_backup "$candidate" || continue
    [[ -n "$(find "$candidate" -maxdepth 0 -type d -mmin +$((MIN_AGE_HOURS * 60)) -print)" ]] || continue
    rm -rf -- "$candidate"
    log "REMOVED generated_backup=$candidate"
    removed=$((removed + 1))
  done
done

log "DONE removed=$removed"
exit 0
