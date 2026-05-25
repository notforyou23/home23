# Step 28: Jerry Resident Spine

Status: implementation slice in progress.

## Directive

`evolve.md` line 1765 supersedes the Step27 scaffold. Step28 treats Home23 organs as inputs and hands for one resident Jerry spine. Chat is one mouth; the engine owns present-tense agency.

## Binding Rules

- Delivery is not completion.
- Telegram is not memory.
- A report that creates no consequence is content, not agent work.
- Every significant input or output must end as discard, durable claim, watch item, active pursuit, task/action, question for jtr, routed handoff, or explicit no-change receipt.
- Agency requires scarcity: active pursuits and watch items are capped.

## Implemented Primitives

- `agency/charter.yaml` defines attention caps, bootcamp rules, authority boundaries, source-truth hierarchy, and editor governance.
- `AgencyKernel.tick()` is the resident tick primitive. It selects one pursuit, applies editor/veto governance, writes scratch, receipt, and consequence records, and updates `state.nextAction`.
- Editor kill verdicts have teeth: stale watch loops are demoted to `discarded` with discard receipts and `stale_thread_killed` consequences.
- `AgencyKernel.intakeWorldStream()` assimilates reports/links/research/cron outputs into machine-readable route and consequence receipts.
- World-stream worker/verifier receipts can close existing pursuits when they name a `pursuitId` and provide closure status/evidence; closure writes `closed` receipts plus `pursuit_closed_by_receipt` consequences.
- `AgencyKernel.recordClaim()` writes source-ranked truth claims and keeps jtr corrections above generated doctrine.
- `AgencyKernel.proposeDelta()` arbitrates behavioral deltas. In live mode, approved reversible L0-L2 `watch_item_created` deltas apply by creating resident watch pursuits; high-risk deltas remain approval-gated.
- Pursuits now include living-thread fields: why it matters, current theory, linked/latest evidence, next move, budget, risk, evidence standard, decay/escalation, and what would change the theory.
- `scratch.jsonl` and `truth.jsonl` are first-class agency ledgers beside inbox, pursuits, receipts, and consequences.
- Cron results from the harness are assimilated into the world-stream path instead of dying at delivery. X timeline and From The Inside prompts now emit `AGENCY_INTAKE_PACKET` blocks that the harness parses into structured agency candidates.
- New recurring `cron`/`every` jobs created through `cron_schedule` require a `pursuit_id` and persist that binding on the job, enforcing the bootcamp rule that recurring work must be tied to resident pursuit.

## Resident State

`instances/<agent>/brain/agency/state.json` is the canonical self/world state for this slice. It exposes:

- current mode and bootcamp posture
- active/watch/deferred counts against charter caps
- current pursuit
- watchlist
- recent belief changes
- open contradictions
- source-of-truth hierarchy
- next autonomous action if jtr says nothing

## Authority

Dry-run remains the default. In dry-run, the resident spine records intent, vetoes, and consequences without executing external action. Live low-risk L0-L2 actions are allowed by policy; L3/L4 remain blocked unless explicitly expanded or approved.

## Remaining Hardening

- Expand live delta appliers beyond watch-item creation only after dry-run receipts prove stable.
- Extend receipt-driven closure to more first-class Home23 surfaces such as live-problem resolution logs and scheduler outcome receipts.
- Audit existing pre-Step28 crons and decide which should be bound to pursuits, demoted, or retired under bootcamp.
