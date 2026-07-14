---
slug: openai-compatible-image-routing
status: approved
intent: clear
pending-action: write .omo/plans/openai-compatible-image-routing.md
approach: Preserve every existing image alias, validator, adapter, fallback order, and output contract; add a v2 routing switch that selects the existing OpenAI-compatible AI SDK provider as the model factory for those aliases.
---

# Draft: openai-compatible-image-routing

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
provider-config | v2 config selects default or OpenAI-compatible image routing without changing v1 input | active | packages/utils/core-config/v2.ts
runtime-wiring | core runtime and standalone tool bridge deliver the same config to Generate | active | apps/core/src/plugins/builtin/server-tools.ts
alias-routing | existing aliases keep their adapters while model construction uses the selected provider | active | apps/core/src/tool-server/tools/generate.ts
wire-qa | fake OpenAI-compatible endpoint proves the real HTTP request and output artifact | active | apps/core/tests/tool-server-image-generation.test.ts

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
gpt-5-image canonical ID | gpt-image-1.5 | upstream OpenAI primary mapping; user chose canonical IDs without mapping | yes
missing third-party base URL | configuration error, no fallback | selected routing is operator intent; silent fallback violates it | yes
post-request failure | return original error, never retry official provider | avoids duplicate generation and billing | yes

## Findings (cited - path:lines)

- Existing aliases, validators, provider factories, fallback order, generation/edit adapters, and output handling are centralized in `apps/core/src/tool-server/tools/generate.ts` on `upstream/main`.
- `packages/utils/model-provider.ts:104` already constructs `openai-compatible` through `createOpenAICompatible` when `OPENAI_COMPATIBLE_BASE_URL` exists.
- `packages/utils/env.ts:66` already exposes the OpenAI-compatible base URL and API key; no new environment variables are needed.
- AI SDK 6 `OpenAICompatibleProvider.imageModel(modelId)` uses `/images/generations` and `/images/edits`, so no custom HTTP client is required.
- Current branch is 11 commits and roughly +1603/-37 from `upstream/main`; most of its profiles, model lists, provider options, retries, and normalization are out of scope.

## Decisions (with rationale)

- Public model input remains the existing Lilac aliases; do not add `openai-compatible/<model-id>` syntax.
- Add `tools.generate.image.provider: default | openai-compatible` to v2 config, defaulting to `default`.
- Keep v1 input schema frozen and synthesize `{provider: "default"}` only in v1-to-universal conversion.
- OpenAI-compatible routing is explicit through core config; merely setting text-provider env vars must not reroute images.
- Use existing canonical IDs: `gpt-image-1.5`, the three existing Google/OpenRouter slugs, and identical Grok IDs.
- Preserve alias-specific validation and all request/output adapters; only model construction changes.
- Use bearer API-key authentication already provided by `createOpenAICompatible`.
- Tests use TDD plus a real local fake HTTP endpoint.

## Scope IN

- Minimal universal/v2 config field and v1 fallback.
- Config delivery to Generate in core runtime and tool bridge.
- Provider-aware model construction for all existing image aliases.
- Focused config/routing regression tests and wire-level generation/edit QA.
- Example config, migration note, and concise tool documentation updates.

## Scope OUT (Must NOT have)

- Model allowlists, profiles, alias mappings, dynamic provider/model specs, or new aliases.
- Provider options, custom headers, query parameters, or new environment variables.
- Automatic fallback after OpenAI-compatible routing is selected.
- Changes to validators, input schemas, output contracts, edit behavior, video generation, or built-in fallback order.
- Broad cherry-picks or destructive history operations on the existing feature branch.

## Open questions

None.

## Approval gate
status: approved by user
approved-action: write `.omo/plans/openai-compatible-image-routing.md`
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
