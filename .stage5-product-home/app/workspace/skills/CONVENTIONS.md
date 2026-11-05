# Skills Conventions

Canonical structure for shared Home23 skills under `workspace/skills/`.

## Required

Each skill lives in its own folder:

```text
workspace/skills/<skill-name>/
```

Preferred files:

- `manifest.json` - lightweight discovery metadata
- `SKILL.md` - deep instructions, examples, gotchas

## Optional

- `index.js` - executable entrypoint
- `scripts/` - helper scripts
- `references/` - reference docs
- `assets/` - templates, examples, fixtures
- `README.md` - local developer notes

## Discovery model

Use progressive disclosure:
1. Discover via `manifest.json`
2. Read deep usage from `SKILL.md`
3. Load code/scripts only when needed

## Manifest shape

```json
{
  "id": "x",
  "version": "1.0.0",
  "name": "X",
  "description": "Read, search, or post on X/Twitter when the task clearly involves tweets, mentions, or timelines.",
  "layer": "skill",
  "runtime": "nodejs",
  "category": "social",
  "author": "home23",
  "entry": "index.js",
  "actions": ["timeline", "read", "search"],
  "keywords": ["x", "twitter", "tweet", "mentions", "timeline"],
  "triggers": ["read this X link", "check mentions", "search X for reactions"],
  "requiresTools": [],
  "dependsOn": [],
  "composes": [],
  "hooks": {
    "beforeRun": "hooks/before-run.js"
  }
}
```

## Home23 notes

- Shared routing guidance lives in `SKILL_ROUTING.md`.
- Home23 agents discover these skills through `skills_list`, `skills_get`, and `skills_run`.
- `SKILL_ROUTING.md` is injected into agent context automatically when present.

## Curation rules

- Keep descriptions short and specific about when the skill adds value.
- Set `routing: "manual"` in the manifest (or frontmatter for docs-only skills) to retain a reference without automatic suggestions; it remains discoverable and can be requested by exact ID.
- Add `category`, `keywords`, and `triggers` to every skill.
- Add `requiresTools`, `dependsOn`, or `composes` whenever the skill relies on other house surfaces.
- `SKILL.md` should include:
  - `When to use`
  - `Actions` or `Workflow`
  - `Gotchas`
  - at least one concrete example or JSON input block
- Side-effecting executable skills should use hooks for guardrails.
- Run `node workspace/skills/index.js audit` to check quality and undertrigger risk.
