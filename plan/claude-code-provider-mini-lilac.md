# Claude Code Provider Support For Mini Lilac

## Status

> **Historical and partially superseded.** This records the Mini provider implementation completed
> 2026-07-26. It is not the authority for current persistence, built-in-tool, or deployment behavior.
> Sections below preserve the original design and validation context even where later work changed
> it. Current behavior is documented in `apps/mini-lilac-server/README.md` and
> `plan/claude-code-native-session-continuation.md`.

This was a follow-up to `plan/claude-agent-sdk-ai-sdk-integration.md`, which implemented the
`claude-code` provider in Core and explicitly deferred Mini Lilac.

Authenticated pass done against a live Claude subscription: streaming, a `read_file` call through the
MCP bridge under Claude's own `toolu_…` id (confirming the nonce round trip that was the plan's main
open risk), and the packaged bundle. Not yet exercised by hand: steering, cancel, compaction,
subagent delegation, and resume after restart.

Follow-up clarification (2026-08-01): this document records the original Mini provider port. The
blanket no-persistence decision was superseded by
`plan/claude-code-native-session-continuation.md`. Mini main and named subagent sessions now start
fresh persisted or fork an exact compatible binding, including generated names returned after an
omitted `sessionName`; utility models remain `persistSession: false`. The shared bridge also always appends `ToolSearch`
for deferred Lilac MCP discovery. Mini conditionally adds `WebSearch`; Core adds no profile-requested
built-in but also has `ToolSearch`. The published Mini bundle still requires an external `claude`
executable on `PATH`, while Core Docker can use the SDK-bundled executable with operator-provided
authentication.

## Historical Goal

Let a Mini Lilac operator select a Claude model backed by their own local Claude Code / Claude Agent
SDK authentication, with the same guarantees Core already ships:

- Lilac never reads, stores, refreshes, or transmits a Claude credential; `claude auth login` owns it.
- At initial release, Claude built-in tools, ambient filesystem settings, and Claude transcript
  persistence were disabled. The later native-continuation work supersedes only the blanket
  persistence part as described above.
- Lilac Level-1 tools reach Claude only through the run-scoped in-process `lilac` MCP server.
- Tool execution parity: approvals, execution events, `toModelOutput`, output normalization, and
  artifact overflow all behave exactly as on ordinary providers.

Non-goal: any new auth flow, Claude built-ins/subagents/skills/plugins, or a Node sidecar.

## Historical Shared Baseline

The branch already moved the reusable parts below the app boundary, so the Mini Lilac port is mostly
wiring, not new mechanism:

- `packages/agent/atomic-tool-execution.ts` — shared atomic executor.
- `AiSdkPiAgent.executeExternalToolCall()`, `sendToolsToModel`, `getRecoverableMessages()`,
  `acknowledgeSteeringDelivery()` — already in `packages/agent`.
- Provider-executed transcript support: inline call/result pairs survive normalization, tool-call-ID
  rewriting, and auto-compaction repair (`packages/agent`).
- `packages/utils/model-provider.ts` registers `claude-code`; `model-capability.ts` aliases
  `claude-code -> anthropic`.

Core-local pieces that must move to be shared:

- `apps/core/src/surface/bridge/bus-agent-runner/claude-code-tools.ts` (MCP facade, nonce
  correlation, result mapping, `displayClaudeCodeToolName`).
- `apps/core/src/surface/bridge/bus-agent-runner/claude-code-run.ts` (per-run materialization,
  injector/controller capture, dispose).
- `apps/core/src/surface/bridge/recovery-checkpoint.ts` (`buildSafeRecoveryCheckpoint`) — Mini Lilac
  persists `agent.state.messages` verbatim and has no equivalent.

Neither claude-code file imports anything Core-specific: only `@modelcontextprotocol/sdk`,
`@stanley2058/lilac-agent`, `@stanley2058/lilac-utils`, `ai`, `ai-sdk-provider-claude-code`, and
`node:path`. The move is mechanical.

## Historical Architectural Differences From Core

| Concern            | Core                                                                  | Mini Lilac                                                                                                       |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Provider registry  | Always-on singletons in `packages/utils/model-provider.ts`, env-gated | Config-driven `providers.yaml` + `auth.json`, every provider must have an API key                                |
| Model catalog      | Capability metadata only                                              | `ModelCatalog` fetches models.dev or `/v1/models` per configured provider                                        |
| Model construction | One place, `bus-agent-runner.ts`                                      | `SessionActor.createAgent()`, used by both top-level and delegated (subagent) runs                               |
| Controls           | `applyToRunningAgent()` steer/interrupt/cancel                        | `SessionActor.steer()`, `interruptQueuedSteering()`, `cancel()`, each a protocol command with a persisted result |
| Transcript         | `transcriptStore` + recovery checkpoints                              | SQLite store, `finalizeRootRun({ modelMessages: agent.state.messages })`                                         |
| Display            | Bus events                                                            | `StoredUIMessageChunk` projection consumed by the client/TUI                                                     |

The credentialless-provider concept already has a precedent in Mini Lilac: Codex OAuth
(`supersededProviderIds`) exempts a provider from `validateProviderAuth`. `claude-code` reuses that
shape but is simpler — it is credentialless by type, not by ambient token discovery.

## Historical Agreed Decisions

1. **Opt-in via `providers.yaml`, not implicit.** (Confirmed.) Mini Lilac builds its model catalog from configured
   providers; an always-on hidden provider would not appear in the model list. Operators add:

   ```yaml
   providers:
     claude-code:
       type: claude-code
       catalog: models-dev
   ```

   (Alternative considered and rejected: auto-register `claude-code` whenever the Claude CLI is
   detected. It contradicts Mini Lilac's fully declarative config and adds filesystem probing.)

2. **No `auth.json` entry.** A supplied key for a `claude-code` provider is a config error.
3. **`catalog: models-dev` only**, resolved against the models.dev `anthropic` provider; `baseUrl` is
   rejected.
4. **Built-in tools become a caller-supplied allowlist.** (Historical initial decision.) Mini Lilac's `websearch` is a
   provider-executed OpenAI/Anthropic tool needing an API key, so `claude-code` models resolve to no
   web search provider (existing behavior of `createWebSearchProviderResolver`, which returns
   `undefined` for unknown types). Claude's own built-in `WebSearch` is subscription-backed, and the
   Agent SDK `tools` option is an allowlist (`string[] | { type: 'preset', preset: 'claude_code' }`).
   So `materializeClaudeCodeRun` takes the allowlist as a parameter: **Core passes `[]`; Mini Lilac
   derives it per run from the profile** — `profileRequestsTool(profile, "websearch")` yields
   `["WebSearch"]`, otherwise `[]`. A profile that does not ask for web search does not get Claude's
   either, and subagent profiles are governed by the same config as every other tool. The utility
   model (title generation and inherit-compaction) always gets `[]`. Current clarification: the
   shared bridge appends `ToolSearch` after this caller-supplied list, so `[]` is not the effective
   agent built-in list. See "Claude built-in web search".
5. **`batch` stays omitted**, matching Core; Claude issues parallel MCP calls natively.
6. **Steering result stays `queued`** in the protocol. Native injection marks the entry consumed and
   decrements the queued count; no protocol version bump.
7. **`interruptQueuedSteering` stays available on `claude-code` runs.** The original decision was to
   reject it, on the premise that native injection always delivers steering immediately. Review found
   the premise incomplete: injection is skipped for multipart/attachment steering and for a steer
   sent before the injector is installed, and those entries stay queued with no other way to flush
   them. The queued count is already the exact condition — it drops to zero the moment delivery is
   confirmed, so the control disappears on its own precisely when it would be useless. Flushing also
   requests a native interrupt so the live query yields.

## Historical Implementation Plan

### Stage 1 — Extract the shared bridge package

Create `packages/claude-code-bridge` (`@stanley2058/lilac-claude-code`), depending on `ai`,
`ai-sdk-provider-claude-code`, `@modelcontextprotocol/sdk`, `@stanley2058/lilac-agent`,
`@stanley2058/lilac-utils`.

- Move `claude-code-tools.ts` and `claude-code-run.ts` verbatim; re-export
  `materializeClaudeCodeRun`, `createClaudeCodeToolBridge`, `displayClaudeCodeToolName`, and the
  request/control types.
- Move the Core tests to the new package.
- Update `apps/core` imports; drop `@modelcontextprotocol/sdk` + `ai-sdk-provider-claude-code` from
  `apps/core/package.json` if nothing else in Core uses them directly.
- Add `COPY packages/claude-code-bridge/package.json ...` to the `deps` stage of the root
  `Dockerfile` (the per-package manifest list at lines ~151–161). The later `COPY packages ./packages`
  in the build stage needs no change. Historical assumption: the container could not use
  `claude-code`. This was superseded for Core; its image can use the SDK-bundled executable with
  `CLAUDE_CODE_OAUTH_TOKEN` and/or mounted authenticated config. The published Mini single-file bundle
  still resolves an external `claude` from `PATH`.
- Move `buildSafeRecoveryCheckpoint` into `packages/agent` (it is transcript logic, not surface
  logic) and re-export from Core's existing module path to keep Core diffs small.
- Harden the bridge while moving: skip (do not throw on) tool definitions without `execute`, since
  Mini Lilac toolsets can contain provider-executed tools. Keep the named error for tools that have
  `execute` but no usable schema.

Rationale for a new package rather than folding into `packages/agent`: `packages/agent` is imported
by every surface, and the MCP SDK + Claude provider are heavy, optional dependencies.

### Stage 1b — Locating the Claude CLI

Found during the authenticated pass, and required for the packaged build to work at all.

The Agent SDK resolves a native CLI binary shipped as an optional dependency of
`@anthropic-ai/claude-agent-sdk`. Mini Lilac publishes a single bundled `main.js` with no dependency
tree, so that lookup fails with `Native CLI binary for <platform> not found` even when Claude is
installed and authenticated.

`claudeCodeExecutableSettings()` in `packages/utils/model-provider.ts` resolves `claude` from PATH and
passes it as `pathToClaudeCodeExecutable` on every Claude model — agent, utility, and both surfaces'
base providers. This is also what the feature promises: run against the installation the operator
authenticated, rather than a second copy shipped inside Lilac. When no `claude` is on PATH it returns
`{}`, so the SDK's own resolution and diagnostic survive — which is what Core-in-Docker relies on,
where auth comes from `CLAUDE_CODE_OAUTH_TOKEN` instead.

Note that `settingSources: []` isolates settings _files_ only (`~/.claude/settings.json`, project and
local settings, CLAUDE.md). Credential resolution is unaffected: the subprocess inherits an allowlist
of `process.env` including `HOME`, `ANTHROPIC_*`, and `CLAUDE_*`, so a stored `claude auth login`
credential and env tokens both work. The one on-disk auth path this isolation does block is
`apiKeyHelper`, which lives in the excluded settings file.

### Stage 2 — Provider type and credentialless auth

`packages/mini-lilac-runtime/src/providers.ts`:

- Add `"claude-code"` to `providerTypeSchema`.
- `providerDefinitionSchema.superRefine`: reject `baseUrl` and reject `catalog: "v1"` for
  `claude-code` (there is no OpenAI-compatible model listing behind the Claude CLI).
- Add `CREDENTIALLESS_PROVIDER_TYPES = new Set(["claude-code"])`.
- `validateProviderAuth`: skip the missing-credential error for credentialless types, and raise a new
  error when `auth.json` supplies a key for one.
- `createAiProviderRegistry`: build the base (utility) model with the same isolated defaults Core
  uses:

  ```ts
  createClaudeCode({
    defaultSettings: { tools: [], settingSources: [], persistSession: false },
  });
  ```

  This instance is correct for title generation, compaction, and validation because it carries no MCP
  server and no tools.

- Add `ai-sdk-provider-claude-code` to `packages/mini-lilac-runtime/package.json`.

### Stage 3 — Model catalog

`packages/mini-lilac-runtime/src/model-catalog.ts`:

- Introduce `modelsDevProviderKey(definition)`: `claude-code -> "anthropic"`, everything else
  unchanged. `modelsFromModelsDev` currently does `registry[providerId] ?? registry[definition.type]`;
  extend to `registry[providerId] ?? registry[modelsDevProviderKey(definition)]`.
- Filter to Claude Code–supported entries the way `isCodexOAuthModel` filters Codex, so the picker
  does not offer legacy Claude models the CLI will reject. Start permissive (`claude-*` ids) and let
  `providers.<id>.models` overrides handle the tail.
- Keep `provider.type` in `CatalogModel` as `claude-code` so the client can label the entry.
- Verify `ModelCapability` (constructed at `session-service.ts:2515` with defaults) picks up the
  existing `claude-code -> anthropic` alias — no change expected, add a test.

### Stage 4 — Per-run materialization in `SessionActor.createAgent()`

This is the core of the port. `createAgent()` is the single construction site for top-level and
delegated runs, so both get support at once.

- After `this.createTools(...)` and before `new AiSdkPiAgent(...)`, when
  `parseModelRef(modelSpecifier).providerId` resolves to a `claude-code`-typed provider, call
  `materializeClaudeCodeRun({ modelId, cwd: this.snapshot.cwd, tools, execute })` where `execute`
  forwards to `agent.executeExternalToolCall(request)` through a late-bound reference (Core uses the
  same "agent not ready yet" guard).
- Pass `builtInTools: profileRequestsTool(profile, "websearch") ? ["WebSearch"] : []` (see "Claude
  built-in web search"). This is per run, so a delegated subagent's allowlist follows its own profile.
- Pass `model: claudeCodeRun.agentModel`, `sendToolsToModel: false`.
- Compaction: pass `summaryModel: claudeCodeRun.utilityModel` when
  `config.agent.compaction.model === "inherit"`; an explicitly configured summary model keeps
  resolving through `resolveModel`. Never reuse the tool-enabled model for utility generation.
- Scope of `utilityModel`: inherit-compaction summarization only. Title generation already goes
  through `this.resolveModel(titleModel)`, i.e. the registry's base `claude-code` provider, which
  carries the same no-tools/no-MCP defaults. Both are safe; neither is the subagent path.
- `createAgent` returns `AiSdkPiAgent` today. Change it to return
  `{ agent, claudeCodeRun }` (or attach a disposer), and store `claudeCodeRun` on the `active` run
  record next to `agent`.
- Editing tools: `resolveEditingToolMode({ provider: "claude-code", ... })` already yields
  `edit_file` (only OpenAI-like providers get `apply_patch`). No change; add an assertion test.
- Reasoning effort needs no special handling: the provider maps AI SDK portable reasoning through its
  own `resolvePortableReasoningOptions` onto Claude `thinking`/effort. Spot-check that Mini Lilac's
  `none` effort maps to disabled thinking rather than the Claude default.

### Stage 5 — Disposal

- Dispose in `finalizeTopLevelRun`'s `finally` (alongside `this.active = undefined`) and in the
  `startRun` failure path where `admitted === false`.
- Dispose on `SessionService.shutdown()`/`close()` for any still-active run.
- Disposal must be failure-isolated (log and continue) so a hung Claude query cannot block run
  finalization or transcript persistence.

### Stage 6 — Controls

`SessionActor.steer()`:

- After `active.agent.steer(userModelMessage)`, when the run is Claude-backed and the merged message
  is plain text, call `claudeCodeRun.control.inject(text, delivered => ...)`.
- On confirmed delivery: `agent.acknowledgeSteeringDelivery(steeringId)`, mark the matching
  `steeringEntries` entry `consumed`, and re-emit the session snapshot so `queuedSteeringCount()`
  drops. This happens asynchronously, so it must go through the actor lock / event queue rather than
  mutating state from the injector callback directly.
- On failed delivery: leave it queued — existing boundary steering handles it.
- Multipart/image steering stays boundary-based.

`SessionActor.interruptQueuedSteering()`:

- Unchanged for Claude runs, and additionally requests a native interrupt so the live query yields
  for the flushed message. See decision 7: entries only remain queued when injection could not take
  them, and the queued count already hides the control in every other case. No client or protocol
  change.

`SessionActor.cancel()`:

- Request a native interrupt (best effort, never awaited) before `active.agent.cancel()`, then the
  existing authoritative Lilac reset and delegated-child cancellation.

  Implementation note: awaiting the interrupt inside the actor lock — as originally written — lets a
  wedged Claude control channel hold the lock indefinitely and delay the abort signal that actually
  ends the run. `requestClaudeCodeInterrupt()` therefore fires and forgets.

Idle watchdog (`executeTopLevelRun`) calls `agent.cancel()` on timeout; route it through the same
best-effort native interrupt so the Claude subprocess does not outlive the run.

### Stage 6b — Cancellation and delivered steering

Found in review. Native injection means a steering message can reach the model before the run is
cancelled, and recovery deliberately preserves the provider-executed work it caused. `cancel()`
discarded `deliveredSteeringMessages` outright, so the persisted transcript kept an answer to a
question no user turn contained.

`AiSdkPiAgent.cancel()` now clears only undelivered queues; `finishCancellation()` commits delivered
steering after truncating to the last valid boundary, so it lands ahead of the preserved assistant
draft. This is shared-agent behavior, so Core gets the same fix.

### Stage 7 — Transcript persistence

- `finalizeRootRun({ modelMessages: agent.state.messages })` becomes
  `buildSafeRecoveryCheckpoint(agent.getRecoverableMessages(), "run ended")`, mirroring Core. Without
  this, a run cancelled between a provider-executed tool call and its inline result persists an
  unpaired call that poisons the next prompt. The checkpoint closes such a call with a synthetic
  `error-text` result rather than dropping it, so the transcript keeps the record of what was
  attempted.
- Confirm superjson round-trips inline provider-executed parts (they are plain JSON-serializable
  objects; add a store test).
- Confirm `terminalText(...)` and `assistantMessageFromChunks(...)` behave when the assistant message
  carries inline tool-call/tool-result parts.

### Stage 8 — Display

Display is mostly already correct, and the reason matters: the MCP handler is registered per plain
Lilac tool name and calls the shared executor with that plain name, so `tool_execution_start/end`
carry `read_file`, never `mcp__lilac__read_file`. Namespaced names exist only in the canonical
transcript. That is why Core's Discord surface renders correctly today and
`displayClaudeCodeToolName` is dead code.

The remaining exposure is narrow: mini-lilac's `message_end` sweep (`session-service.ts` ~2012) emits
`tool-input-available` for assistant tool-call parts not already registered in `toolInputsAvailable`.
For a normal Claude MCP call the id is already registered (nonce correlation gives the executor the
real `toolUseID`), so it dedups. A call denied at `canUseTool` — or any future non-bridge tool — never
produces an execution event, so its namespaced name would reach the projection.

- Apply `displayClaudeCodeToolName()` defensively in the `message_end` sweep and in `tool-input-error`
  chunks. Strip only the exact `mcp__lilac__` prefix.
- Keep namespaced names in the canonical transcript.
- Decide Core's dead export: either delete `displayClaudeCodeToolName` from the shared package, or
  keep it and apply it at Core's equivalent `message_end` path for the same denied-call edge. Do not
  leave it exported and uncalled.

Add a regression test pinning the dedup contract: `tool_execution_start/end` fire before `message_end`,
and inline tool-_result_ parts inside assistant messages are deliberately not handled by the
`role === "tool"` branch because `tool_execution_end` already emitted the output chunk.

### Stage 9 — Config Surface And Docs (Historical)

- `apps/mini-lilac-server/providers.example.yaml`: add a commented `claude-code` block.
- `mini-lilac server auth` help text: state that `claude-code` needs no Lilac auth command, only
  `claude auth login`.
- README: the initial port described `WebSearch` as Mini's one admitted built-in and Core as admitting
  none. Current correction: the shared bridge always enables `ToolSearch`; Mini may additionally
  enable profile-requested `WebSearch`, while Core enables no profile-requested built-in.
- No `configVersion` bump: `providers.yaml` gains an enum member, which is backward compatible.

## Claude Built-In Web Search (Historical Initial Design)

The initial Mini port enabled `WebSearch` for profiles that request `websearch`, because its own
`websearch` tool needs a provider API key that a `claude-code` session does not have. That conditional
behavior remains, but the current shared bridge also always appends `ToolSearch` for deferred Lilac
MCP discovery in both Mini and Core. Core keeps the caller-supplied/profile-requested allowlist empty,
not the effective built-in list.

- `materializeClaudeCodeRun` gained a caller-supplied `builtInTools` option (initial default `[]`) for
  the agent model. Current materialization appends `ToolSearch` to that validated list. The utility
  model remains tool-free so a summarization prompt cannot reach the network.
- `canUseTool` currently rejects everything outside `mcp__lilac__*`. Extend it to also allow exactly
  the names in the run's allowlist — a set membership check, not a prefix or pattern match — and keep
  rejecting everything else.
- `webfetch` stays Lilac-implemented; do not enable Claude's `WebFetch`.
- Mini Lilac's `websearch` tool and `WebSearch` must never both be active for one run: when the
  provider is `claude-code`, `resolveWebSearchProvider` already returns `undefined`, so assert it
  rather than relying on it.
- Document that search results are fetched by Claude, outside the pipeline every other Lilac tool
  goes through — no Lilac approval, artifact capture, or output normalization.

### What the provider emits (verified against 4.0.1)

`ai-sdk-provider-claude-code` builds a provider-executed `tool-call` part (`providerExecuted: true`,
`dynamic: true`) and a matching `tool-result` part (`result`, `isError`) for every Claude-side tool,
built-ins included. `AiSdkPiAgent` already pushes both into the assistant message
(`ai-sdk-pi-agent.ts:1728-1757`, `tool-error` and `tool-output-denied` mapped to results too).

So a built-in search **renders as one completed call**: input and output arrive together at
`message_end`, with no incremental progress. There is no half-open tool call to worry about.

The projection change is correspondingly small — mini-lilac's `message_end` sweep
(`session-service.ts` ~2012) iterates only `tool-call` parts today:

- Also iterate inline `tool-result` parts, emitting `tool-output-available` (or `tool-output-error`
  when `isError`, `tool-output-denied` for `execution-denied`), deduped by `toolOutputsAvailable`.
- MCP-bridge calls emit these same inline parts, but their ids are already in
  `toolInputsAvailable`/`toolOutputsAvailable` from the execution events, so they dedup away. Only
  built-ins (and denied calls, which produce a result with no execution event) fall through.
- Run the tool name through `displayClaudeCodeToolName` on this path; `WebSearch` is not namespaced
  and passes through unchanged.

## Historical Testing

**New shared package** — move the existing Core bridge tests; add the "tool without execute is
skipped" case; `canUseTool` allows an allowlisted built-in and still rejects every other non-`lilac`
tool; the utility model never receives a built-in allowlist.

**`packages/mini-lilac-runtime`**

- `providers.test.ts`: `claude-code` needs no key; supplying a key errors; `baseUrl` and
  `catalog: v1` rejected; registry builds a no-tools base model.
- `model-catalog.test.ts`: models.dev `anthropic` entries surface under the `claude-code` provider id;
  unsupported models filtered; `models:` overrides still apply; stale-cache paths unchanged.
- `session-service.test.ts`: agent model is the materialized tool-enabled model; `sendToolsToModel`
  false; utility model used for inherit-compaction; dispose runs on success, error, cancel, and
  shutdown; subagent (`depth > 0`) runs materialize and dispose independently.
- Controls: successful injection consumes the steering entry exactly once and updates the queued
  count; failed injection stays queued; `interruptQueuedSteering` is rejected on Claude-backed runs
  without persisting a command result; cancel interrupts natively before resetting.
- Transcript: cancelling mid provider-executed call persists a valid message suffix.
- Projection: namespaced tool names render stripped; no duplicate chunks for inline provider parts;
  a `WebSearch` call produces both an input and a terminal output chunk; an errored built-in result
  produces `tool-output-error`.
- `websearch` (the Lilac tool) is never present in a `claude-code` run's toolset.
- Historical assertion: a profile without `websearch` materialized with `[]`. Current effective agent
  built-ins always include `ToolSearch`; `WebSearch` still follows the active profile, including a
  delegated subagent's own profile rather than its parent's.

**Manual/authenticated** — one real `claude auth login` session through the TUI: prompt, parallel
tool calls, a web search, steering mid-run, cancel, compaction, subagent delegation, resume after
restart.

## Historical Risks And Open Questions

- **`updatedInput` nonce round trip** is still unverified against a live authenticated session (open
  from the Core work). Mini Lilac inherits the risk; it fails closed, so the failure mode is refused
  tool calls, not silent mis-execution.
- **Steering acknowledgement is asynchronous** and crosses the actor lock. Getting this wrong
  double-counts queued steering in the session snapshot. Prefer routing the callback through
  `active.eventQueue`.
- **Subagent fan-out cost**: every delegated Claude-backed run spawns its own Claude CLI process, and
  a Claude-backed `titleModel` spawns one per new session. Measure during the manual pass and decide
  whether to cap concurrent Claude-backed runs.
- **models.dev drift**: the supported-model filter is a heuristic; keep it permissive and rely on
  config overrides.
- Bun hosting of the provider is already proven in Core; no new gate.

## Historical Implementation Order

1. Extract `packages/claude-code-bridge` (+ `Dockerfile` manifest line); move
   `buildSafeRecoveryCheckpoint` into `packages/agent`; add the `builtInTools` option with Core
   passing `[]`; keep Core green.
2. Provider type, credentialless auth validation, registry construction.
3. Model catalog mapping and filtering.
4. `createAgent` materialization + utility model + `sendToolsToModel` + profile-derived `builtInTools`.
5. Disposal across all terminal paths.
6. Steering / cancel / idle-watchdog controls; reject `interruptQueuedSteering` server-side and hide
   it in the TUI.
7. Safe transcript persistence.
8. Projection: inline provider-executed tool-result mapping (covers built-in `WebSearch`), defensive
   display-name stripping.
9. Example config, help text, README.
10. Focused tests, changed-package typechecks, root `lint:fix` + `fmt`, then the full harness; one
    authenticated manual pass.

## Historical Deferred Work

- Ambient Claude user/project/local settings.
- Task-facing Claude built-ins beyond `WebSearch`; native Claude subagents, plugins, skills.
- Any Lilac-owned Claude OAuth or token storage.
- A concurrency cap on Claude-backed runs (measure first).
- Historical Mini container packaging work. Core Docker is supported through the SDK-bundled
  executable; a custom Mini container must provide the external CLI required by the published bundle.
