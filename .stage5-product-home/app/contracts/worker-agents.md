# Worker Agents Apple Client Contract

Home23 owns this contract source. Apple clients may copy it into their contract snapshot, but backend `contracts/` is the source of truth.

## Route Family

Native clients should use the selected-agent dashboard base URL:

```text
host.dashboardURL(for: selectedAgent)
```

Dashboard proxy endpoints:

```http
GET  /home23/api/workers
GET  /home23/api/workers/templates
GET  /home23/api/workers/runs
GET  /home23/api/workers/runs/:runId
GET  /home23/api/workers/runs/:runId/receipt
GET  /home23/api/workers/runs/:runId/artifacts
POST /home23/api/workers
POST /home23/api/workers/:name/runs
POST /home23/api/workers/runs/:runId/cancel
POST /home23/api/workers/runs/:runId/promote-memory
```

## Worker Summary Shape

```json
{
  "workers": [
    {
      "name": "systems",
      "displayName": "Systems",
      "ownerAgent": "jerry",
      "class": "ops",
      "purpose": "Diagnose Home23 host, PM2, ports, logs, and scoped service issues without destructive global operations."
    }
  ]
}
```

The schema is `schemas/worker-agents.schema.json`; fixture is `fixtures/worker-agents.json`.

## Native UX Contract

- Show each worker as a capability, not as a raw run-id table.
- Show guardrails before run controls: no global PM2 stop/delete, no destructive cleanup, no claimed fix without verification.
- Show receipts as proof trails: what happened, what was checked, files produced, and what Jerry can learn.
- Keep owner-agent routing explicit in any create/run request.
