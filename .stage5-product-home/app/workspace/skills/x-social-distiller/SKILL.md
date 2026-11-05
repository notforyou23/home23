# X Social Distiller

Turn internal source material into useful public X/Twitter contributions.

This is the top-level social workflow. It does **not** replace the canonical `x` skill. It composes:

- `x-research` for live discourse discovery
- `x` for public post/reply/delete/read/write verification
- `generate_image` outside the skill when media is wanted

## When to use

Use when jtr asks to:

- turn a newsletter/article/curriculum topic/dissertation into X content
- find high-value X posts to respond to from source material
- create a quick-hit social post that teaches the world something
- queue reply/original post candidates before public posting
- post a selected queued item with read-back verification

Do **not** use this for raw X reading/posting. Use `x` directly for that.

## Core doctrine

The public unit is **a useful lesson**, not an internal receipt.

Wrong:

> finished curriculum topic 7, here's our dissertation

Right:

> agents don't need infinite memory. they need lifecycle: verify, revise, expire, compost.

The source artifact is backing material. The public hook must stand alone.

## Actions

### `distill`

Create public lesson cards from source material.

Input options:

```json
{
  "sourceUrl": "https://olddeadshows.com/issues/100.html",
  "sourceText": "optional pasted source text",
  "sourcePath": "/absolute/path/to/article.md",
  "topic": "agent memory lifecycle",
  "audience": "AI builders and agent-runtime people",
  "voice": "jtr",
  "limit": 3,
  "save": true
}
```

Output:

- lesson cards
- standalone tweet drafts
- reply drafts
- X search queries
- optional image prompts
- saved queue path if `save:true`

### `search`

Distill first, then search X for live chatter matching the lesson queries.

```json
{
  "sourceUrl": "https://olddeadshows.com/issues/100.html",
  "topic": "agent memory lifecycle",
  "since": "7d",
  "minLikes": 20,
  "minImpressions": 1000,
  "limit": 8,
  "save": true
}
```

Output:

- ranked candidate tweets
- recommended action: reply/original/skip
- drafts matched to candidates
- queue file path

### `queue`

Alias-style workflow that distills + searches + writes a queue. Use this most often.

```json
{
  "sourceUrl": "https://olddeadshows.com/issues/100.html",
  "topic": "agent memory lifecycle",
  "save": true
}
```

### `postQueued`

Post one selected queue item through the canonical `x` skill, then verify by reading back the created tweet.

```json
{
  "queuePath": "/absolute/path/to/queue.json",
  "itemId": "candidate-1",
  "mode": "reply",
  "confirm": true,
  "generatedImage": "latest",
  "requireMedia": true,
  "requireGeneratedImage": true
}
```

Rules:

- `confirm:true` required.
- Public writes go through `x` only.
- Success is returned only after read-back verification.
- If reply is blocked by X, return failure and preserve the draft for standalone use.

## Queue item shape

```json
{
  "id": "candidate-1",
  "kind": "reply",
  "score": 87,
  "reason": "High fit: agent memory lifecycle + stale context pain",
  "targetUrl": "https://x.com/user/status/123",
  "targetAuthor": "user",
  "targetMetrics": { "likes": 120, "impressions": 50000 },
  "text": "yea. persistent memory is the right direction...",
  "fallbackStandaloneText": "agent memory gets weird when...",
  "imagePrompt": "abstract technical illustration...",
  "includeRepoLink": false,
  "riskNotes": ["No source URL needed", "No private internal claims"]
}
```

## Gotchas

- X may block API replies to conversations where the account is not engaged/mentioned. The skill returns that failure instead of claiming success.
- Do not include links by default. Links are for public artifacts/newsletters when they genuinely help.
- Do not attach arbitrary image paths. For generated image posts use `generatedImage:'latest'` plus `requireGeneratedImage:true`.
- Always verify X writes by read-back before saying posted.
- High views are useful, but relevance and reply permissions matter more than raw reach.

## Operating pattern

1. Distill source into public lesson.
2. Search X chatter.
3. Pick reply if it adds value naturally.
4. Otherwise post standalone.
5. Generate image only for standalone posts or when visual helps.
6. Post through `x`.
7. Verify read-back.
8. Report tweet URL + what happened.
