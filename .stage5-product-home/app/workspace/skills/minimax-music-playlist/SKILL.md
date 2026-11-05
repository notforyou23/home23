---
id: minimax-music-playlist
name: MiniMax Music Playlist
version: 1.0.0
layer: skill
runtime: nodejs
author: home23
description: Turn a taste brief into a custom multi-track playlist plan, then generate the tracks and optional cover art.
category: media
keywords:
  - playlist
  - mixtape
  - taste profile
  - album
  - cover art
  - tracks
  - music
triggers:
  - make me a playlist
  - build a custom mixtape
  - generate a themed soundtrack
  - turn my taste into tracks
capabilities:
  - profile: Turn a listening brief into a taste profile
  - plan: Create a multi-track playlist plan
  - create: Generate the tracks and optional cover art
---

# MiniMax Music Playlist

Use this skill when the user wants a set of related tracks, not one song.

## When to use

Use `minimax-music-playlist` for:
- custom playlists
- thematic mixtapes
- soundtrack-style bundles
- taste-profile driven multi-track generation

## Actions

### profile

Input:
```json
{
  "brief": "I like moody synth music, late-night city energy, and female vocals",
  "favoriteArtists": "Chromatics, M83, The Midnight"
}
```

### plan

Input:
```json
{
  "brief": "Three-track sunrise drive playlist for Home23",
  "count": 3,
  "includeInstrumentals": true
}
```

### create

Input:
```json
{
  "brief": "Three-track sunrise drive playlist for Home23",
  "count": 3,
  "includeInstrumentals": true,
  "includeCoverArt": true
}
```

## Gotchas

- `create` is capped at 5 tracks per run.
- If the user is still shaping taste, run `profile` or `plan` first.
- This skill creates multiple assets, so it is heavier than `minimax-music-gen`.
