---
id: xai-x-search
name: xAI X Search
version: 1.0.0
layer: skill
runtime: nodejs
author: home23
description: >-
  Search X/Twitter in real-time using Grok's native x_search tool through the
  xAI API. No X developer API credits required.
category: research
keywords:
  - x search
  - twitter search
  - search x
  - grok search
  - xai search
  - what are people saying
  - twitter discourse
  - live x
triggers:
  - search x for
  - search twitter for
  - what are people saying on x
  - what's twitter saying
  - check x discourse
  - grok search x
  - find tweets about
capabilities:
  - search: Search X discourse using Grok's native x_search tool with date and handle filtering
  - thread: Fetch and summarize a thread/conversation from a tweet URL
  - profile: Read recent posts from a specific X account
---

# xAI X Search

Search X/Twitter through Grok's native `x_search` server-side tool via the xAI Responses API. This does **not** use the X developer API — it uses the xAI API key already configured in Home23 secrets.

## When to use

- "what are people saying on X" questions
- live discourse around topics, products, people, events
- checking recent posts from specific accounts
- following a thread from a tweet URL
- any X/Twitter research when the X developer API is unavailable or out of credits

## When NOT to use

- Posting, replying, or authenticated account actions → use the `x` skill
- Raw tweet JSON / structured data extraction → use `x-research` (X developer API)

## Actions

### search

Search X in real-time. Grok searches natively and returns a synthesized answer with citations.

Input:
```json
{
  "query": "what are people saying about AI agents",
  "fromHandle": "elonmusk",
  "excludeHandle": "spamaccount",
  "fromDate": "2026-07-20",
  "toDate": "2026-07-23",
  "model": "grok-4.5"
}
```

- `query` (required): Natural language question or search topic
- `fromHandle` (optional): Only include posts from this X handle
- `excludeHandle` (optional): Exclude posts from this X handle
- `fromDate` / `toDate` (optional): ISO 8601 date range (YYYY-MM-DD)
- `model` (optional): xAI model to use (default: grok-4.5)

### thread

Fetch and summarize a conversation thread from a tweet URL.

Input:
```json
{
  "url": "https://x.com/user/status/123456789",
  "model": "grok-4.5"
}
```

### profile

Read recent posts from a specific X account.

Input:
```json
{
  "username": "elonmusk",
  "model": "grok-4.5"
}
```

## How it works

1. Sends the query to the xAI Responses API (`/v1/responses`) with `x_search` enabled as a server-side tool
2. Grok searches X natively in real-time
3. Returns a synthesized answer with citations to the original posts
4. Optional parameters filter by handle, date range, and media understanding

## Gotchas

- This returns **synthesized answers with citations**, not raw tweet JSON
- Grok decides what's relevant — results are curated, not exhaustive
- The xAI API key is in `config/secrets.yaml` under `xai.apiKey`
- Rate limits follow the xAI API plan, not X developer API tiers
- Image/video understanding can be enabled but increases token usage
- For structured data needs (metrics, exact timestamps, bulk export), use `x-research` with the X developer API instead