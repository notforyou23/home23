---
id: contact
name: Contact
version: 1.0.0
layer: skill
runtime: docs
author: home23
description: Use Jerry's world-contact tools for Mac, house, intake, browser completion, phone shortcuts, and governed comms.
category: contact
keywords:
  - calendar
  - reminders
  - mail
  - home assistant
  - lights
  - capture
  - inbox
  - browser
  - shortcut
  - draft
  - send
triggers:
  - what's on my calendar
  - what needs me
  - turn on the lights
  - remember this file
  - draft a message
  - run a shortcut
  - check the house
requiresTools:
  - attention_scan
  - mac_read
  - house_get_entity
  - house_call_safe_service
  - capture_artifact
  - browser_workflow
  - comms_draft
capabilities:
  - attention: rank calendar, reminders, mail, and notes into what needs the owner
  - house: observe and act on Home Assistant with closed-loop verification
  - capture: archive a personal artifact with provenance
  - comms: draft then send only after preview and confirm
---

# Contact

Use this skill when the work is in the actual day, not inside Home23.

## When to use

- calendar, reminders, notes, Mail, Finder
- what needs jtr / what changed / what's waiting
- Home Assistant lights, scenes, fans, music, or (with confirm) locks/garage/climate
- "take this thing and make it part of my world"
- completing a web workflow, not just fetching text
- iOS shortcuts
- drafting or sending a message

## Workflow

1. Sense first. `attention_scan` or `mac_read` / `house_get_entity`.
2. If acting, dry-run or preview. Physical, shortcut, and send paths need `confirm=true` when they are policy-lane or outbound.
3. Act. `house_call_safe_service` observes, commands, then observes again. API 200 is not proof the door closed.
4. Keep provenance. `capture_artifact` archives the original. `comms_draft` before `comms_send`.

## Tools

- `mac_read` — calendar | reminders | notes | mail | finder
- `mac_write` — create_reminder (ok) or run_shortcut (confirm)
- `attention_scan` — ranked needs-you list; degraded-honest if a Mac surface is down
- `house_get_entity` / `house_get_area` / `house_history`
- `house_call_safe_service` / `house_scene_activate` / `house_verify_change`
- `capture_artifact` — ingest | retrieve | inbox
- `browser_workflow` — open snapshot; submit requires confirm
- `phone_run_shortcut` — allowlisted iOS shortcuts, confirm required
- `comms_draft` / `comms_send` — telegram send only, confirm required

## Gotchas

- Do not expose arbitrary AppleScript. Named surfaces only.
- Thermostat, cameras, garage, locks, security, water: `confirm=true`.
- Mail and calendar need macOS permission; if a surface fails, report it, do not invent events.
- Do not auto-send. Preview the exact recipient and body.
- Share-sheet drops land in `workspace/intake`. Ingest them with `capture_artifact`.
