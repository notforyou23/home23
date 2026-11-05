# HOME23 Canonical Vision

Last updated: 2026-03-31
Status: canonical north star
Purpose: define the actual product/architecture target for HOME23 based on the original brief, not just the implementation waves.

---

## Source brief

This vision is grounded in the original HOME23 request:
- COSMO 2.3 already has a strong, working settings system
- Evobrew already proved a robust onboarding flow for providers, OAuth, local models, and OpenClaw integration
- HOME23 should become the installable harness for persistent agents with persistent memories
- creating a HOME23 instance should spin up a real house/runtime, not just static files
- onboarding should capture user, agent, continuity, provider, communication, and security choices
- the result should be a real, tactile, live operator surface where user and agent are both in control

This document is the canonical target.

---

## Product thesis

HOME23 is not merely a dashboard and not merely a scaffold generator.

HOME23 is the installable house and control plane for COSMO-backed persistent agents.

A user should be able to:
1. install HOME23 from scratch
2. create a new HOME23 instance
3. configure user identity, agent identity, continuity, providers, communications, and security posture
4. generate bootstrap files and memory/bootstrap surfaces
5. activate a real runtime for the instance
6. continue onboarding in conversation with the newly formed agent
7. operate the instance through a live control plane with truthful state and live feedback
8. change settings and have those changes affect the real runtime in comprehensible ways

---

## Core principles

- HOME23 is the house and harness.
- COSMO is the cognitive/memory substrate.
- Chat is ingress, not center.
- Onboarding is relationship formation plus system activation.
- Settings must be real, not decorative.
- Control plane must show live truth, not synthetic status.
- The runtime must be installable and restartable from canonical state.
- The system should reuse proven patterns from COSMO 2.3 / Evobrew where those patterns already work.

## Canonical stack model

HOME23 should be understood as a complete-stack AI operating house built as one continuous pyramid.

At the base is the COSMO engine plus the persistent main brain cortex.
- the engine keeps the system alive over time: runtime loops, persistence, receipts, workflows, security posture, and truthful state
- the main brain is the enduring cortex: it absorbs what happens, builds substrate and synapses, sleeps, dreams, and consolidates continuity over time

Above that sits the runtime/house layer.
- named selves live here
- sessions, tools, model execution, workflows, and operator control happen here
- the runtime can access the main brain and, through the shared brain standard, other brains across the ecosystem

At the top is the front door.
- onboarding
- control plane
- chat
- operator-facing simplicity

The operator experience should remain simple: choose a model, talk naturally, and let that model act through the full house stack. But the model is not the system. The model is the current voice. The engine is the living process. The brain is the enduring cortex.

At least initially, the operator should retain meaningful control over which models are used and when.

---

## End-state capabilities

### 1. Instance creation and activation
A HOME23 instance is a real installable/runnable house.

Minimum end-state:
- create a named instance
- emit canonical config/bootstrap/state files
- register the instance in canonical state
- activate a real runtime for that instance
- expose operator surfaces for the live instance

### 2. Onboarding that produces real system state
Onboarding must collect and persist:
- instance identity
- user identity and preferences
- agent identity, mission, boundaries, goals, and voice
- continuity choices (fresh/import/ingest/attach later)
- provider choices and model settings
- communications setup (web chat, Telegram, etc.)
- security/access posture

Outputs must become real bootstrap and runtime state, not just form residue.

### 3. Provider/settings parity with prior systems
HOME23 should inherit or adapt the best working parts of COSMO 2.3 / Evobrew:
- robust provider settings UX
- support for API key, OAuth, and local auth modes where relevant
- local models and Ollama-like flows
- OpenClaw integration where appropriate
- model selection and validation
- settings changes that can affect future and resumed runs correctly

### 4. Runtime/run management
The system must support:
- starting a run
- continuing a run
- resuming a run after settings changes when valid
- tracking runs, runtime jobs, and resumability status
- preserving enough state to recover after restart

### 5. Persistent memory/continuity harness
The instance should be able to:
- start fresh
- import/attach existing continuity/brain state
- ingest project docs/logs/memories
- keep durable current-state and historical state surfaces
- bridge the control plane to the underlying memory/brain substrate honestly

### 6. Live operator control plane
The control plane should expose:
- truthful instance status
- provider status and execution records
- workflow and runtime history
- comms/event history
- artifact receipts and proof surfaces
- live updates
- operator actions that mutate real system state

### 7. Security/capability controls
The operator should be able to set and understand:
- what can run and what cannot
- shell/network/file/self-modify/cron/sub-agent posture
- whether the runtime is full-access, almost-full, or restricted
- how these choices affect live behavior

These controls must be real and reflected by the runtime, not just labels.

### 8. Human/agent control loop
The final feel should be:
- the user forms the house
- the agent comes online inside it
- the operator can see and guide it
- the agent can continue onboarding through conversation
- user and agent both remain in meaningful control

---

## Non-goals for now

These are explicitly not the near-term target unless demanded later:
- enterprise auth/RBAC theater
- multi-tenant SaaS abstractions
- OAuth-first complexity before the runtime/settings seam is ready
- cosmetic dashboards with fake state
- pretending full COSMO seam exists when it does not

---

## Current canonical question

Every new wave/cut should be judged against this:

> Does this move HOME23 closer to being an installable harness for a real persistent agent/runtime with truthful settings, continuity, communication, and control?

If not, it may still be useful, but it is not direct progress toward the canonical target.
