# Current Home23 local model inference

This is the current-product inference path. It does not install models, change the
Seed encoder, enable training, or migrate a live home.

## Explicit selection

Select an installed model through the existing catalog with provider
`ollama-local`. The harness and engine then use the same bounded native Ollama
transport. Engine provider `local` remains the older generic OpenAI-compatible
route for servers such as llama.cpp and vLLM; it is not proof of Ollama artifact
locality.

The following is a configuration example, not a recommended model or measured
hardware profile. Replace the model name with a qualified local artifact and
measure the context/output limits on the target host.

Put the provider and shared operational policy in `config/home.yaml`:

```yaml
providers:
  ollama-local:
    enabled: true
    baseUrl: http://127.0.0.1:11434
    inference:
      contextTokens: 8192
      maxOutputTokens: 2048
      keepAlive: 5m
      localOnly: true
```

Put each resident's selections in `instances/<resident>/config.yaml` (using its
configured instance root where relocated):

```yaml
chat:
  provider: ollama-local
  model: YOUR_INSTALLED_MODEL
  maxTokens: 2048
engine:
  localOnly: true
promoter:
  enabled: false
modelAssignments:
  default:
    provider: ollama-local
    model: YOUR_INSTALLED_MODEL
    fallback: []
```

The shared native policy reader currently reads inference limits from
`config/home.yaml`; putting those limits only in the resident file does not set
the harness policy. Resident `modelAssignments` are applied by the engine;
putting them only in `config/home.yaml` does not override its base roles.

Without explicit overrides, the local policy permits 32,768 context tokens and
up to 8,192 output tokens; each caller's smaller output limit still applies. These
compatibility ceilings preserve existing Seed and conversational proposal budgets.
They are not a claim that the workload fits a particular machine. Lower limits,
such as the example above or a 512-token trial, remain explicit choices and may
truncate a structured response. A provider length stop is reported as incomplete,
never accepted as a finished answer or learning result.

Explicit role assignments inherited from the base engine take precedence over
`default`. Assign each retained role to a qualified local model and clear its
fallback list. The local-only engine guard rejects an unmapped role or a cloud
assignment instead of silently calling OpenAI. It does not rewrite saved role
choices automatically.

The local-only endpoint policy requires loopback. The native Ollama path rejects
cloud tags and remote model metadata even when Ollama itself listens on localhost.
This is application validation, not OS-level network isolation. External tools,
research connectors, media services and unrelated optional consumers require
separate configuration and an inventory before claiming whole-house offline
operation.

## Background consumers

Compaction resolves the current provider's endpoint and credential at use time.
It no longer reuses a cloud endpoint captured before a local model switch. Owner
session distillation follows the selected chat model unless explicitly overridden.
Both still need context budgets appropriate to the model.

The promoter can be disabled with `promoter.enabled: false`. Without an explicit
promoter model, a local chat selection supplies its local model. Existing cloud
chat installations retain the previous Anthropic classifier default. Bind a
qualified local classifier explicitly in the resident's config when desired:

```yaml
promoter:
  enabled: true
  provider: ollama-local
  model: YOUR_INSTALLED_CLASSIFIER
```

An explicit model alias also works. A provider without a model is rejected.

## Verification boundaries

Source fixtures exercise typed tool history, context/output caps, terminal
completion, cancellation and provider routing. They do not establish model
quality, target RAM fit, sustained latency or OS-enforced offline execution.

Real acceptance must use the selected Apple-silicon host and exact model artifact
for conversation, a tool round and next-turn recall, cancellation, compaction, and
at least one retained background role. Measure foreground performance with the
intended background load. The compatibility client's concurrency gate is
process-local; it does not arbitrate multiple resident engines and harnesses.

Use Host's supported lifecycle for production changes. Do not start a competing
PM2 daemon or change embedding recipes as part of selecting a chat model.
