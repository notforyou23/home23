# 📸 File Snapshot System

## Overview

Automatic file version control with instant rollback for AI edits.

## Features

✅ **Auto-snapshots before AI edits** - Automatically saves file state before any AI change  
✅ **Visual timeline** - Browse all saved versions with timestamps  
✅ **One-click restore** - Rollback to any previous version instantly  
✅ **Visual diffs** - Compare current vs snapshot before restoring  
✅ **Safety net** - Creates snapshot before restore (double protection)  
✅ **Space-efficient** - Only stores versions, not redundant copies  

## How to Use

### View File History

1. Open any file in the editor
2. Click the **⏪ File History** button in the toolbar (enabled when file is open)
3. Browse all snapshots for that file

### Restore a Previous Version

1. Open the File History panel
2. Click **👁️ View** to see the diff between snapshot and current
3. Click **↩️ Restore** to rollback to that version
4. Confirm restoration (current state will be snapshotted first!)

### Manual Snapshot (Optional)

```javascript
// From browser console or custom script
await createSnapshot(filePath, content, 'My reason');
```

## When Snapshots are Created

- ✅ **Before AI edit acceptance** - Every time you accept an AI-proposed edit
- ✅ **Before restore** - When you restore a snapshot (saves current state)
- ✅ **Manual trigger** - Via API or custom integration

## Storage

Snapshots are stored in:
```
/snapshots/
  ├── <file-hash>/
  │   ├── snap_<timestamp>_<id>.json
  │   └── snap_<timestamp>_<id>.json
  └── <file-hash>/
      └── ...
```

- Organized by file path (hashed for filesystem safety)
- Each snapshot is a JSON file with metadata + content
- `.gitignore` already excludes `/snapshots/` directory

## API Endpoints

### Create Snapshot
```http
POST /api/snapshots
Content-Type: application/json

{
  "filePath": "/path/to/file.js",
  "content": "file contents...",
  "reason": "Before AI edit"
}
```

### List Snapshots for File
```http
GET /api/snapshots?filePath=/path/to/file.js
```

### Get Specific Snapshot
```http
GET /api/snapshots/:id?filePath=/path/to/file.js
```

### Delete Snapshot
```http
DELETE /api/snapshots/:id?filePath=/path/to/file.js
```

### Delete All Snapshots for File
```http
DELETE /api/snapshots?filePath=/path/to/file.js
```

## Safety Features

1. **Pre-restore snapshot** - Before restoring, current state is saved
2. **Confirmation dialogs** - Restore and delete actions require confirmation
3. **Non-destructive** - Original snapshots never modified
4. **Independent of git** - Works even in non-git projects
5. **Monaco undo still works** - Doesn't interfere with editor undo/redo

## Integration with Edit Queue

When you **Accept** an AI edit:

1. 📸 Snapshot created (original content saved)
2. ✍️ Edit applied to file
3. 💾 File saved to disk
4. ✅ Edit marked as accepted

If you want to undo:

1. Open File History (⏪)
2. Find the "Before AI edit" snapshot
3. Click **↩️ Restore**

## Maintenance

### Clear Old Snapshots

- **Per-file**: Open File History → **🗑️ Clear All History**
- **All files**: Manually delete `/snapshots/` directory (or add cleanup script)

### Backup Snapshots

Snapshots are just JSON files! You can:
- Copy `/snapshots/` to external backup
- Commit to a separate git branch
- Sync to cloud storage

## Tips

💡 **Quick rollback**: After accepting AI edit, immediately press ⏪ to review  
💡 **Compare versions**: Use View button to see what changed  
💡 **Keep important snapshots**: Delete only the ones you don't need  
💡 **Combine with git**: Use snapshots for quick undo, git for long-term history  

## Technical Details

- **Storage format**: JSON with metadata (timestamp, reason, size)
- **Filename hashing**: Base64-encoded file paths (prevents illegal characters)
- **No deduplication**: Each snapshot is complete (future: could add delta compression)
- **No size limit**: Monitor `/snapshots/` directory size manually

---

**Last Updated:** December 2025  
**Status:** ✅ Production Ready
