# Claude Code Portable Replay, Native Continuation, And Fallback

## Status

Superseded 2026-08-01 by `plan/claude-code-native-session-continuation.md`.

Only Stage 0 remains authoritative as the historical prerequisite that established canonical/model
view separation and retry safety. The proposed Stages 1 through 3 below must not be used as current
behavior or implementation guidance: the replacement plan ships deliberately lossy text replay,
fork-only native continuation for a broader exact-proof session matrix, and no cross-family automatic
fallback. This document is retained to preserve the architecture history.

The work is intentionally sequential:

0. Separate canonical history from model-facing compaction and close retry-safety gaps.
1. Add lossy portable replay across the Claude Code boundary.
2. Add minimal persistent native continuation for sessions with exact canonical ownership.
3. Reuse those seams for native-to-Claude and Claude-to-native model fallback.

Each stage must ship cleanly before the next starts. Stage 2 is not independently implementable on
the current runtime wiring without the Stage 0 model-call pipeline and runtime ownership seams.

## Goals

- Switching an idle populated transcript to or from `claude-code` continues without provider-invalid
  history.
- Claude Code MCP tool history reaches ordinary providers as valid AI SDK history.
- Ordinary provider history reaches Claude through the current provider's prompt conversion.
- Core named subagents and Mini Lilac current sessions use native Claude continuation without
  replaying an ever-growing synchronized prefix.
- Persistent Claude attempts never replace the last clean native binding after failure, cancellation,
  or crash.
- Core fallback can enter or leave Claude Code at a safe failed model-call boundary.
- Model selection remains agent-controlled even when native-session reuse is ineligible.

## Non-Goals

- A lossless or bijective AI SDK to Claude JSONL conversion.
- Parsing or generating Claude's private JSONL record format.
- Core primary-session native persistence or resume.
- Native reuse across Claude model changes in v1.
- Mini Lilac historical undo/redo native-head reuse.
- Multi-host or lease-based ownership for local SQLite session bindings.
- Claude-to-Claude model fallback in the first cross-provider fallback release.
- Persisting utility-only title, validation, or compaction-summary calls.
- Eager deletion of Claude JSONL files from Lilac retention paths.
- Preserving hidden reasoning, reasoning signatures, native lifecycle events, or Claude UUID graphs in
  portable `ModelMessage[]`.

## Review Decisions

Accepted architecture corrections:

- Auto-compaction must never write an outbound replay/media/pruning view back into canonical history.
- Persistent Claude retries must rematerialize a model and native attempt instead of auto-resuming a
  dirty provider session.
- Full-context estimation and actual suffix-only native payloads are separate values.
- External MCP execution marks the turn retry-unsafe before the tool starts.
- Canonical and execution-scope hashes are versioned contracts with shared fixtures.
- Runtime replacement needed by compaction moves before persistent continuation.
- Core promotion is canonical-first and verified, not falsely cross-store atomic.
- Native bindings are validated through supported Agent SDK session APIs before reuse.
- `ReplayTarget` carries target capabilities required by its own media and tool-history rules.

Scope removed from v1:

- Broad legacy-origin guessing.
- Core primary persistence without resume.
- Retained native generations for Mini undo/redo.
- SQLite leases and multi-process fencing machinery.
- Cross-model native reuse.
- Claude-to-Claude fallback.
- Public `ReplayLoss[]` plumbing.
- A general same-provider metadata policy framework.
- Eager native JSONL deletion.

Runtime versions are recorded for diagnostics, but exact provider/SDK/CLI version equality is not a
binding key. Lilac never parses the native format; the current Claude SDK owns compatibility. Binding
protocol/hash versions must match, native metadata is checked before reuse, and a failed resume falls
back once to a fresh session.

## Core Invariants

1. Canonical messages are changed only by canonical operations such as a model response, steering,
   recovery repair, or Lilac compaction.
2. Outbound replay lowering, media scrubbing, historical-output pruning, suffix selection, prompt
   cache decoration, and ephemeral overlays never enter canonical history.
3. Compaction persists a Lilac summary plus an untouched canonical suffix selected on canonical turn
   boundaries.
4. The complete transformed target view is used for context estimation, while a native-resume call
   may send only an unsynchronized canonical suffix.
5. Ephemeral overlays are regenerated after suffix selection. They are never included in canonical
   hashes, synchronized message counts, or native cursors.
6. Portable replay is deterministic, idempotent, and never emits an unmatched protocol tool part.
7. Hidden reasoning and source-provider metadata do not cross the Claude boundary.
8. Tool-call IDs are normalized after structural replay conversion using the active target model.
9. A persisted native binding is eligible only when it owns the immediate latest committed canonical
   head before the current uncommitted input, uses the exact v1 model spec and execution scope, and
   passes native-session validation.
10. Every continued request forks from the last clean native binding. Only clean terminal success can
    promote the attempt.
11. Every retry after a persistent Claude query starts uses a newly materialized Claude model and
    native attempt. AI SDK internal retries are disabled for persistent Claude models.
12. Provider-executed tool activity makes the attempt retry-unsafe before execution begins.
13. Canonical persistence failure can lose native-resume efficiency but cannot produce a promoted
    binding whose canonical head is unavailable.
14. Cross-provider fallback occurs only when `TurnRetrySafety.canRetry` is true.

## Model-Call Views

The implementation must distinguish three representations:

### Canonical Messages

Durable `ModelMessage[]` owned by Lilac. They contain complete recoverable history and may carry
Lilac-owned origin metadata. They never contain todo overlays, target prompt-cache decoration, or
model-facing historical-output placeholders.

### Full Budget View

The complete current target-provider view used for context estimation and compaction decisions:

```text
canonical messages
  -> replay preparation
  -> target media sanitation
  -> historical-output pruning view
  -> current ephemeral overlays
```

It represents everything the target would conceptually know, including a native prefix that will not
be retransmitted on a resume call.

### Request Payload

The messages actually sent on this model call:

- Full transformed canonical history for ordinary providers and fresh Claude sessions.
- Only the transformed unsynchronized canonical suffix for a native Claude fork/resume.
- Freshly regenerated ephemeral overlays appended after full/suffix selection.
- Final target decoration such as prompt-cache metadata.
- Target tool-call ID normalization.

## Stage 0: Canonical And Retry Foundations

Stage 0 is required even without Claude persistence. Current auto-compaction can already retain
outbound-only media/pruning transforms in canonical history.

### 0.1 Split Auto-Compaction Inputs And Outputs

Replace `baseTransformMessages` with explicit responsibilities. Exact names may follow existing style,
but the contract must distinguish:

```ts
type PrepareFullModelView = (
  canonicalMessages: readonly ModelMessage[],
  context: TransformMessagesContext,
) => Promise<ModelMessage[]> | ModelMessage[];

type BuildEphemeralOverlay = (
  context: TransformMessagesContext,
) => Promise<readonly ModelMessage[]> | readonly ModelMessage[];

type DecorateRequestPayload = (
  payload: readonly ModelMessage[],
  context: TransformMessagesContext,
) => Promise<ModelMessage[]> | ModelMessage[];
```

The model-call pipeline becomes:

```text
canonical messages
  -> consume canonical-only continuation/compaction markers
  -> prepare full target view
  -> append ephemeral overlay for estimation
  -> estimate and decide compaction
  -> if compacting:
       select a canonical suffix boundary
       summarize the transformed view of the canonical prefix
       replace canonical with Lilac summary + untouched canonical suffix
       recompute the full target view
  -> select full canonical replay or native canonical suffix
  -> prepare the selected target view
  -> append freshly generated ephemeral overlay
  -> final request decoration
  -> target tool-call ID normalization
  -> streamText
```

Compaction boundary selection must map back to canonical indexes. Because replay preparation can split
one canonical Claude assistant message into multiple model-view messages, do not select a retained
tail solely by model-view index. Evaluate transformed token cost at valid canonical turn boundaries,
then retain `canonicalMessages.slice(suffixStart)` unchanged.

`compactRepairedMessages` may summarize transformed content, but `agent.replaceMessages` receives only
the canonical Lilac summary and original canonical suffix. After replacement, recompute the full
target view from the new canonical transcript.

### 0.2 Separate Ephemeral Overlays

Move Mini Lilac's synthetic `<session-todos>` message out of `appendTransformMessages` and into the
explicit ephemeral-overlay hook.

Requirements:

- Include its current token cost in every full budget estimate.
- Append it after native suffix selection on every request.
- Never count it in `canonicalMessageCount` or a native synchronization cursor.
- Never summarize or persist it as canonical history.
- Regenerate it from the current todo store revision rather than replaying a prior synthetic message.

Provider-specific final decorations, including Anthropic prompt-cache options and Codex item-ID
sanitation, run after payload selection. Lilac compaction markers are consumed on canonical messages
before replay-origin metadata is removed from the model view.

### 0.3 Add A Pre-Call Runtime Preparation Seam

Add a model-call hook after compaction settles and before `streamText` captures the model and request
payload. It receives final canonical messages and the full budget view and may:

- Confirm or replace the active runtime binding for the final canonical head.
- Choose full-history or native-suffix payload mode.
- Return the active model, model spec, execution mode, and selected canonical payload range.

This is the seam Stage 2 uses when preflight compaction invalidates a planned native fork. It must be
able to dispose an uninvoked attempt runtime and install a fresh attempt before the first provider
call. It runs before every outer model call. If a later compaction or canonical replacement occurs
after the Claude attempt was already invoked, it marks that attempt unpromotable, disposes it, resets
its native cursor, and installs a fresh attempt before the next call. It does not enable model
fallback by itself.

### 0.4 Mark External Tool Execution Retry-Unsafe At Entry

`AiSdkPiAgent.executeExternalToolCall` must synchronously latch provider-executed activity before
calling validation or `executeAtomicToolCall`. `runTurn` retry safety reads this latch in addition to
stream-part observation.

This covers Claude MCP execution, where a tool can run before the provider emits the corresponding
AI SDK stream part. Claude built-ins remain covered by provider stream observation.

The latch resets only when a new model attempt starts. It must not be cleared by a partial-output
rollback inside the same attempt.

### 0.5 Stage 0 Tests

- Replay lowering in a full model view never appears in the retained canonical suffix.
- Media scrub and historical-output pruning never enter canonical history after compaction.
- Prompt-cache provider options never enter canonical history.
- Compaction summarizes transformed prefix content while retaining byte-equivalent canonical tail
  messages.
- A transformer that expands one canonical message still retains a valid canonical turn boundary.
- Todo overlays affect estimates, are regenerated for payloads, and never enter canonical state.
- `executeExternalToolCall` followed immediately by a model failure is retry-unsafe even before a
  provider tool stream part arrives.

### 0.6 Stage 0 Ship Gate

- Existing Core and Mini compaction behavior remains user-equivalent.
- Canonical/model-view separation is enforced by regression tests.
- The pre-call runtime seam exists without changing provider selection.
- External provider tool execution cannot race ahead of retry-safety observation.

## Stage 1: Portable Replay Across Claude Code

### 1.1 Record Message Origin

Add a small Lilac-owned origin marker to finalized assistant canonical messages:

```ts
providerOptions: {
  lilac: {
    replayOrigin: {
      version: 1,
      provider: "claude-code",
      modelSpecifier: "claude-code/claude-sonnet-4-6",
    },
  },
}
```

Origin metadata identifies new text-only Claude turns and supports diagnostics. It is stripped from
the model view after canonical-only compaction markers have been consumed.

Legacy transcripts use only strong structural evidence:

- Inline call/result parts explicitly marked `providerExecuted`.
- Exact `mcp__lilac__*` tool names.

Do not infer Claude origin from generic reasoning, arbitrary metadata, or assistant text. No
persistent migration is required.

### 1.2 Add A Capability-Aware Replay Target

Add a shared outbound replay helper in `packages/agent`:

```ts
type ReplayTarget = {
  readonly provider: string;
  readonly modelSpecifier: string;
  readonly availableToolNames: ReadonlySet<string>;
  readonly capabilities: {
    readonly inputModalities: ReadonlySet<"text" | "image" | "audio" | "video" | "pdf">;
    readonly supportsHistoricalToolProtocol: boolean;
    readonly supportsParallelToolResults: boolean;
  };
  readonly onDiagnostic?: (diagnostic: ReplayDiagnostic) => void;
};

function prepareReplayMessagesForTarget(
  messages: readonly ModelMessage[],
  target: ReplayTarget,
): ModelMessage[];
```

`ReplayDiagnostic` is a closed internal union for tests and bounded debug logging. Do not thread a
new `ReplayLoss[]` result through agent/runtime APIs. Deduplicate diagnostics because preflight,
compaction, and the final payload may prepare the same history more than once.

The helper clones canonical input and is deterministic/idempotent.

### 1.3 Lower Claude Inline Tool Exchanges

Convert ordered inline Claude provider-executed parts into portable protocol turns:

```text
canonical assistant: text A, call 1, result 1, text B

portable assistant: text A, call 1
portable tool:      result 1
portable assistant: text B
```

Rules:

- Preserve consecutive parallel calls/results when the target supports them.
- Remove `providerExecuted`, `dynamic`, and Claude-only provider metadata.
- Map exact `mcp__lilac__<name>` to `<name>`.
- Keep a structural exchange when the target exposes the mapped tool and supports historical tool
  protocol.
- Lower unknown Claude built-ins and unsupported historical tools to clearly delimited historical
  text.
- Lower orphan or malformed call/results to bounded historical text rather than emitting invalid
  protocol turns.
- Preserve surrounding assistant text order and result error/denial semantics.
- Run existing target tool-call-ID normalization afterward.

### 1.4 Sanitize Only The Claude Boundary

Claude-sourced history sent to another provider:

- Drop reasoning, reasoning-file, and source-provider custom reasoning.
- Remove Claude Code message/part provider metadata.
- Preserve portable text, supported files, and lowered tool history.

Other-provider history sent to Claude Code:

- Drop signed, encrypted, redacted, or provider-specific reasoning.
- Remove source-provider metadata and unsupported provider references.
- Preserve text and supported inline images.
- Replace unsupported historical file content with a short explicit description rather than silent
  disappearance.

For exact same-provider replay, preserve existing provider-native metadata and remove only Lilac's
replay-origin marker. Do not introduce a general provider-family replay framework in this work.

### 1.5 Reuse The Current Claude Provider Converter

After replay sanitation and optional compaction, pass portable `ModelMessage[]` to the existing
`ai-sdk-provider-claude-code` converter.

Accepted v1 losses:

- Historical roles and tool protocol are flattened into one Claude prompt on fresh sessions.
- Historical tool-call input is truncated at the provider's current limit.
- Hidden reasoning is omitted.
- Unsupported non-image data is represented only by descriptive text.

Pin these assumptions with dependency characterization tests. Do not fork the provider solely to
remove them.

### 1.6 Integrate Through The Full-View Pipeline

Core and Mini use replay preparation in Stage 0's full-view preparation, not as a transform whose
output can become canonical. Final prompt-cache decoration stays in the request-decoration hook.

Context dumps capture the final request payload and may separately expose the full budget estimate;
they never replace canonical transcript inspection.

### 1.7 Stage 1 Tests

Shared transformer:

- Sequential and parallel inline Claude tool rounds.
- Text before, between, and after tool exchanges.
- Exact MCP prefix mapping.
- Known structural tool versus unknown built-in text lowering.
- Missing call/result, duplicate result, malformed output.
- Boundary-specific reasoning and metadata sanitation.
- Capability-based media preservation/description.
- Determinism, idempotence, immutability, and diagnostic deduplication.

Integration:

- Persist Claude MCP history, restart, switch to OpenAI-compatible, and prompt.
- Persist Claude built-in history, switch to Anthropic API, and prompt.
- Persist ordinary tool history, restart, switch to Claude Code, and inspect its payload.
- Repeated Claude to native to Claude switching does not duplicate results.
- Oversized transformed history compacts without lowering the retained canonical suffix.
- Cancellation recovery followed by a provider switch remains valid.

### 1.8 Stage 1 Ship Gate

- Idle provider switching works in both directions with populated text and tool history.
- No destination request contains unmatched tool protocol.
- Canonical history changes only when compaction itself intentionally changes it.
- One authenticated pass covers both directions and one oversized transcript.

## Stage 2: Minimal Persistent Native Continuation

### 2.1 Scope

Enable persistence and native continuation only where the runtime can consume it:

- Core non-primary named subagent sessions with full canonical transcript continuation.
- Mini Lilac current top-level and named delegated session heads.

Keep `persistSession: false` for:

- Core primary runs until exact surface-history prefix ownership is designed.
- Title, validation, and compaction utility models.
- Any Claude call site without a durable binding consumer.

Mini undo/redo always permits fresh portable replay. Reusing retained historical native heads is
deferred.

### 2.2 Own A Replaceable Attempt Runtime

Move the minimum runtime-binding ownership needed from fallback work into Stage 2. The existing
`AiSdkPiAgent` remains alive, but its active model runtime can be replaced before a provider call or at
a safe model-call retry boundary.

```ts
type ClaudeAttemptRuntime = {
  readonly model: LanguageModel;
  readonly run: MaterializedClaudeCodeRun;
  readonly attemptId: string;
  readonly requestedSessionId: string;
  readonly baseBinding: ClaudeSessionBinding | null;
  readonly payloadMode: "full" | "suffix";
  dispose(): Promise<void>;
};
```

Persistent Claude models always set AI SDK `streamText` retries to zero. The Lilac retry controller
owns retries and invokes a runtime-replacement callback before returning `retry`.

Same-model transient retry:

1. Finish the failed attempt as unpromoted/uncertain.
2. Dispose its model/process.
3. Build a new model and native attempt from the last clean binding, or fresh canonical history.
4. Install it through the Stage 0 pre-call seam.
5. Retry on the existing agent and canonical state.

This recreates the provider runtime, not `AiSdkPiAgent`; steering queues, recovery checkpoints,
subscriptions, usage, and compaction hooks remain intact.

### 2.3 Define Versioned Compatibility Hashes

Binding compatibility v1 includes:

```text
providerId
requestClient
lilacSessionId
bindingProtocolVersion
canonicalHashVersion
canonicalHeadHash
executionScopeHashVersion
executionScopeHash
modelSpecifier
```

The stable binding row key is `(providerId, requestClient, lilacSessionId,
executionScopeHashVersion, executionScopeHash, modelSpecifier)`. Protocol/hash versions and the
canonical head are validated row values. `canonicalHeadHash`, `canonicalMessageCount`, and
`terminalRequestId` must describe the immediate latest committed transcript before current input;
they are not a search for any matching historical prefix.

`canonicalHashVersion: 1`:

- Project normalized canonical `ModelMessage[]` into an explicit semantic schema.
- Include roles, text/files, tool names/IDs/inputs/results, and replay origin provider/model.
- Exclude Lilac metadata format-version fields, ephemeral overlays, target decorations, debug data,
  and provider metadata that does not alter portable replay semantics.
- Serialize with shared recursively key-sorted SuperJSON.
- Hash with SHA-256 and a domain string such as `lilac:claude-canonical:v1`.

`executionScopeHashVersion: 1` hashes a canonical object containing:

- Canonical cwd.
- Profile and safety mode.
- Effective authority/capability fingerprint.
- System-policy fingerprint.
- Effective tool/MCP authority fingerprint.
- Provider configuration identity.

Include a principal identity only when it changes effective authority. Do not include an incidental
caller identity that would prevent a deliberately shared named subagent from continuing.

For v1, model spec must match exactly. An agent may choose another Claude model, but that request
starts a fresh persisted session from portable canonical history.

Persist provider package, Agent SDK, and Claude CLI versions for diagnostics. Do not require exact
version equality; validate through the current SDK and fall back fresh if it rejects the session.

Core and Mini share hash schemas, domain strings, and golden fixtures. Mini's internal transcript-node
hash is not reused.

### 2.4 Store One Clean Binding And Bounded Attempts

Store one current clean binding per logical compatibility key, not retained generations:

```ts
type ClaudeSessionBinding = {
  bindingProtocolVersion: 1;
  providerId: string;
  requestClient: string;
  lilacSessionId: string;
  canonicalHashVersion: 1;
  canonicalHeadHash: string;
  canonicalMessageCount: number;
  executionScopeHashVersion: 1;
  executionScopeHash: string;
  modelSpecifier: string;
  claudeSessionId: string;
  nativeLastModified: number;
  nativeContextTokens: number;
  nativeContextMaxTokens: number;
  nativeCwd: string;
  terminalRequestId: string;
  updatedAt: number;
};
```

Attempts are bounded audit/coordination rows keyed by `(requestId, attemptIndex)` with states
`active | succeeded | failed | cancelled | uncertain` and their concrete requested Claude session
ID.

Use immediate SQLite transactions and compare-and-swap promotion against the expected row and old
canonical head. A successful non-Claude commit does not need to delete the row; its newer latest
request/head makes the old row ineligible. Do not add leases. On startup, mark leftover active
attempts uncertain. A failed CAS leaves the attempt unpromoted.

### 2.5 Fork From The Last Clean Same-Model Binding

Lookup occurs against the complete latest committed transcript before admitting the next user input.
The binding's `terminalRequestId`, hash, and count must match that immediate transcript head exactly.
Only the newly admitted input and later messages in the same active request may follow it as an
unsynchronized suffix.

For a compatible binding at latest committed head H:

```text
clean Claude session A at H
  -> request attempt creates UUID B
  -> resume A + forkSession=true + sessionId=B
  -> send only the unsynchronized canonical suffix
  -> clean success persists canonical H2
  -> promote B as the one clean binding at H2
```

On failure, cancellation, crash, ID mismatch, or transcript persistence failure, do not promote B.
The old clean binding remains eligible for the unchanged old head.

Without a compatible binding, start a fresh persisted session using a new UUID and the full Stage 1
portable replay. A successful cross-provider turn changes the latest committed request/head, so an
older Claude binding cannot qualify merely because it remains a historical prefix. A model change
also uses the fresh path.

### 2.6 Validate The Native Session Before Reuse

Before forking, call the supported Agent SDK session helper scoped to the expected cwd. Require:

- The native session exists.
- Its ID and cwd match the binding.
- Its `lastModified` matches the snapshot recorded at promotion, preventing resume after an external
  continuation or mutation.
- The binding has a terminal native context-usage snapshot captured through
  `ClaudeCodeQueryController.getContextUsage()`.

Missing or changed native state invalidates the binding and chooses fresh mode. A deletion/mutation
race after validation may retry once fresh when a closed error classifier recognizes native
resume-load, missing-session, corrupt-session, or session-compatibility rejection and retry safety
still permits replay. Authentication, network, model, permission, and arbitrary process failures do
not use this special fresh fallback.

Capture native `totalTokens` and `maxTokens` while the query controller is live. The bridge schedules
a context-usage read from the latest assistant/stop-adjacent SDK event (or an equivalent live Stop
hook), retains the latest successful snapshot, and awaits that pending read during finalization. Do
not attempt the first read only after `streamText` has resolved. Accept the snapshot for promotion only
after the matching successful result arrives.

Refresh the process-local native occupancy after every successful outer model call in one Lilac
request. This accounts for Claude-native compaction, tool/system context, same-request responses, and
prior ephemeral overlays that do not exist in Lilac canonical messages. If a terminal-adjacent usage
snapshot cannot be captured, stop suffix continuation for later calls and do not promote the attempt
as a reusable clean binding.

The bridge captures `system/init.session_id` and successful terminal result `session_id`. Both must
equal the UUID requested for the fresh/fork attempt. Callback failures are recorded in bridge state;
do not rely on throwing from `onSdkMessage`, because provider observability callbacks swallow errors.
Missing, conflicting, or mismatched IDs make the attempt uncertain and ineligible for promotion.

At successful finalization, re-read the attempt session through `getSessionInfo` and record its
authoritative cwd and `lastModified`. For a fork, also re-read the source clean session and require its
`lastModified` still equals the preflight snapshot. If either side changed or disappeared, do not
promote the fork.

### 2.7 Estimate Full Context, Send Only The Suffix

The Stage 0 full budget view always represents the complete canonical target context plus current
ephemeral overlays. For a validated native binding, also estimate the upcoming native occupancy as:

```text
stored nativeContextTokens + transformed suffix tokens + current ephemeral overlay tokens
```

Use the larger of the reconstructed full-view estimate and native occupancy estimate. This is
conservative when Claude has compacted its own native session, but it prevents hidden native-only
messages and repeated overlays from bypassing Lilac's threshold. Native suffix selection happens only
after estimation and any compaction.

For suffix mode:

1. Verify the first `canonicalMessageCount` canonical messages hash to `canonicalHeadHash`.
2. Select the remaining canonical messages.
3. Replay-transform only that suffix for the request payload.
4. Append freshly generated ephemeral overlays.
5. Apply final decorations and target tool-ID normalization.

A process-local canonical cursor tracks successful outer model calls within one Lilac request. It
counts canonical messages only. Todo/context overlays never advance it. Its native occupancy snapshot
is refreshed after each successful call; missing refresh marks the invoked attempt unpromotable and
forces a fresh runtime before another outer call.

If preflight compaction changes canonical history before the first provider call, the pre-call seam
disposes the uninvoked fork runtime and installs a fresh persisted attempt for the compacted head. If
compaction or another canonical replacement occurs between later outer calls, finish the invoked
attempt without promotion, dispose it, reset the cursor, and install a fresh attempt before the next
call. This avoids resuming native context after Lilac intentionally replaced its canonical lineage.

### 2.8 Canonical-First Promotion

Core cannot atomically compose the current transcript save with a separate binding update. Use a
safe two-step protocol:

1. Save the canonical request transcript through `SqliteTranscriptStore`.
2. Re-read that request transcript and verify its versioned canonical hash.
3. CAS-promote the successful attempt against the expected old binding head.

If save or verification fails, log the existing transcript error and do not promote. A crash between
canonical save and promotion loses only native-resume efficiency; the next run uses full replay.

Mini may commit canonical finalization and binding promotion in one existing runtime-store
transaction because both records share that store.

### 2.9 Retention

- Prune Lilac binding and attempt metadata with the corresponding canonical transcript/session
  retention.
- Bound attempt rows per logical session and by age.
- Let Claude's own cleanup policy own JSONL retention in v1.
- Do not add eager `deleteSession` calls to transcript deletion paths in this stage.
- A missing native file invalidates the binding and transparently falls back to fresh replay.

Native session IDs are opaque identifiers, not credentials. Structured debug logs may include them;
user-facing output does not need them.

### 2.10 Stage 2 Tests

Foundation/runtime:

- Persistent eligible agent model uses `persistSession: true`; utility and ineligible models remain
  false.
- Internal AI SDK retries are zero only for persistent Claude attempts; native-provider retry behavior
  is unchanged.
- Same-model retry rematerializes a new model/session rather than auto-resuming the dirty attempt.
- Preflight compaction disposes an uninvoked fork and installs a fresh attempt.
- Between-turn compaction retires an invoked attempt and starts the next call fresh.
- External MCP execution prevents retry before stream observation.

Hashes/store:

- Core and Mini golden canonical/scope hashes match.
- Hash-version, scope-version, protocol-version, model, head, and authority mismatches use fresh mode.
- Replay-origin format-version changes do not invalidate semantically identical bindings.
- Active attempts become uncertain on startup.
- CAS promotion is deterministic; no lease behavior exists.
- Bounded retention removes old attempt/binding metadata.

Continuation:

- A second same-model named subagent request forks the clean session and sends only the suffix.
- Full-view estimation includes native prefix and current todos while the payload excludes both the
  synchronized prefix and stale todo overlays.
- Native context usage includes prior overlays that are absent from canonical history; missing usage
  prevents native-binding promotion.
- Native context usage refreshes after every successful outer call; a missing refresh prevents later
  suffix continuation in that attempt.
- Hash/count mismatch uses full fresh replay.
- A historical Claude prefix does not qualify after a newer non-Claude transcript becomes the latest
  committed head.
- Model change and cross-provider return start fresh persisted sessions.
- Mini current-head continuation works; undo/redo is allowed to replay fresh.
- Missing/externally changed native session uses fresh mode.
- Source-session mutation between validation and fork promotion prevents promotion.
- Init/result ID mismatch prevents promotion.
- Canonical save failure prevents Core promotion.
- Crash/cancellation leaves the prior clean binding unchanged.

Authenticated:

- Continue one Core named subagent through three same-model requests and verify suffix-only prompts.
- Continue one Mini session and verify current todos are regenerated once per call.
- Delete or externally continue the native session and verify fresh replay.
- Change Claude model and verify fresh persisted continuation without gating model choice.

### 2.11 Stage 2 Ship Gate

- Eligible Claude sessions persist by default and continue through clean native forks.
- Full target context drives budgeting even when only a suffix is sent.
- Dirty retries, failed persistence, and uncertain attempts never promote.
- Cross-model/cross-provider choices remain allowed and use fresh portable replay.
- Missing native state degrades without user intervention.
- No leases, retained generations, primary persistence, or undo-head reuse are introduced.

## Stage 3: Cross-Boundary Model Fallback

Stage 3 reuses Stage 0 runtime replacement, Stage 1 replay, and Stage 2 persistent attempt ownership.

### 3.1 Materialized Runtime Binding

Represent all model-derived run state as one replaceable binding:

```ts
type ModelRuntimeBinding = {
  readonly resolved: ResolvedModelRef;
  readonly model: LanguageModel;
  readonly system: SystemPrompt;
  readonly tools: ToolSet;
  readonly activeToolNames: ReadonlySet<string>;
  readonly sendToolsToModel: boolean;
  readonly beforeStep?: BeforeStepHandler;
  readonly providerOptions?: Record<string, JSONObject>;
  readonly experimentalDownload?: Experimental_DownloadFunction;
  readonly claudeAttempt: ClaudeAttemptRuntime | null;
  createSummaryModel(): LanguageModel;
  dispose(): Promise<void>;
};
```

Build replacement bindings without mutating live state.

### 3.2 One Binding Commit Point

Define one synchronous/actor-locked commit point:

1. Build the replacement binding completely.
2. Apply model, system, reasoning, tools, active tools, execution mode, refresh hook, download behavior,
   replay target, and output-normalizer policy to the agent.
3. Replace the active binding reference and active Claude control together.
4. After commit, finish any failed Claude attempt without promotion and dispose the previous binding.

If build or pre-commit validation fails, dispose the candidate and leave the old binding/control
unchanged. There is no interval where a native binding is exposed with stale Claude control or vice
versa.

Add the minimum mutable agent execution-mode seam, including `sendToolsToModel`. Do not recreate
`AiSdkPiAgent` during fallback.

### 3.3 Supported Launch Matrix

Launch scope:

- Native AI SDK provider to another native provider.
- Native AI SDK provider to Claude Code.
- Claude Code to a native AI SDK provider.

Defer Claude Code to Claude Code fallback. Different Claude candidates commonly share process/auth
failures and require additional policy around clean-base reuse. The configured skip remains explicit
and documented for this one transition in v1.

When entering Claude Code, use Stage 2 only if an exact same-model clean binding exists; otherwise
start a fresh persisted attempt from full portable canonical history. When leaving Claude, finish the
failed attempt without promotion and replay canonical history through the native target transformer.

### 3.4 Retry Safety

Fallback is legal only for transient model-call/stream failures with:

- No provider-executed tool latch.
- No completed model phase.
- No invalid canonical tool boundary.
- No cancellation/interrupt.

Partial text/reasoning and native unfinalized tool drafts roll back through the existing `turn_retry`
contract. Any MCP or built-in provider tool activity blocks retry and fallback. A surviving clean
native base does not make side effects in the failed attempt repeatable.

### 3.5 Binding-Aware Compaction

- Resolve context limits and replay target from the active binding.
- Resolve inherited summary models lazily through the active binding.
- If the active binding is Claude, never use `summaryModel: "current"`; that would select the
  tool-enabled Claude agent model. Use a fresh no-tools utility model.
- A fallback into Claude may compact before its first call, then rematerialize fresh for the compacted
  canonical head through the Stage 0 pre-call seam.
- Transform/summary failures remain transform failures and do not masquerade as safe model-call
  fallback opportunities.

### 3.6 Retry Semantics

Do not change native-provider retry behavior merely because a chain contains a Claude candidate.
Only persistent Claude attempts force AI SDK internal retries to zero. The Lilac controller still
applies configured per-candidate budgets and invokes runtime replacement for Claude retries.

Add a ship-gate assertion that a native run whose fallback chain contains an untouched Claude
candidate retains its previous retry count and timing.

### 3.7 Stage 3 Tests

- Native to Claude with populated canonical history.
- Claude to native with populated inline tool history.
- Native to Claude to native chain.
- Claude-to-Claude candidate remains explicitly skipped without stopping a later native candidate.
- Partial output rollback in both directions.
- MCP/built-in execution prevents fallback.
- Active Claude control changes at the binding commit point and cancellation reaches only the active
  binding.
- Entering Claude after compaction uses a fresh persisted attempt.
- Inherited compaction never resolves to a tool-enabled Claude model.
- Failed Claude fallback attempts never promote.
- Native retry semantics are unchanged by an unused Claude fallback candidate.
- Final labels, cost attribution, provider options, tools, editing mode, and prompt-cache decoration
  follow the active binding.

### 3.8 Stage 3 Ship Gate

- The supported launch matrix works with populated transcripts.
- Side-effect retry safety is unchanged.
- Binding/control replacement is atomic from the runner's perspective.
- Compaction uses the active target without contaminating canonical history.
- One authenticated pass covers native-to-Claude and Claude-to-native fallback.

## Implementation Order

1. Add the external-tool retry-safety latch and focused tests.
2. Split auto-compaction canonical input, full budget view, ephemeral overlays, retained canonical
   suffix, and final decoration.
3. Move Mini todo context into the ephemeral-overlay hook.
4. Add canonical-preservation regression tests around current Core/Mini transforms.
5. Add the pre-call runtime preparation seam.
6. Add replay-origin parsing with narrow structural legacy handling.
7. Implement capability-aware replay lowering and Claude-boundary sanitation.
8. Integrate replay through the full-view pipeline and complete Stage 1 tests.
9. Introduce replaceable persistent-Claude attempt ownership without enabling new fallback candidates.
10. Define versioned canonical/scope hashes and shared golden fixtures.
11. Add simplified one-clean-binding and bounded-attempt stores without generations or leases.
12. Add bridge fresh/fork options, native validation, and init/result identity tracking.
13. Implement Core named-subagent and Mini current-head full-estimate/suffix-payload continuation.
14. Disable internal retries for persistent Claude and rematerialize every same-model retry.
15. Implement canonical-first verified promotion and metadata retention.
16. Complete Stage 2 tests and authenticated continuation validation.
17. Generalize runtime bindings and add one binding/control commit point.
18. Enable native-to-Claude and Claude-to-native fallback.
19. Complete Stage 3 tests and authenticated fallback validation.
20. Update superseded Claude/fallback documentation and run package typechecks, root lint/format, and
    the full test harness.

## Deferred

- Core primary native persistence and exact-prefix resume.
- Native reuse across Claude model changes.
- Claude-to-Claude fallback.
- Mini Lilac historical undo/redo native-head reuse.
- Eager deletion of native Claude JSONL when Lilac transcript retention expires.
- Read-only exceptions to provider-executed retry safety.
- Configurable historical tool-input limits in the community Claude provider.
- A general provider replay-policy plugin framework.
