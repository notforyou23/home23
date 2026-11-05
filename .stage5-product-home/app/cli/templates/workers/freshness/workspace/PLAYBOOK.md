# Freshness Playbook

Default inspection order:

1. Identify the specific surface, file, endpoint, receipt, or metric named by the request.
2. Read the outer timestamp and any inner semantic timestamp.
3. Compare freshness against the request's stated threshold, or report the exact age when no threshold is given.
4. Check whether related receipts or state snapshots agree.
5. Classify the result as fresh, stale, historical-only, unknown, or contradictory.
6. Return the precise evidence and the next verification needed.

Useful local checks when the request does not provide a different host or port:

- `curl -s http://localhost:5002/api/state`
- `curl -s http://localhost:5002/api/good-life`
- `find instances -name '*receipt*.json' -mtime -2`
