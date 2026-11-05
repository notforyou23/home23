---
id: browser-automation
name: Browser Automation
version: 1.0.0
layer: skill
runtime: nodejs
author: home23
description: Use Home23's live browser controller for screenshots, navigation checks, and page extraction.
category: browser
keywords:
  - browser
  - screenshot
  - page
  - rendered
  - extract
  - navigate
triggers:
  - take a screenshot
  - extract the page text
  - check if this page loads
  - inspect the rendered page
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

## Gotchas

- This skill requires the Home23 browser controller to be available.
- Heavy client-side pages may need a longer `waitMs`.
- Use this when rendering matters. If plain HTTP text is enough, `web_browse` may be cheaper.
