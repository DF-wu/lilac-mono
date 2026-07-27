# Mini Lilac — Compaction UX

Design + implementation plan for manual (`/compact`) and automatic compaction in Mini Lilac.

## 1. Answers to the two open questions

### 1.1 Does the compaction agent have tool access?

**No.** There is exactly one model invocation in the whole compaction engine and it is a bare,
toolless, single-shot completion — `summarizePrompt` in
`packages/agent/auto-compaction.ts:601-617`:

```ts
const res = streamText({
  model: options.model,
  instructions: options.system,
  messages: [{ role: "user", content: options.prompt }],
  providerOptions: options.providerOptions,
  abortSignal: options.abortSignal,
});
return await res.text;
```

No `tools`, no `toolChoice`, no `stopWhen`, no `maxSteps`, no `prepareStep`. The transcript is not
even handed over as messages — `renderMessageForSummary`
(`packages/agent/auto-compaction.ts:491-560`) flattens it to a text blob
(`TOOL_CALL <name> id=<id>: …` / `TOOL_RESULT …` lines) that is embedded in a single user message.

Toollessness is deliberate and enforced a second time for Claude Code sessions —
`packages/mini-lilac-runtime/src/session-service.ts:1271-1276`:

```ts
summaryModel:
  configuredSummaryModel === "inherit"
    ? // Never summarize with the tool-enabled model: its embedded MCP
      // settings would let a summarization prompt call workspace tools.
      (claudeCodeRun?.utilityModel ?? "current")
    : this.resolveModel(configuredSummaryModel),
```

Compaction also does **not** reuse the agent loop. `attachAutoCompaction` installs a
`transformMessages` hook (`packages/agent/auto-compaction.ts:1737`) that runs *between* the loop's
turn boundary and the model call; it never calls `runTurn` and never emits `turn_end`.

### 1.2 Why one manual `/compact` produced many `/responses` calls

**This is a bug, not just an expensive design. `summarizeMessagesHierarchical` makes one model call
per transcript _message_, regardless of budget.** Chunking is computed and then completely
discarded.

`renderMessagesForSummarySegments` (`packages/agent/auto-compaction.ts:573-599`) pushes **one
segment per message** and never joins messages within a chunk:

```ts
for (const message of messages) {
  const rendered = renderMessageForSummary(message);
  if (rendered.length <= segmentLimit) {
    segments.push(rendered);   // one segment per message, always
    continue;
  }
  // ... only oversized messages get split further
}
```

and `summarizeMessagesHierarchical` (`:669-677`) fires one model call per segment:

```ts
for (const chunk of chunks) {
  const transcriptSegments = renderMessagesForSummarySegments(chunk, { ... });
  for (const transcriptText of transcriptSegments) {
    if (!transcriptText.trim()) continue;
    summary = await options.summarizeChunk(transcriptText, summary, options.abortSignal);
  }
}
```

So `chunkMessagesByEstimatedTokens` has **zero effect on call count**. The chunk boundaries only
feed the retry-shrink logic.

The joining implementation exists and is correct — `renderMessagesForSummary`
(`packages/agent/auto-compaction.ts:562-571`) joins with `"\n\n---\n\n"` — but it is **dead code**,
referenced only from `__autoCompactionInternals` (`:1762`) for tests. This looks like a refactor
regression: the batching renderer was replaced by the per-message one and nothing pinned the
behaviour.

Measured against the internals: 40 messages totalling 2,120 estimated tokens, chunked into **1
chunk** under a 129,000-token budget, produced **40 sequential model calls**.

For the reported session at `166.1K (45%)`: retaining ~20k recent tokens leaves ~146k of history,
and the call count is simply the number of history messages — several hundred. Each trace file in
the codex wire log (`packages/utils/llm-wire-debug.ts:53`, one file per fetch) is one of them.

Two secondary consequences beyond cost and latency:

- **Summary quality degrades.** Each call rewrites the entire running summary via
  `buildSummaryUpdatePrompt`. A 300-link serial refine chain paraphrases the earliest context 300
  times — classic telephone-game drift.
- **The whole chain is serial**, so wall-clock is the sum of several hundred round trips.

**Fix, part 1 — batch messages into segments.** Make `renderMessagesForSummarySegments` accumulate
messages into a buffer up to `segmentLimit`, flushing when full, and split only individual oversized
messages — i.e. restore the `renderMessagesForSummary` join semantics inside the segment loop, then
delete the dead function.

**Fix, part 2 — stop pre-splitting at all.** `DEFAULT_SUMMARY_CHUNK_FRACTION = 0.35` capped the
first attempt at 35% of the context window, so a transcript sitting just under the compaction
threshold was split into 2–3 calls *by design*. That defeats the purpose of the threshold: it
exists precisely so the transcript fits one call. Splitting should be **recovery**, not
anticipation — `summarizeMessagesHierarchical` already shrinks the budget and retries when the
provider actually rejects the request. Setting the fraction to `1` restores that original
behaviour: one call, and split only on a real overflow error.

**Fix, part 3 — size budgets against the summary model, not the active one.** Both call sites
passed the *active* model's context limit as `summaryContextLimit` (`:1347`, `:1712`) even when a
different `summaryModel` is configured. With fraction `0.35` that overshoot was masked by the
margin; at `1` it becomes fatal — a 2M active model with a 128K summary model leaves every retry
above 128K and compaction fails outright. `ManualCompactionOptions.summaryContextLimit` and
`AutoCompactionOptions.resolveSummaryContextLimit` now carry the summary model's own window, wired
from the already-known `summaryModelSpecifier` in the runtime. A prompt/output reserve
(`DEFAULT_SUMMARY_PROMPT_RESERVE_TOKENS`) is held back so chunks do not land exactly on the window
and overflow on the prompt template alone.

Retries now halve every dimension (`SUMMARY_OVERFLOW_RETRY_SCALE = 0.5`) instead of scaling the
token budget by 0.6 and the char limits by 0.7; uneven scales let the char limit lag the token
budget and stretched how many retries were needed to reach a fitting size.

Together these take the reported session to exactly one `/responses` call.

Two further loops still multiply the base count, but only on the failure path:

1. **Reduction retry** — up to `DEFAULT_SUMMARY_REDUCTION_PASSES = 6`. On a context-overflow error
   the chunk budget shrinks (`budget * 0.6`) and the **entire** chunk loop restarts from scratch.
2. **Compaction pass** — `compactRepairedMessages` (`:1153-1270`), up to
   `DEFAULT_COMPACTION_MAX_PASSES = 4`. If the compacted result still exceeds `inputBudget`,
   retention shrinks and the whole hierarchical summarization runs **again from the top**.

Plus, main-history and split-turn-prefix summarization run concurrently
(`packages/agent/auto-compaction.ts:1240-1243`), so two chains can be in flight at once.

Two more amplifiers worth noting:

- The pass-3 retry is nearly always wasted work. `shrinkCompactedMessagesToBudget`
  (`packages/agent/auto-compaction.ts:354-395`) truncates the summary to fit anyway, and the thing
  that actually overflows is usually the *retained suffix*, not the summary. Re-summarizing all of
  history to fix a too-large suffix is the wrong lever.
- On the auto path, `providerOptions` is `agent.state.providerOptions`
  (`packages/agent/auto-compaction.ts:1690`), which for a codex session includes
  `reasoningSummary: "detailed"` (`packages/mini-lilac-runtime/src/providers.ts:331-338`). Every
  summarization call therefore also generates detailed reasoning summaries that are immediately
  discarded — `summarizePrompt` only reads `res.text`. The manual path passes its own options
  (`packages/mini-lilac-runtime/src/session-service.ts:2713-2717`) and does not, so the two paths
  are inconsistent.

### 1.3 Why the UI said `Ready · submitting`

Two independent status sources are rendered side by side in the footer and neither knows about
compaction.

- `workingStatus` (`apps/mini-lilac-tui/src/app.tsx:695-702`) keys off `active()`, which is true
  only for an agent **run**. Manual compaction is a plain control POST — no run — so this renders
  `"Ready"`.
- `phaseText` (`apps/mini-lilac-tui/src/app.tsx:676-685`) renders the editor phase. `/compact` sets
  `phase: "submitting"` (`apps/mini-lilac-tui/src/input-state.ts:227-233`), the same phase used by
  `/undo` and binding changes, so it renders the literal word `"submitting"`.

Session status has no compaction member at all —
`packages/mini-lilac-client/protocol.ts:83`:

```ts
export const miniLilacSessionStatusSchema = z.enum(["idle", "streaming", "cancelling", "error"]);
```

`compact()` in fact *requires* the session to stay `idle`/`error`
(`packages/mini-lilac-runtime/src/session-service.ts:2672-2678`) and never changes it. So for the
entire multi-minute, multi-request operation the session is genuinely, truthfully "Ready".

Two aggravating details:

- `workingStatus` can itself already contain a `·`, so after any earlier run the footer reads
  `▣ Ready · Ran for 12s · submitting` — a three-part status where none of the parts is the thing
  actually happening.
- The same string is produced by `/undo` and by binding changes
  (`apps/mini-lilac-tui/src/input-state.ts:163-165`, `apps/mini-lilac-tui/src/controller.ts:190`),
  so the footer cannot distinguish compaction from undo from a model switch.
- The glyph is frozen at the static `▣` because `workingStatusFrame` early-returns when `!active()`
  (`apps/mini-lilac-tui/src/app.tsx:703-709`) — so there is not even motion to signal liveness.

## 2. Current-state gaps

| # | Gap | Evidence |
|---|---|---|
| G0 | ~~**Summarization makes one model call per transcript message**, and pre-splits at 35% of the context window even when the transcript fits.~~ **Fixed** — see §1.2. | `packages/agent/auto-compaction.ts:573-599, 669-677`; `DEFAULT_SUMMARY_CHUNK_FRACTION` |
| G1 | ~~Manual compaction is a blocking POST with zero progress.~~ **Fixed** — the endpoint returns a UI message event stream; admission still precedes the stream, so a non-quiescent session is still a 409. | `apps/mini-lilac-server/src/server.ts` |
| G2 | ~~Manual compaction cannot be cancelled.~~ **Fixed** — `esc` posts to `/sessions/:id/compact/cancel`, which aborts the compaction; it stops at the next summarization boundary and re-checks the abort immediately before commit. Nothing is committed, so the transcript is byte-identical. Detaching the response stream is *not* a cancel. | `session-service.ts` `cancelCompaction` |
| G3 | ~~`onCompactionStart` is never wired.~~ **Fixed** — auto compaction publishes `started` before its first summarization request. | `session-service.ts` `attachCompaction` |
| G4 | Auto compaction mid-run is still indistinguishable in the *footer* (the run genuinely is streaming), but it now has its own live transcript entry with progress and streamed summary. | `render.ts` `compactionEntry` |
| G5 | `messages_reset` with `reason: "compaction"` is explicitly dropped instead of surfaced. | `packages/mini-lilac-runtime/src/session-service.ts:2271-2278` |
| G6 | ~~No progress granularity.~~ **Fixed** — `CompactionProgress` carries `stage`/`step`/`stepCount`/`pass`; `stepCount` is known before the first request because segments are flattened up front. | `auto-compaction.ts` `summarizeMessagesHierarchical` |
| G7 | ~~The generated summary is never viewable.~~ **Fixed** — `onSummaryDelta` streams it into the entry live and it is persisted on the committed `data-compaction` part, so it survives a reload. | `auto-compaction.ts` `summarizePrompt`; `sqlite-store.ts` `commitCompaction` |
| G8 | ~~`input_tokens` set to `NULL`, so the meter disappears.~~ **Fixed** — the post-compaction estimate is persisted with an `input_tokens_estimated` flag and rendered with a leading tilde. | `sqlite-store.ts`; `presentation.ts` `formatTokenUsage` |
| G9 | Manual compaction silently destroys undo history (`DELETE FROM user_checkpoints`) with no warning and no way back. | `packages/mini-lilac-runtime/src/sqlite-store.ts:1160-1162` |
| G10 | ~~No threshold context on the meter.~~ **Partly fixed** — `compactionThreshold` is on the session snapshot and the meter reads `148K (74% · compacts at 80%)` within ten points of the threshold. The separate pre-threshold nudge line is not built. | `presentation.ts` |
| G11 | No way to steer a manual compaction (`/compact <focus>`), and no `/context` inspection command. | `apps/mini-lilac-tui/src/palette.ts:24` |
| G12 | ~~Manual and auto disagree on summary provider options and split-turn prompt overridability.~~ **Fixed** — both paths run `buildSummaryProviderOptions` (which drops `reasoningSummary`), and `buildSplitTurnSummaryUpdatePrompt` is an option on both. | `auto-compaction.ts` |
| G13 | ~~A `noop`/`empty` compaction is completely silent.~~ **Fixed** — the live entry renders `Nothing to compact · transcript already minimal`. It stays transient: no durable divider is written, so the README rule holds. | `render.ts` `compactionHeadline` |
| G14 | Typed `/compact` during an active run is silently swallowed — the text just sits in the editor with zero feedback. | `apps/mini-lilac-tui/src/input-state.ts:251-257` |
| G15 | The client cannot compute threshold proximity: `earlyCompactionPoint` is server-side config and is absent from both the session snapshot and the model summary. | `packages/mini-lilac-runtime/src/config.ts:73-79` vs `packages/mini-lilac-client/protocol.ts:86-103, 72-81` |
| G16 | ~~`messageCountBefore/After` dropped by the renderer.~~ **Fixed** — rendered as `214 → 12 msgs`. | `render.ts` |
| G17 | The compaction entry is not in `isToolTranscriptEntry`, so it has no disclosure affordance to hang an expand off. | `apps/mini-lilac-tui/src/app.tsx:194-202` |
| G18 | ~~No cancel hint.~~ **Fixed** — the hint renders for any busy phase and reads `esc cancel` while compacting. | `app.tsx` `workingHint` |
| G19 | The 409 "must be quiescent to compact" maps to a raw error string in a red transcript line. | `apps/mini-lilac-server/src/server.ts:188`; `apps/mini-lilac-tui/src/controller.ts:1148-1150` |

## 3. Design

### 3.1 Principle

Compaction is expensive, slow, lossy, and currently irreversible. It should therefore be a
**first-class, observable, cancellable, inspectable, reversible operation** — not a hidden
transform and not a generic "submitting" blip.

### 3.2 Manual compaction becomes a run

The central structural change. Today `/compact` is a control POST outside the run machinery, which
is exactly why it has no status, no stream, no progress, and no cancel.

Make `compact()` allocate a `runId` and drive the existing run plumbing:

- session status transitions to a new `"compacting"` value;
- progress is streamed as `data-compaction` chunks over the existing
  `GET /chat/:sessionId/stream` (`apps/mini-lilac-server/src/server.ts:392`), so reconnect and
  resume work unchanged;
- `POST /sessions/:id/cancel` aborts it via the abort signal already threaded through
  `compactMessages`;
- the existing `commands` reservation and the transactional `commitCompaction`
  (`packages/mini-lilac-runtime/src/sqlite-store.ts:1110-1180`) stay as-is, preserving idempotency
  and the quiescence re-check.

Nothing is committed until the summarization succeeds, so cancellation is already safe — it just
needs to be reachable.

> **Superseded by §4.** This phase was not built. What shipped streams the compact POST response
> instead, and cancellation is its own endpoint (`POST /sessions/:id/compact/cancel`) rather than a
> reuse of the run cancel path — compaction owns no run to cancel.

### 3.3 Protocol: a compaction lifecycle, not a terminal event

There is already a precedent for this in-repo, on both sides:

- `data-subagentStatus` (`packages/mini-lilac-client/protocol.ts:255-271`) carries
  `state: "running" | …` plus an `activity` string, and has a self-updating renderer
  (`apps/mini-lilac-tui/src/render.ts:1326-1345`) that mutates one entry rather than appending.
- `apps/core` renders live compaction progress on the Discord surface by fabricating a synthetic
  tool call (`apps/core/src/surface/bridge/bus-agent-runner.ts:3268-3288`, display strings at
  `:591-608`). That is the right *information*, delivered through the wrong mechanism — Mini Lilac
  should model it properly instead of copying the fiction.

Extend `miniLilacCompactionEventSchema` (`packages/mini-lilac-client/protocol.ts:282-298`) with a
`phase` discriminant and keep the chunk `id` stable across the lifecycle so renderers update one
entry in place.

```ts
phase: "started" | "progress" | "completed" | "failed" | "cancelled";
progress?: {
  stage: "history" | "split-turn";
  pass: number;          // 1-based compaction pass
  step: number;          // 1-based segment within the pass
  stepCount: number;     // segments in this pass, known up front
};
startedAt?: number;
durationMs?: number;
modelCalls?: number;     // cumulative /responses calls — makes §1.2 self-evident
summaryChars?: number;
```

`stepCount` is knowable before the loop starts: `chunkMessagesByEstimatedTokens` computes all
chunks up front (`packages/agent/auto-compaction.ts:666`) and
`renderMessagesForSummarySegments` is pure. Pass count is not knowable in advance (retries are
error-driven), so render it as `pass 2` rather than `2/4`.

Add `"compacting"` to `miniLilacSessionStatusSchema`, the SQLite `CHECK` constraint
(`packages/mini-lilac-runtime/src/sqlite-store.ts:522`), and `MIGRATIONS.md`.

Also surface the threshold. `earlyCompactionPoint` is server-side config only and appears in
neither `miniLilacSessionSnapshotSchema` nor `miniLilacModelSummarySchema`, so the client
*physically cannot* render "compacts at 80%" today. Add `compactionThreshold: number` to the
session snapshot.

### 3.4 Engine: progress + cooperative cancellation

Add an optional `onProgress` to both `ManualCompactionOptions` and `AutoCompactionOptions`, threaded
through `compactRepairedMessages` → `summarizeMessagesHierarchical` → `summarizePrompt`. Callback
only; the engine keeps no UI concepts.

Also check `abortSignal.aborted` *between* steps, not only inside each `streamText` — a cancel
during a 6-segment chain should stop at the next boundary rather than finishing all six.

### 3.5 TUI

**Live entry.** One `kind: "compaction"` transcript entry, updated in place:

```
⊙ Compacting context · summarizing 2/5 · 18s          (esc cancel)
⊙ Compacted · 214 → 12 msgs · 148k → 9.2k · 43s · 5 calls    ctrl+o summary
⊙ Nothing to compact · transcript already minimal
⊙ Compaction cancelled · transcript unchanged
⊙ Compaction failed: <message> · transcript unchanged
```

Three things this fixes beyond progress:

- `messageCountBefore/After` already cross the wire and are currently discarded by the renderer —
  render them.
- `modelCalls` is deliberately surfaced; it makes the cost model of §1.2 visible instead of
  surprising.
- The `noop`/`empty` case gets a line. Today it is completely silent: the divider is written only
  `if (result.status === "compacted")`
  (`packages/mini-lilac-runtime/src/sqlite-store.ts:1137`), so pressing `/compact` on a short
  session appears to do nothing. This should be a transient status line, not a durable divider —
  the "durable dividers only for real compactions" rule in
  `apps/mini-lilac-tui/README.md:126-128` stays intact.

Similarly, typed `/compact` during an active run is currently swallowed with the text left sitting
in the editor (`apps/mini-lilac-tui/src/input-state.ts:251-257`). It should produce the same
`interrupt active work before switching` notice that `/new`, `/model`, and `/session` already use
(`apps/mini-lilac-tui/src/app.tsx:1912-1922`).

**Status line.** Make `workingStatus` operation-aware instead of binary. Introduce a run kind so
`active()` distinguishes prompt runs from compaction runs:

- prompt run → `Working… 12s` (unchanged);
- compaction run → `Compacting… 12s`;
- `/undo` → `Undoing…`.

Then drop the redundant `submitting` from `phaseText` whenever `workingStatus` already names the
operation. That removes `Ready · submitting` (and `Ready · Ran for 12s · submitting`) at the root
rather than papering over it.

`workingHint()` — the `esc interrupt` affordance — currently renders only `<Show when={active()}>`
(`apps/mini-lilac-tui/src/app.tsx:1940-1952`). Once compaction is a run this comes along for free;
it should read `esc cancel` for compaction runs.

**Stream the summary as it is generated.** Requested directly, and it is the strongest
answer to "I can't tell what's in the transcript after compaction". OpenCode does this; today the
summary is invisible and the user is left trusting a two-number diff.

`summarizePrompt` (`packages/agent/auto-compaction.ts:601-617`) already uses `streamText` and
simply awaits `res.text`, discarding the stream. Add an optional `onSummaryDelta` alongside
`onProgress` and consume `res.textStream`, forwarding deltas to the runtime, which republishes them
as `data-compaction` updates on the stable chunk id.

This makes the case for §3.2 (manual compaction as a run) decisive rather than merely tidy: a
blocking control POST has no channel to stream anything over. It also largely subsumes the
progress-bar question in open question 0 — streaming text is a better liveness signal than
`2/5`, and after the Phase 0 fixes there is usually only one call to report on anyway.

Render it as a live, muted, collapsible body on the compaction entry — streaming while it
generates, collapsed to the header line once complete, re-expandable afterwards. This needs the
compaction kind added to `isToolTranscriptEntry`-style handling
(`apps/mini-lilac-tui/src/app.tsx:194-202`), which today excludes it, so it has no disclosure
affordance at all.

The persisted copy already exists — the summary is stored as the first model message wrapped in
`<context-compaction>` (`packages/agent/auto-compaction.ts:918-930`) — so the expand also works on
reload, not just live.

**Header meter.** Upgrade `formatTokenUsage` (`apps/mini-lilac-tui/src/presentation.ts:49-55`) to
be threshold-aware, with a tilde for estimated values:

```
9.2k (3%)                    normal
~9.2k (3%)                   estimated, post-compaction
148k (74% · compacts at 80%) warning band
185k (92% · compacts at 80%) danger band
```

**Pre-threshold nudge.** Emit one muted status line per crossing when usage passes
`threshold − 10%`, so the user can compact at a clean boundary or start a fresh session instead of
being ambushed mid-task.

### 3.6 Post-compaction token accounting

Replace `input_tokens = NULL` with the engine's `estimatedInputTokensAfter`, plus a flag column
marking it an estimate. The meter then visibly drops — which is the entire point of running
compaction — instead of blanking out until the next turn reports real usage.

### 3.7 Undo

`DELETE FROM user_checkpoints` (`packages/mini-lilac-runtime/src/sqlite-store.ts:1160-1162`) plus
the undo-barrier check (`:1253-1260`, which makes `/undo` return `empty` when the latest manual
compaction sits after the latest user message) makes `/compact` a one-way door with no warning.
Two options, preference order:

1. **Reversible** — snapshot the pre-compaction model messages alongside the compaction command and
   let `/undo` restore them. The store already versions model messages, so this is a row plus a
   restore path, and it turns the scariest command in the product into a safe one.
2. **Warned** — if (1) is deferred, at minimum print `compaction clears undo history` on the
   compaction entry.

### 3.8 Controls

- `/compact <focus instructions>` — appended to the summary prompt as a focus section. Threaded via
  a new `instructions?: string` on `MiniLilacCompactRequest` and `ManualCompactionOptions`; the
  engine already accepts `buildSummaryPrompt` overrides (`packages/agent/auto-compaction.ts:1001`),
  no caller uses them today.
- `/context` — breakdown panel: message count, estimated tokens, model context window, threshold,
  keep-recent budget, reserved output tokens. All of it is already computed by
  `computeInputCompactionBudget`.

### 3.9 Efficiency fixes (bounded scope, high leverage)

These are not UI, but they directly determine how long the UI has to show a spinner:

- ~~Batch messages into segments; stop pre-splitting below the threshold~~ (§1.2, Phase 0 item 0).
  Done — the single highest-leverage change in this document.
- **Don't re-summarize history to fix a too-large suffix.** In `compactRepairedMessages`, when the
  pass result overflows, first shrink the retained suffix and re-check; only re-run summarization if
  the *summary itself* is the overflowing part.
- **Strip `reasoningSummary` from summarization calls.** Auto forwards
  `agent.state.providerOptions` wholesale; detailed reasoning summaries are generated and discarded
  on every segment call.
- **Share one summary-provider-options builder** between the manual and auto paths so they stop
  diverging.
- **Fix `DEFAULT_SPLIT_TURN_UPDATE_PROMPT`** being hardcoded at
  `packages/agent/auto-compaction.ts:1224` while the main-history path honours the option.

## 4. Implementation phases

### Stage 1 — engine correctness (shipped, commit `399dd16`)

0. Segment batching, no pre-splitting below the threshold, summary-model-sized chunk budgets, a
   prompt/output reserve, and uniform retry halving. See §1.2.

### Stage 2 — UX (shipped)

**Engine.** `onSummaryDelta` consumes `res.textStream` in `summarizePrompt` instead of discarding
it; `onProgress` fires immediately before each summarization request with `stage`/`step`/`stepCount`
/`pass`. Segments are flattened before the loop so `stepCount` is known up front. `abortSignal` is
checked between steps, so a cancel during a refine chain stops at the next boundary rather than
running the remaining requests. `buildSplitTurnSummaryUpdatePrompt` is honoured, and both paths
share `buildSummaryProviderOptions`, which drops the `reasoningSummary` that summarization generates
and throws away.

**Protocol.** `phase` replaces `status` on `miniLilacCompactionEventSchema`, joined by `outcome`,
`progress`, `summary`, `elapsedMs`, `durationMs`, `modelCalls`. `compacting` is a session status;
`compactionThreshold` and `inputTokensEstimated` are on the session snapshot.

**Runtime.** `POST /sessions/:id/compact` returns a UI message event stream. Admission still runs
under the actor lock before the stream opens, so a non-quiescent session is still a 409; the
summarization itself runs outside the lock, and the `compacting` status is what keeps the session
exclusive — every admission path, `startPrompt` included, requires `idle`/`error`.

The compaction is tracked runtime work, owned by the actor rather than by the request that started
it: it is included in `isQuiescent()`, so `close()` refuses and `shutdown()` waits. **Disconnecting
detaches the client. Compaction continues and commits server-side. Reconnecting to the live progress
stream is not supported.** Stopping it is `POST /sessions/:id/compact/cancel`, a distinct operation;
the abort is re-checked immediately before the commit, so a cancel that lands while summarization is
finishing still leaves the transcript byte-identical.

History and split-turn prefixes summarize concurrently, so the runtime buffers deltas per stage and
assembles them with the engine's own `combineCompactionSummaryParts`. The terminal event carries the
engine's final summary, which is post-truncation and complete. Streamed deltas are republished at
most every 100ms, because a summary emits thousands of them and the automatic path persists each
chunk into the run log; the automatic path captures every field at raise time so a backed-up event
queue cannot backdate later progress onto an earlier phase.

**TUI.** A `compacting` editor phase drives `Compacting... 12s` in the footer with a live glyph and
an `esc cancel` hint, and `phaseText` no longer contributes `submitting` — that removes
`Ready · submitting` at the root. One transcript entry is updated in place across the lifecycle,
carrying the streamed summary as its body; on success it is replaced by the server's committed
entry, which persists the summary for reload. `ChunkRenderer` keys compaction entries by chunk id,
so the automatic path updates a single entry too rather than appending one line per phase.

Three failure modes are kept apart, because conflating them produces contradictory output: a
terminal `failed`/`cancelled` event renders on the entry and the rejection that follows it is
swallowed; a stream that breaks *before* any terminal event reports that the compaction may still be
running, since it is out of view rather than known to have failed; and a failure to refresh the
transcript after a successful commit is reported as a refresh failure, not a compaction failure.

### Stage 3 — review blockers (fixed)

A static review of Stage 2 surfaced seven blockers, all in the
concurrency/lifecycle corners. All are fixed:

1. **Cancel losing the admission race.** `manualCompaction` is now installed
   *inside* the admission lock, and the TUI's `esc` cancel waits behind a
   `compactionAdmission` gate that opens on the compact stream's first
   lifecycle event — a cancel can no longer reach the server before the
   operation it targets exists and be answered `inactive`.
2. **Shutdown missing an admitted compaction.** `requestShutdown()` aborts the
   compaction *under* the actor lock (an admission that won the lock first is
   always visible), and `compact()` admission checks `acceptsAdmissions()` like
   `startPrompt` does. Shutdown now cancels a running compaction instead of
   exhausting its grace period.
3. **A failing stage no longer strands its sibling.** History and split-turn
   summarization share a per-pass `AbortSignal.any` stage signal; the first
   failure aborts the sibling, both are awaited (`Promise.allSettled`), and the
   genuine failure is re-thrown in preference to the abort it induced.
4. **Persisted summary matches the committed context.**
   `shrinkCompactedMessagesToBudget` now takes the summary, truncates *it* and
   rebuilds the `<context-compaction>` wrapper (keeping the closing tag), and
   returns the post-shrink text as the summary that is reported and persisted.
5. **`completed` is terminal to the transport.** The client stops reading at
   the `completed` event instead of waiting for EOF, so a post-terminal
   disconnect or a stream held open cannot turn a committed compaction into a
   hang or an error.
6. **Detached/reopened compaction is represented, not idled.** A new
   `compaction-observed` input event keeps (or puts) the editor in the
   `compacting` phase, and the controller follows the detached operation by
   polling the session (`compactionWatchDelay`, default 1.5s) until the status
   leaves `compacting`, then refreshes the transcript. `esc cancel` stays
   reachable throughout. A request the server refused outright (an HTTP error
   before any event) is reported as a failure instead of being watched.
7. **Prompt-during-compaction is a 409.** The server classifies the runtime's
   `cannot accept a prompt` rejection as a `conflict`.
8. **Completion is atomic.** `commitCompaction` now commits the transcript,
   command result, token estimate, and transition back to `idle` in one SQLite
   transaction. A post-commit state write can no longer produce a false
   `failed` event that claims the rewritten transcript is unchanged.
9. **Detached cancellation is generation-safe.** Live session snapshots expose
   `activeCompactionCommandId`; reopened and polling clients use it for targeted
   cancellation and update it on every compacting snapshot, including direct
   compaction-to-compaction handoffs.
10. **Malformed terminal events fail immediately.** A recognized
    `data-compaction` part that violates the current protocol is rejected rather
    than ignored, so a malformed `completed` event on a held-open stream cannot
    hang forever.
11. **Terminal paths re-check server activity.** Failed, cancelled, noop, empty,
    refused, and detached completion paths refresh the session before idling;
    successor compactions are watched and successor prompt runs are adopted with
    their run id wired into steering and cancellation.
12. **Server shutdown aborts compaction before listener drain waits.** The
    listener and runtime shutdown requests start together, so an attached
    compaction closes cooperatively instead of holding the response open until
    the listener's force-close deadline.

### Not built

- **Manual compaction as a true run (former Phase 3).** `RunProjection` requires an
  `AiSdkPiAgent`, and the store's unique active-root-run index plus `commitCompaction`'s quiescence
  assertions all assume a prompt run. Streaming the POST response delivers the same observability
  without that refactor.
- **Reconnection to live compaction progress.** A client that detaches cannot re-attach to the
  running compaction; it completes and commits server-side, and the committed entry is visible on
  the next transcript read.
- **Suffix-first overflow retry** (§3.9): re-summarizing all of history to fix a too-large retained
  suffix is still the wrong lever.
- **Pre-threshold nudge** (§3.5) and the `/compact <focus>` and `/context` commands (§3.8).
- **Undo reversibility** (§3.7). `/compact` still clears undo history without a warning; open
  question 2 is unresolved.
- **`/compact` during an active run** (G14) is still silently swallowed.

## 5. Test plan

**Engine (`packages/agent/tests/auto-compaction.test.ts`)**

Phase 0 item 0 is landed with these tests already in place:

- N messages whose combined rendering fits inside `segmentLimit` produce exactly one
  `summarizeChunk` call.
- A transcript above 35% of the context window but below it summarizes in one call (pins the
  no-pre-split rule).
- End-to-end: `compactMessages` on a ~220k-token, 300-message transcript against a 369k-context
  model issues exactly one model request.
- Message order and content survive segment packing; a new segment starts at the char limit.
- An oversized message still splits, flushes buffered messages first, and keeps its
  `[message continuation i/n]` markers.

Remaining:

- Overflow still triggers progressive splitting after a real provider rejection (existing coverage
  at `:136-163` — verify it still exercises the split path now that the first attempt is unsplit).
- `onSummaryDelta` forwards streamed text and the final concatenation equals `res.text`.
- Abort between segments stops before the next model call; no partial commit.
- Suffix-first retry: an over-budget suffix shrinks retention without a second summarization pass.
- Split-turn update prompt override is honoured.
- Summary provider options exclude `reasoningSummary`.

**Runtime (`packages/mini-lilac-runtime/tests/session-runtime.test.ts`)**

- Manual compaction emits `started` → `progress`* → `completed` with a stable chunk id.
- Session status is `"compacting"` for the duration and returns to `"idle"`.
- Explicit cancel mid-compaction leaves the transcript byte-identical and emits `cancelled`; a
  cancel landing after summarization but before the lock still stops the commit; cancelling when
  nothing is running answers `inactive`.
- Detaching the stream does not cancel: the session stays `compacting`, prompts and a second
  compaction are refused, and the compaction commits with nobody attached.
- `close()` throws while compacting; `shutdown()` waits for the tracked work.
- Command idempotency survives (replayed `clientCommandId` returns the stored result without
  re-running).
- `input_tokens` is set to the post-compaction estimate, flagged as estimated.
- Auto compaction emits `started` before the first summarization call, with no summary and zero
  `modelCalls` on that event even though publication is deferred.
- Split-turn deltas reach the summary, and the terminal event carries the engine's final summary.

**Store (`packages/mini-lilac-runtime/tests/sqlite-store-*.test.ts`)**

- `"compacting"` passes the `CHECK` constraint; migration applies to existing rows.
- `input_tokens_estimated` clears on reported usage even when the count equals the estimate, and on
  a model binding change that clears the count.
- Pre-compaction snapshot round-trips and `/undo` restores it.

**TUI (`apps/mini-lilac-tui/src/*.test.ts(x)`)**

- Footer shows `Compacting… Ns`, never `Ready`, while a compaction run is active.
- `phaseText` does not render `submitting` when `workingStatus` names the operation.
- The compaction entry updates in place rather than appending a line per progress chunk, on the
  automatic path as well as the manual one.
- A streamed `failed` event is reported once, not twice; a stream that breaks before any terminal
  event says the compaction may still be running; a refresh failure after a successful commit is
  not reported as a compaction failure.
- A `noop` compaction renders a transient line and writes no durable divider.
- `/compact` during an active run shows the interrupt notice instead of silently doing nothing.
- Header meter renders threshold text, warning/danger bands, and the estimate tilde.
- `esc` during compaction calls the cancel endpoint (not the request signal), and the `esc cancel`
  hint is visible.

**Lint/format/typecheck**: `bun run lint:fix`, `bun run fmt`, `bunx tsc -p tsconfig.json --noEmit`
in each touched package.

## 6. Open questions

0. **Is `onProgress` still worth building?** Phase 0 made compaction a single call for any
   below-threshold transcript, and Phase 2 item 9 streams the summary text — which is a better
   liveness signal than `2/5` anyway. `onProgress` now only earns its keep in the overflow-recovery
   path, where splitting genuinely happens. Leaning toward dropping it and reporting pass count
   only in the terminal event.
1. **Phase 3 scope.** Turning manual compaction into a run is the right shape but touches
   admission, status, and cancel. Acceptable to do now, or split Phases 1–2 + 4 first with manual
   compaction still a blocking POST (progress then only reaches the UI for *auto* compaction)?
2. **Undo.** Is a pre-compaction transcript snapshot acceptable storage cost, or is the warning
   fallback preferred?
3. **Auto-continue message.** `AUTO_CONTINUE_AFTER_COMPACTION_TEXT`
   (`packages/agent/auto-compaction.ts:829-830`) is injected via `agent.followUp` after a threshold
   compaction. Should it be visibly attributed as system-injected in the transcript, or stay
   invisible?
4. **Threshold configurability from the client.** `earlyCompactionPoint` is config-file only. Worth
   a `/compact-at <pct>` session-scoped override, or leave it in config?
5. **Verification item.** Manual compaction on codex sends `providerOptions` without any
   `instructions`, so the responses body has no top-level `instructions` field. Worth one
   `LLM_WIRE_DEBUG` trace to confirm the codex backend is happy with that, since the auto path and
   the main turn both differ from it.
