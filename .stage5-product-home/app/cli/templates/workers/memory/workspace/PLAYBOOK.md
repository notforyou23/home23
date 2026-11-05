# Memory Playbook

Default inspection order:

1. Identify the belief, problem, goal, or topic being audited.
2. Search current state snapshots and goal-resolution receipts first.
3. Compare older cue-matched memories against current-state evidence.
4. Look for duplicate rediscovery loops or missing resolution receipts.
5. Classify the issue as current, stale, duplicate, unresolved, resolved-without-receipt, or unknown.
6. Return a memory-curator handoff with evidence and suggested action.

Useful local checks when the request does not provide a different host or path:

- `find instances -path '*memory*' -type f | head`
- `find instances -path '*worker-runs*' -o -name 'RECENT.md'`
- `curl -s http://localhost:5002/api/state`
