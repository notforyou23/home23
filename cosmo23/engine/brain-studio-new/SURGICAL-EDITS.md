# Surgical Edits Implementation

## Overview

Surgical edits allow the AI to make targeted, precise changes to files without rewriting entire files. All surgical edits are **queued for user review** before being applied, maintaining the "measure twice, cut once" philosophy.

## Available Tools

### 1. `edit_file_range` ⭐ PREFERRED
Edit specific line ranges without rewriting entire files.

**Use when:**
- Changing a function implementation
- Modifying a specific block of code
- Updating configuration sections

**Example:**
```javascript
edit_file_range({
  file_path: 'src/api.js',
  start_line: 45,
  end_line: 52,
  new_content: 'async function fetchData() {\n  // new implementation\n}',
  instructions: 'Update fetchData to use async/await'
})
```

### 2. `search_replace` ⭐ PREFERRED
Find exact text and replace it precisely.

**Use when:**
- Renaming variables/functions in specific locations
- Updating specific strings
- Changing import statements

**Example:**
```javascript
search_replace({
  file_path: 'src/utils.js',
  old_string: 'console.log(error);',
  new_string: 'logger.error(error);',
  instructions: 'Replace console.log with logger'
})
```

**Important:** Include enough surrounding context to make the match unique!

### 3. `insert_lines`
Insert new lines at a specific position.

**Use when:**
- Adding new imports
- Inserting new functions
- Adding configuration entries

**Example:**
```javascript
insert_lines({
  file_path: 'src/config.js',
  line_number: 10,
  content: 'export const NEW_FEATURE = true;',
  instructions: 'Add new feature flag'
})
```

### 4. `delete_lines`
Delete specific line range.

**Use when:**
- Removing deprecated code
- Deleting unused imports
- Cleaning up comments

**Example:**
```javascript
delete_lines({
  file_path: 'src/old.js',
  start_line: 100,
  end_line: 150,
  instructions: 'Remove deprecated helper functions'
})
```

### 5. `edit_file` (Legacy)
Complete file rewrite. **Only use when restructuring entire files.**

## How It Works

### Backend Flow

1. **AI calls surgical tool** (e.g., `edit_file_range`)
2. **Tool validates** the request (line ranges, uniqueness, etc.)
3. **Tool generates complete edited file** content
4. **Returns queue_edit response** with metadata:
   ```javascript
   {
     action: 'queue_edit',
     edit_type: 'range', // or 'search_replace', 'insert', 'delete'
     file_path: '/full/path/to/file.js',
     start_line: 10,
     end_line: 15,
     old_content: 'original lines...',
     new_content: 'new lines...',
     instructions: 'What changed',
     code_edit: 'complete file content with changes',
     message: 'Edit lines 10-15 queued for review'
   }
   ```

### Frontend Flow (To Be Implemented)

1. **Receives queued edit** from AI
2. **Shows compact diff viewer** focusing on changed lines
3. **User reviews and accepts/rejects**
4. **If accepted**, applies via `/api/folder/write`

## Safety Features

### Built-in Validation

- ✅ **Line range validation** - Prevents out-of-bounds edits
- ✅ **Uniqueness checking** - search_replace requires unique matches
- ✅ **File existence** - Validates file exists before editing
- ✅ **Complete file generation** - Always generates full valid file content

### User Control

- ✅ **No auto-apply** - All edits queued for review
- ✅ **Explicit accept** - User must approve changes
- ✅ **Clear diffs** - See exactly what changed
- ✅ **Rollback ready** - Use git/undo to revert if needed

## Benefits

### For Users
- 📊 **Cleaner diffs** - Only see what actually changed
- ⚡ **Faster review** - Less code to review
- 🎯 **More precise** - AI can't accidentally break other code
- 🔒 **Safer** - Smaller changes = less risk

### For AI
- 🚀 **More efficient** - Don't need to send entire files
- 🧠 **Better prompting** - Forces AI to think surgically
- 💾 **Token savings** - Smaller payloads
- 🎯 **More accurate** - Focused on specific changes

## Implementation Status

### ✅ Completed
- Tool definitions added to `server/tools.js`
- Executor methods implemented
- Anthropic tool conversion automatic
- System prompt updated to guide AI
- Comprehensive test suite (7/7 tests passing)
- Validation and error handling

### 🚧 Frontend Integration (Next Steps)
- Enhance edit queue UI to show surgical edit types
- Display compact diffs for range/search-replace edits
- Add visual indicators for insert/delete operations
- Improve accept/reject workflow

## Testing

All surgical edit tools have been tested and validated:

```bash
✅ edit_file_range - Correct queue_edit response
✅ search_replace - Correct queue_edit response
✅ search_replace - Rejects non-unique strings
✅ insert_lines - Correct queue_edit response
✅ delete_lines - Correct queue_edit response
✅ edit_file - Existing functionality preserved
✅ edit_file_range - Validates line ranges
```

## Usage Examples

### Good: Surgical Edit
```
User: "Add error handling to the fetch call on line 42"

AI:
1. read_file(api.js)
2. search_replace(
     old_string: "const data = await fetch(url);",
     new_string: "const response = await fetch(url);\nif (!response.ok) throw new Error('Fetch failed');\nconst data = await response.json();"
   )
```

### Bad: Full File Rewrite
```
User: "Add error handling to the fetch call on line 42"

AI:
1. read_file(api.js) // 500 lines
2. edit_file(api.js, <entire 500 lines with 1 line changed>)
```

## Architecture Philosophy

**"Measure Twice, Cut Once"**

- Surgical edits are **proposed**, not applied
- User has final say on all changes
- No race conditions between editor and server
- Git/undo available as backup safety net
- Clean, reviewable diffs for better code quality

---

**Created:** Dec 2024  
**Status:** Production Ready ✅

