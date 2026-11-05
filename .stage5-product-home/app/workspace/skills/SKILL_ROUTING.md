# Skill routing

Use a skill when it adds Home23 knowledge, an integration contract, or a task-specific standard. Ordinary reasoning, organizing notes, and planning do not require a skill.
Discover with `skills_list` or `skills_suggest`, then read only the selected skill with `skills_get`. Use `skills_run` for executable actions. Metadata is a menu, not a requirement to load every related skill. Tool availability and instance authority still apply.

## Integration routes

- X URLs, timeline, mentions, posting/replies: `x`. Read-only discourse, account/thread research, watchlists: `x-research`. Use the xAI search variants when that provider is specifically appropriate; do not run overlapping searches by default.
- Browser inspection, extraction, screenshots: `browser-automation` or `web_browse`. Completing a page and verifying the outcome: `browser_workflow`, documented in `contact`.
- Calendar, reminders, Mail, Finder, attention, house controls, durable intake, iOS shortcuts, governed communications: `contact`. Preserve preview, confirmation, and physical-outcome checks required by that integration.
- Delegated coding: `coding-agent` for the dedicated `coding_*` job lifecycle, isolation, and integration contract. Small edits can be done directly. `spawn_agent` is separate general background work; `worker_run` uses a configured worker contract.
- Review a diff or PR: `code-review`.
- Shakedown feature research/writing: `shakedown-feature-forge`; Substack operations: `substack`. Editorial work and publishing authority are distinct.
- Music: discover `buddy-sings`, `minimax-music-gen`, or `minimax-music-playlist` for the requested output.

## Optional references

`source-validation` is for an explicit source audit; the core evidence standard covers ordinary research. `deep-research-synthesizer` is an optional synthesis reference, not a mandatory COSMO route.
`knowledge-structuring` and `workflow-automation` are manual references, excluded from automatic suggestions unless named. They are not prerequisites for other skills.
`autoresearch` is for deliberate skill improvement. Judge task outcomes against representative examples; a documentation/metadata audit score alone does not establish quality.
