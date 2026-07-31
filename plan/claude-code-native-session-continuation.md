# Claude Code Native Session Continuation And Text Replay

## Status

Proposed.

This plan is the narrow alternative to Stages 1 through 3 of
`plan/claude-code-portable-replay-and-fallback.md`.

The earlier plan's Stage 0 remains a prerequisite. This plan replaces its capability-aware structured
cross-provider replay with a deliberately lossy plain-text projection. Explicit model selection may
cross the `claude-code` boundary at a new-turn boundary; automatic fallback may not. Consecutive
Claude-backed turns use Claude's native persisted transcript for efficient continuation.

The implementation intentionally chooses the simple, storage-heavy safety model:

- Every admitted Claude-backed turn starts a fresh Claude session or forks the last clean Claude
  session.
- Lilac never advances a clean Claude session in place.
- Successful forks become clean bindings only after Lilac commits canonical history.
- Old Mini main-session forks remain available for history navigation.
- Native transcript storage may grow roughly quadratically with conversation length when Claude
  copies the synchronized prefix into every fork. This is an accepted v1 tradeoff.
- A user-selected cross-provider turn starts fresh from a text-only view of prior canonical history.

## Goals

- Let a populated `claude-code` session switch Claude model and reasoning effort without replaying
  its synchronized history through Lilac.
- Continue eligible Core and Mini sessions through persisted Claude sessions after process restart.
- Preserve one known-clean Claude base across model failures, cancellation, crashes, and failed
  Lilac persistence.
- Make Mini main-session undo, redo, and branching select the matching native Claude history when a
  binding exists.
- Continue Core primary Discord sessions only when their current composed history is an exact
  ID-based extension of the history owned by the clean Claude binding.
- Start a fresh persisted Claude session from canonical same-provider history whenever native state
  is missing, invalid, compacted, or not an exact prefix.
- Let `/model`, `!m:<slug>`, and equivalent quiescent model selection cross into or out of
  `claude-code` by replaying historical context as plain text.
- Preserve useful historical tool facts as clearly labeled assistant text without emitting
  structured historical tool protocol.
- Keep Lilac canonical history authoritative for recovery, validation, fresh same-provider replay,
  and user-visible transcript behavior.

## Non-Goals

- Lossless or structured tool-protocol replay between `claude-code` and ordinary AI SDK providers.
- Cross-boundary model fallback.
- Automatic Claude-to-Claude fallback. Explicit model and effort changes are supported.
- Direct in-place resume of a clean Claude session.
- Reducing or deduplicating Claude's native JSONL storage.
- Parsing or writing Claude's private JSONL format.
- Making surface edits retroactively change model context.
- Retaining multiple historical Core primary branch bindings in v1.
- Native continuation for Core primary request clients that do not emit an exact lineage manifest.
- Native bindings for title, validation, summary, or other utility-only model calls.
- Sharing one native session concurrently between Lilac processes.
- Exactly-once external tool side effects across process crashes.
- Treating Claude Agent SDK subagents as Lilac named subagent sessions.

## Agreed Decisions

1. **The Claude boundary is a runtime boundary, not a permanent session lock.** An active model
   runtime never changes provider family in place. A newly materialized turn may cross the boundary
   through lossy text replay.
2. **Provider family is resolved from the product's provider descriptor, not an arbitrary display
   ID.** Mini uses its configured provider type, so a provider named `claude` may still have type
   `claude-code`. Core uses its built-in `claude-code` provider descriptor.
3. **Every eligible Lilac turn starts with a fresh or forked Claude attempt.** The initial candidate
   is materialized once at the admitted Lilac request boundary, not once per internal model/tool
   loop. A failed retry or invalidated candidate may create a replacement attempt.
4. **The clean base is immutable.** A continued turn uses `resume`, `forkSession: true`, and a new
   Lilac-generated Claude UUID.
5. **Model and effort are not native-binding compatibility keys.** The fork uses the model and
   effort selected for the new Lilac turn.
6. **Model and effort changes are explicit selection, not fallback.** A model change does not by
   itself invalidate a compatible Claude binding.
7. **Lilac canonical history remains authoritative.** Claude native state is an opaque acceleration
   and may always be discarded in favor of fresh same-provider replay.
8. **Cross-boundary replay is text-only.** Preserve user and assistant text. Drop hidden reasoning and
   provider metadata. Flatten historical tool exchanges into labeled assistant text blocks with no
   tool-call or tool-result protocol parts.
9. **Tool history is never serialized as a fake user instruction.** A historical tool block is
   explicitly labeled as prior activity, retains bounded tool name/input/result text, and cannot be
   interpreted as a pending tool request.
10. **Surface message identity is ID-based.** Once Core has admitted a surface message ID, its
   first-seen canonical projection is immutable for that lineage. Later edits do nothing.
11. **Ignoring an edit applies to all future uses.** Fresh replay, compaction, budgeting, and prefix
   reconstruction use the stored first-seen projection, not newly fetched edited text.
12. **A missing, deleted, reordered, or differently selected surface ID is not an edit.** It changes
     the lineage and may force a fresh Claude session.
13. **Core starts fresh on prefix mismatch.** V1 keeps only one current clean Core primary binding;
     it does not search retained historical branches.
14. **Mini main history is branch-aware.** A clean native binding is attached to the exact Mini
     history state it represents. Undo and redo select bindings by history state.
15. **Mini and Core named subagents use one current clean binding.** Their public workflows do not
     expose historical rewind, so old bindings are not selected again.
16. **Lilac compaction breaks native synchronization.** The compacted canonical state starts a fresh
     persisted Claude session. It never resumes a pre-compaction native session as if the summary
     were the same prefix.
17. **V1 accepts native storage growth.** Native cleanup is conservative and never scans or deletes
     Claude sessions that Lilac cannot prove it owns.

## Required Stage 0 Foundation

Complete Stage 0 of `plan/claude-code-portable-replay-and-fallback.md` before enabling native
continuation:

- Separate canonical messages from the full model-facing budget view.
- Keep media sanitation, historical-output pruning, and prompt decoration out of canonical state.
- Separate ephemeral overlays such as Mini session todos from canonical messages.
- Select compaction suffixes on canonical turn boundaries.
- Add a pre-call runtime preparation seam after compaction settles.
- Latch provider-executed external tool activity before tool validation or execution starts.

The last item is required even with forked attempts. Forking protects native context but cannot undo
filesystem, network, or MCP side effects.

## Core Invariants

1. A clean native binding owns one exact committed Lilac history head.
2. A clean native session is never resumed in place for a new Lilac turn.
3. Every fresh or forked attempt uses a new Lilac-generated UUID.
4. A continued attempt forks only from the clean binding that owns the committed head immediately
   before the admitted input.
5. Model and effort may change across a fork and do not affect prefix ownership.
6. Provider identity, Claude storage namespace, cwd, effective authority, and system policy remain
   binding compatibility inputs.
7. Persistent Claude models use zero AI SDK internal retries. Lilac owns attempt replacement.
8. A safe retry creates another fork from the unchanged clean base.
9. Provider-executed tool activity blocks retry even though the clean native base still exists.
10. Only clean terminal model success may become promotable.
11. Canonical persistence and verification happen before native-binding promotion.
12. Cancellation, crash, native identity mismatch, context-usage failure, or canonical persistence
    failure never promotes the candidate.
13. Failed candidate sessions are never used as continuation bases.
14. Full canonical target context drives estimation even when the request payload contains only an
    unsynchronized suffix.
15. Ephemeral overlays are regenerated after suffix selection and never advance native cursors.
16. Canonical replacement after a candidate was invoked makes that candidate unpromotable.
17. A missing or externally changed native session falls back to a fresh persisted Claude session.
18. A user-selected provider-family change starts a fresh target runtime from plain-text historical
    replay. It never mutates an active runtime in place.
19. Core primary continuation requires an exact complete-segment prefix match, not merely the same
    Core session ID.
20. A first-seen surface projection is immutable for its ID and lineage version.
21. Successful provider-executed tool activity does not block promotion. It blocks retry only when
    the attempt subsequently fails or becomes uncertain.

## Session Support Matrix

| Session type | Native ownership key | Historical bindings | Prefix policy |
| --- | --- | --- | --- |
| Mini main | Mini session ID + history state ID | Retained per bound history state | Exact history state |
| Mini named subagent | Named child Mini session ID | Current clean binding only | Exact current history state |
| Core named subagent | Request client + named subagent session ID | Current clean binding only | Exact canonical transcript head |
| Core primary Discord | Request client + Core session ID | Current clean binding only | Exact ordered lineage prefix |
| Core primary without lineage manifest | None | None | Fresh ephemeral or fresh persisted call only |
| Utility/title/summary | None | None | Always ephemeral |

## Shared Native Session Model

### Materialization Input

Extend `packages/claude-code-bridge/claude-code-run.ts` with an explicit native-session mode:

```ts
type ClaudeNativeSessionStart =
  | {
      readonly mode: "ephemeral";
    }
  | {
      readonly mode: "fresh";
      readonly sessionId: string;
    }
  | {
      readonly mode: "fork";
      readonly baseSessionId: string;
      readonly sessionId: string;
    };
```

Agent-model settings become:

```text
ephemeral -> persistSession: false
fresh     -> persistSession: true, sessionId: candidate UUID
fork      -> persistSession: true, resume: clean UUID,
             forkSession: true, sessionId: candidate UUID
```

Utility models always remain:

```text
persistSession: false
tools: []
settingSources: []
```

Do not expose raw `resume`, `forkSession`, or `sessionId` options to callers. The typed union prevents
invalid combinations and keeps ownership in the bridge.

### Materialized Attempt

The bridge returns model/control/disposal plus native observations:

```ts
type ClaudeNativeAttemptObservation = {
  readonly requestedSessionId: string;
  readonly sourceSessionId: string | null;
  readonly initSessionId: string | null;
  readonly resultSessionId: string | null;
  readonly contextTokens: number | null;
  readonly contextMaxTokens: number | null;
  readonly requestedModel: string;
  readonly initializedModel: string | null;
  readonly requestedReasoning: string;
  readonly providerWarnings: readonly string[];
  readonly invoked: boolean;
  readonly callbackError: string | null;
};
```

It must also provide a supported finalization method that:

- Waits for context usage captured while the query controller is still live.
- Calls `getSessionInfo` while scoped to the expected cwd.
- Returns authoritative cwd and `lastModified`.
- Re-reads the source clean session for fork attempts.
- Reports missing, conflicting, or mismatched native IDs without relying on exceptions thrown from
  observability callbacks.

Capture `system/init.session_id` and the successful terminal result session ID. Both must equal the
candidate UUID. The source session's final `lastModified` must still equal its preflight snapshot.

Install a terminal Claude SDK `Stop` hook, or use an equivalent terminal-adjacent SDK event, for each
outer call. Start `getContextUsage()` while the controller is live, retain the latest successful
snapshot, and await that pending capture during finalization. Do not make the first context-usage
call after `streamText` has already resolved.

### Model And Effort

Create the fork with the currently selected Claude model. Continue passing Lilac's portable
`reasoning` value to `streamText`.

The installed `ai-sdk-provider-claude-code` maps:

| Lilac reasoning | Claude behavior |
| --- | --- |
| `none` | Thinking disabled |
| `minimal` | Low effort |
| `low` | Low effort |
| `medium` | Medium effort |
| `high` | High effort |
| `xhigh` | Extra-high effort |
| `provider-default` | Provider default |

Do not use the live query controller's `setModel` as the cross-turn mechanism. The controller exists
only while one query is active. A new Lilac turn materializes a new fork with the selected model and
effort.

Record requested model/effort, the initialized model when a documented SDK event supplies it, and
provider warnings. Do not invent an observed effort value when the SDK does not expose one.

## Binding And Attempt Records

### Clean Binding

Use one shared logical shape with product-specific head identity:

```ts
type ClaudeBindingHead =
  | {
      readonly product: "mini";
      readonly historyStateId: string;
      readonly canonicalMessageCount: number;
    }
  | {
      readonly product: "core-named";
      readonly terminalRequestId: string;
      readonly canonicalHashVersion: 1;
      readonly canonicalHeadHash: string;
      readonly canonicalMessageCount: number;
    }
  | {
      readonly product: "core-primary";
      readonly lineageVersion: 1;
      readonly atomCount: number;
      readonly prefixDigest: string;
      readonly canonicalMessageCount: number;
    };

type ClaudeSessionBinding = {
  readonly bindingProtocolVersion: 1;
  readonly providerId: string;
  readonly providerFamily: "claude-code";
  readonly requestClient: string;
  readonly lilacSessionId: string;
  readonly head: ClaudeBindingHead;
  readonly executionScopeHashVersion: 1;
  readonly executionScopeHash: string;
  readonly claudeSessionId: string;
  readonly nativeCwd: string;
  readonly nativeLastModified: number;
  readonly nativeContextTokens: number;
  readonly nativeContextMaxTokens: number;
  readonly lastModelSpecifier: string;
  readonly lastReasoning: string;
  readonly revision: number;
  readonly updatedAt: number;
};
```

`lastModelSpecifier` and `lastReasoning` are diagnostics only.

### Attempt Record

Persist bounded attempt metadata for crash recovery, promotion fencing, and later cleanup:

```ts
type ClaudeSessionAttempt = {
  readonly product: "mini" | "core-named" | "core-primary";
  readonly providerId: string;
  readonly requestClient: string;
  readonly lilacSessionId: string;
  readonly sourceHead: ClaudeBindingHead | null;
  readonly executionScopeHashVersion: 1;
  readonly executionScopeHash: string;
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly candidateSessionId: string;
  readonly sourceSessionId: string | null;
  readonly expectedBindingRevision: number | null;
  readonly state: "active" | "succeeded" | "failed" | "cancelled" | "uncertain";
  readonly createdAt: number;
  readonly updatedAt: number;
};
```

Forking means an `active` attempt left by a crash cannot corrupt the clean base. Startup marks it
`uncertain`; it is never promoted. Attempt rows do not need leases or retained generations.

### Canonical Hash

Core named sessions use the versioned semantic canonical hash from the earlier Stage 2 proposal:

- Include roles, ordered text/files, tool names and IDs, inputs, outputs, and error semantics.
- Exclude ephemeral overlays, request decorations, cache metadata, debug data, and lineage metadata.
- Canonically serialize recursively sorted data.
- Hash with SHA-256 and a versioned domain string.

Mini uses its exact committed history-state identity as the primary head key. It may additionally
store the model-head hash for diagnostics and integrity checks.

### Execution Scope

The execution-scope hash includes:

- Canonical cwd.
- Provider identity and Claude session-storage namespace.
- Executable/config identity that changes where native sessions are stored.
- Profile and safety mode.
- Effective authority/capability fingerprint.
- Stable system-policy fingerprint.
- Effective Lilac tool/MCP authority fingerprint.

It excludes:

- Model and reasoning effort.
- Request IDs.
- Incidental caller identity that does not change authority.
- Ephemeral todos, thread search, or transient overlays.
- Dynamic prompt-cache decoration.

A scope mismatch starts a fresh persisted Claude session within the same provider family.

## Attempt Lifecycle

### Selection

After durable prompt admission identifies the exact pre-input history head, but before provider
invocation:

1. Resolve the requested provider, model, and effort.
2. Read the exact committed head and its provider-state metadata immediately before the admitted
   input.
3. Determine whether the target continues the head family or crosses the Claude boundary.
4. For a Claude target, load a clean binding for that exact head or prefix.
5. Verify binding protocol, provider namespace, execution scope, and native state.
6. Generate a candidate Claude UUID when the target is Claude.
7. Materialize a fork when the Claude binding is valid; otherwise materialize a fresh target runtime.
8. For a fresh runtime only, prepare the historical prefix through plain-text replay when the family
   changed or the committed history is already mixed-family. An exact Claude fork remains suffix-only
   even when older canonical history contains cross-family turns.

Mini uses the prompt transition's actual `fromStateId` after any workspace-observation state is
created. Candidate materialization therefore happens in the Stage 0 pre-call seam after admission and
before the first Claude call.

### Invocation

The candidate runtime is installed through the Stage 0 pre-call seam after compaction settles.

- A fork sends only the unsynchronized canonical suffix plus freshly regenerated overlays.
- A fresh same-family session may send the complete canonical target view plus overlays.
- A fresh cross-family or mixed-history session sends the plain-text projected historical prefix,
  followed by the normal current user message and overlays.
- The full target view is always used for context estimation.
- The first successful outer model call advances a process-local synchronized-message cursor.
- Later model/tool-loop calls in the same Lilac turn reuse the candidate session and send only the
  new canonical suffix.
- The candidate is not forked again for each internal tool loop.

### Retry

Persistent Claude models set AI SDK internal retries to zero.

For a safe transient model-call retry:

1. Mark the failed candidate unpromotable.
2. Dispose its model, query, and MCP bridge.
3. Roll back partial Lilac output through the existing turn-retry contract.
4. Generate another candidate UUID.
5. Fork again from the unchanged clean base, or create another fresh candidate when no base exists.
6. Install the replacement runtime before the next provider call.

Any provider-executed MCP or built-in tool activity blocks retry. Forking does not make side effects
repeatable.

### Promotion

A candidate is promotable only when:

- The model turn completed successfully.
- No cancellation or interrupt was requested.
- Requested, init, and result session IDs match.
- Terminal native context usage was captured.
- Candidate `getSessionInfo` returns expected cwd and `lastModified`.
- The source clean session remained unchanged during the fork.
- Canonical history was durably committed and verified.
- The expected prior binding revision/head still matches.

Promotion is compare-and-swap. A failed CAS leaves the candidate unpromoted.

A successful tool-using turn remains promotable. The provider-tool latch governs whether a failed
attempt may be retried; it does not invalidate a clean terminal result whose canonical transcript was
successfully committed.

### Failure

Failure, cancellation, crash, native mismatch, canonical save failure, or failed CAS leaves the clean
base unchanged. The candidate is failed, cancelled, or uncertain and is never selected as a base.

## Context And Compaction

### Full Budget View

Estimate both:

```text
complete transformed canonical target view + current overlays
```

and, for a native fork:

```text
stored native context tokens + transformed suffix tokens + current overlay tokens
```

Use the larger estimate.

Refresh native context usage after every successful outer model call. Missing usage makes the
candidate unpromotable and forces a fresh runtime before another outer call.

### Model Changes

Resolve context limits against the newly selected model. Switching from a larger-context Claude
model to a smaller model may trigger Lilac compaction before the fork is invoked.

If compaction changes canonical history:

- Dispose the uninvoked fork candidate.
- Create a fresh persisted candidate for the compacted canonical head.
- Send the complete compacted history.

Do not attempt to resume the old native prefix after compaction.

### Canonical Replacement After Invocation

If compaction or another canonical replacement occurs after the candidate was invoked:

- Mark the candidate unpromotable.
- Dispose it.
- Reset the native cursor.
- Rerun normal binding selection against the replacement canonical head before the next model call.
- Force fresh mode when the replacement changed the clean-base prefix; otherwise another fork from
  the still-matching clean base is allowed.

## Explicit Cross-Provider Selection

The `claude-code` boundary separates runtime and message protocols, not user-visible sessions.
Explicit selection may cross it only by materializing a new turn.

### Committed Head Metadata

Persist provider-family metadata with each committed history head:

```ts
type HistoryProviderFamily = "claude-code" | "ai-sdk";

type HistoryProviderState = {
  readonly lastFamily: HistoryProviderFamily;
  readonly containsCrossFamilyTurns: boolean;
};
```

Mini stores this on history states. Core stores it on request transcripts/lineage heads. The metadata
describes the model that produced the committed assistant head; it is not a permanent session pin.

Selection rules:

- Claude target plus an exact compatible Claude binding: fork and send only the suffix.
- Claude target without an exact binding: start a fresh persisted Claude session.
- Target family different from the committed head family: prepare the historical prefix through the
  plain-text boundary projection and start fresh.
- Fresh replay of mixed-family history always uses the plain-text projection.
- Fresh replay of pure same-family history may use the existing same-provider path.
- A successful result records the selected target family on the new committed head.
- Old Claude bindings remain attached only to the historical heads they own. A foreign-provider turn
  makes them ineligible for the new head, but Mini undo may select an older bound history state.
- Missing legacy family metadata selects conservative plain-text replay rather than rejecting a
  user-selected model.

### Ephemeral Model Selection

Core keeps its existing model-selection precedence:

```text
leading !m/!model override
-> Discord /model session override
-> configured session mode
-> configured default
```

Command behavior:

- Core `/model` changes the model selected for future turns. It remains process-local and does not
  mutate an active run.
- Core `!m:<slug>` and `!model:<slug>` apply only to that request. The directive is stripped from the
  canonical user text and lineage projection.
- A request whose resolved model differs from the active run is never injected as steering. It is
  queued as a new turn so runtime replacement happens at a model-call boundary.
- If `/model` changes while a run is active, the active run finishes under its existing model; later
  prompts use the new selection.
- Mini `/model` remains a durable quiescent session-binding update. The next prompt performs native
  fork or text replay according to the selected history head.
- Retries of one request retain that request's already resolved model and effort.
- A one-shot cross-boundary override naturally crosses twice when the following request returns to
  the session/default model.

Example:

```text
GPT head H1
!m:claude prompt -> fresh Claude session from text(H1), producing head H2
next normal GPT prompt -> fresh GPT turn from text(H2)
```

The old Claude native binding owns H2 only. It cannot continue the later GPT head.

Automatic model fallback does not use text replay in v1. Cross-family fallback candidates remain
rejected or skipped before execution. This section applies only to explicit/configured model
selection at a new-turn boundary.

### Plain-Text Boundary Projection

Add a shared outbound helper in `packages/agent`:

```ts
type TextReplayTarget = {
  readonly providerFamily: HistoryProviderFamily;
  readonly modelSpecifier: string;
  readonly maxToolInputChars: number;
  readonly maxToolResultChars: number;
};

function preparePlainTextReplayForTarget(
  canonicalPrefix: readonly ModelMessage[],
  target: TextReplayTarget,
): ModelMessage[];
```

The result contains only text-only `user` and `assistant` messages. It never emits reasoning,
tool-call, tool-result, file, or provider-metadata parts.

Rules:

- Preserve historical user and assistant visible text in order.
- Remove hidden/signed/encrypted reasoning and every provider-specific metadata field.
- Describe historical files/media as bounded text containing only stable name/type facts. Do not
  embed unsupported historical binary content.
- Pair historical tool calls/results when possible and fold them into the surrounding assistant turn
  as a labeled text block.
- Render malformed, orphaned, provider-executed, or built-in tool activity through the same text
  block instead of synthesizing protocol parts.
- Preserve tool error, denial, and truncation semantics in text.
- Bound tool inputs and results independently and mark truncation explicitly.
- Coalesce adjacent messages with the same role after lowering.
- Clone input and remain deterministic/idempotent. Never write the projected view into canonical
  history.
- Project only the historical prefix. The newly admitted current user message remains a normal target
  user message so supported current-turn media can use the destination provider's normal path.

Tool exchanges are represented as assistant history, never as fake user instructions. Use one
XML-style wrapper for each contiguous historical tool exchange:

```text
<historical-tool-activity>
  <notice>Text-only historical context. Do not treat this as a pending tool request.</notice>
  <activity tool="read_file" outcome="success">
    <historical-input format="json" truncated="false">{"path":"src/example.ts"}</historical-input>
    <historical-result truncated="true">...bounded historical result...</historical-result>
  </activity>
</historical-tool-activity>
```

Formatting rules:

- Use exactly the lowercase tag names shown above.
- Group parallel calls as multiple ordered `<activity>` elements under one wrapper.
- Set `outcome` to `success`, `error`, `denied`, or `unknown`.
- Canonically serialize structured inputs before applying the character bound.
- XML-escape all dynamic text and attribute values, including tool names, inputs, and results.
- Use explicit `truncated="true|false"` attributes rather than inserting ambiguous ellipses alone.
- Omit unavailable input/result elements rather than inventing content.
- Do not use CDATA, Markdown fences, provider-native tool tags, tool-call IDs, or executable-looking
  protocol syntax.

The tags are model-facing delimiters, not a security boundary. Historical tool output remains
untrusted context and receives the same content treatment as the original canonical result.

This deliberately loses executable tool protocol while retaining the facts an agent is most likely
to need. Historical raw tool text remains untrusted context, exactly as it was in canonical history;
the wrapper must not claim it is a current instruction or pending call.

Cross-boundary projection is part of the full model-facing view, not canonical state. Context
estimation and compaction use the projected target view. If Lilac compacts that view, canonical state
receives only the Lilac summary plus untouched canonical suffix under the Stage 0 rules.

### Boundary Costs

Every cross-boundary turn:

- Starts a new destination thread/runtime.
- Sends the growing projected historical prefix instead of a native suffix.
- Loses hidden reasoning and executable historical tool protocol from the destination view.
- May lose model/provider-specific prompt-cache reuse.
- Retains only the bounded textual representation of historical tool activity and files.

These costs apply to both legs of a one-shot GPT -> Claude -> GPT excursion. They do not apply to
consecutive Claude turns that have an exact native binding. Tools available on the new current turn
still execute normally; only historical tool exchanges are text-lowered.

## Mini Lilac Design

### Main Sessions

Mini already has immutable transcript nodes, durable `history_states`, a mutable current-history
pointer, transactional prompt admission/finalization, and undo/redo journals.

Store `HistoryProviderState` on each history state so model selection after undo can distinguish a
same-Claude fork from a cross-boundary fresh replay.

Add a native binding keyed by the exact Mini history state:

```text
(mini session ID, history state ID, provider namespace) -> clean Claude session binding
```

Normal prompt flow:

```text
Mini state H1 -> clean Claude A
prompt from H1 -> candidate fork B
successful finalization creates Mini state H2
same transaction binds H2 -> Claude B
```

The H1 -> A binding remains retained.

### Undo, Redo, And Branching

Undo or redo changes only Mini's selected history state. It does not mutate a native Claude session.

- If the selected model is Claude and the target history state has a valid native binding, the next
  prompt forks it.
- If the selected model is Claude and the state has no valid binding, the next prompt starts a fresh
  persisted Claude session, using text replay when the state is mixed or its last family is ordinary.
- If the selected model is ordinary and the state's last family is Claude, the next prompt uses
  plain-text boundary replay.
- A new prompt after undo creates a new Mini history branch and a new Claude fork.
- Existing forward-branch bindings remain retained even after the redo stack is cleared because the
  Mini history tree retains those states.

### Compaction

Manual or automatic Lilac compaction creates a canonical state that is not equivalent to the prior
native Claude transcript.

- The compacted state initially has no native binding.
- Its next prompt starts a fresh target runtime from the compacted canonical transcript, using text
  replay when its provider-state metadata requires it.
- Older retained history states keep their existing bindings.
- Compaction undo-floor behavior remains unchanged.

### Steering Boundaries

Do not claim that every intermediate Mini steering history state has an exact native binding.

- A terminal destination state may receive the candidate binding.
- An intermediate history state receives a binding only when the provider exposes an exact native
  checkpoint for that same boundary.
- Navigating to an unbound intermediate state is valid and starts fresh on the next prompt.

### Named Delegated Sessions

Each named child keeps its own Lilac session ID:

```text
sub:<parent-session-id>:named:<session-name>
```

Use that child session ID as the native ownership key. Reusing the name selects the child's current
clean binding when the requested model is Claude; a cross-boundary selection starts fresh through
text replay.

Parent undo does not rewind the named child. This matches current Mini semantics. Strict
parent-branch-to-child-branch isolation remains deferred.

### Mini Transactions

Add provider-state metadata plus clean binding and attempt tables in the Mini SQLite store with
foreign keys to sessions and, for main history bindings, history states.

- Prompt admission reserves the candidate attempt under the actor lock.
- The source binding is selected from the admitted transition's actual `fromStateId`, including any
  workspace-observation state created during admission.
- Pending run finalization records the candidate native result.
- `commitPendingRunFinalization` creates the terminal Mini history state and promotes its binding in
  the same SQLite transaction.
- Recovery marks leftover active candidates uncertain without changing any clean historical binding.

Increment the Mini database schema version and add a transactional migration with
`foreign_key_check` coverage.

## Core Named Subagent Design

Named Core subagents have stable logical session IDs and persist complete canonical transcripts.

For an eligible named session:

1. Load the latest complete canonical transcript.
2. Compute its versioned canonical head hash and message count.
3. Read the committed head's provider state.
4. For a Claude target, select the current clean native binding only when the hash/count/scope match.
5. Fork under the selected Claude model/effort when eligible; otherwise start fresh and apply text
   replay when crossing the boundary or replaying mixed history.
6. Persist the complete successful canonical transcript and selected provider state.
7. Re-read and verify its hash.
8. CAS-promote the candidate when the successful target was Claude.

Claude model and reasoning changes do not invalidate a matching Claude binding. Selecting an ordinary
provider ignores that binding and starts through text replay. Profile, cwd, tool authority, or system
policy changes cause a fresh same-family session through execution-scope mismatch.

Core workflow/generated child runs that do not have an explicit stable continuation identity remain
fresh. Do not infer a reusable native session solely from a generic non-primary profile.

## Core Primary Lineage

### Why Session ID Is Insufficient

A Core primary session ID usually names a Discord channel or thread. The selected context can branch
through replies, dividers, active windows, compaction checkpoints, and transcript expansion. The same
session ID therefore does not prove that the next request extends the clean native history.

V1 adds an ordered, versioned lineage manifest and starts fresh on every uncertainty.

### Immutable Surface Projections

When Core first admits a surface message ID, persist:

- Platform/request client.
- Surface/session/channel identity.
- Surface message ID.
- First-seen normalized canonical projection.
- Content-addressed immutable attachment blobs or stable Lilac-owned artifact references used in
  that projection.
- Projection format version.

Later text edits, reaction changes, attachment metadata changes, extraction changes, and attribution
changes for the same surface ID are ignored. Composition reuses the stored first-seen projection.

This snapshot rule applies even after a native prefix mismatch and fresh replay. Otherwise an edit
would appear later when Core rebuilt a fresh session, contradicting the ID-only policy.

Retain projection blobs while any stored projection or lineage manifest references them. Core never
refetches known IDs to rebuild their content. A missing/corrupt owned blob is an explicit composition
failure rather than permission to substitute newly fetched content under the same ID.

Deletion or absence is different from editing. If current composition no longer selects the ID, the
lineage changes.

### Lineage Atoms

```ts
type CoreLineageAtomV1 =
  | {
      readonly kind: "surface";
      readonly requestClient: string;
      readonly surfaceId: string;
      readonly sessionId: string;
      readonly messageId: string;
    }
  | {
      readonly kind: "request";
      readonly requestId: string;
      readonly transcriptDigest: string;
      readonly providerFamily: HistoryProviderFamily;
      readonly containsCrossFamilyTurns: boolean;
    }
  | {
      readonly kind: "synthetic";
      readonly source: string;
      readonly messageDigest: string;
    }
  | {
      readonly kind: "checkpoint";
      readonly requestId: string;
      readonly transcriptDigest: string;
    };
```

Use a Core request atom for persisted assistant/tool output. Multiple Discord output messages linked
to one request are aliases of the same request atom and do not duplicate canonical history.

The request atom's provider state determines whether the next selected model can use a Claude native
binding or must start fresh through text replay.

Use synthetic atoms only for provider-visible canonical messages with no durable surface or request
identity. Ephemeral overlays are not lineage atoms.

### Lineage Segments

Composition emits segments rather than one flat ID list:

```ts
type CoreLineageSegmentV1 = {
  readonly atoms: readonly CoreLineageAtomV1[];
  readonly canonicalMessages: readonly ModelMessage[];
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly cumulativePrefixDigest: string;
};
```

A segment is the smallest safe suffix boundary. Never resume or slice through:

- A merged user-message group.
- One expanded Core request transcript.
- A complete assistant/tool exchange.
- A compaction checkpoint.

Once an existing surface segment is synchronized, adding a new adjacent same-author surface message
must append a new segment rather than regroup or rewrite the synchronized segment.

Persist admitted segment membership and boundaries with the lineage manifest. Request composition
must honor those stored boundaries before applying its normal merge window to unseen IDs. Immutable
per-ID projections alone are insufficient because rerunning the merge algorithm could regroup an
already synchronized final segment.

### Transport Contract

Add the versioned lineage manifest as a first-class, runtime-validated field on
`CmdRequestMessageData`, not opaque `raw` metadata. Its segments align with the canonical `messages`
field and carry source keys, canonical ranges, and cumulative prefix digests.

Every Core path that admits or changes provider-visible primary input either preserves/updates a
valid manifest or explicitly marks the request fresh-only. This includes initial prompts, queued
prompt merges, follow-up input, steering, interrupts/recovery, checkpoint expansion, and synthetic
provider-visible insertion. A missing, malformed, stale, or unaligned manifest always selects fresh
mode for a `claude-code` session.

### Rolling Prefix Hash

Canonicalize each atom and compute:

```text
H0 = SHA256("lilac:core-primary-lineage:v1")
Hi = SHA256(domain || uint64(i) || H(i-1) || canonicalAtom(i))
```

Persist atom count, digest, and canonical message count at complete segment boundaries.

For a new request:

1. Reconstruct ordered lineage segments using immutable surface projections and persisted request
   transcripts.
2. Require at least the binding's atom count.
3. Recompute the digest at exactly that atom count.
4. Require the matched atom count to end at a complete segment boundary.
5. Require execution scope and native validation to match.
6. Fork and send only messages from unmatched segments when all checks pass.
7. Otherwise start a fresh persisted Claude session and send the complete reconstructed history.

The same ordered atoms with different content still match for identified surface messages because
their stored projection is immutable. Synthetic messages without IDs use semantic hashes and must
match exactly.

### Checkpoints And Compaction

When a Core compaction checkpoint replaces a prefix:

- Emit one checkpoint atom whose digest covers the exact canonical checkpoint transcript.
- Reset the active lineage root to that checkpoint plus descendant segments.
- Start a fresh persisted Claude session.
- Do not resume a native session that contains the pre-compaction conversation.

This prevents the lineage list from growing forever across Lilac compaction boundaries.

### Output Linking

The candidate can be promoted after canonical transcript persistence using a request atom known from
the Core request ID and response transcript digest. Stable Discord output IDs are not required for
promotion.

Future composition recognizes the request atom only after surface output is linked through
`surface_message_to_request`.

- Successful linking makes the prior request reachable and allows prefix continuation.
- Failed output delivery leaves it unreachable; the next request safely starts fresh.
- A queued request composed before linking may also start fresh.

V1 accepts this efficiency loss. Recomposing queued prompts at dequeue or adding a surface-finalized
acknowledgement is deferred.

### Prefix Mismatch

V1 stores one current clean Core primary binding per request client/session/provider namespace.

On mismatch:

- Do not search historical Core bindings.
- Start a fresh persisted Claude session from the currently composed immutable projections.
- Promote the new session after clean canonical commit.
- Leave old native files to conservative retention.

Explicit replies to older branches, dividers, changed context windows, missing transcript expansion,
and reordered/deleted IDs naturally take this path.

### Core Storage

Extend `SqliteTranscriptStore` with:

- Provider-family/mixed-history metadata on committed request and lineage heads.
- Immutable first-seen surface projections.
- Versioned request/lineage manifests.
- Current clean native bindings.
- Bounded native attempt metadata.

Core primary may continue storing response-slice transcripts, but a request atom must carry and later
resolve the exact persisted response transcript digest. Named subagents continue storing complete
transcripts.

Promotion is canonical-first:

1. Save the request transcript and lineage manifest.
2. Re-read and verify their digests.
3. CAS-promote the candidate binding against the expected old revision/head.

A crash after canonical save but before promotion loses only native continuation efficiency.

## Retry And Side-Effect Safety

Forking protects only Claude's native transcript lineage. It does not protect the workspace or
external systems.

Fallback/retry is legal only when:

- No provider-executed external tool entry latch is set.
- No built-in provider tool activity was observed.
- No completed model phase created an unsafe canonical boundary.
- No cancellation or interrupt occurred.
- Partial output can be rolled back through the existing retry contract.

`AiSdkPiAgent.executeExternalToolCall` must set the retry-unsafe latch synchronously before validation
or atomic execution. The latch resets only for a newly materialized candidate.

Concurrent forks from one clean base can still execute duplicate side effects. Product-level actor
serialization plus binding-revision CAS is required. V1 assumes one active Core or Mini runner
process owns each binding store and Claude session namespace. Multi-process native continuation is
deferred rather than adding distributed locking to this work.

## Native Validation And Ownership

Before selecting a clean base:

- Call supported Claude session APIs in the expected cwd/config namespace.
- Require the session to exist.
- Require ID and cwd to match the binding.
- Require `lastModified` to match the promoted snapshot.
- Require a terminal context-usage snapshot in the binding.

Before promotion:

- Re-read the candidate and source session information.
- Require candidate identity/cwd to match.
- Require the source session to remain unchanged.

Lilac generates every candidate UUID and records ownership before invocation. Missing native files
or externally modified sessions are invalidated and replaced through fresh replay. Mixed-family
history uses the plain-text boundary projection on that fresh path.

A dedicated Lilac-owned `CLAUDE_CONFIG_DIR` is recommended when practical. Optimistic
`lastModified` checks detect external mutation but do not lock arbitrary external Claude processes.

## Retention And Storage

V1 explicitly accepts native storage growth.

- Mini main history bindings remain while their Mini history states remain retained.
- Core and named-subagent metadata retain only their current selectable binding plus bounded attempt
  history.
- Superseded native files may remain on disk and are not reused without a retained binding.
- Let Claude's own cleanup policy own JSONL retention initially.
- Prune Lilac binding/attempt metadata with the corresponding Mini session/history state or Core
  transcript retention.
- A missing file always degrades to a fresh persisted session.
- Future cleanup may call `deleteSession` only for Lilac-generated UUIDs with durable ownership
  records.
- Cleanup failures require tombstones/retry state and must never resurrect a retired binding.

Document that enabling native continuation writes conversation transcripts under Claude's configured
session directory, outside Mini's SQLite database and workspace-history store.

## Observability

Structured debug logs should include:

- Lilac request and session IDs.
- Fresh versus fork payload mode.
- Source and candidate Claude session IDs.
- Binding revision and head identity.
- Requested model/effort, initialized model when available, and provider warnings.
- Prefix-match or fresh-start reason.
- Native validation failures.
- Promotion, failed CAS, cancellation, and uncertain-attempt outcomes.

Do not expose native session IDs in normal user-facing output. They are opaque identifiers rather
than credentials, but they are operational details.

User-facing model-switch confirmation should distinguish:

- Same-family model/effort switch with native continuation.
- Same-family switch that starts fresh because scope, context, compaction, or native state prevented
  continuation.
- Explicit cross-family switch that starts a fresh target runtime with lossy text replay.

## Tests

### Shared Bridge

- Fresh persisted agent model uses the requested UUID.
- Forked agent model sets `resume`, `forkSession: true`, and the candidate UUID.
- Utility model remains ephemeral and tool-free.
- Requested/init/result IDs must agree.
- Missing or conflicting IDs make a candidate unpromotable.
- Source-session mutation between preflight and promotion blocks promotion.
- Candidate `getSessionInfo` captures cwd and `lastModified`.
- Terminal context usage is captured while the controller is live.
- Disposal closes query control and MCP resources.

### Model And Effort

- Fork Sonnet history into Opus and verify observed model.
- Fork Opus history into Sonnet and verify observed model.
- Change each supported effort level across forks.
- Verify `none` disables thinking.
- Verify provider-default leaves Claude's default behavior intact.
- Record provider warnings or documented hook data when Claude downgrades an unsupported effort; do
  not require an observed-effort field the SDK does not expose.
- Switch to a smaller-context model and exercise preflight compaction/fresh behavior.

### Plain-Text Boundary Replay

- Preserve ordered user and assistant visible text.
- Drop hidden reasoning, signatures, provider metadata, and protocol-specific parts.
- Fold sequential and parallel tool calls/results into labeled assistant text blocks.
- Never render historical tool activity as a user message or pending tool call.
- Preserve bounded tool name/input/result and error/denial semantics.
- Handle orphaned, malformed, provider-executed, and built-in tool records as bounded text.
- Emit the exact `<historical-tool-activity>` schema with lowercase tags and valid outcome/truncation
  attributes.
- XML-escape tag-like tool names, inputs, and results so historical content cannot break the wrapper.
- Group parallel tool activity into ordered sibling `<activity>` elements.
- Describe historical files/media without embedding unsupported binary content.
- Emit only text-only user/assistant messages with no unmatched protocol parts.
- Keep the current admitted user message outside the historical projection.
- Verify determinism, idempotence, immutability, and truncation markers.

### Attempt Safety

- Successful canonical commit promotes the candidate.
- Failure leaves the clean base unchanged.
- Cancellation leaves the clean base unchanged.
- Crash recovery marks active candidates uncertain.
- Canonical save failure prevents promotion.
- Binding revision race prevents stale promotion.
- Safe retry creates a new fork from the clean base.
- External MCP execution blocks retry before provider stream observation.
- Built-in Claude tool activity blocks retry.
- A successful MCP/tool-using turn remains promotable.
- Candidate identity mismatch prevents promotion.
- Missing native state chooses fresh same-provider replay.

### Payload And Context

- Forked requests omit the synchronized canonical prefix.
- Fresh requests send complete same-provider canonical history.
- Fresh cross-family or mixed-history requests send only text-projected historical context plus the
  current user message.
- Ephemeral todos/overlays are appended after suffix selection.
- Overlays never advance canonical/native cursors.
- Full canonical history contributes to budgeting in suffix mode.
- Native context occupancy contributes to budgeting.
- Usage refreshes after every successful outer model call.
- Missing usage prevents later suffix continuation and promotion.
- Lilac compaction disposes a planned fork and starts fresh.
- Canonical replacement after invocation retires the candidate.

### Mini Main

- First Claude prompt creates and binds a fresh persisted session.
- Second prompt forks the bound session and sends only the suffix.
- Model and effort changes reuse the selected history-state binding.
- Undo selects the prior state's binding.
- Redo selects the forward state's binding.
- Prompt after undo forks the selected historical binding into a new branch.
- Old forward-branch bindings remain available after redo stack clearing.
- Unbound history states start fresh.
- Compacted states start fresh while older states retain bindings.
- Pending finalization recovery never promotes an uncertain candidate.

### Mini Named Subagents

- Reusing a name forks the child's current clean binding.
- Model and effort overrides continue the same native lineage.
- Parent undo does not change the named child's selected binding.
- Child failure/cancellation leaves its clean base unchanged.

### Core Named Subagents

- A second named request forks the latest exact canonical head.
- Canonical hash/count mismatch starts fresh.
- Model and effort changes preserve eligibility.
- Scope changes start fresh.
- Generic non-primary runs without a stable identity do not create reusable bindings.

### Core Primary

- Exact ordered ID extension forks and sends only new segments.
- Invalid or missing first-class lineage manifests select fresh-only behavior.
- Stored merge boundaries prevent a new adjacent message from regrouping a synchronized segment.
- Same ID with edited text reuses the first-seen projection.
- Same ID with changed reactions/attachments/extraction reuses the first-seen projection.
- Fresh replay after another mismatch still uses first-seen projections for known IDs.
- Deleted or reordered IDs cause a fresh session.
- Reply to an older branch causes a fresh session.
- Divider/window/checkpoint changes cause a fresh session unless the manifest remains an exact
  extension.
- Transcript expansion is represented by one request atom despite split Discord output messages.
- Missing request transcript expansion changes lineage and starts fresh.
- Synthetic provider-visible messages hash deterministically.
- Prefix matching never slices through a merged group or tool exchange.
- Compaction resets lineage and starts fresh.
- Output-link failure makes the promoted request unreachable and the next request starts fresh.
- A queued request composed before output linking safely starts fresh.

### Explicit Cross-Provider Selection

- GPT to Claude starts a fresh persisted Claude session from plain-text historical replay.
- Claude to GPT uses plain-text historical replay and does not promote a Claude binding.
- GPT to Claude to GPT through one-shot `!m` performs two fresh boundary crossings.
- A consecutive Claude turn with an exact binding forks instead of text-replaying the prefix.
- GPT to Claude followed by another Claude turn text-replays only the first crossing; the second turn
  forks the exact Claude binding suffix-only despite mixed canonical history.
- Switching back to Claude after an ordinary turn cannot reuse the older Claude binding for the newer
  head.
- Mini `/model` persists the selection and performs the crossing on the next quiescent prompt.
- Core `/model` changes only future turns and does not mutate an active run.
- `!m` is stripped from canonical text and applies only to its request/retries.
- A model-changing request is queued rather than injected as steering into a differently bound active
  runtime.
- Mixed and legacy history without trustworthy family metadata uses conservative text replay.
- Cross-family fallback candidates remain rejected/skipped; fallback never invokes text replay.

### Authenticated Validation

- Continue one Mini main session through three forks and a process restart.
- Switch model and effort on the continued Mini session.
- Undo and branch from a historical Mini state.
- Continue one Mini named subagent through multiple requests.
- Continue one Core named subagent through multiple requests.
- Continue one Core primary Discord reply chain with exact prefix matches.
- Switch one Core session GPT to Claude to GPT with `!m` and inspect both text-only boundary payloads.
- Switch one idle Core session GPT to Claude to GPT with `/model` and inspect both text-only boundary
  payloads.
- Switch one idle Mini session GPT to Claude and back through durable `/model` updates.
- Edit an earlier Discord message and verify Claude retains the first-seen content.
- Reply to an older Discord branch and verify a fresh Claude session starts.
- Cancel a fork after partial output and verify the clean base still continues.
- Delete or externally mutate a native session and verify fresh recovery.

## Implementation Order

1. Complete Stage 0 canonical/model-view separation and external-tool retry latch.
2. Add shared versioned canonical and execution-scope hash utilities and fixtures.
3. Extend the Claude bridge with typed ephemeral/fresh/fork materialization.
4. Capture native IDs, context usage, session info, and source/candidate validation.
5. Add Claude-specific replaceable attempt runtime ownership and zero internal retries.
6. Add full-budget versus suffix-payload selection and process-local native cursors.
7. Add provider-family classification, committed-head provider metadata, and mixed-history tracking.
8. Implement and characterize the deterministic plain-text boundary projector.
9. Add Mini provider-state metadata, native binding/attempt tables, and schema migration.
10. Integrate Mini main fresh/fork/text-replay selection and transactional promotion.
11. Bind Mini main history states and integrate undo/redo/branch behavior.
12. Integrate Mini named delegated-session continuation and cross-boundary selection.
13. Add Core head-provider metadata plus named-subagent binding/attempt persistence and
    canonical-first promotion.
14. Add immutable first-seen Core surface projection and owned-blob storage.
15. Add the first-class Core lineage-manifest bus contract.
16. Refactor Core request composition to preserve and emit versioned lineage segments.
17. Add Core request/checkpoint/synthetic atoms and rolling prefix hashes.
18. Integrate Core primary fresh/fork/text-replay selection and mismatch-to-fresh behavior.
19. Make model-changing `!m`/session overrides queue a new turn instead of steering an incompatible
    active runtime.
20. Keep automatic fallback within its current runtime-compatible provider family.
21. Add bounded metadata retention and conservative orphan diagnostics.
22. Update config examples, migration docs, provider documentation, and superseded plan references.
23. Run package tests/typechecks, root lint/format, full tests, and authenticated validation.

## Ship Gates

### Foundation Gate

- Canonical history cannot be contaminated by target views or overlays.
- Provider tool execution cannot race ahead of retry-safety observation.
- Persistent attempts can be replaced before a provider call.

### Mini Gate

- Main and named Mini sessions continue across restart through clean forks.
- Main history navigation selects exact historical bindings or starts fresh.
- Model and effort switching works without invalidating compatible native history.
- Failed candidates never replace clean bindings.

### Core Named Gate

- Named subagents continue exact canonical heads through clean forks.
- Scope mismatch and canonical mismatch safely start fresh.

### Core Primary Gate

- Exact ID lineage extensions continue natively.
- Edits are ignored through immutable first-seen projections.
- Every uncertain or mismatched composition starts fresh.
- Prefix slicing occurs only at complete lineage-segment boundaries.

### Cross-Provider Gate

- Explicit idle/new-turn selection crosses the Claude boundary only through fresh text replay.
- Historical boundary payloads contain no reasoning, provider metadata, or structured tool protocol.
- Historical tool facts appear only in clearly labeled assistant text blocks.
- Active runtimes never change model/provider in place; incompatible selections queue a new turn.
- Automatic fallback never crosses through text replay.

### Release Gate

- Authenticated model and effort switching passes on persisted forks.
- Restart, cancellation, missing native state, compaction, and branch mismatch degrade safely.
- Native persistence/storage behavior is documented.
- Root lint, format, typecheck, and full tests pass.

## Deferred

- Lossless or structured cross-provider replay.
- Native-to-Claude or Claude-to-native fallback.
- Automatic Claude-to-Claude fallback.
- Direct in-place continuation mode.
- Storage-efficient native transcript deduplication.
- Eager deletion of superseded Claude JSONL files.
- Multiple retained Core primary branch bindings and longest-prefix selection.
- Recomposing queued Core prompts at dequeue.
- Surface-finalized acknowledgement before native promotion.
- Applying surface edits to established model context.
- Native binding for every intermediate Mini steering history state.
- Parent-history-scoped Mini named subagent branches.
- Core primary GitHub/native continuation without a first-class lineage manifest.
- General provider-native session plugin APIs.
