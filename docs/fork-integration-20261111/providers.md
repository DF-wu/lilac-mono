# Provider, compaction, and configuration integration evidence

Scope: F09–F14 and F23 in `catalina/pr101-integration-20261111`, using fork
`3c01ce2c29a66fa9be573f573c9865b7cb20c030`, upstream
`3493c0c6c06260e6c472bd230dc02d4b0308db43`, and base
`05c41baa7a45b728d1722d69d5e55d5dc9e580b4`. The saved fork audit was checked against
these sources and the current merge. The fork production adapters automerged and the focused checks
did not expose a production defect. Changes in this work are regression tests and a rebuilt external
example bundle. Models, aliases, `agentCanSelect`, operator configuration, and stored data were not
changed.

## Dispositions and source owners

| Finding | Disposition and owner | Preserved behavior and evidence |
| --- | --- | --- |
| F09 Responses hosted search | Retain the isolated Core web-search adapter. `apps/core/src/tool-server/tools/web-search/openai-web-search-provider.ts`, `openai-web-search-model.ts`, `web.ts`; shared schema composition in `packages/utils/core-config/openai-web-search.ts`. | The configured search model selects the explicit OpenAI or compatible endpoint. Requests require hosted search. Completed responses require search-call evidence; citations precede deduplicated uncited sources. Explicitly failed searches trigger provider failure/fallback, while a successful empty search remains empty. Extraction skips the search-only provider. Existing provider/model/web tests pass; no adapter rewrite was needed. |
| F10 compatible image scripts | Retain the small Core provider-descriptor adapter. `apps/core/src/tool-server/tools/image-script-openai-compatible.ts` and `image-script.ts`. | A trimmed compatible base URL enables `providers.openaiCompatible`; the key is optional and trailing slashes are removed. Existing compatible recipe tests and upstream script-runner tests pass, including strict code-only input, restricted-call denial, redaction, bounded output, cancellation, deadline, descendant termination, and native provider recipes. Retired structured image routing remains retired. |
| F11 external custom-media | Retain the external Level-2 example. `examples/plugins/custom-media/src/` owns its provider calls, Result mapping, models, paths, image edits, and video protocol. `dist/index.js` is the deployed entry. | New tests invoke both source and actual bundled factories against local image and video fixtures. Both expose the same callable IDs and Result success/error methods, write the returned media, use the expected submit/poll/content endpoints, return typed invalid-input errors, and map cancellation without leaving an output file. Existing tests additionally cover named multipart images/masks, bounded downloads, unique paths, terminal video errors, credential redaction, and defect/Panic identity. |
| F12 compatible finish reasons | Retain the one-line AI SDK execution patch. `packages/agent/adapters/ai-sdk/adapter.ts`. | Parsed local calls execute for non-length reasons through the normal host authority/validation path. New tests cover `other` with parallel valid calls, malformed JSON, and a provider-executed call: valid local siblings execute once, malformed input becomes an error result, and provider work is not repeated locally. A separate length test proves parsed calls are not executed and recovery closes the exchange. Existing continuation, provider-result, retry, checkpoint, and cancellation tests pass. |
| F13 compatible tool images | Retain the provider-view middleware. `packages/utils/openai-compatible-tool-images.ts`; construction in `model-provider.ts`. | A new integration test runs actual compaction followed by the compatible Chat serialization: the canonical active input and image tool results remain unchanged, all parallel tool replies precede the labeled user image input, and image bytes stay out of serialized tool text. A new official Responses wire test confirms that protocol receives no lifted user message or shim labels. Existing factory/stream/generate, replay, URL image, text-only, and non-image tests pass. |
| F14 protected current input | Keep the small protected-boundary patch on upstream canonical compaction. `packages/agent/auto-compaction.ts` owns selection and compaction; Core runner/lineage owns the supplied and remapped offset. | New package tests retain exact canonical text spacing, image/document bytes, filenames and provider metadata across repeated compaction and manual compaction of a resumed recovery checkpoint. Completed image tool call/result pairs survive without reexecution. The server-compaction test now protects multipart input, excludes it from both server and local summary inputs, and verifies rejection falls back to the portable summary without changing active parts. Existing zero/nonzero boundary, invalid-bound, omitted/null behavior, threshold, overflow, and manual tests pass. Core's mapping regression is owned by the runtime integration worker. |
| F23 schema/editor compatibility | Retain V2 fork composition and lazy mutable defaults; preserve frozen V1 input and upstream V3 inheritance. `packages/utils/core-config/`; Core's `apps/core/scripts/generate-config-schemas.ts` owns editor generation. | New editor/runtime cases cover both V2 and V3 Telegram/hosted-search fields, normalized units/provider order, and V1 rejection/absence. The provider-alias matrix now includes V3: canonical plural extraction is accepted; legacy singular/search aliases remain rejected. Existing independent-default, versioning, V3 removal and frozen V1 tests pass. Generated schemas are fresh. |

## Commands and results

All commands used the exact repository Bun version, 1.4.4 (`38afee6c8`), through this prefix:

```sh
rtk proxy env PATH=/home/df/workspace/lilac-pr101-checkpoint-20261111/toolchain/package/bin:$PATH
```

Commands below are relative to the integration root unless an example cwd is stated. Focused test
invocations use the root `test:root` script. The root workspace typecheck script has no workspace
selector, so the affected workspaces were checked with its underlying compiler invocation separately.

| Command after the prefix | Result |
| --- | --- |
| `bun run test:root -- ./packages/agent/tests/auto-compaction.test.ts ./packages/agent/tests/ai-sdk-pi-agent.test.ts` | 161 passed, 0 failed. |
| `bun run test:root -- ./packages/utils/tests/openai-compatible-tool-images.test.ts ./packages/utils/tests/core-config.fork-v3.test.ts ./packages/utils/tests/core-config.web-search-provider.test.ts ./packages/utils/tests/core-config.versioning.test.ts ./packages/utils/tests/core-config.telegram-surface.test.ts ./packages/utils/tests/core-config.v3-removals.test.ts` | 105 passed, 0 failed. |
| `bun run test:root -- ./apps/core/tests/tools/web-search-openai.test.ts ./apps/core/tests/tools/web-search-openai-model.test.ts ./apps/core/tests/tools/web.test.ts ./apps/core/tests/tool-server/image-script-openai-compatible.test.ts ./apps/core/tests/runtime/config-schemas.test.ts ./apps/core/tests/runtime/config-schema-generator.test.ts` | 82 passed, 0 failed. |
| `bun run test:root -- ./apps/core/tests/tool-server-image-generation.test.ts` | 16 passed, 0 failed. |
| `bunx tsc -p packages/agent/tsconfig.json --noEmit` | Passed. |
| `bunx tsc -p packages/utils/tsconfig.json --noEmit` | Passed. |
| `bunx tsc -p apps/core/tsconfig.json --noEmit` | Passed. |
| `bun run codegen:config-schemas:check` | Passed; no schema regeneration needed. |
| `bun install --frozen-lockfile` in `examples/plugins/custom-media` | Installed its separate locked dependencies; no lockfile change. |
| `bun run test` in `examples/plugins/custom-media` | 25 passed, 0 failed, including committed-bundle parity before rebuild and rebuilt-bundle parity after rebuild. |
| `bun run typecheck` in `examples/plugins/custom-media` | Passed. |
| `bun run build` in `examples/plugins/custom-media` | Passed, 118 modules bundled. |
| `bun run fmt:check` in `examples/plugins/custom-media` | Passed. |
| `bunx oxlint --tsconfig tsconfig.json packages/agent/tests/auto-compaction.test.ts packages/agent/tests/ai-sdk-pi-agent.test.ts packages/utils/tests/openai-compatible-tool-images.test.ts apps/core/tests/runtime/config-schemas.test.ts examples/plugins/custom-media/tests/bundle-parity.test.ts` | Passed. |
| `bunx oxfmt --check` on the five changed test files | Passed; the supplied bundle path is ignored by formatter configuration. |
| `rtk git diff --check` on the changed tracked provider test/bundle files | Passed; this command used `rtk` directly. |

The rebuild preserves 335,519 bytes and 95 lines. Inspecting the generated diff found only the same
88-byte Zod export-initialization statement moved from line 45 to line 3 by Bun 1.4.4. The rebuilt
artifact is retained; no example source or dependency contract changed.

## Limits and residual verification

- All provider traffic in these checks used local servers or intercepted fetches. No live provider,
  deployed gateway, operator configuration, private transcript, or runtime database was accessed.
- F13 requires an endpoint and model that accept user image inputs. The middleware has no vision
  capability gate. It leaves text/non-image behavior and official Responses on their existing paths;
  it does not make a nonvision endpoint accept images. This limitation already appears in
  `docs/fork-differences.md` and remains explicit here.
- F14 protects canonical input after normal ingress normalization, not a caller's pre-normalization
  message representation. A missing/null current-input lineage offset intentionally keeps upstream
  behavior. Protection cannot make an oversized active request fit a model; real overflow still
  recovers or fails explicitly rather than deleting active parts. The package recovery test uses the
  real agent recovery-checkpoint callback and resumes those messages; it does not claim a live Core
  WAL/process-restart test. Core offset remapping/restored-lineage checks are the runtime worker's
  separate evidence.
- OpenAI hosted-search time/topic constraints remain model instructions, not strict upstream date
  filters. Compatibility with a specific external Responses gateway remains deployment verification.
- Custom-media remains an independently installed example outside the root workspace test loop;
  absent in-repo plugin installs are not evidence that operator deployments do not use it. Existing
  restricted-call admission policy is unchanged.
- No architecture registrations, root scripts, configuration options, or subsystems were added. The
  parent integration owns repository-wide checks and footprint bookkeeping. This worker ran no full
  repository check and created no commit.

The repository gate now also runs `test:custom-media`: a frozen example install, its source/bundle tests and its typecheck. It is covered even though the example is outside the workspace loop.
