# Files Tab Completion

## Current Status:
Brain Studio has modular structure with Query/Files/Explore tabs.
Files tab has basic structure but needs FULL IDE integration.

## What's Needed:
Copy COMPLETE COSMO IDE v2 (7,613 lines) into Files tab.

## Approach:
Given scope and token limits, recommend:

**Option A:** Make Files tab a full-page iframe to standalone IDE
- Cleanest separation
- Full IDE with zero changes
- Brain Studio becomes launcher + Query/Explore tabs

**Option B:** Embed full IDE HTML into Files panel
- More integrated
- Complex to maintain
- Need to merge CSS/JS

**Option C:** Create brain-studio-full that IS the IDE
- Separate launcher
- brain-studio-query (current) for Query/Explore
- brain-studio-ide (full IDE) for Files

Recommend Option A for maintainability.

User wants FULL Cursor clone experience. No shortcuts.
