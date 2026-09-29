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
