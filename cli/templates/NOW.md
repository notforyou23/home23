# NOW — {{displayName}}

_This file is the live situational snapshot for {{displayName}}. It's injected into every fresh session automatically (see src/agent/session-bootstrap.ts)._

_Until a refresh script is wired, this is a placeholder. To make NOW.md live:_

1. _Write `workspace/scripts/update_now.py` that pulls whatever matters for this agent — health metrics, system state, inbox, pipeline status, weather, whatever._
2. _Add a scheduler job in `conversations/cron-jobs.json` that runs the script every 5 min._
3. _The agent will see the refreshed NOW.md at the start of every new session._

## Situation
- Status: _not yet configured_
- Updater: _not yet wired_

## Imminent
- _No schedule known_

## Data freshness
- _NOW.md is currently a static placeholder. Treat as stale until the refresh loop is running._
