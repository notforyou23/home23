---
id: x
name: X
version: 1.0.0
layer: skill
runtime: nodejs
author: home23
description: Operate on X/Twitter through the canonical Home23 X skill. Supports official API-backed read/search/post/reply/media/delete plus bird-backed timeline/mentions fallback.
category: social
keywords:
  - x
  - twitter
  - tweet
  - mentions
  - timeline
  - reply
  - post
triggers:
  - read this x link
  - search x for reactions
  - check mentions
  - look at my timeline
  - reply on x
capabilities:
  - timeline: Fetch For You plus Following feeds and save them to workspace
  - read: Read a tweet by URL or ID
  - search: Search X for tweets
  - mentions: Check mentions for the current or specified user
  - post: Post a tweet, optionally with image media
  - reply: Reply to an existing tweet, optionally with image media
  - delete: Delete one of the authenticated account's tweets
---

# X

Use this skill for direct X/Twitter work. It is the canonical Home23 interface for X: official API-backed read/search/post/reply when credentials are present, with `bird` retained for timeline/mentions and explicit fallback/debug use. Do not use ad hoc shell snippets for normal X work.

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

Input:
```json
{
  "text": "short tweet text",
  "media": ["/absolute/path/to/image.png"],
  "alt": ["optional alt text"],
  "confirm": true
}
```

Generated-image safe path:
```json
{
  "text": "short tweet text",
  "generatedImage": "latest",
  "requireMedia": true,
  "requireGeneratedImage": true,
  "alt": ["optional alt text"],
  "confirm": true
}
```

### delete

Deletes a tweet owned by the authenticated account. Use only for explicit cleanup/testing.

Input:
```json
{
  "tweetId": "123",
  "confirm": true
}
```

### reply

Replies to a tweet by URL or ID.

Input:
```json
{
  "url": "https://x.com/user/status/123",
  "text": "reply text",
  "confirm": true
}
```

Can also attach generated media safely with `generatedImage:"latest"`, `requireMedia:true`, and `requireGeneratedImage:true`.

## Gotchas

- `post`, `reply`, and `delete` require `confirm: true`. The skill blocks write/delete actions without it.
- For normal Home23 agent work, this skill is the only approved write path for X. Do not call `bird` directly for posting/replying unless you are debugging this skill or the user explicitly asks for raw CLI diagnostics.
- Use `x-research` for read-only target discovery, discourse scans, profiles, and thread follow-up. Come back to `x` only for authenticated account actions.
- When doing outreach, prefer a reply queue first: candidate URL, why it fits, draft in the user's voice, include-link yes/no, priority, and posted/skipped/failed state. Avoid repeated repo-link replies that look spammy.
- Official API write/media/delete actions require OAuth 1.0a user-context credentials at `secrets.skills.x.apiKey`, `apiSecret`, `accessToken`, and `accessTokenSecret`. Image media uses the v1.1 chunked upload flow (`INIT`/`APPEND`/`FINALIZE`) before v2 tweet creation.
- For "generate an image and post it" workflows, use `generatedImage:"latest"` plus `requireMedia:true` and `requireGeneratedImage:true`. This resolves the newest receipt from `workspace/media/generated-images` and refuses screenshots/random PNGs.
- `bird` must have working browser cookies for timeline/mentions or explicit `backend:"bird"` fallback. If X auth is stale, those calls will fail cleanly.
- This skill is for X itself. If you just need web content from an X link, `browser-automation` may still be better.

## Notes

- `read` and `search` can use the official X API when `secrets.skills.x.bearerToken` is configured, or `backend: "api"` is passed.
- `post` and `reply` use the official X API with OAuth 1.0a when user-context credentials are configured, including image media upload, or `bird` only when `backend:"bird"` is explicit.
- Timeline/search/read/mentions default to saving JSON artifacts into workspace so the results can be inspected later.
- Prefer this skill over standalone `scripts/x-timeline-fetch.sh`. That script is the old one-off path.
