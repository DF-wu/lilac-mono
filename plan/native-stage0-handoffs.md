# Native Stage 0: Admission, output and history handoffs

Status: source audit and proposed implementation design, 2026-09-19. These findings do not constitute passing runtime proofs or close Stage 0. No runtime changes accompany this document.

## Durable input admission

The existing request-delivery coordinator remains the execution admission owner. Native storage owns visible inputs and the minimal intent required to cross the native/request-delivery transaction boundary.

Evidence:

- `apps/core/src/surface/bridge/request-delivery/durable-request-bus.ts:42` intercepts `CmdRequestMessage` and routes it through `prepareAndPublish`. It validates the prepared envelope and requires a request ID.
- `apps/core/src/surface/bridge/request-delivery/coordinator.ts:98` implements preparation/publication with the existing publication claim protocol. `coordinator.ts:358` returns accepted/terminal receipts before resolving blobs again.
- `apps/core/src/surface/bridge/request-delivery/types.ts:4` sets input blob resolution timeout to 60 seconds. `coordinator.ts:681` resolves all input handles, and `coordinator.ts:698` terminalizes an unresolved upload as upload-timeout/upload-failed.
- `packages/event-bus/lilac-spec.ts:78` defines the durable command with `requestDeliveryId`, queue mode, messages, optional lineage/model override and raw metadata. It does not yet carry a native generation, turn or pending-upload contract.
- `PROJECT.md:250` describes accepted work as the recovery floor; WAL checkpoints may lag execution. The design must preserve that at-least-once contract.

Implementation:

1. In one native SQLite transaction, validate actor/thread/generation, record command receipt and visible input, reserve stable input/request/delivery identities, and record its admission intent. Store attachment dependencies and requested input mode with the active run association observed at acceptance. Acknowledgement follows this commit, not model admission or file completion.
2. HTTP upload completion verifies bytes and obtains the retained resource URI. Native attachment state and readiness are committed before the intent becomes eligible. Do not submit unresolved native upload handles to `cmd.request`: a large user upload must not hit the coordinator's existing 60-second materialization timeout.
3. Reconcile eligible intents using the existing durable request bus. Retry with exactly the same request/delivery identity and prepared envelope. Store enough immutable submitted data to reproduce the same envelope after a crash. An ambiguous publication cannot cause a new identity or a second input.
4. Recheck current access, origin-thread resource access, history generation, cancellation fence and mode/run association before executable admission. The execution store must also validate the native admission fence, so a prepared Redis command cannot execute after native cancel/rewind commits.
5. Once durable acceptance is confirmed, settle the intent. Recovery handles both orders of cross-store completion: a native unsettled intent whose delivery already exists, and an accepted delivery whose native acknowledgement was interrupted. Do not create a second execution queue.
6. An upload failure leaves the visible message and its actionable failure state. Retry reuses input/upload ownership; it does not post duplicate text. Removing/canceling the pending entry terminalizes its admission intent. Cleanup progress is separate from this logical outcome.

Resolve configured model identity at acceptance for a full input and persist the resolved selection needed for later execution. The existing command's model name alone is insufficient if config changes while an upload is pending. Active steering keeps the target run's pinned model and starter principal. Starter authority is rechecked at executable admission. The actual input author remains attribution only.

### Upload-ready versus run-finish policy

Native thread mutation serialization must decide this race explicitly. Do not let generic runner fallback reinterpret a native command implicitly.

| Accepted input | Readiness/control race | Required disposition |
| --- | --- | --- |
| Full prompt in an idle thread | Attachments become ready, generation still valid | Admit its full turn in input order. |
| Follow-up tied to run A | A naturally finishes before upload readiness | Keep it as a follow-up, admit a new full turn after readiness and earlier accepted follow-ups. |
| Steering tied to run A | Ready while A still accepts steering | Deliver to A; do not allocate another full turn or change its model. |
| Steering tied to run A | A naturally finishes before admission | Return an explicit `target-ended` outcome and require resend as a full input. Do not silently change steering to a prompt. The accepted visible input remains attributable but was not delivered to a model. |
| Any pending input tied to A | A is canceled, entry removed, thread rewound/deleted | Persist the dropped/canceled disposition. Late upload completion cannot admit it. |
| New input | Accepted after cancel transaction completes | It belongs to the new admission interval and is not part of A's canceled set. |

The `target-ended` choice is a conservative proposed technical policy, not a claim that it is already implemented. It must be encoded in the contract and reviewed alongside the race tests before Stage 0 closes. Existing runner behavior differs: `apps/core/src/surface/bridge/bus-agent-runner.ts:9082` calls `promptWhileIdle` for an idle steer; `:9131` queues follow-up while streaming. Native controls must carry and enforce the target association before reaching those branches.

The oldest unresolved full input in a lane prevents later full inputs from overtaking it. Controls such as cancel remain independent of upload readiness. Persist all lane decisions; process-local ordering alone is insufficient after restart.

## Durable native output

The existing request output transport cannot satisfy the approved native delivery guarantee unchanged.

Evidence:

- `packages/event-bus/redis-streams-bus.ts:68` sets output stream TTL to 24 hours. `:1312` publishes every `out.req.*` event with expiry.
- `packages/event-bus/redis-streams-bus.ts:1581` rejects durable subscriptions to output topics. `packages/event-bus/tests/event-delivery.test.ts:956` tests that rejection.
- `MIGRATIONS.md:349` explicitly says expiring output is tail-only. Managed durable groups start at stream end when first created.
- `apps/core/src/surface/bridge/bus-agent-runner/output-publisher.ts:92` serializes publications, but ordinary text publication is queued without awaiting the call site. `:106` reports publication errors through `onError`; `:294` drains a tail whose type does not retain those errors.
- `apps/core/src/surface/bridge/bus-agent-runner.ts:5202` awaits terminal output publication, then marks the run terminal. It does not await a surface projection acknowledgement.
- `apps/core/src/surface/bridge/bus-agent-runner.ts:2867` writes WAL checkpoints independently of the output publisher; `:2991` coalesces pending checkpoints. A new native output contract must cover checkpoint/output ordering as well as terminal output.

Recommended implementation within the planned durable bus integration:

1. Add one fixed, nonexpiring native output topic and a schema-validated native output event family to the existing Lilac event catalog. Reuse managed durable delivery and its retry/commit/trim policies. Do not enable durable delivery on existing expiring `out.req.*` topics or change Discord/GitHub retention as a side effect.
2. Establish the native projection consumer group before admitting any native producer, including during recovery. Its identity is stable across boots. Startup fails native readiness if this prerequisite fails. A missing group against existing unprojected output requires an explicit recovery path; creating it at `$` must not silently skip existing events.
3. Native output includes server-internal request/attempt, turn, generation, step/part and ordered event identity sufficient for idempotent projection. These fields are not all socket payload requirements. Project only client-visible metadata to the native replay log.
4. Commit each event's native projection, replay changes and deduplication receipt in one native transaction, then return handler success so the bus acknowledges it. Retry a projection failure. A duplicate delivery sees the receipt and commits without appending text again.
5. Publish native terminal output durably before terminalizing request delivery/WAL. A failed durable publication is not a successful terminal surface write. Browser sockets and native projection latency do not block model execution.
6. Capture a native output publication barrier with each WAL checkpoint. Before committing that checkpoint, settle its captured barrier successfully. A checkpoint must not recover from a point after visible events that were only buffered and lost. This barrier is between backend durability owners, never between the model and a browser. Failed output publication must retain an earlier safe checkpoint and surface the failure; `drain()` swallowing an earlier text publication error is insufficient.
7. Trim the native bus topic only after managed pending and committed projection frontiers allow it. Client replay remains a separate seven-day/byte-capped native-store concern. Expiring client replay does not permit dropping unprojected durable output.
8. Recovering model work can still repeat effects. Attempt/reset identity must let the projection replace an abandoned attempt's text without appending its replay as new text. No exactly-once claim applies to model calls or tools.

This needs catalog/codec/delivery architecture registrations, migration/recovery documentation and integration tests. It is a required Stage 1 contract change already motivated by the plan, not a completed Stage 0 proof. A reliable final transcript alone cannot recreate all intermediate activity, paragraph publication and compaction events.

## Provider publication boundaries

The runner receives enough agent events to implement paragraph/complete publication before the generic output bus loses their boundaries.

| Existing source | Available information | Native use |
| --- | --- | --- |
| `apps/core/src/surface/bridge/bus-agent-runner.ts:7091` | `message_update/text_start`, part ID and OpenAI phase | Open a text part and preserve supplied commentary/final-answer phase. |
| `apps/core/src/surface/bridge/bus-agent-runner.ts:7110` | Text deltas, part ID, synthetic separator length | Accumulate provider text with stable part identity; do not turn synthetic separators into duplicate content. |
| `apps/core/src/surface/bridge/bus-agent-runner.ts:7162` | `text_end`, part ID | Flush paragraph remainder and close part; do not treat this as complete-mode stop. |
| `packages/agent/agent-executor.ts:1507` | `turn_end` with normalized finish reason, messages and usage | Treat this as a model step boundary inside the native UI turn. Stop/tool-calls commit complete-mode text. |
| `apps/core/src/surface/bridge/bus-agent-runner.ts:7012` | `turn_abort` reason | Flush retained nonempty remainder once with incomplete status on cancellation/failure. |
| `apps/core/src/surface/bridge/bus-agent-runner.ts:7028` | Retry and recovery `messages_reset` | Reset abandoned attempt projection rather than duplicating already published text. |
| `apps/core/src/surface/bridge/bus-agent-runner.ts:6392` | Compaction start with reason/counts | Emit structured compaction start correlated to request/UI turn. |
| `apps/core/src/surface/bridge/bus-agent-runner.ts:6431` | Compaction end status, before/after counts and canonical replacement | Emit completion/failure with boundary/counts, without summary/provider prompt contents. |

`packages/event-bus/lilac-spec.ts:347` currently exposes text delta/phase and `:365` exposes aggregate final text. Neither carries text-end or model-step-end. `output-publisher.ts:13` uses 40 ms/4 KiB batching. Implement the native accumulator at the runner's semantic event seam, not by guessing text/step endings from the existing relay stream.

For paragraph mode, normalize CRLF incrementally, retaining a trailing `\r` until the next chunk or boundary. Scan for literal `\n\n`, including delimiters split across chunks, and emit newly complete spans including delimiters. Flush the remainder at part/step/terminal boundaries. Blank lines in fenced code still count. Preserve part and phase ordering around tool/thinking activity.

For complete mode, preserve part/phase records in the step buffer and release text at normalized `stop`/`tool-calls`. Length/cancel/error flush remaining text as incomplete. A tool call does not settle the UI turn. Tool/activity events may progress independently of buffered text; their chronological identity preserves the eventual display order.

Do not render provider-hidden reasoning. Retain the existing no-reply suppression before native visible projection, and handle phase transitions without leaking a possible no-reply sentinel. Pin streaming mode to the run, as the approved plan specifies.

## Rewind state and fences

A rewind is a generation mutation across the native projection and existing execution/history owners, not a message-array splice.

Evidence:

- `apps/core/src/transcript/transcript-store.ts:4151` retrieves latest transcript by session timestamp. An old suffix remains the latest unless native composition explicitly excludes it.
- `apps/core/src/transcript/transcript-store.ts:3542` validates complete lineage against exact canonical messages, transcript digests, surface projections, provider family and aliases. Reusing a suffix lineage manifest after rewind is invalid.
- `apps/core/src/transcript/transcript-store.ts:3640` validates compaction checkpoint context and requires a live output link. A checkpoint that summarized removed turns cannot be reused merely because its summary exists.
- `apps/core/src/transcript/transcript-store.ts:5331` and `:5792` persist named/primary Claude continuation bindings, including provider session and revision/hash identity. Rewind must invalidate continuation state tied to the removed suffix.
- `apps/core/src/surface/bridge/bus-agent-runner.ts:7030` distinguishes canonical reset from text projection reset. Rewind must repair both.
- `PROJECT.md:250` and `MIGRATIONS.md:245` separate accepted deliveries from recoverable WAL state. Resetting only WAL cannot prevent an accepted old-generation request from restarting.

Persist a minimal rewind intent with expected generation, target full `turnId`, retained prefix boundary, affected active request identities and mutation phase. Atomically move the native thread into mutation state, fence new/old generation work and cancel eligible uploads/follow-ups. Obtain runner cancellation quiescence before publishing a completed rewind. Retry unfinished mutation phases during native startup before native request recovery/admission.

Reset or fence these owners:

- Native visible turns/messages/parts, input dispositions, read positions and queued controls after the boundary. Increment history generation, invalidate replay/hydration slots and publish the truncation event.
- Existing accepted deliveries for discarded work, including commands published before cancellation but not yet consumed. Make them terminal or reject them by generation on intake. Retire their active WAL heads/checkpoints so startup cannot restart the suffix.
- Canonical history and active lineage pointer. Build the next request from the retained prefix with protocol-valid tool call/result pairing. Native history selection must not fall back to unrestricted latest-by-session timestamp.
- Provider continuation bindings and caches. Invalidate affected Claude native sessions/bindings and other provider continuation hints; use retained portable canonical prefix when continuation cannot prove an exact prefix match.
- Compaction/checkpoint lineage, loaded skill/tool catalog state and provider family state inherited from the discarded suffix. A post-boundary compaction summary is not valid prefix context. Rebuild from surviving canonical history and only surviving compatible checkpoints.
- Surface-to-transcript aliases, native discovery/search projections and summaries. Queries exclude removed generations before asynchronous cleanup completes.
- Resource retention references for removed projection rows. Resource origin-thread authorization remains unchanged; cleanup must respect surviving transcript/resource owners.
- In-flight output and hydration from the discarded generation. Commit guards reject stale generation even if cancellation arrives late or recovery republishes output.

Keep immutable request transcripts where another surviving owner still references them. Rewind changes active reachability first; cross-store physical deletion/cleanup follows. Do not mutate a retained transcript's digest behind a lineage manifest. Only the invoking client receives target user text for its composer, and no new prompt is sent automatically.

## Required proofs before closing Stage 0

These have not been run by this source audit:

1. Native message commit -> process death -> replay/reconciled single durable request; command reissue with identical identity; publication ambiguity; accepted delivery before native intent settlement.
2. Large upload accepted before completion; multiple readiness orders; process restart; canceled/removed/rewound input later finishing upload; no generic 60-second upload timeout; no lane overtaking.
3. Finish versus ready steer gives one explicit disposition; follow-up starts once only after readiness; cancel fences already-published-but-unconsumed commands and drops the correct accepted set.
4. Durable output consumed after process restart, projection-before-ack crash deduplication, output publication failure before terminalization, and WAL checkpoint unable to outrun its output durability barrier.
5. Existing output TTL/durable restrictions remain unchanged for Discord/GitHub. Native projection catches up beyond 24 hours without lost output, and the first consumer-group creation/recovery path cannot skip unprojected work.
6. Paragraph delimiter splits/CRLF/fences; step stop/tool-calls/length; no-reply suppression; retry/reset; phases with missing provider metadata; compaction event correlation.
7. Rewind during active generation, post-compaction and native provider continuation; process death between every mutation owner; prior accepted work cannot recover; valid surviving tool-exchange prefix; deleted suffix absent from search/resources/replay.

The source audit resolves where changes belong. It does not prove transport/storage crash behavior. Stage 0 remains open until executable protocol/race proofs and review settle these contracts.
