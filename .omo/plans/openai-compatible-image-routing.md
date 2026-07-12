# openai-compatible-image-routing - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** Existing GPT, Gemini, and Grok image aliases will keep all current validation and image-generation behavior, while an explicit configuration switch can route their actual requests through one third-party OpenAI-compatible endpoint.

**Why this approach:** Provider routing is separated from model behavior. This reuses the mature alias adapters and the AI SDK's existing OpenAI-compatible transport without introducing another image API abstraction.

**What it will NOT do:** It will not add custom aliases, per-model mappings, profiles, arbitrary provider options, custom headers, or automatic retries to official providers.

**Effort:** Medium
**Risk:** Medium - the routing decision must remain identical across the core runtime and standalone tool bridge while preserving every existing alias path.
**Decisions to sanity-check:** The switch is v2-only, all aliases route together, canonical model IDs are fixed, and selected third-party routing never falls back after a request starts.

Your next move: Start execution, or request a high-accuracy plan review first. Full execution detail follows below.

---

> TL;DR (machine): Medium effort/risk; add a narrow v2 image-provider routing switch, preserve all alias adapters, and prove the third-party HTTP wire contract end to end.

## Scope
### Must have
- Start implementation from a clean worktree based on `upstream/main`; retain `rebuild/pr15-custom-image-provider` only as read-only reference.
- Add `tools.generate.image.provider` with exactly `default | openai-compatible`, defaulting to `default`.
- Keep `coreConfigInputSchemaV1` frozen and provide the universal default in `parseCoreConfigV1ToUniversal`.
- Deliver config consistently to Generate from both the core runtime and standalone tool bridge.
- Preserve all existing image aliases, fallback order, validators, prompt/edit adapters, output handling, and video behavior.
- Under OpenAI-compatible routing, construct every alias through `providers["openai-compatible"].imageModel(canonicalId)`.
- Fail clearly before generation when OpenAI-compatible routing is selected without a configured base URL.
- Prove generation and editing requests against a real local fake OpenAI-compatible HTTP endpoint.
### Must NOT have (guardrails, anti-slop, scope boundaries)
- No model lists, allowlists, aliases, mappings, profiles, defaults, `useWhen`, retries, or GPT-image normalization from the prior branch.
- No explicit `provider/model` model syntax; callers continue using existing Lilac aliases.
- No `providerOptions`, custom headers, query parameters, new environment variables, or new dependencies.
- No fallback to OpenAI/OpenRouter/xAI after OpenAI-compatible routing is selected, including configuration, HTTP, timeout, and response errors.
- No changes to image input schema, alias validators, canonical IDs, result shape, edit adapters, video generation, or built-in default routing.
- No reset, rebase, revert, or broad cherry-pick of the current feature branch.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD with `bun:test`; each behavioral todo begins with a focused failing test and records the expected failure before implementation.
- Evidence: .omo/evidence/task-<N>-openai-compatible-image-routing.<ext>
- Config tests assert v1 immutability, v1 universal fallback, v2 defaulting, valid selection, and invalid-provider rejection.
- Routing tests assert canonical IDs, unchanged alias validation, unchanged default provider preference, missing-config failure, and no post-request fallback.
- Wire QA uses `Bun.serve({ hostname: "127.0.0.1", port: 0 })` and drives the real `generate.image` surface for generation and editing.

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- Wave 1: Todos 1-3 establish the clean baseline, config contract, and config delivery seams.
- Wave 2: Todos 4-5 implement alias-preserving routing and user-facing configuration documentation.
- Wave 3: Todo 6 performs full integration verification and live manual QA.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 2, 3, 4, 5, 6 | none |
| 2 | 1 | 3, 4, 5, 6 | none |
| 3 | 2 | 4, 6 | 5 |
| 4 | 3 | 6 | 5 |
| 5 | 2 | 6 | 3, 4 |
| 6 | 4, 5 | final wave | none |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Establish a clean upstream implementation baseline
  What to do / Must NOT do: Create or use a clean worktree/branch at `upstream/main`; record `git status`, baseline SHA, and `git diff --stat upstream/main`. Keep the current `rebuild/pr15-custom-image-provider` branch untouched and use individual files only as read-only evidence. Do not reset, revert, rebase, or cherry-pick its feature commits.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 2, 3, 4, 5, 6
  References (executor has NO interview context - be exhaustive): `AGENTS.md`; `upstream/main:apps/core/src/tool-server/tools/generate.ts`; current branch commits `717eb41`, `1c4c811`, `65aca14`, `d518f54` are reference-only.
  Acceptance criteria (agent-executable): `git merge-base HEAD upstream/main` equals the recorded baseline before product edits; `git status --short` contains no unrelated tracked changes; evidence records the branch/worktree path and SHA.
  QA scenarios (exact tool + invocation): happy: `git status --short --branch` and `git diff --stat upstream/main`; failure: detect any inherited tracked feature diff and stop before editing. Evidence `.omo/evidence/task-1-openai-compatible-image-routing.txt`.
  Commit: N | workspace setup only

- [x] 2. Add the minimal versioned image-routing config contract with TDD
  What to do / Must NOT do: First add failing `bun:test` cases for v1 universal fallback, omitted v2 default, accepted `openai-compatible`, and rejected unknown values. Then add `tools.generate.image.provider` as exactly `"default" | "openai-compatible"` in universal types and v2 Zod parsing. Keep `coreConfigInputSchemaV1` byte-for-byte unchanged; only add the universal fallback in `parseCoreConfigV1ToUniversal`. Do not add models, mappings, profiles, provider options, or defaults beyond this enum.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3, 4, 5, 6
  References (executor has NO interview context - be exhaustive): `packages/utils/core-config/types.ts`; `packages/utils/core-config/v2.ts`; `packages/utils/core-config/v1.ts`; `packages/utils/tests/core-config.versioning.test.ts`; `packages/utils/tests/core-config.drift.test.ts`; `AGENTS.md` Core Config rules.
  Acceptance criteria (agent-executable): focused tests fail for the missing field before implementation and pass afterward; v1 input schema has no new key; universal v1 output and omitted v2 output equal `{ provider: "default" }`; v2 accepts only the two enum values. Run `cd packages/utils && bun test tests/core-config.versioning.test.ts tests/core-config.drift.test.ts` and `bunx tsc -p tsconfig.json --noEmit`.
  QA scenarios (exact tool + invocation): happy: parse v2 YAML with `provider: openai-compatible`; failure: parse `provider: arbitrary` and assert the Zod error points to `tools.generate.image.provider`. Evidence `.omo/evidence/task-2-openai-compatible-image-routing.txt`.
  Commit: Y | `feat(config): add image provider routing switch`

- [x] 3. Deliver the routing config to Generate in both server entrypoints
  What to do / Must NOT do: Add narrow lazy config access to Generate following the existing `ContentInspect`/`runtime.getConfig` pattern, then wire it in the built-in server-tools plugin and standalone tool bridge. Config must be read at resolution time so tests and runtime reload behavior remain deterministic. Do not pass the whole config through unrelated tools or create a broad plugin-manager abstraction solely for this feature.
  Parallelization: Wave 1 | Blocked by: 2 | Blocks: 4, 6 | Can parallelize with: 5
  References (executor has NO interview context - be exhaustive): `apps/core/src/plugins/builtin/server-tools.ts`; `apps/core/src/tool-server/tools/content-inspect.ts` lazy config precedent; `apps/core/src/tool-server/tools/generate.ts` `Generate`; `apps/tool-bridge/index.ts`; `packages/utils/core-config/types.ts`.
  Acceptance criteria (agent-executable): focused construction tests prove both entrypoints deliver `default` and `openai-compatible` to Generate without import-time env mutation; `cd apps/core && bunx tsc -p tsconfig.json --noEmit`; `cd apps/tool-bridge && bunx tsc -p tsconfig.json --noEmit`.
  QA scenarios (exact tool + invocation): happy: instantiate each entrypoint with a test config getter and observe selected routing through the public tool listing/call seam; failure: config getter rejection propagates with context and does not silently choose default. Evidence `.omo/evidence/task-3-openai-compatible-image-routing.txt`.
  Commit: Y | `refactor(generate): inject image routing config`

- [x] 4. Route existing aliases through OpenAI-compatible model factories with TDD
  What to do / Must NOT do: Before implementation, add failing routing and wire tests. Extend each existing image descriptor with one canonical ID while preserving its alias, validator, official provider factory, descriptor ordering, and fallback order. Under `default`, execute exactly the upstream factory. Under `openai-compatible`, require the configured provider and call `.imageModel(canonicalId)`: `gpt-image-1.5`, `google/gemini-2.5-flash-image`, `google/gemini-3.1-flash-image-preview`, `google/gemini-3-pro-image-preview`, `grok-imagine-image`, and `grok-imagine-image-pro`. Missing base URL must throw one stable configuration error before provider fallback. Once selected, all HTTP/timeout/response failures propagate with no official retry. Do not modify schemas, validation, prompt/edit conversion, output processing, or video code.
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 6 | Can parallelize with: 5
  References (executor has NO interview context - be exhaustive): `apps/core/src/tool-server/tools/generate.ts` `SupportedImageModelId`, `DEFAULT_IMAGE_MODEL_FALLBACK_ORDER`, validators, `IMAGE_MODEL_DESCRIPTORS`, `resolveAvailableModels`, `getAvailableImageModels`, `pickModel`, `generateImageWithModel`, `Generate.list`, `Generate.callGenerateImage`; `packages/utils/model-provider.ts:104`; `packages/utils/env.ts:66`; `apps/core/tests/tool-server-image-generation.test.ts`.
  Acceptance criteria (agent-executable): red tests fail on upstream routing, then pass; every alias reaches the fake endpoint with the exact canonical `model`; existing invalid size/aspect/edit combinations fail before HTTP; `default` retains upstream provider preference; missing base URL yields the stable config error and zero requests; a fake 500 produces one request and no fallback. Run `cd apps/core && bun test tests/tool-server-image-generation.test.ts` and `bunx tsc -p tsconfig.json --noEmit`.
  QA scenarios (exact tool + invocation): happy: `Bun.serve` captures `POST /v1/images/generations` with bearer auth, canonical model, original prompt, and `response_format: "b64_json"`, returns a 1x1 PNG, and the real tool writes the expected artifact; editing: capture multipart `POST /v1/images/edits`; failure: return HTTP 500 and assert exactly one request plus surfaced error. Evidence `.omo/evidence/task-4-openai-compatible-image-routing.txt` and generated PNG under `.omo/evidence/`.
  Commit: Y | `feat(generate): route image aliases through compatible provider`

- [x] 5. Document the routing switch without expanding the feature surface
  What to do / Must NOT do: Add the v2 example configuration and migration note explaining that the switch changes transport only, all aliases/adapters remain, canonical IDs are fixed, and endpoint/key use existing env vars. Update `.env.example` only to mention image use of the existing variables. Keep documentation concise; do not describe unsupported mappings, custom options, headers, retries, or multiple endpoints.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 6 | Can parallelize with: 3, 4
  References (executor has NO interview context - be exhaustive): `packages/utils/config-templates/core-config.example.yaml`; `.env.example`; `MIGRATIONS.md`; `PROJECT.md`; `packages/utils/prompt-templates/TOOLS.md` only if its existing generate documentation becomes inaccurate.
  Acceptance criteria (agent-executable): example config parses through v2; docs contain the exact enum value and existing env names; no unsupported feature terms are introduced; `bun run fmt` leaves documentation/config formatted.
  QA scenarios (exact tool + invocation): happy: parse the copied example with the package config parser; failure: verify an unknown provider shown nowhere and remains rejected by the schema. Evidence `.omo/evidence/task-5-openai-compatible-image-routing.txt`.
  Commit: Y | `docs(generate): document compatible image routing`

- [x] 6. Verify the complete feature through package and live surfaces
  What to do / Must NOT do: Run focused tests, package typechecks/builds, monorepo tests, lint fix, and formatter. Start the real standalone tool server against a local fake OpenAI-compatible endpoint and invoke `generate.image` through the built `tools` CLI, covering one successful alias request and one upstream failure. Confirm the output file and captured HTTP request. Do not treat unit tests or direct helper calls as the manual QA gate.
  Parallelization: Wave 3 | Blocked by: 4, 5 | Blocks: final wave
  References (executor has NO interview context - be exhaustive): `AGENTS.md` build/test/typecheck commands; `apps/tool-bridge/index.ts`; `apps/tool-bridge/package.json`; `README.md` Running section; Todo 4 wire contract.
  Acceptance criteria (agent-executable): `cd apps/core && bun run build:remote-runner`; `cd apps/tool-bridge && bun run build`; both package typechecks; focused package tests; root `bun test`; root `bun run lint:fix`; root `bun run fmt`; final `git diff --check`. Any pre-existing failure is separated by reproducing it on the clean baseline and recorded rather than hidden.
  QA scenarios (exact tool + invocation): happy: launch fake endpoint and `bun apps/tool-bridge/index.ts`, invoke built CLI `generate.image` with an existing alias, inspect captured request and PNG artifact; failure: fake endpoint returns 500, CLI surfaces it, fake records exactly one request, and no official provider receives a request. Evidence `.omo/evidence/task-6-openai-compatible-image-routing.txt` plus request capture and PNG artifact.
  Commit: N | verification only; commit formatter changes with the owning todo if needed

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit: compare the final diff against every Must have/Must NOT have item and canonical ID; evidence `.omo/evidence/f1-plan-compliance.txt`.
- [x] F2. Code quality review: inspect type safety, config boundary, descriptor responsibility, error semantics, and unchanged video/default routing; evidence `.omo/evidence/f2-code-quality.txt`.
- [x] F3. Real manual QA: independently repeat the tool-server + CLI happy and HTTP-500 scenarios against a fresh fake endpoint; evidence `.omo/evidence/f3-manual-qa.txt` and artifacts.
- [x] F4. Scope fidelity: compare `git diff upstream/main` against the prior branch's 15-file/+1603 implementation and reject profiles, mappings, provider options, retries, or unrelated changes; evidence `.omo/evidence/f4-scope-fidelity.txt`.

## Commit strategy

- Use the four atomic commits named in Todos 2, 3, 4, and 5; combine Todos 3 and 4 only if the repository cannot compile between the config-injection and routing states.
- Stage only files owned by the current todo; never stage `.omo/`, `.serena/`, generated evidence, or unrelated user changes.
- Before each commit inspect `git status`, staged diff, and recent commit-message style. Do not amend or push unless explicitly requested.

## Success criteria

- Existing aliases and their visible validation/output behavior are unchanged under `provider: default`.
- `provider: openai-compatible` sends each alias to the existing endpoint with the exact approved canonical model ID and bearer API key.
- Missing endpoint configuration and upstream failures never fall back or generate duplicate requests.
- Core runtime and standalone tool bridge behave identically.
- v1 input remains frozen; v2/default/universal config semantics are covered by tests.
- Focused tests, package typechecks/builds, root tests, lint, format, and diff checks pass or have baseline-proven pre-existing failures.
- Real CLI-driven generation and failure scenarios produce inspectable wire captures and output evidence.
- Final diff contains none of the prior implementation's out-of-scope profiles, mappings, options, retries, or normalization machinery.
