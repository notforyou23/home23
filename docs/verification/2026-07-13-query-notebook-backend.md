# Query Notebook Backend Verification

## Status

`PENDING LIVE ACCEPTANCE`

This dated file is the verification template for the Query Notebook backend.
It is not a passed receipt. Do not create or update `docs/verification/current.md`
until every mandatory automated, restart, and live gate below has passed on the
exact final commit.

## Authority

- Final backend commit: `<pending>`
- Live deployment tree/commit: `<pending>`
- Selected agent: `<pending>`
- Selected-agent dashboard owner: `<pending>`
- Selected-agent harness owner: `<pending>`
- Machine receipt: `.verification/query-notebook/backend-live.json`
- Receipt SHA-256: `<pending>`
- Started/completed: `<pending>` / `<pending>`

The JSON receipt is machine authority for operation identifiers, exact catalog
provider/model pairs, timings, persisted progress samples, route-scoped
credential checks, SSE cursors, protected result digests, continuation reuse,
notification subscription, same-origin web compatibility, and the selected-agent
brain-tool turn. It must have `status: "passed"` and must not contain bearer
tokens, cookies, API keys, answer text, raw sweep outputs, filesystem paths, or
provider payloads.

## Automated gates

Record exact counts and any expected skips. Every command must exit zero.

```bash
node --test --test-concurrency=1 tests/engine/dashboard/query-progress.test.js tests/engine/dashboard/brain-operation-store.test.js tests/engine/dashboard/brain-operation-coordinator.test.js tests/engine/dashboard/query-notebook-service.test.js tests/engine/dashboard/query-notebook-action-token.test.js tests/engine/dashboard/home23-query-notebook-api.test.js
node --import tsx --test --test-concurrency=1 tests/agent/query-notebook-credential.test.ts tests/agent/query-notifications.test.ts
node --test --test-concurrency=1 tests/cosmo23/pgs-source-pin.test.cjs tests/cosmo23/pgs-retry-state.test.cjs
node --test --test-concurrency=1 tests/scripts/verify-query-notebook-live.test.mjs
npm run test:contracts
npm run build
npm test
git diff --check
```

- Dashboard/operation tests: `<pending>`
- Harness credential/notification tests: `<pending>`
- COSMO PGS tests: `<pending>`
- Live-verifier unit tests: `<pending>`
- Contract tests: `<pending>`
- Build: `<pending>`
- Full suite: `<pending>`
- Diff check: `<pending>`

## Scoped restart receipt

Capture identities before and after. Restart only loaded Query owners: the
selected-agent dashboard for dashboard/notebook code and the selected-agent
harness for credential/push code. Do not stop or delete unrelated processes.

- Before: `<pending>`
- Restarted owners: `<pending>`
- After: `<pending>`
- Chat health before/after: `<pending>`
- Unrelated processes preserved: `<pending>`
- Original-checkout user-owned paths preserved: `<pending>`

## Live acceptance

Provide the bridge token through an environment variable or a mode-0600
nonsymlink file. Never put it on the command line or in this document.
Provider/model overrides are optional, but each override must be an exact pair
from the live Query catalog; the verifier contains no fallback model names.

```bash
HOME23_QUERY_BRIDGE_TOKEN='<redacted>' \
node scripts/verify-query-notebook-live.mjs \
  --agent jerry \
  --dashboard-url http://127.0.0.1:<dashboard-port> \
  --output .verification/query-notebook/backend-live.json
```

The command writes redacted JSON progress lines to standard error when a phase,
event sequence, recorded counter, provider-activity timestamp, or terminal state
changes; unchanged polling is collapsed to one heartbeat per minute. Standard
output remains a single machine-readable completion line.

Mandatory receipt readback:

- `status: passed`: `<pending>`
- Dashboard/harness/wrong-agent route separation: `<pending>`
- Missing, wrong-device, and wrong-agent credential rejection: `<pending>`
- Direct operation ID and byte-identical request replay: `<pending>`
- PGS operation ID, named level, and exact sweep/synthesis pairs: `<pending>`
- Activity-aware direct/PGS timings and monotonic persisted counters: `<pending>`
- SSE detach/reconnect cursors and event-gap recovery: `<pending>`
- Protected result byte/digest receipt and unauthenticated rejection: `<pending>`
- Forbidden projection key and raw `sweepOutputs` rejection: `<pending>`
- Continuation operation and positive reused-work count: `<pending>`
- Exact-device terminal-notification subscription: `<pending>`
- Same-origin web Query session/readback: `<pending>`
- Real selected-agent `brain_status` tool turn: `<pending>`
- Receipt size and redaction scan: `<pending>`

## Final exact-commit rerun

- Exact commit: `<pending>`
- Automated gates rerun after commit: `<pending>`
- Live verifier rerun after commit: `<pending>`
- Machine receipt SHA-256 after rerun: `<pending>`
- Environment-only blockers: `<pending>`

Only after all entries above are backed by fresh evidence may this file be
changed to `PASSED` and copied to `docs/verification/current.md`. Backend
acceptance does not claim iOS or physical-device completion.
