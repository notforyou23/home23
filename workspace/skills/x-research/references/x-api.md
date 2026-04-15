# X API Notes

This skill uses the X API v2 recent-search and user/tweet lookup endpoints.

Endpoints used:
- `GET /2/tweets/search/recent`
- `GET /2/tweets/:id`
- `GET /2/users/by/username/:username`

Current scope:
- recent search only
- read-only research
- bearer-token auth via `X_BEARER_TOKEN`

Useful query patterns:
- `from:username`
- `conversation_id:tweet_id`
- `url:github.com`
- `-is:retweet`
- `-is:reply`

Research heuristics:
- start narrow, then widen
- use `from:` for expert voices
- use `since` for recency-sensitive questions
- use `quality` or minimum likes to reduce junk
- validate claims outside X before treating them as fact
