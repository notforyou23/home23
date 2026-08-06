# xAI Search

Search X/Twitter and the web using Grok's built-in search tools via the xAI API.

## Why this exists

The X/Twitter developer API has credit limits that can deplete independently of the xAI API. This skill uses the xAI API key (Grok models) which includes native X search as a server-side tool — no X developer API credits required.

## When to use

- **search** — when you need to find what people are saying on X/Twitter, and the X developer API is unavailable or credits are depleted
- **web_search** — when you want Grok's web search as an alternative to the local searxng/Brave search

Prefer the `x` or `x-research` skills when X API credits are available — they return structured tweet data. Use this skill when those are unavailable or when you want Grok's synthesized take on X discourse.

## Actions

### search

Searches X/Twitter in real-time using Grok's `x_search` tool. Returns a synthesized answer with citations.

Input:
```json
{
  "query": "AI agents memory persistence",
  "allowedXHandles": ["elonmusk"],
  "excludedXHandles": ["spambot"],
  "fromDate": "2026-07-01",
  "toDate": "2026-07-23",
  "model": "grok-4.5"
}
```

All parameters except `query` are optional. Date format: ISO 8601 (`YYYY-MM-DD` or full datetime).

### web_search

Searches the web using Grok's `web_search` tool.

Input:
```json
{
  "query": "latest AI agent frameworks 2026",
  "model": "grok-4.5"
}
```

## What you get

- A synthesized text answer from Grok based on real X/web search results
- Citation URLs where available
- The search queries Grok used internally

## What you don't get

- Raw tweet JSON or structured tweet objects (use `x` or `x-research` skills for that)
- Posting or replying capability (that requires the X API OAuth credentials)
- Retweet/like counts as structured data

## Gotchas

- Uses the xAI API key from `config/secrets.yaml` under `xai.apiKey`, or `XAI_API_KEY` env var
- Default model is `grok-4.5`; `grok-4.3` also works
- The xAI Responses API is the endpoint used (`/v1/responses`), not chat completions
- Grok synthesizes rather than returning raw search results — the output is an AI-generated summary with citations
- `allowed_x_handles` and `excluded_x_handles` each have a max of 20 handles (xAI API limit)
- Grok decides how many results to return based on query scope — there is no result count parameter
- Rate limits follow the xAI API plan, not the X developer API plan