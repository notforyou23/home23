# Substack Skill

Programmatic Substack editing for **Shakedown Shuffle** (`shakedownshuffle.substack.com`).
Born from the 2026-07-26 issue-02 backlink repair — the first automated Substack edit.

## How it works

- **Auth:** rides the logged-in session inside the dedicated Chrome profile
  `/Users/jtr/.codex/browser-profiles/shakedown-publishing-v3`. No tokens, no secrets —
  the session cookie IS the credential.
- **Chrome is launched on demand** on CDP `127.0.0.1:9223` (the supervisor launchd job is
  intentionally disabled; this skill spawns Chrome itself and records a launch marker).
- **API:** Substack's internal draft API, driven by same-origin `fetch` from page context
  via CDP `Runtime.evaluate`:
  - `GET  /api/v1/drafts/{postId}` → full draft incl. `draft_body` (stringified ProseMirror doc)
  - `PUT  /api/v1/drafts/{postId}` with `{draft_body}` → saves draft
  - `POST /api/v1/drafts/{postId}/publish` with `{send:false, share_automatically:false}` →
    pushes changes live WITHOUT emailing subscribers
  - `GET  /api/v1/post_management/published` → post list (also used as the session probe)

## Doctrine (non-negotiable)

1. **Fail loud.** Expired session, changed API contract, failed readback — every failure
   throws with an explicit `FAIL LOUD:` message. No silent degradation, no retry loops.
2. **Backup before write.** `editDraft` snapshots the full draft JSON to
   `projects/shakedownshuffle/content/newsletter/source-receipts/` before any PUT.
   Rollback = restore `draft_body` from the backup and re-publish.
3. **Append-only.** `editDraft` only appends ProseMirror nodes. It never rewrites or
   deletes existing content.
4. **Idempotent.** `editDraft` requires an `idempotencyMarker`; if the marker already
   exists in the body, the edit is skipped.
5. **No email without double confirmation.** `publish` defaults to `send:false`. Emailing
   subscribers requires `confirmSend:true` AND `confirmSendText` exactly matching the post
   title. The skill also verifies `email_sent_at` stays null on no-email publishes and
   throws if Substack violates that.
6. **Never kill a Chrome it didn't start.** `stopChrome` only works with the launch marker.

## Actions

| Action | Params | What it does |
|---|---|---|
| `status` | — | Chrome/CDP/session health. Read-only, does not launch Chrome. |
| `listPosts` | `limit?`, `offset?` | Published posts (id, slug, title). |
| `readDraft` | `postId` | Draft metadata + tail of the ProseMirror doc. |
| `editDraft` | `postId`, `appendNodes[]`, `idempotencyMarker` | Backup → append → PUT → readback-verify. |
| `appendCanonicalFooter` | `postId`, `canonicalUrl`, `leadText?` | Convenience: hr + em footer whose anchor text is the URL itself. |
| `publish` | `postId`, `confirmSend?`, `confirmSendText?` | Push draft changes live. No email by default. |
| `verifyBacklink` | `substackUrl`, `needle` | Checks anonymous AND logged-in render for the needle string. |
| `stopChrome` | — | SIGTERM the Chrome this skill launched. |

## Typical flow (backlink repair)

```
1. skills_run substack readDraft            {postId: 204430362}
2. skills_run substack appendCanonicalFooter {postId: 204430362, canonicalUrl: "https://www.shakedownshuffle.com/newsletter/..."}
3. skills_run substack publish              {postId: 204430362}
4. skills_run substack verifyBacklink       {substackUrl: "https://shakedownshuffle.substack.com/p/...", needle: "www.shakedownshuffle.com/newsletter/..."}
```

## Gotchas

- **Anonymous cache lag.** After publish, `/p/` and `/i/` pages served to anonymous
  readers can lag behind for a while (Substack origin cache, ignores cache-busting query
  params inconsistently). Logged-in fetches show truth immediately. `verifyBacklink`
  reports both and returns `published-but-anon-cache-stale` for this state. Do NOT
  re-edit or re-publish in that state — wait for the TTL.
- **The publish-pipeline verifier** (`shakedown-publish-pipeline.mjs`) greps raw HTML for
  the literal canonical URL (`textMentionsUrl`). Anchor text must therefore BE the URL,
  not prose. `appendCanonicalFooter` handles this.
- **Session expiry.** When the session dies, actions throw
  `SUBSTACK SESSION EXPIRED`. Fix: launch Chrome with the publishing-v3 profile
  (`status` action leaves it up), sign in manually once, retry.
- **This is Substack's internal API.** It can change without notice. The session probe
  validates the contract shape before any write; a changed contract fails loud.

## What this skill will NOT do

- Send subscriber email without the double confirmation.
- Rewrite or delete existing post content.
- Touch Stripe/payments/settings.
- Kill Chrome processes it didn't launch.
