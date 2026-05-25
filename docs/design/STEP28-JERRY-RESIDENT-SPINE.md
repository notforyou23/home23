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
- Dashboard bootcamp governance has teeth: dashboard panels/expansions without a declared agency-clarifying changed future are demoted to `discarded` with `ornamental_dashboard_panel_demoted` consequences.
- Raw machine/OS telemetry and heartbeat observations cannot occupy active or watch attention unless they declare a meaningful changed future. New low-signal raw observations are discarded with `raw_observation_not_attention` receipts, and legacy raw active/watch pursuits are discarded during state reconciliation.
- `AgencyKernel.intakeWorldStream()` assimilates reports/links/research/cron outputs into machine-readable route and consequence receipts.
- Bootcamp editor governance now runs before world-stream selector routing for outputs that do not declare a changed future. Research summaries, newsletter drafts, cron reports, timeline reports, and curriculum digestions without a consequence are discarded with `editor_rejected_no_consequence` receipts instead of becoming watch/active attention.
- World-stream worker/verifier receipts can close existing pursuits when they name a `pursuitId` and provide closure status/evidence; closure writes `closed` receipts plus `pursuit_closed_by_receipt` consequences.
- Live-problem observations are keyed by problem id instead of collapsing into one channel pursuit. A resolved live-problem transition closes the matching resident pursuit with verifier evidence and `pursuit_closed_by_receipt` consequence.
- Resolved live-problem verifier evidence no longer creates new active pursuits when no resident pursuit is open. It records explicit no-change evidence, while legacy active resolved live-problem rows are closed or discarded during state reconciliation.
- `AgencyKernel.recordClaim()` writes source-ranked truth claims, demotes lower-authority contradicted claims through append-only `truth_claim_superseded` receipts, keeps lower-authority contradictions visible, and decays stale claims out of the current-state projection.
- Chat/user corrections are no longer generic conversation noise: incoming correction messages become `operator_correction` world-stream packets, write durable `jtr_correction` claims, and can demote weaker truth when linked to a contradicted claim. Chat also exposes `agency_record_claim` for explicit truth/correction entries.
- Canonical resident state now projects active obligations from authority-request receipts, blocked pursuits, and unresolved truth contradictions. The success-test brief reads from this same obligation projection instead of reconstructing a separate "needs jtr" list.
- `AgencyKernel.proposeDelta()` arbitrates behavioral deltas. In live mode, approved reversible L0-L2 `watch_item_created` deltas create resident watch pursuits, `watch_item_closed` deltas close exhausted watch pursuits with evidence, `pursuit_killed` deltas discard report-only threads with evidence, `state_posture_updated` deltas alter canonical resident posture with evidence, `prompt_updated` deltas persist prompt contracts that future chat context hydrates from resident state, `memory_candidate_created` deltas persist durable memory candidates with receipts, `dashboard_contract_changed` deltas persist evidence-first operator-surface contracts, `worker_delegated` deltas create resident worker handoff tasks with delegation receipts, `cron_adjusted` deltas create bounded scheduler handoff tasks with adjustment receipts, and `pursuit_note_added` deltas update an existing pursuit's theory, next move, evidence, and note ledger. High-risk deltas remain approval-gated.
- Questions for jtr are now first-class consequences instead of implicit anxiety. `AgencyKernel.raiseQuestion()`, `GET/POST /api/agency/questions`, dashboard proxying, and chat tool `agency_raise_question` write `jtr_question_raised` receipts/consequences and project open operator questions into canonical obligations.
- Tasks and routed handoffs are now first-class action records. `tasks.jsonl`, `AgencyKernel.recordTask()`, `AgencyKernel.closeTask()`, `GET/POST /api/agency/tasks`, `POST /api/agency/tasks/:id/transition`, dashboard proxying, chat tools `agency_create_task`/`agency_close_task`, and live low-risk `task_created` deltas create and close resident task/action receipts without pretending handoffs are complete at creation time.
- Pursuits now include living-thread fields: why it matters, current theory, linked/latest evidence, next move, budget, risk, evidence standard, decay/escalation, and what would change the theory.
- Pursuit snapshots cap embedded history and the store keeps a current-pursuit index in memory, so resident startup review does not repeatedly parse inflated append-only snapshots before the bridge binds.
- `scratch.jsonl` and `truth.jsonl` are first-class agency ledgers beside inbox, pursuits, receipts, and consequences.
- `memory-candidates.jsonl` is a first-class agency ledger for durable memory candidates that should not yet become source-ranked truth claims.
- Private scratch is now a deliberate resident surface: `AgencyKernel.recordScratch()`, `GET/POST /api/agency/scratch`, dashboard proxying, and chat tool `agency_scratch_note` let Jerry record provisional theories, dead ends, and wrong takes without promoting them to claims, pursuits, or public artifacts.
- Cron results from the harness are assimilated into the world-stream path instead of dying at delivery. X timeline and From The Inside prompts now emit `AGENCY_INTAKE_PACKET` blocks that the harness parses into structured agency candidates.
- Structured report packets no longer collapse into one delivery receipt. `actionWorthy` items become child active pursuits, `watchItems` become child watch pursuits, `contradictions` become durable truth claims, and discarded report noise receives explicit child discard receipts plus fan-out consequences.
- New recurring `cron`/`every` jobs created through `cron_schedule` require a `pursuit_id` and persist that binding on the job, enforcing the bootcamp rule that recurring work must be tied to resident pursuit.
- Pre-Step28 recurring crons are audited at harness startup. Any enabled recurring job without `agency.pursuitId` is turned into a resident bootcamp pursuit, bound back onto the scheduler job, and recorded as a `cron_bound_to_pursuit` consequence. External config reloads preserve existing runtime pursuit bindings.
- `cron_bound_to_pursuit` now satisfies the corresponding bootcamp pursuit stop condition. Future and legacy bootcamp audit pursuits close with `pursuit_closed_by_receipt` consequences instead of camping in active attention after the scheduler job has been bound.
- Bound recurring crons are reviewed at harness startup. In dry-run, a cron whose resident pursuit is closed or editor-discarded receives a `cron_retirement_proposed` consequence. In live mode, only that specific bound recurring job is disabled and recorded as `cron_retired_by_editor`.
- The scheduler tracks `consecutiveNoConsequence` when a run completes mechanically but its semantic outcome remains unknown. After three no-consequence runs, agency bootcamp proposes retirement for the bound recurring job instead of letting output continue as theater.
- Cron retirement proposals include compact recent run-log excerpts: status, semantic status, response preview, and outcome-layer statuses. The operator can inspect why a cron was challenged without opening raw scheduler logs first.
- `AgencyKernel.inspector()` plus `GET /api/agency/inspector?filter=cron_retirement_proposals` expose those retirement proposals as a first-class evidence-chain view. The dashboard Agency Inspector renders job evidence, bound pursuit evidence, and recent run excerpts instead of burying proposals in raw consequences.
- Bound scheduler outcomes carry their `pursuitId` back through world-stream assimilation. Non-closing receipts attach evidence and `cron_report` consequences to the existing pursuit instead of creating disconnected "cron finished" items.
- Bound scheduler outcomes that report `semanticStatus: satisfied` become stop-condition closure receipts. They close the resident pursuit with explicit `changedFuture` evidence instead of leaving scheduler work permanently "advanced."
- Unbound mechanical cron success is an explicit no-change receipt by default. It does not spend watch attention unless the job declares an agency changed-future or emits a structured intake packet; legacy unbound "cron finished ok" watch rows are discarded during state reconciliation.
- Artifact registry promotions and registration-time verified outputs feed the same consequence path. A committed artifact with a passing verifier and resident `pursuitId` emits an `artifact_verifier_receipt`, closing or advancing the pursuit with artifact hash/path evidence. The Capabilities organ now forwards resident pursuit/verifier metadata into the registry so file-write artifacts can participate without custom glue.
- `AgencyKernel.brief()` and `GET /api/agency/brief` answer the Step28 success-test question from live resident state: what Jerry is following, what changed, what he is doing next, and what needs jtr. Chat exposes this through `agency_brief`, and the dashboard renders the same resident brief.

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

## Remaining Audit

- Run a final requirement-by-requirement audit against the full `evolve.md` directive before marking Step28 complete.
