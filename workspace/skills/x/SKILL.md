---
id: x
name: X
version: 1.0.0
layer: skill
runtime: nodejs
author: home23
description: Operate on X/Twitter with bird CLI for timelines, reads, search, mentions, posts, and replies.
capabilities:
  - timeline: Fetch For You plus Following feeds and save them to workspace
  - read: Read a tweet by URL or ID
  - search: Search X for tweets
  - mentions: Check mentions for the current or specified user
  - post: Post a tweet
  - reply: Reply to an existing tweet
---

# X

Use this skill for direct X/Twitter work. It wraps the local `bird` CLI instead of using ad hoc shell snippets.

## When to use

Use `x` when the task is:
- reading a tweet or thread from a URL
- searching X for live conversation
- checking timeline or mentions
- posting or replying on X

## Actions

### timeline

Fetches both Following and For You feeds and writes a JSON snapshot into the agent workspace.

Input:
```json
{
  "count": 20
}
```

### read

Reads a specific tweet by URL or ID.

Input:
```json
{
  "url": "https://x.com/user/status/123"
}
```

### search

Searches X and optionally saves the raw JSON result.

Input:
```json
{
  "query": "home23",
  "count": 10
}
```

### mentions

Checks mentions for the logged-in account or a specific handle.

### post

Posts a tweet. Use only when the user explicitly wants X activity.

### reply

Replies to a tweet by URL or ID.

## Notes

- Authentication comes from the local browser session through `bird`.
- Timeline/search/read/mentions default to saving JSON artifacts into workspace so the results can be inspected later.
- Prefer this skill over standalone `scripts/x-timeline-fetch.sh`. That script is the old one-off path.
