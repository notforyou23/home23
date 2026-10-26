# Resident brain backups

Configure the scheduled engine backup destination in the installed home's private `config/home.yaml`:

```yaml
backups:
  brain:
    directory: "/Volumes/External Drive/Home23 Brain Backups"
```

Create that directory on the mounted volume before starting the home. It must be an existing, absolute, canonical directory, not a symlink. The Host passes this value to each resident engine. The engine writes to `<directory>/<resident>/backups/`, so residents do not share a retention set. A missing or unmounted destination makes that backup attempt fail; it does not fall back to the internal disk. On macOS, paths beneath `/Volumes/` must be on a mounted volume.

The scheduled backup remains a coherent snapshot every six hours, retaining the newest generated backup for each resident. Before copying, the destination must have enough free space for the projected snapshot plus a 50 GiB reserve. Existing local backups are not moved or pruned by the new destination. Without this setting, the engine keeps using each brain's local `backups/` directory and its existing internal disk guard.

These resident snapshots are separate from the product's encrypted whole-home backup archive used for home moves and recovery. Configure and verify that archive independently.

## Nightly community maintenance

The `/admin/memory/cleanup/communities` operation also makes a recovery snapshot before changing the brain. These snapshots live in each brain's existing `backups/` directory, including an existing linked destination. They are separate from the scheduled six-hour backups above.

Before maintenance, the engine waits for persistence to finish and captures the canonical backup source set. That set includes the memory manifest and its selected generation files when present. The copy uses bounded streams, validates compressed files and hashes, and publishes a completion manifest atomically. The destination must have room for the projected snapshot plus a 4 GiB reserve. A failed backup or a brain revision change prevents maintenance from proceeding.

After maintenance saves successfully, retention keeps the newest seven successful community snapshots and up to four additional weekly recovery points. Weeks begin on Monday in UTC. A backup-root lock prevents overlapping community maintenance operations from pruning each other's snapshots. An abandoned lock requires inspection of its `owner.json` before manual recovery; the engine does not expire it by age.

Retention only removes snapshots created by this policy with a matching resident, destination, file inventory and successful-operation receipt. It verifies the successor snapshot first, checks for open files, and records removal receipts in `.community-retention-receipts/`. Retention errors are reported without turning successfully saved maintenance into a failed operation.

Legacy snapshots, failed or incomplete operations, changed contents, and unknown directories remain untouched. Place `.retention-pin` inside a snapshot to keep it, or at the backup root to disable expiry there. A retain-all resident policy also prevents expiry. These holds can grow beyond the normal retention count and require separate review; the policy does not automatically adopt or delete historical recovery material.
