# Claude Agent SDK AI SDK Integration Todo

Source: `plan/claude-agent-sdk-ai-sdk-integration.md`

Status key: `[ ]` pending, `[~]` in progress, `[x]` complete, `[-]` explicitly deferred.

## Agreed Decisions

- [x] Target Core first; defer Mini Lilac until the shared boundary is proven.
- [x] Use `ai-sdk-provider-claude-code` rather than maintain a language-model adapter.
- [x] Keep authentication entirely in official local Claude tooling.
- [x] Disable Claude built-ins with `tools: []`.
- [x] Isolate ambient Claude settings with `settingSources: []`.
- [x] Disable Claude transcript persistence with `persistSession: false`.
- [x] Expose Lilac Level-1 tools through an in-process MCP server.
- [x] Keep `batch` out of MCP and preserve `ToolExpansion` as outer-loop-only behavior.
- [x] Target full observable tool execution parity.
- [x] Use hybrid native steering and interruption controls.
- [x] Use a separate no-tools utility model.

## Stage 1: Plan And Baseline

- [x] Persist the complete agreed implementation plan.
- [x] Create this compaction-safe progress tracker.
- [x] Confirm the worktree is clean before implementation.
- [x] Inventory the existing agent execution, provider resolution, Core run wiring, compaction, and
  control paths.
- [x] Confirm the upstream helper cannot preserve the agreed parity.
- [x] Add exact provider/MCP dependencies and run a Bun import/model-construction smoke test.

Stage 1 validation: Bun successfully imported `ai-sdk-provider-claude-code@4.0.1`, created an
isolated provider, and materialized `claude-code/sonnet`. `@modelcontextprotocol/sdk@1.29.0` is
installed directly in Core for the in-process bridge.

## Stage 2: Shared Atomic Tool Execution

- [x] Add a reusable atomic tool execution module under `packages/agent`.
- [x] Move shared output conversion, invalid-input classification, async iterable handling, and
  normalization behavior into the module.
- [x] Support caller-selected input validation and expansion capture/rejection.
- [x] Preserve start/update/end events and pending-tool tracking.
- [x] Replace the nested executor in `AiSdkPiAgent` without moving scheduling/transcript/expansion
  orchestration.
- [x] Keep all existing `ToolExpansion` and batch behavior passing unchanged.
- [x] Add focused atomic executor tests.

## Stage 3: In-Process MCP Bridge

- [x] Add a Core-side or shared bridge using `@modelcontextprotocol/sdk` and an Agent SDK-compatible
  in-process server instance.
- [x] Build declarations and validation through AI SDK `asSchema`.
- [x] Expose all atomic Level-1 tools except `batch`.
- [x] Reject direct calls to omitted or expansion-returning tools.
- [x] Route calls through the shared atomic executor with current messages/context/signal.
- [x] Map every supported `ToolResultOutput` variant into MCP content/results.
- [x] Implement bounded single-use nonce correlation from `canUseTool.toolUseID` to MCP calls.
- [x] Fail closed for invalid correlation and unknown tools.
- [x] Clear bridge state on completion, interruption, cancellation, and disposal.
- [~] Add focused schema, correlation, result mapping, parallel call, and abort tests.

## Stage 4: Provider And Model Resolution

- [x] Register credentialless `claude-code` in `packages/utils/model-provider.ts` with isolated
  no-tools defaults.
- [x] Add the `claude-code -> anthropic` model-capability alias.
- [~] Verify direct refs, aliases, slots, and durable rehydration.
- [x] Add focused provider/model-slot/model-capability tests.

## Stage 5: Core Per-Run Integration

- [x] Add a Core Claude materialization helper after Level-1 tool construction.
- [x] Create a run-scoped tool-enabled model and separate no-tools utility model.
- [x] Retain Level-1 tools for MCP execution while omitting ordinary AI SDK tool declarations from
  Claude `streamText()` calls.
- [x] Set cwd, isolated settings, disabled persistence, disabled built-ins, MCP server, correlation
  callback, streaming input, and control callbacks.
- [x] Disable direct read-file attachment assumptions only if rich MCP output mapping cannot preserve
  them.
- [x] Use the utility model for compaction and other utility generation.
- [x] Add Core materialization tests.

## Stage 6: Provider Transcript And Display Parity

- [x] Normalize provider-executed inline tool results.
- [x] Preserve inline provider tool exchanges through valid-boundary repair.
- [x] Rewrite paired inline call/result IDs during Claude ID normalization.
- [x] Preserve provider exchanges through auto-compaction repair.
- [~] Preserve provider exchanges through Core historical output pruning and recovery checkpoints.
- [x] Strip only `mcp__lilac__` for user-facing status/display.
- [x] Update heartbeat handoff handling if Claude-backed heartbeat runs are supported.
- [ ] Add focused transcript, compaction, recovery, and display tests.

## Stage 7: Hybrid Controls

- [x] Add run-scoped storage for the Claude message injector and query controller.
- [x] Inject normal text steering and acknowledge it exactly once in the canonical transcript.
- [x] Leave failed or unsupported structured steering queued for the next boundary.
- [x] Implement native hard interrupt with Lilac recovery fallback.
- [x] Implement best-effort native cancellation followed by authoritative Lilac reset.
- [x] Clear controls and correlation state at every terminal path.
- [~] Add steering, interrupt, fallback, and cancellation tests.

## Stage 8: Documentation And Validation

- [x] Document `claude-code/<model>` configuration and `claude auth login` prerequisite.
- [x] Document credential ownership, isolation, disabled built-ins/settings, and omitted `batch`.
- [x] Run focused package tests.
- [x] Run changed-package TypeScript checks.
- [x] Run the Core test suite.
- [x] Run the monorepo test harness if focused validation passes.
- [x] Run root `bun run lint:fix`.
- [x] Run root `bun run fmt`.
- [x] Inspect final git diff for unintended changes.

## Stage 9: Final Review

- [x] Review the complete implementation for behavioral regressions, parity gaps, credential
  handling, transcript corruption, and missing tests.
- [x] Fix concrete findings without adding hosted auth or Claude ambient behavior.
- [x] Re-run focused tests, typechecks, lint, and formatting.
- [x] Record validation results and residual risks here.

## Validation Results

- `packages/agent`: 86 tests passed; TypeScript check passed.
- `packages/utils`: 255 tests passed; TypeScript check passed.
- `apps/core`: 1211 tests passed; TypeScript check passed.
- Monorepo harness: 3 tests passed.
- Root lint fix and formatter completed without errors.

## Residuals And Blockers

- None currently requiring a product decision.
- Authenticated Claude execution is not testable without the operator's local Claude session. The
  exact `canUseTool.updatedInput` nonce round trip still needs a real authenticated smoke test.
- Historical inline provider-result pruning and Claude-backed heartbeat handoff extraction remain
  pending parity work; recovery checkpoints and auto-compaction already preserve inline exchanges.
- Stop for a decision if Bun cannot host the provider reliably and a Node sidecar is required.
- Stop for a decision if exact tool-use correlation cannot be made reliable with the selected
  provider/Agent SDK versions.

## Deferred

- [-] Mini Lilac integration.
- [-] Ambient Claude user/project/local settings.
- [-] Claude built-in tools, native subagents, plugins, and skills.
- [-] Hosted or Lilac-owned OAuth/token handling.
