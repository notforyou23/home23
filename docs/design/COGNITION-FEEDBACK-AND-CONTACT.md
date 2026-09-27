# Cognition: contact, correction, and room to think

This repair connects attention, correction, action outcomes, and two-way owner contact. Internally generated operational hypotheses could monopolize attention, their failed predictions did not reliably change subsequent thought or exported context, and authorized Seed outreach stopped at a local outbox. A useful resident must be able to explore a connection without manufacturing a belief, task, or completed action, and initiate a real conversation when there is something worth sharing or asking.

## The connected path

1. The existing canonical resident contact shipper remains the conversation owner. Thinking reads its committed, resident-scoped `substrate/conversation-stream.jsonl` with original timestamps, stable message identities, and Owner / Resident / Peer attribution. No second ingestion path is created. Historical compiled session material is an explicitly labelled fallback.
2. Discovery admits remembered material and conversation for exploration independently of the stricter current-operational-authority gate. Source and correction labels travel into DeepDive, Critique, and PGS. A bounded content-aware cooldown prevents unchanged material immediately reclaiming attention; new evidence can return. Failed model calls release their selection.
3. Seed recruitment receives retained resolved predictions, their errors, IDs, and the descriptions of open intentions. A model can close an intention with a reason. Closure is receipted and the inquiry manifest closes without rewriting its original historical document.
4. Advisory interpretations are retained in actual lobe receipts and supplied to later recruitment as prior considerations. They are neither external observations nor obligations. An explicit empty action agenda stays empty.
5. Repeated failed prediction families require a newer relevant external reference, a link to the latest failed occurrence, and an explanation of what changed. New predictions and intentions use occurrence IDs. Pending duplicates and repeat resolution are rejected.
6. Current Seed projections incorporate contiguous accepted feedback receipts after their checkpoint. They never rerun live admission. If receipt coverage is incomplete, active estimates and expectations are omitted. Historical failure verdicts remain visible. A receipt-carried evidence snapshot explains an admitted revision even when its source reference has left the bounded current window; it does not establish the revised claim as true.
7. NOW, RECENT, contextual memory, engine thought, and dream residue distinguish prior thought, failed hypothesis, unresolved expectation, and external contact. High confidence, age, duplicate reference strings, or a resident's own assertion cannot manufacture evidence.
8. Action routing distinguishes queued, dispatched, simulated, failed, and an action handler's execution result. Canonical Work terminal outcomes and engine action receipts use the existing event-ledger-to-Seed route. Completing a handler or receiving a terminal Work state does not itself prove the owner's desired outcome was independently verified.
9. Action feedback is projected from durable execution receipts; retrying the projection never reruns the action. Canonical Work feedback starts at the current event boundary on first installation, so activation does not flood the resident with old completed jobs. Later terminal evidence receives its own receipt rather than changing an earlier report.

## Owner contact and replies

The `contact_owner` tool lets registered residents and durable helpers initiate contact in their own canonical owner conversation. The runtime supplies identity and destination; model arguments cannot select another agent or recipient. An absent owner pair is established through the existing channel service under the agent's own credentials. Canonical message persistence, notification dispatch, and reply routing are shared with ordinary Home23 messaging.

Background thinking can propose a question, insight, or action update independently of an agenda item. The critic must explicitly keep the thought and approve outreach with real source references. Silence remains valid. Repeated unchanged outreach is suppressed, and a pending local delivery intent survives an unavailable harness. The resident's authenticated local bridge hands it to the durable Home23 outbox; retries reuse the same delivery identity.

Seed's existing authorized operator messages now have an outbox consumer. The relay records queued and committed states separately, recovers its cursor, and retries uncertain sends with the same identity. Previously unattempted requests older than 24 hours are recorded as expired rather than sent as current contact. Already attempted requests retain their identity across that age boundary.

An owner reply enters the same agent conversation and existing Work route. For configured residents, the canonical contact projection and shipper carry that reply back into Seed. Processless helpers use their existing durable AgentLoop; this change does not invent a separate helper Seed process.

`committed` means the message exists in the conversation. `queued` means the durable delivery path has accepted it for retry. Neither means Apple accepted a notification, a device displayed it, or the owner read it. Tests exercise the real notification service with a simulated APNs client; physical phone acceptance is a separate live check.

## Compatibility and limits

Historical unversioned delta semantics remain unchanged. Current accepted receipts carry the exact occurrence identity needed for replay, including an index for ambiguous legacy prediction rows. A read-only feedback projection copies state; it does not mutate the resident, change the encoder, re-ingest conversations, or rewrite history.

Family matching uses conservative lexical overlap plus explicit revision links. It recognizes near repeats, not arbitrary semantic equivalence. Evidence provenance, recency, and topical relevance are necessary checks, not proof of logical entailment. Failure history is the retained bounded cell history, and context is selected, not exhaustive recall.

A logged thought is evidence that the resident considered something. A queued action is evidence of an intention to execute. An execution receipt is evidence of the reported execution. A claim about the world still needs the relevant observation or verifier. These distinctions must survive prompt construction, persistence, restore, and user-facing context.

## Verification

Behavioral tests cover the actual Seed recruitment and restoration path, not only the family helper: unsupported repeats are refused; relevant evidenced revisions are allowed; unrelated exploration survives without obligations; intention closure reconciles the manifest; and accepted evidence survives checkpoint/reference lag. Cross-surface tests verify current context after post-checkpoint failure and honest degradation on a missing receipt.

The engine integration test starts from canonical contact through the production Orchestrator factory, Discovery, DeepDive, Critique, and thought persistence. Outcome bridge tests cover typed execution feedback, terminal Work provenance, duplicate delivery/restart behavior, and declared-versus-verified legacy worker results. Existing authority boundaries remain covered.

Outreach tests exercise the production resident sender, durable adapter, authenticated Core publisher, canonical recorder, notification service, owner reply, Work routing, contact projection, and Seed adapter. Helper identity and reply routing are covered separately. Recovery tests include unavailable transport, lost acknowledgements, process restart, stable message IDs, changed-content conflicts, and retry fairness.

Private captured-history verification is recorded with the task's verification artifacts. The ledger does not retain every original external event payload/vector, so a full reconstruction of all historical metabolic transitions cannot be claimed from that ledger alone. Checkpoint restore and historical accepted lobe-delta compatibility are tested separately. Source verification is not live activation or proof of long-term behavioral improvement.
