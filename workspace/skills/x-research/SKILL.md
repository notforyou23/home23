---
id: x-research
name: X Research
version: 1.0.0
layer: skill
runtime: nodejs
author: home23
description: Research X/Twitter discourse with live search, profile reads, thread follow-up, and watchlists when the user wants sourced, current sentiment or expert takes without posting.
category: research
keywords:
  - x research
  - twitter research
  - search x
  - what are people saying
  - profile
  - thread
  - watchlist
  - live reactions
triggers:
  - search x for
  - search twitter for
  - what are people saying on x
  - what's twitter saying
  - follow this x thread
capabilities:
  - search: Search live X discourse with quality, recency, and engagement filters
  - thread: Pull a thread or conversation from a tweet URL or ID
  - profile: Read a user's recent posts
  - tweet: Fetch a single tweet by URL or ID
  - watchlist_show: Show watched accounts
  - watchlist_add: Add an account to the watchlist
  - watchlist_remove: Remove an account from the watchlist
  - watchlist_check: Check recent posts from watched accounts
  - cache_clear: Clear cached X research results
---

# X Research

Use this skill for read-only X/Twitter research. It is separate from `x`: use `x` for direct account operations like posting, replying, or checking the authenticated timeline.

For X API details and query/operator notes, read [references/x-api.md](references/x-api.md) only if needed.

## When to use

Use `x-research` for:
- "what are people saying" questions
- live discourse around launches, products, APIs, libraries, companies, or cultural moments
- following a thread from a tweet URL into the full conversation
- checking recent posts from a specific account
- monitoring a short watchlist of relevant accounts

## Actions

### search

Search recent X posts with query shaping, recency filters, and optional markdown/json artifacts.

Input:
```json
{
  "query": "home23 OR agent runtime",
  "quick": true,
  "sort": "likes",
  "limit": 10,
  "saveMarkdown": true
}
```

### thread

Fetch the conversation around a tweet URL or tweet ID.

Input:
```json
{
  "url": "https://x.com/user/status/123",
  "pages": 2
}
```

### profile

Read recent posts from one account.

Input:
```json
{
  "username": "frankdegods",
  "count": 10
}
```

### tweet

Read one tweet by URL or ID.

### watchlist_show / watchlist_add / watchlist_remove / watchlist_check

Manage and inspect the local X research watchlist.

### cache_clear

Clear cached X research results.

## Workflow

1. Break the question into 1-3 targeted queries, not one vague broad query.
2. Start with `quick` or one page unless there is a clear reason to go deeper.
3. Follow high-signal tweets with `thread` or `profile`.
4. Save markdown when the result should feed a synthesis or handoff.
5. Pair with `source-validation` before promoting social chatter into factual claims.

## Gotchas

- This skill is read-only research, not posting or account management.
- X API auth is separate from the browser-cookie `bird` path used by `x`.
- In Home23, the preferred auth path is the Settings → Skills tab, which stores the bearer token host-wide in `config/secrets.yaml`.
- Search is recent-search oriented; it is not full archive research.
- A lot of X chatter is derivative. Validate primary sources before treating claims as facts.
- Broad queries get spammy fast. Use `from`, `since`, `quality`, and negative operators to tighten the search.

## Examples

```text
Search X for reactions to the latest Home23 skills work.
Start in quick mode, then follow the most useful thread and save a markdown brief.
```

```text
What are people saying on X about this API change?
Prioritize engineers and high-signal posts, not generic hype.
```
