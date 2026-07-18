# Home23 AI OS Kernel + Control Plane — Design (v0)

Date: 2026-07-17  
Status: approved direction — awaiting jtr review of this file before implementation plan  
Supersedes: `2026-07-17-operator-escalation-actions-design.md` (too narrow: live-problem garnish)

## Bar

Home23 is an **AI operating system** when this loop is **enforced**, not narrated:

> observe → remember → interpret → decide → authorize → act → verify → update belief → recover

Seven properties (all required for the claim):

1. **Canonical state** — one inspectable answer to running / believed / pending / failed / complete  
2. **Persistent continuity** — history changes later decisions  
3. **Governed execution** — actions authorized and bounded  
4. **Verifiable outcomes** — done requires runtime + artifact evidence  
5. **Belief revision** — failures and contradictions update future behavior  
6. **Recovery** — stop, retry, snooze, rollback are real  
7. **User control** — human can see, redirect, approve, reverse  

Anything that cannot participate in this loop is a service or prototype — not kernel work.

## Product stance

- **Scoreboard:** finished outcomes with receipts, not chronics / node count / agent count  
- **Cut mode:** starve corner rebuild (no Phase 0 mega-audit as the main quest)  
- **Wedge:** one kernel + control plane + one flagship loop proven repeatedly  
- **Later:** belief-ledger perfection, institutional memory, multi-agent committees — *on top of* the kernel  

## Non-goals (v0)

- Full live-truth archaeology as a multi-week project  
- Rewriting COSMO / inventing new agent roles  
- Graph / dashboard cognition redesign  
- Expanding goal capacity  
- Claiming OS readiness after UI polish alone  

---

## Architecture

### Kernel objects (canonical)

One versioned contract. Subsystem-specific substitutes do **not** count as done.

```text
Intent      why this exists (human or system)
Goal        one owner, one deliverable, WIP-limited
Plan        ordered steps (optional for tiny goals)
Capability  action class + authority envelope
Action      authorized attempt to change the world
Event       append-only fact about what happened
Artifact    persisted output with path + content hash
Test        acceptance check (verifier, script, human gate)
Outcome     pass | fail | blocked | cancelled + evidence refs
BeliefDelta what to trust differently next time
Recovery    stop | retry | snooze | rollback | escalate_to_human
```

Minimum receipt for any Action that claims completion:

```text
intent_id / goal_id
capability_id
action_id
started_at / finished_at
tool + inputs (or human step id)
runtime exit / status
artifact_uri + content_hash (or explicit no-artifact reason)
test_result
outcome
beliefs_affected[]
recovery_state
```

**Rule:** prose alone cannot complete a Goal. No artifact (when required) + no runtime evidence = not executed. No test = not verified.

### Action classes (enforced in executor)

| Class | Examples | Default |
|-------|----------|---------|
| Observe | read logs, query graph | auto |
| Analyze | rank options, draft diagnosis | auto |
| Draft | write uncommitted files / drafts | auto + receipt |
| Local reversible | pm2 restart home23-*, known-safe disk reclaim, workspace edit in sandbox | preauthorized within catalog |
| External consequential | Telegram outbound beyond notify template, publish, spend, shared state | **Needs you** or standing capability |
| Destructive / irreversible | delete, secrets, brain-risk, broad prod | strong confirm or blocked |

Fail-closed for: authority, external consequential, destructive, completion claims, evidence integrity.  
Fail-open only for optional observe/enrichment.

### WIP limits (v0)

- ≤ **3** active Goals house-wide (or per agent if split is clearer in impl)  
- **1** accountable owner per Goal  
- **1** explicit deliverable + **1** acceptance test per Goal  
- New Goals cannot activate while at cap (queue / defer — not silent drop without Event)

Starve: goal creation exceeds closure. Kernel refuses promotion without a free WIP slot.

---

## Control plane (primary human OS surface)

Not a Good Life garnish. **The** operator surface for authorize + recover.

### Three lanes

| Lane | Meaning | User action |
|------|---------|-------------|
| **Needs you** | Authorization, fuse failure, blocked Goal, human checklist | Approve / Deny / Do safe action / Checklist + Mark done / Snooze |
| **In flight** | Authorized Actions / Goals running | Watch; Stop if offered |
| **Verified** | Outcomes with receipts (recent) | Inspect; no work |

Telegram: only **Needs you** items (short form + deep link).  
Dashboard Home: these three lanes first. Graph / cognition secondary.

### Needs-you item (`OperatorIntent`)

Producers (v0):

1. Fuse-box live-problem notify (catalog safe actions)  
2. Goal blocked on human approval (external / destructive class)  
3. Agent / charter fuse-box hit (`requiresApproval`)  
4. Flagship loop explicit human gate  

Same object shape whether from cron fuse or agent ask:

```yaml
schema: home23.operator-intent.v1
id: ...
goal_id: ... | null
source: live-problem | charter | flagship | agent
title: string
why: string
evidence: string
checklist: [string]          # 1–3 steps when human must do work
safe_action:                 # optional, closed catalog only
  class: local_reversible
  id: restart_pm2 | reclaim_known_safe_disk
  label: string
  args: object
authorize:                   # when waiting on approval to run
  action_preview: string
  capability_required: string
buttons: [approve, deny, safe_execute, mark_done, snooze, stop]
deep_link: /home23#needs-you=<id>
```

**Weak escalation design is absorbed here:** fuse notify creates an OperatorIntent in Needs you — it is not a separate product.

### Safe-action catalog (v0)

Closed set only:

- `restart_pm2` — `home23-*` process names only  
- `reclaim_known_safe_disk` — existing remediator  

Everything else: checklist + authorize/deny/mark done. No free-form shell button.

---

## Flagship loop (proof the OS exists)

One bounded real commitment, run **only** through the kernel:

> Capture intent → retrieve relevant history → decide next action → authorize → act → artifact + receipt → test → outcome → belief delta → next session can reconstruct without archaeology

**Candidate domains (pick one at plan time):**

- Jerry: one life-ops or Home23 ship deliverable already near-final  
- Forrest: one health companion artifact already near-final (e.g. filed weekly with acceptance)  

**Pass criteria (repeat ≥3 times):**

1. Goal entered via kernel (not chat prose “done”)  
2. Continuity retrieval cited in receipt (`prior_context_used`)  
3. Action authorized per class  
4. Artifact on disk at expected path + hash  
5. Test passed (verifier or explicit acceptance)  
6. Next session reconstructs objective / decisions / evidence / next without re-brief  
7. Control plane showed Needs you only when actually required; In flight / Verified accurate  

**Fail criteria:** any completion by narrative; missing receipt; WIP exceeded; scenery paging human.

Compare lightly to clean-session baseline later (Phase after v0 passes) — not a blocker to start building the kernel.

---

## Mapping to existing Home23 pieces

| Existing | Role in v0 |
|----------|------------|
| Agency charter + fuse box | Capability / approval classes |
| Live-problems + verifiers | Test + Recovery producers; fuse → Needs you |
| Cron circuit revive | Recovery for schedulers (not OS claim alone) |
| Generator contract | Doctrine: finish with receipts |
| Session bootstrap / NOW | Observe + remember surfaces |
| Good Life | **Demote** from primary control UI; feed status into canonical state / In flight |
| Event ledger / memory objects | Seeds for Event + BeliefDelta (tighten, don’t replace with essays) |
| Dashboard Home | Host Control Plane lanes |
| Harness `/api/notify` | Telegram transport for Needs you |

Do not add a parallel “escalation system.” Extend toward kernel objects.

---

## Implementation slices (ordered)

1. **Kernel schema + store** — Goal / Action / Receipt / OperatorIntent JSON (per agent or house), append-only Events  
2. **Executor gate** — action class check before remediator / tool side effects that mutate; write Receipt  
3. **Control plane UI** — Home: Needs you / In flight / Verified + APIs (approve, deny, safe_execute, mark_done, snooze, stop)  
4. **Telegram** — Needs you short form from OperatorIntent  
5. **WIP enforcement** — activate Goal only under cap  
6. **Flagship #1** — one real commitment through the loop; receipt pack  
7. **BeliefDelta minimum** — on fail/success, write what changed for next retrieve (even if simple)  
8. **Starve producers** — scenery notify stays starved; only kernel/fuse paths page humans  

Tests: catalog gate, WIP refuse, no-prose-completion, OperatorIntent lifecycle, receipt required for Goal complete.

---

## Release gate (when we may say “OS kernel v0”)

- [ ] Canonical Goal/Action/Receipt/OperatorIntent inspectable  
- [ ] Control plane is the primary Home surface for authority  
- [ ] Fuse + approval paths only enter Needs you  
- [ ] ≥3 flagship loops with full receipts  
- [ ] Next-session reconstruction works without archaeology  
- [ ] WIP cap enforced  
- [ ] No scenery Telegram / Needs you spam  

Until then: accurate description remains *persistent cognitive + automation platform building toward an OS kernel* — not full OS.

---

## Deferred (fuel, not v0 scope)

- Full belief ledger (temporal validity, contradiction graph)  
- Longitudinal A/B vs clean chatbot  
- Institutional multi-user governance  
- Broad capability signing / attested sandboxes  
- Mega live-truth Phase 0 as standing project  
- More agents / coordinators  

---

## Acceptance of this design

jtr sets the bar at **AI operating system**. This doc defines the **smallest honest kernel** that can claim OS *v0* without rebuilding the caution corner: enforced loop + control plane + flagship proof.

Weak escalation-only work is rejected.

Review this file. Say go for an implementation plan, or name what to harden before planning.
