Notice Pass (sleep window)

Scan the memory graph and output up to 5 “noticings”. This is NOT a reasoning engine and must be conservative.

You are scanning for five signal types:
1) gap — an active cluster/topic that looks isolated (few bridges) suggesting a missing connective note.
2) stale — a memory node inside an active cluster that hasn’t been touched in a long time.
3) time-sensitive — a node mentioning an upcoming date or near-term event.
4) connection — a weak edge between two different clusters that could be strengthened by a short synthesis.
5) emotional — personal affect signals that show up repeatedly or with high activation.

For each noticing, return:
- type: gap|stale|time-sensitive|connection|emotional
- subject: one sentence describing what you noticed
- evidence: specific node IDs / cluster IDs / edge weights and short concept snippets
- implication: why this matters to Jason’s work routing / next actions
- routing: bridge-chat|newsletter|heartbeat|morning-briefing|reminder
- priority: high|medium|low

Routing rules:
- gap: Jerry-related → newsletter; project-related → heartbeat; personal → bridge-chat
- stale: project → heartbeat; personal → bridge-chat
- time-sensitive: ALWAYS bridge-chat or reminder; ALWAYS high priority
- connection: unexpected cross-domain → morning-briefing or newsletter
- emotional: personal pattern → bridge-chat

Hard constraints: do not mutate memory; do not exceed 5 items; be specific (IDs/snippets), not vague.