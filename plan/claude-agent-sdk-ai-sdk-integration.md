# Claude Agent SDK AI SDK Integration

## Status

This is the implementation plan agreed on 2026-07-25. The live execution tracker is
`plan/claude-agent-sdk-ai-sdk-integration.todo.md`.

The first implementation target is Core. Mini Lilac follows after the shared tool execution and
MCP boundary is proven.

## Goal

Allow a person running Lilac on their own computer to select a Claude model backed by their own
local Claude Code/Claude Agent SDK authentication, without Lilac implementing OAuth, accepting or
storing subscription credentials, proxying users, pooling tokens, or maintaining a custom AI SDK
language-model adapter.

Use the community `ai-sdk-provider-claude-code` package as the AI SDK v7 `LanguageModel` adapter.
Lilac will expose its own Level-1 tools to Claude through an in-process MCP server.

## Deployment And Authentication Boundary

Lilac is downloaded or built and run locally for personal use. The integration must preserve these
properties:

- The user authenticates independently through the official Claude tooling, such as
  `claude auth login`.
- Lilac does not implement a Claude.ai OAuth flow.
- Lilac does not request, read, import, copy, persist, refresh, log, or transmit Claude subscription
  credentials.
- Lilac does not route multiple users through one subscription or operate shared production
  infrastructure.
- The provider invokes the official Claude Agent SDK/Claude Code runtime, which resolves its own
  local authentication.
- Authentication failures are reported with a clear instruction to authenticate using the official
  Claude CLI. They are not repaired by credential scraping or a Lilac-owned token flow.

## Agreed Product Decisions

- Implement Core first.
- Target full observable tool-execution parity rather than a raw MCP bridge.
- Register a credentialless provider id named `claude-code`.
- Construct the tool-enabled Claude model per agent run, after the run-scoped Level-1 toolset exists.
- Disable Claude built-in tools with `tools: []`.
- Expose Lilac tools only through the in-process `lilac` MCP server.
- Do not expose `batch` through MCP. Claude uses native parallel MCP calls.
- Keep `ToolExpansion` and synthetic child scheduling exclusively in the ordinary
  `AiSdkPiAgent` outer loop.
- Isolate Claude filesystem settings with `settingSources: []`. Lilac remains the sole source of
  prompts, workspace instructions, tools, permissions, and policy.
- Disable Claude session persistence with `persistSession: false`; Lilac owns canonical transcripts
  and persistence.
- Use hybrid native controls: normal steering is injected into the active Claude query between tool
  calls, while hard interruption/cancellation uses the Agent SDK query controller and Lilac recovery.
- Use a separate no-tools Claude model for compaction and utility generations.
- Preserve canonical `mcp__lilac__<tool>` names in provider transcripts, but display the original
  Lilac tool name to users.

## Package And Provider Strategy

Use `ai-sdk-provider-claude-code` 4.x because it implements AI SDK v7 `LanguageModelV4`, matching
the repository's `ai@^7` dependency.

Register an always-available `claude-code` provider in `packages/utils/model-provider.ts`. Its base
provider instance is safe for validation, durable model rehydration, title generation, compaction,
and other utility calls:

```ts
createClaudeCode({
  defaultSettings: {
    settingSources: [],
    persistSession: false,
    tools: [],
  },
});
```

No environment credential gate is added for this provider. Existing `ResolvedModelRef` and
`DurableResolvedModelRequest` shapes remain valid because provider/model identity is already
durable and credential-free.

Add `claude-code -> anthropic` as a model-capability provider alias for full Anthropic model IDs.
Short aliases such as `sonnet`, `opus`, and `haiku` may need explicit capability overrides when a
concrete models.dev entry cannot be inferred.

## Per-Run Materialization

The singleton provider model is not the agent model. Core must create the agent model only after
`pluginManager.buildLevel1Toolset()` returns, because Level-1 tool closures capture run-specific
state including cwd, request/session IDs, safety mode, subagent dispatch, artifact scope, protected
paths, and environment.

For `claude-code` runs, materialize:

- A tool-enabled agent model with the run-scoped in-process MCP server.
- A no-tools utility model for compaction and other non-agent generation.
- A Claude run-control object that receives the active message injector and query controller.
- The ordinary Level-1 `ToolSet` retained for execution, display, metadata, and status handling.
- No ordinary AI SDK tool declarations passed to `streamText()`, because Claude Code ignores their
  execute functions and emits unsupported-tool warnings.

Representative settings:

```ts
claudeCode(modelId, {
  cwd: executionCwd,
  settingSources: [],
  persistSession: false,
  tools: [],
  mcpServers: { lilac: bridge.server },
  canUseTool: bridge.canUseTool,
  streamingInput: "always",
  onStreamStart: control.setInjector,
  onQueryControllerCreated: control.setController,
});
```

The ordinary providers continue through the existing path without provider-specific behavior.

## Shared Atomic Tool Execution

Extract the atomic body of `AiSdkPiAgent.executeToolCalls()` into a reusable executor in
`packages/agent`. Both the ordinary AI SDK outer loop and the Claude MCP bridge call this executor.

The shared executor owns:

- Tool lookup.
- Input validation when requested by the caller.
- Invalid-input classification and model-visible errors.
- `needsApproval` evaluation.
- Full tool execution options: `toolCallId`, canonical messages, abort signal, and run context.
- Async iterable draining and `tool_execution_update` events.
- `toModelOutput` conversion.
- Generic output normalization and tool-specific normalizer bypass.
- Artifact overflow conversion.
- Success, denial, invalid-input, and error outcomes.
- `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events.
- Detection of `ToolExpansion` as an outcome marker.

The shared executor does not own:

- Parallel worker scheduling.
- Ordered transcript insertion.
- Same-turn exclusive-tool arbitration.
- Synthetic assistant child calls.
- Recursive expansion scheduling.

Those remain in `AiSdkPiAgent.executeToolCalls()` so `batch` preserves its intentional outer-loop
expansion semantics.

The ordinary outer loop calls the executor with provider-validated inputs and permits expansion
capture. The MCP bridge calls it with raw MCP input validation and rejects any unexpected expansion.

## In-Process MCP Bridge

Do not use `createAiSdkMcpServer()` directly for the full-parity path. Its contract is intentionally
smaller than Lilac's:

- It accepts only direct top-level `ZodObject` schemas.
- It loses whole-object preprocess/transform/refine behavior.
- It supplies only an MCP request ID and abort signal to `execute`.
- It bypasses Lilac approval, execution events, `toModelOutput`, output normalization, and artifacts.
- It serializes successful output to one text block.
- It would reject existing schemas such as the preprocessed `attachment.add_files` input.

Build a small standards-based MCP facade using `@modelcontextprotocol/sdk` and an SDK server instance
accepted by the Claude Agent SDK. This is not a language-model adapter; it is a transport facade over
Lilac's existing tool executor.

The bridge must:

- Advertise all atomic run-scoped Level-1 tools except `batch`.
- Derive JSON Schema through AI SDK `asSchema(tool.inputSchema)`.
- Validate incoming arguments through the same AI SDK schema validator so preprocesses, transforms,
  defaults, refinements, strictness, and asynchronous transforms run exactly once.
- Invoke the shared atomic executor with current canonical messages, run context, and abort signal.
- Return normalized tool output rather than raw execute output.
- Return MCP `isError: true` results for denial, invalid input, execution failure, output mapping
  failure, and unexpected expansion.
- Never mutate the canonical transcript directly. Provider-executed tool parts from the model
  response remain transcript authority.
- Fail model materialization with the exact tool name if a tool cannot provide a usable schema or
  execute function.

## Tool Call Correlation And Approval

The Agent SDK `canUseTool` callback exposes Claude's real `toolUseID`; the MCP handler exposes an
independent JSON-RPC request ID. There is no protocol-native mapping in the selected versions.

Use a bounded, single-use nonce correlation layer:

1. `canUseTool` receives the namespaced tool name, input, abort signal, and real `toolUseID`.
2. It rejects every tool outside `mcp__lilac__*` and every tool not present in the run-scoped bridge.
3. It evaluates Lilac approval behavior or delegates approval to the shared execution policy.
4. On allow, it adds a cryptographically random private nonce to `updatedInput` and stores a bounded
   nonce record containing tool name and `toolUseID`.
5. The MCP handler removes the private nonce before Lilac schema validation, consumes the matching
   record once, and executes with the real `toolUseID`.
6. Missing, expired, reused, mismatched, model-invented, or malformed nonces fail closed rather than
   trusting uncorrelated input.
7. Correlation records are cleared on query completion, abort, and run disposal.

Do not correlate by argument fingerprint, tool name, or queue order because parallel identical calls
make those approaches ambiguous.

The exact provider version must be integration-tested to verify that `updatedInput` reaches the MCP
handler unchanged. If that validation fails, event-ID parity requires either an upstream provider
change or a separately approved degraded correlation strategy.

## MCP Result Mapping

Map the shared executor's exhaustive `ToolResultOutput` union into MCP results:

- Text output becomes MCP text.
- JSON output becomes serialized text and `structuredContent` when the value is an object.
- Error text/JSON and execution denial become text with `isError: true`.
- Text content parts become MCP text content.
- Image content becomes MCP image content with base64 bytes and MIME type.
- Audio content becomes MCP audio content when representable.
- Other inline binary files become embedded MCP resources with generated URNs.
- Text files become text or embedded text resources.
- URL-backed files become MCP resource links when enough metadata exists.
- Provider file references/custom content without bytes fail explicitly rather than being silently
  dropped.
- `Buffer`, `Uint8Array`, and `ArrayBuffer` values are encoded safely.
- Provider-specific metadata is not forwarded unless it has a defined MCP meaning.

Use exhaustive discriminant switches so AI SDK additions fail typechecking until mapped.

## Provider-Executed Transcript Support

Claude MCP calls arrive as provider-executed dynamic tool parts. Extend transcript helpers so a
self-contained provider tool call/result exchange is treated as valid everywhere ordinary
assistant-call/tool-result pairs are valid.

Review and update:

- Tool result normalization in `AiSdkPiAgent`.
- Tool call/result stream lifecycle handling and deduplication.
- Last-valid-boundary truncation and cancellation repair.
- Claude tool-call ID normalization so inline calls/results stay paired.
- Auto-compaction suffix validation and repair.
- Historical tool-output compaction views.
- Recovery checkpoint repair.
- Heartbeat handoff extraction for namespaced tools if heartbeat supports this provider.
- Retry safety after provider-executed side effects.

Provider transcript names remain namespaced. User-facing status and argument formatting strip only
the exact `mcp__lilac__` prefix.

## Steering, Interrupt, And Cancellation

One Claude-backed `streamText()` call may contain multiple internal model/tool turns, so ordinary
Pi turn-boundary steering alone is not responsive enough.

Normal steering:

- Queue through the existing Lilac steering API as the durable fallback.
- Inject text-only steering through the provider message injector while the query is live.
- On confirmed delivery, acknowledge the queued steering item exactly once and preserve the injected
  user message in Lilac's canonical transcript.
- On failed delivery, leave the message queued for the next normal boundary.
- Multipart/image steering remains boundary-based unless the upstream injector gains structured
  input support.

Hard interruption:

- Queue the interrupt message durably.
- Ask the live Claude query controller to interrupt so completed MCP calls/results can finish
  provider bookkeeping.
- Continue through Lilac recovery and drain the queued instruction into the next query.
- Fall back to the existing abort/rewind path if no controller exists or native interruption fails.

Cancellation:

- Best-effort native query interruption.
- Then use Lilac's existing cancellation/reset path, clear pending correlation/control state, cancel
  delegated children, and preserve authoritative cancellation events.

## Utility Model Isolation

Never reuse the tool-enabled per-run model for compaction, title generation, routing, validation, or
other utility calls. Otherwise a summarization prompt could invoke workspace tools through the
model's embedded MCP settings.

For Claude-backed runs, pass the separately materialized no-tools model into auto-compaction rather
than `"current"`. Utility model creation uses the same model ID and local Claude authentication but
has no MCP servers, callbacks, or tools.

## Configuration And Documentation

Document model selection such as:

```yaml
models:
  main:
    model: claude-code/claude-sonnet-4-6
```

Document that:

- The user installs/authenticates official Claude tooling locally.
- Lilac stores no Claude credential.
- `claude-code` is distinct from the API-key-backed `anthropic` provider.
- Claude filesystem settings and built-in tools are intentionally disabled.
- Lilac tools and subagent delegation remain available through Lilac MCP tools.
- `batch` is intentionally absent because Claude can call MCP tools in parallel.

No Core config v1 schema key or migration is needed solely to add the provider.

## Testing

### Shared Executor

- Input validation and transformed values.
- Invalid-input errors.
- Approval allow/deny behavior.
- Full messages/context/signal/toolCallId options.
- Async iterable progress/final value and abort cleanup.
- `toModelOutput`.
- Normalizer success/failure and bypass.
- Artifact overflow conversion.
- Expansion capture in the outer loop and rejection in MCP.
- Existing batch expansion tests remain unchanged and passing.

### MCP Bridge

- `batch` absent from `tools/list` and rejected from `tools/call`.
- Every exposed declaration has valid MCP JSON Schema.
- Whole-object preprocess/transform/refine/strict behavior runs exactly once.
- Missing validators or execute functions fail with a named tool.
- Nonce correlation succeeds for parallel distinct and identical calls.
- Missing/reused/expired/mismatched nonces fail closed.
- Abort signals and async progress propagate.
- Every supported output variant maps correctly.
- Unsupported provider references/custom output fail explicitly.

### Provider And Model Resolution

- `claude-code` resolves without API credentials.
- Aliases and durable rehydration work.
- Full model IDs inherit Anthropic capability metadata.
- The per-run model is created only after Level-1 tools.
- Agent and utility model instances/settings are separate.
- AI SDK tool declarations are not passed to Claude.
- Claude MCP tool names are formatted as ordinary Lilac names in user-facing events.

### Transcript And Controls

- Provider-executed tool exchanges remain valid through replay, normalization, compaction, recovery,
  cancellation, and tool-call ID rewriting.
- Tool lifecycle events preserve real Claude tool-use IDs.
- Steering injection success is committed once.
- Failed injection remains queued.
- Hard interrupt uses native control and falls back safely.
- Cancellation clears controls and correlation state.
- Compaction uses the no-tools utility model.

### Runtime Verification

- Import/model-construction smoke test under Bun.
- Authenticated manual or opt-in integration test under the exact provider/Agent SDK versions.
- Core focused tests.
- Changed-package TypeScript checks.
- Root lint fix and formatting.
- Monorepo tests when focused validation passes.

## Known Validation Gates

These are implementation checks, not unresolved product decisions:

- `ai-sdk-provider-claude-code` declares Node.js 22 support; Lilac runs under Bun. Validate before
  considering a Node sidecar.
- Nonce correlation depends on Agent SDK `updatedInput` reaching the MCP handler unchanged.
- MCP supports rich content types, but Claude's useful handling of every audio/resource variant must
  be verified.
- Provider-executed transcript shapes must be confirmed against the exact package version.
- Hard interruption cannot undo external side effects from a tool that already completed.

If Bun compatibility or reliable tool-use correlation fails materially, stop and request a product
decision rather than silently degrading the agreed behavior.

## Implementation Order

1. Add the provider/MCP dependencies and verify Bun import/model construction.
2. Extract and test shared atomic tool execution without changing outer-loop behavior.
3. Implement and test the in-process MCP facade and result mapping, excluding `batch`.
4. Register the credentialless no-tools `claude-code` provider and capability alias.
5. Materialize tool-enabled and utility models per Core run.
6. Add provider-executed transcript and user-facing name support.
7. Add hybrid steering, interrupt, cancellation, and correlation lifecycle.
8. Update configuration examples and documentation.
9. Run focused tests/typechecks, then root lint/format and broader tests.
10. Perform one final implementation review, fix concrete findings, and re-run validation.

## Deferred Work

- Mini Lilac provider/config/auth integration.
- Loading user/project/local Claude settings.
- Claude built-in tools, native Claude subagents, plugins, and skills.
- A hosted or Lilac-owned Claude OAuth flow.
- Provider-specific fallbacks that require a Node sidecar.
