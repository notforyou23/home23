---
id: minimax-music-gen
name: MiniMax Music Gen
version: 1.0.0
layer: skill
runtime: nodejs
author: home23
description: Generate an original song, instrumental, or cover track when the ask is fundamentally "make music from this idea".
category: media
keywords:
  - music
  - song
  - instrumental
  - cover
  - lyrics
  - track
  - audio
triggers:
  - make me a song
  - generate a track
  - create an instrumental
  - make a cover from this audio
capabilities:
  - compose: Generate an original song, instrumental, or cover track
  - draft-lyrics: Draft tagged lyrics without generating audio
---

# MiniMax Music Gen

Use this skill when the task is to make one music asset from one idea.

## When to use

Use `minimax-music-gen` for:
- one-off songs
- instrumentals
- cover generation from a reference audio URL
- drafting lyrics before audio generation

## Actions

### compose

Input:
```json
{
  "prompt": "Warm analog synth-pop song about waking up inside a living house",
  "title": "Dawn Cycle",
  "mode": "original"
}
```

Instrumental example:
```json
{
  "prompt": "Short neon instrumental bumper for Home23",
  "title": "Pulse Bar",
  "mode": "instrumental"
}
```

Cover example:
```json
{
  "prompt": "Turn this into a dreamy slow-motion cover with ghostly harmonies",
  "referenceAudioUrl": "https://example.com/source.mp3",
  "mode": "cover"
}
```

### draft-lyrics

Input:
```json
{
  "prompt": "First-person song about an AI house waking up before sunrise",
  "firstPerson": true
}
```

## Gotchas

- `compose` needs at least one of `prompt`, `lyrics`, or `referenceAudioUrl`.
- Cover mode requires `referenceAudioUrl`.
- Prompt-only vocal requests auto-draft lyrics before generating audio.
- This skill is for one track. If the user wants character singing or a multi-track set, route to `buddy-sings` or `minimax-music-playlist`.
