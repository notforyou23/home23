---
id: deep-research-synthesizer
name: Deep Research Synthesizer
version: 1.0.0
layer: skill
runtime: docs
author: home23
description: Optional reference for source-grounded synthesis with uncertainty and retrieval limits.
category: research
keywords:
  - research
  - synthesis
  - sources
  - brain
  - contradictions
  - analysis
triggers:
  - synthesize this research
  - pull these sources together
  - what do all these findings say
  - summarize the research with contradictions
capabilities:
  - synthesize: combine many sources or research outputs into one usable answer
---

# Research synthesis reference

Optional when explicitly requested or when a complex synthesis needs a shared output standard. Ordinary research does not require loading this file.

Use the evidence relevant to the question. Own-brain retrieval uses `brain_search`; use `brain_query` only where supported and useful. External research uses available web/source tools. COSMO is not a prerequisite: hosted research and PGS require supported capabilities and instance authority.

Deliver the answer with source provenance, material disagreements, and uncertainty. Distinguish direct evidence from inference, and preserve the limits of partial retrieval. Add next actions only when they help the requested outcome. Do not turn the synthesis into a mandatory report template.
