# HOME23 Gap Map

Last updated: 2026-04-03
Status: canonical gap map
Purpose: compare the original HOME23 harness brief to current repo reality, with evidence and next steps.

---

## Summary

HOME23 now has a serious canonical platform foundation and operator/control-plane v1. The major remaining gaps are in runtime parity, settings/provider sophistication, and the installable/live-house experience.

---

## Gap matrix

| Requirement from original brief | Current state | Evidence | Gap severity | Next step |
|---|---|---|---|---|
| Create a HOME23 instance from scratch | Present | onboarding app, bootstrap engine, registry/receipts/state | Low | tighten docs and final bootstrap UX |
| Onboarding captures user, agent, continuity, provider, comms, security baseline | Mostly present | onboarding stages 0–6, instance-core/security/memory/comms/provider types | Medium | deepen settings/security semantics |
| Bootstrap files and memory/bootstrap surfaces are generated | Present | bootstrap-engine, receipt/state artifacts on disk | Low | connect outputs more directly to runtime activation |
| Instance creation spins up a real runtime/house | Partial but stronger | activation/start/continue/handoff/session seam exists and a long-lived house-engine loop now runs active instances | Medium/High | deepen orchestrator behavior into fuller autonomous house execution |
| Robust settings system like COSMO 2.3 / Evobrew | Stronger but not final | provider catalog, credential store/import, browser OAuth, live settings mutation, preset bundles, readiness UX, and reconcile sync now exist | Medium/High | deepen local/OpenClaw/settings architecture |
| OAuth model/provider setup parity | Stronger/core real | secure credential storage/import and browser OAuth flows now exist | Medium | deepen provider-specific polish and broader parity |
| Local model support parity | Stronger but not final | local provider discovery/runtime path plus reconcile sync now exist, but management parity is still thin | Medium/High | deepen local model settings/validation/runtime |
| OpenClaw integration parity | Partial | local auth lineage import exists, but no full OpenClaw runtime/provider surface | High | add integration seam or explicit defer doc |
| Robust run management | Stronger but not final | lifecycle, handoff, session ledger, resume contract, explicit resume accept/unblock flow, and first-pass scheduler loop now exist | Medium | deepen orchestrator behavior and richer scheduler support |
| Continue a run with new settings | Stronger but not final | resume compatibility/reasons exist and operator accept/unblock flow now exists in runtime panel | Medium | deepen migration behavior and fuller run-review workflow |
| Web dashboard chat interface as key comms surface | Partial | live handoff and real provider-backed chat now exist | Medium | deepen chat/runtime identity and capabilities |
| Telegram setup baseline | Partial | comms profile fields exist | Medium | add real comms provisioning/validation flow |
| Chat onboarding with agent after setup | Partial | onboarding now prepares a real live handoff, but still on a provider-backed runtime seam | Medium | deepen house-agent execution contract |
| Security posture with tactile live changes | Partial but real | security profile persists, control-plane editing exists, and network/channel enforcement is live | Medium/High | deepen shell/file/self-modify/cron/sub-agent enforcement |
| Live settings with real feedback | Partial but stronger | control plane has live updates, credential truth, handoff, resume classifications, and real security/scheduler gating | Medium | deepen remaining runtime behavior and gating |
| User and agent in control | Partial | operator control and live handoff exist; deeper autonomous agent/runtime integration is still incomplete | Medium/High | complete execution/checkpoint/control loop |

---

## What exists today and should be preserved

Do not throw away these assets:
- canonical monorepo/packages/apps
- onboarding flow
- bootstrap engine
- registry/receipts/state persistence
- unified backend API
- history surfaces
- SSE/live updates
- provider execution seam
- house identity + write guard
- API validation/versioning/tests

These are the right substrate for the next tranche.

---

## The three biggest missing chunks

### 1. Runtime execution and run management
This is the largest product gap.

Missing:
- explicit house-agent execution layer beyond provider turns
- checkpoint/synthesis/session receipts beyond first-pass session ledger
- actual runtime process/control integration
- richer resume gating/migration behavior beyond first-pass compatibility + operator accept/unblock

### 2. Settings/provider parity with prior systems
This is the largest parity gap.

Missing:
- deeper provider settings management at COSMO/Evobrew quality
- richer local model parity
- full OpenClaw integration story

### 3. Live chat + tactile security/capability control
This is the largest UX/control gap.

Missing:
- deeper house-agent identity/execution beyond the provider-backed runtime seam
- live capability/security changes that affect the runtime in real time

---

## Recommended next tranche

### Tranche A — Runtime parity
- instance activation/orchestrator
- run start/continue/resume model
- runtime receipts and status surfaces

### Tranche B — Settings parity
- adapt proven COSMO 2.3 / Evobrew settings patterns
- OAuth/provider/local model flows
- OpenClaw integration decision/implementation

### Tranche C — Live house experience
- web chat ingress/handoff
- post-bootstrap agent conversation
- live security/capability controls wired to runtime
