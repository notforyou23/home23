---
id: browser-automation
name: Browser Automation
version: 1.0.0
layer: skill
runtime: nodejs
author: home23
description: Use Home23's live browser controller for screenshots, navigation checks, and page extraction.
capabilities:
  - navigate: Verify a page loads and return title plus URL
  - extract: Extract visible text from a page or selector
  - screenshot: Save a screenshot using the live browser controller
---

# Browser Automation

Use this skill when a live browser pass is a better fit than plain HTTP fetches.

## When to use

Use `browser-automation` for:
- page screenshots
- extracting rendered text
- checking that a page loads correctly in the live browser

## Actions

### navigate

Input:
```json
{
  "url": "https://example.com",
  "waitMs": 3000
}
```

### extract

Input:
```json
{
  "url": "https://example.com",
  "selector": "main",
  "waitMs": 3000
}
```

### screenshot

Input:
```json
{
  "url": "https://example.com",
  "waitMs": 3000
}
```

## Notes

- This skill requires the Home23 browser controller to be available.
- It complements `web_browse`; use the skill when you want the canonical shared pattern rather than an ad hoc call.
