---
id: buddy-sings
name: Buddy Sings
version: 1.0.0
layer: skill
runtime: nodejs
author: home23
description: Let a Home23 companion sing in first person by turning persona context into a repeatable vocal identity and song prompt.
category: media
keywords:
  - buddy
  - sings
  - persona
  - character
  - song
  - first person
  - companion
triggers:
  - let jerry sing
  - make the buddy sing
  - sing as the character
  - turn this persona into a song
capabilities:
  - profile: Derive and store a repeatable singing persona profile
  - sing: Generate a first-person song in that persona
---

# Buddy Sings

Use this skill when the ask is not just "make a song" but "make this character sing".

## When to use

Use `buddy-sings` for:
- Jerry or another companion singing in character
- first-person songs from a defined persona
- repeatable character voice/style profiles

## Actions

### profile

Input:
```json
{
  "personaName": "Jerry",
  "personaFile": "SOUL.md"
}
```

### sing

Input:
```json
{
  "personaName": "Jerry",
  "subject": "a dawn song about waking up before the humans",
  "style": "warm synth-pop with a little ache"
}
```

## Gotchas

- By default this skill reads persona context from `SOUL.md`, `MISSION.md`, and `LEARNINGS.md`.
- It stores a reusable profile under `workspace/reports/buddy-sings/profiles/`.
- This is character-first. If the user just wants a normal song, route to `minimax-music-gen`.
