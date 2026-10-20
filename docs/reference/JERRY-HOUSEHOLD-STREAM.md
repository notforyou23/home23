# Jerry household stream tokens

Paired Home23 apps request short-lived Shakedown stash URLs from Core. The
apps never hold the house service key. Core mints a household token on
loopback and returns tokened URLs.

This is a Core product-API addition, not a Connected Agents contract-pack
change. Clients should call it directly on the paired Bearer session
(`http://127.0.0.1:7346` locally, or the Tailscale edge to that same Core
listener). It is not on the dashboard product-proxy allowlist.

## Endpoint

```
POST /api/v1/music/jerry/stream
Authorization: Bearer <paired product access token>
Content-Type: application/json
```

Auth reuses the existing paired-app session. Required scope: `product:read`.
No new credential profile, scope, or Idempotency-Key. `Cache-Control` on
success is `private, no-store`.

The `/api/v1` prefix matches every other Core product route. The suggested
`POST /music/jerry/stream` shape is that path under `apiBase`.

### Request

Exactly one or both of:

```json
{ "show_id": "d39f4acc70114e679236eb670c861616" }
```

```json
{ "full_path": "d39f4acc70114e679236eb670c861616/1986-10-19_01.mp3" }
```

`show_id` is 32 hex characters. `full_path` is a stash path (canonical
`show_id/file` or an old-name path). Other keys are rejected.

### 200 response

```json
{
  "url": "https://www.shakedownshuffle.com/audio/stash/<show_id>/<file>?token=au1....",
  "expires_at": "2026-10-21T02:14:27.000Z",
  "show_id": "d39f4acc70114e679236eb670c861616",
  "files": [
    {
      "index": 0,
      "full_path": "d39f4acc70114e679236eb670c861616/1986-10-19_01.mp3",
      "allowed": true,
      "url": "https://www.shakedownshuffle.com/audio/stash/<show_id>/<file>?token=au1...."
    }
  ]
}
```

Use `url` as-is for the requested `full_path`. If the client sent only
`show_id`, `url` is the first allowed file. A YouTube-only show returns
`files: []` and `url: null` — do not play that show through stash.

Tokens are show-scoped and last six hours. Core keeps a small in-memory
cache per show until 60 seconds before `expires_at`.

On 401 or 403 from the stash itself, remint once and retry playback. Do
not loop.

### Error envelope

Standard Core error:

```json
{
  "error": {
    "code": "show_not_found",
    "message": "That show was not found.",
    "retryable": false,
    "requestId": "request_...",
    "details": {}
  }
}
```

| HTTP | `error.code` | Meaning |
| --- | --- | --- |
| 400 | `request_invalid` | Missing or malformed body |
| 401 | `access_invalid` / `access_expired` | Paired Bearer missing or invalid |
| 401 | `service_key_required` | House service key missing or rejected by Shakes |
| 403 | `local_only` | Mint was not loopback, or a proxy header was present |
| 404 | `show_not_found` | Unknown `show_id` or unmatched `full_path` |
| 503 | `audio_tokens_unconfigured` | Key file missing, empty, or mint unconfigured |
| 503 | `audio_tokens_unavailable` | Shakes down, timeout, or unexpected mint failure |

`503` is fallback-safe while Shakes is in log mode: the app may use the
plain stash URL. Do not treat `503` as a hard stop.

## House mint (Mini only)

Core reads `~/.config/shakedown/house-service.key` at request time, resolving `~` from the account's passwd entry (the resident runtime overrides `HOME` to `Home/runtime/user`). The
key is never copied into Home23 config, logs, or Git.

It then POSTs only to `http://127.0.0.1:3005/api/v1/audio/household-token`
with `X-House-Service-Key` and `{"show_id"}` or `{"full_path"}`. The
outbound request is built from a fixed header set. It never sends
`X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`, `Via`, or `X-Real-IP`.

Logs strip `token=` and `au1.` values and never print the house key.
