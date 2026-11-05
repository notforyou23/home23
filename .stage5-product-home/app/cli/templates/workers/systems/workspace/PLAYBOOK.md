# Systems Playbook

Default inspection order:

1. Identify the exact Home23 process, port, verifier, or log named by the request.
2. Check process state with scoped PM2 commands.
3. Check the endpoint or file freshness the verifier depends on.
4. Read only the logs needed for the named process.
5. Prefer diagnosis and evidence over restarts.
6. If the task or standing policy authorizes a needed restart, target only that named Home23 process. Otherwise report the required action and evidence.
7. Re-run the verifier and record the result.

Useful local checks when the request does not provide a different host or port:

- `pm2 jlist`
- `curl -s http://localhost:5002/api/state`
- `curl -s http://localhost:5002/api/good-life`
