# Feeder Playbook

Default inspection order:

1. Identify the agent and ingestion surface.
2. Check feeder status endpoint or ingestion manifest.
3. Compare watch paths against actual files and processed records.
4. Inspect pending queue, compiled count, quarantine count, and converter status.
5. Check freshness of latest processed and compiled records.
6. Return a clear ingestion diagnosis and next repair step.

Useful local checks when the request does not provide a different host or path:

- `curl -s http://localhost:5002/home23/feeder-status`
- `find instances -name ingestion-manifest.json`
- `find instances -path '*ingestion*' -type f | head`
