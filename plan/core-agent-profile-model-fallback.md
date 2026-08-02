# Core Agent Profile Model Fallback

## Status

Implemented.

## Goal

Allow Core agent runs to continue on an ordered, operator-configured model fallback chain when the
active model repeatedly fails with a transient model-call or stream error.

This applies to the primary profile and the native `explore`, `general`, and `self` subagent
profiles. It does not apply to non-agent model call sites or Mini Lilac.

## Configuration

`fallback` is an optional flat array on model-reference-bearing v2 config nodes:

- `models.def.<alias>`
- `models.main`
- `models.fast`
- `agent.subagents.profiles.<profile>`

Entries are either an alias/direct model string or an object containing `model`, optional
`reasoning`, and optional `options`. Nested fallback chains are not supported.

```yaml
models:
  def:
    primary:
      model: vercel/anthropic/claude-opus-4.8
      reasoning: high
      fallback:
        - sonnet
        - openrouter/openai/gpt-5.5
    sonnet:
      model: vercel/anthropic/claude-sonnet-4.8

  main:
    model: primary
    fallback:
      - model: sonnet
        reasoning: medium
      - openrouter/openai/gpt-5.5

agent:
  subagents:
    profiles:
      explore:
        modelSlot: main
        fallback: [sonnet]
```

There is no global enable switch and no maximum-switch setting. An absent or empty fallback array
does nothing. The configured list is consumed in order without deduplication, so repeated entries
receive independent retry budgets.

## Resolution

The active head keeps the existing precedence:

1. durable workflow head
2. request model override
3. direct subagent profile model
4. selected model slot

The nearest explicitly configured fallback array wins and chains never concatenate. A profile
fallback also applies when the profile selects a slot rather than a direct model. If no nearer array
exists, an alias's own fallback is used.

Fallback entries resolve eagerly through the normal model-ref path, including alias options and
reasoning. An explicit request/workflow reasoning override applies to the whole chain. Otherwise,
candidate-specific reasoning wins over a profile default or alias preset.

## Retry And Switching

Only transient failures from the actual model call or response stream may switch models. Context
overflow, authentication and permission errors, invalid models, cancellation, aborts, pre-step
hooks, message transforms, tools, and unsafe transcript boundaries fail or recover through their
existing paths.

Each candidate receives the configured `agent.retry` budget. With `maxRetries: N`, a candidate can
be called up to `N + 1` times. If retry is disabled or `maxRetries` is zero, a transient failure
advances immediately. AI SDK retry-exhaustion wrappers advance only when their underlying error is
transient.

A switch rebuilds all model-derived state and the complete Level-1 toolset before mutating the live
agent. This includes provider options, reasoning, prompt/cache framing, download behavior,
capabilities, editing mode, tools, selected catalog authority, batch authority, tool display specs,
and output-normalizer bypasses.

`claude-code` cannot enter or leave the native AI SDK tool loop mid-run. A `claude-code` head does
not switch; `claude-code` fallback entries are logged, skipped, and do not stop later native entries
from being attempted.

## Workflow Behavior

The workflow head remains pinned in durable dispatch policy. Fresh dispatches resolve the complete
current plan. A live dispatch retains its attached plan. A stale redispatch preserves the pinned
head but replaces the fallback array with one resolved from current config.

Fallback is excluded from workflow policy identity comparisons and does not affect workflow
revision, run, operation, or request hashes. The full current chain remains in the active dispatch
policy so the runner receives concrete model candidates. Policies created before fallback support
decode as an empty chain.

## Observability

- Switches and skipped `claude-code` entries are logged with request, session, model, and index.
- Transcripts and diagnostics record the final active model.
- Reply stats render switched runs as `head→final`.
- Switched-run cost uses accumulated per-turn estimates rather than pricing all usage as the final
  model.
- Retry rollback restores visible output and graceful-restart partial-output state.

## Validation

Coverage includes config/versioning, exact chain resolution, reasoning precedence, durable
round-trips, transient-only retry behavior, error provenance, full-list exhaustion, Claude Code
skipping, model-plan selection, workflow stale redispatch, policy identity projection, legacy
policies, labels, and retry output rollback.
