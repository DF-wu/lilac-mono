# Core configuration documentation audit — 2026-10-08

Source baseline: `DF-wu/lilac-mono` main at `213ad849`.
Scope: current source, `packages/utils/config-templates/core-config.example.yaml`, and
`docs/core-config-migrations.md`. Changes are documentation/comment/example corrections only, except
removing the retired `batch` name from the active explore tool list. Schema definitions, runtime code, dependencies, and tests are unchanged.

## Corrected findings

| Finding and correction | Source evidence |
| --- | --- |
| Retired `batch` remained exposed by explore and documented as an active expansion feature. Removed exposure; documented `tools.batch.maxCalls`, `supportsBatch`, and `editTargets` as inert compatibility only. | `MIGRATIONS.md:35`; `packages/utils/core-config/v2.ts` still carries the compatibility default. |
| Version/default and validation notes were incomplete. Documented numeric versions, omission versus null, unknown-key warnings, strict blob adapter failures, removed-field failures, and model option warning limits. | `packages/utils/core-config/parse.ts`; `core-config/v1.ts`; `core-config/v2.ts`; `core-config/unknown-keys.ts`; `core-config.ts`. |
| Blanket duration guidance obscured numeric-only millisecond fields and retention exceptions. Added a field-specific units table and local template notes, including decimal/binary bytes, fixed 30-day months, positive ranges, `unlimited`, and native `null` ages. | `packages/utils/friendly-units.ts`; `core-config/v1.ts`; `core-config/v2.ts`; `core-config/telegram-surface.ts`. |
| Filesystem and web selection semantics were missing. Documented `fff`/`node-rg`, fuzzy search availability, ordered configured provider chains, terminal versus retryable failures, five fetch modes, and extraction's search-only-provider skip. | `apps/core/src/plugins/builtin/local-tools.ts`; `plugins/manager.ts`; `packages/fs/src/fs-impl.ts`; `apps/core/src/tool-server/tools/web.ts`; `web-search/resolve-provider.ts`; `web/provider-page-extraction.ts`. |
| Output, media, and historical pruning were easy to conflate. Documented transient overflow resources, artifact quota/TTL and storage failures, decoded binary budgets, and model-view pruning versus transcript deletion. | `packages/tool-results/src/tool-result-output-normalizer.ts`; `apps/core/src/surface/bridge/bus-agent-runner.ts` (`maybeMarkOldToolOutputsCompacted`, media composition). |
| Plugin and reload boundaries were incomplete. Documented plugin IDs/config ownership/discovery, consumer refresh versus resource reconstruction, blob offline cutover/restart, Discord connection fields, Native startup/auth fields, and Telegram's pinned restart fields. | `apps/core/src/runtime/create-core-runtime.ts`; `plugins/manager.ts`; `packages/plugin-runtime/discovery.ts`; `surface/discord/discord-adapter.ts`; `surface/telegram/telegram-adapter.ts`; `surface/telegram/telegram-surface-runtime.ts`; `MIGRATIONS.md:632`. |
| Native title-model text implied YAML was a continuing control. Updated it and documented all five initial-import deployment fields, database precedence after restart, and Settings > Deployment. | `apps/core/src/surface/native/runtime.ts` (`initializeDeployment`); `surface/native/store.ts`; `packages/utils/core-config/v2.ts`. |
| Duplicate commented `basePrompt` and three separate `def` examples encouraged accidental duplicate YAML keys. Kept the active base prompt, consolidated one commented preset mapping, explained selection opt-in and alias constraints, and used defined aliases in session examples. | `packages/utils/core-config/v2.ts`; `packages/utils/model-slot.ts`; `apps/core/src/surface/bridge/bus-agent-runner/prompt-overlays.ts`. |
| Fallback family terminology obscured cross-vendor support. Clarified `ai-sdk` versus `claude-code`, permitted cross-vendor AI SDK fallback, and retained precedence/empty-chain guidance. | `apps/core/src/agent/agent-composition.ts` (`selectNextNativeModelFallback`); `packages/agent/session-continuation.ts` (`classifyHistoryProviderFamily`). |
| Adaptive Anthropic thinking incorrectly included `budgetTokens`; OpenRouter example carried Anthropic/gateway controls; slot examples mixed flat values with namespaces. Corrected provider-specific maps and alternatives; retained OpenRouter's supported temperature forwarding. | `packages/utils/model-provider-option-validation.ts`; `model-provider-option-shapes.generated.ts`; installed `@ai-sdk/anthropic` and `@openrouter/ai-sdk-provider` declarations/implementations under `packages/utils/node_modules`. |
| Capability example inherited itself, causing an override cycle. Changed the base to `anthropic/claude-opus-4.6`; documented explicit overrides before forced-unknown registry lookup, manual completeness, and inherited-base resolution failures. | `packages/utils/model-capability.ts` (`resolveWithOverridesResult`, `mergeCostPatchResult`, `mergeModalitiesPatchResult`); `core-config/v2.ts`. |
| Heartbeat output format did not specify supported clients or GitHub's concrete session grammar. Documented Discord IDs/aliases and `github/OWNER/REPO#NUMBER`, with an example and access caveat. | `packages/utils/core-config/v1.ts` (`heartbeatOutputSessionSchema`); `apps/core/src/heartbeat/common.ts` splits at the first slash; `apps/core/src/github/github-ids.ts`. |

## Rejected or qualified claims

- **OpenAI cannot automatically fall back to Anthropic:** rejected. Both use the `ai-sdk` history
  family. The automatic fallback exclusion applies to `claude-code`, not upstream vendors.
- **Entity comments are not prompt-visible:** rejected. `appendConfiguredAliasPromptBlock` in
  `apps/core/src/surface/bridge/bus-agent-runner/prompt-overlays.ts` renders comments and appends the
  block to the system prompt. The existing correct note remains; comments must suit that audience.
- **Null configVersion works like omission:** only true at dispatch. Direct checks show `{}` parses as
  v1; `{ configVersion: null }` selects v1 but fails with `Invalid input: expected 1`. Documentation
  records the actual behavior; resolving this inconsistency would require an out-of-scope code change.
- **Every duration accepts friendly suffixes:** rejected. Router/heartbeat/retry/idle/Telegram streaming
  fields use numeric schemas. New friendly-unit fields have their own ranges and sentinel values.
- **Every parsed manual capability override is incomplete until runtime:** rejected. V2 already checks
  required context, cost pairs, and modalities input without inheritance. Inherited bases and cycles
  still need runtime resolution.
- **Every configuration edit requires restart:** rejected. Filesystem toolsets read current config;
  only fff prewarming is startup-only. Native deployment settings belong to the database, while blob,
  Native listener/auth, and Telegram connection resources have actual startup boundaries.
- **Enabled Anthropic thinking always requires budgetTokens in the installed SDK schema:** rejected.
  The SDK permits omission; adaptive thinking does not accept that field. Upstream acceptance remains
  endpoint/model-specific. No schema or provider behavior was changed.
- **Zero provider-option warnings prove upstream validity:** rejected. The checker validates names,
  not values or selected union branches, and leaves permissive namespaces such as OpenRouter alone.
  OpenRouter reasoning/temperature examples were additionally checked against the installed provider
  types/forwarding code. No network call or model-availability assertion was made.

## Validation

Final independent review also corrected participant filtering: both recall lanes apply the filter
to Discord/Telegram origins with recovered IDs, retaining matching same-platform and Native threads.
Native origins and requests without IDs continue unfiltered by participant. Evidence:
`bus-agent-runner.ts` (shortlist/search arguments), `thread-store.ts` (participant platform filter),
and `telegram-request-router-publish.ts` (participant IDs).

- Final focused config test suite: **173 passed, 0 failed** across 19 files (428 assertions),
  including versioning, drift, unknown-key, provider-option, capability, Native and Telegram config tests.
- Independent temporary Bun script: the active YAML parses with **zero unknown-key and model-option
  warnings**; its entire universal config equals the original HEAD template after removing only
  explore's `batch` entry. Defaults such as `tools.batch.maxCalls: 8` remain unchanged compatibility
  values, and active `basePrompt: "You are Lilac."` remains unchanged.
- The same script uncommented the consolidated preset and capability mappings and checked profile,
  direct OpenAI/OpenRouter/compatible slot options, and Discord/GitHub heartbeat examples: all parse
  without warnings. It does not verify credentials, available models, or remote API support.
- `bunx tsc -p packages/utils/tsconfig.json --noEmit`: passed. The utils package has no `typecheck`
  script, so the repository's underlying TypeScript invocation was used directly.
- `git diff --check`: passed. Final changes are limited to the two requested documentation files and
  this report. Full repository verification is recorded in the pull request checks.
