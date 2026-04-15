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
  "description": "Operate on X/Twitter via bird CLI",
  "layer": "skill",
  "runtime": "nodejs",
  "author": "home23",
  "entry": "index.js",
  "actions": ["timeline", "read", "search"]
}
```

## Home23 notes

- Shared routing guidance lives in `SKILL_ROUTING.md`.
- Home23 agents discover these skills through `skills_list`, `skills_get`, and `skills_run`.
- `SKILL_ROUTING.md` is injected into agent context automatically when present.
