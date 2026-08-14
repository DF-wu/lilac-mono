# Redis Event Delivery Reliability Follow-Up

## Status

This is the active runtime follow-up to the boundary contracts summarized in `PROJECT.md`: complete event
decoding, typed handler Results, transport-owned acknowledgement, and explicit delivery dispositions are
already implemented. This plan does not change those established contracts.

The follow-up covers Redis pending-entry reclamation, leased attempt ownership, retry scheduling,
attempt exhaustion, idempotency and deduplication, the dead-letter/`XACK` crash window, and
transactional inbox/outbox processing.

## Current Baseline

The active event-bus path has these relevant contracts and behaviors:

- `packages/event-bus/types.ts` defines `work` and `fanout` as durable consumer-group modes, `tail` as
  a non-durable cursor read, and `SubscriptionOptions` with `subscriptionId`, `consumerId`, and batch
  controls.
- `packages/event-bus/raw-bus.ts` exposes `RawBus.subscribe`. Its handler returns a
  `RawDeliveryAction`, and the transport owns acknowledgement. The API explicitly says that
  `park-pending` leaves an entry in the pending entries list (PEL) without scheduling retry.
- `packages/event-bus/redis-streams-bus.ts` implements durable delivery with
  `XREADGROUP GROUP <group> <consumer> ... STREAMS <stream> ">"`. It invokes `XACK` only for `commit`
  or after dead-letter acceptance. It may inspect `XPENDING` summaries or bounded ranges for
  trimming, cleanup, and observability, but it does not call `XAUTOCLAIM` or `XCLAIM`, reclaim
  pending entries, or redispatch them to handlers.
- `RedisStreamsBus.subscribe().stop()` deletes a durable consumer only when that consumer has
  no pending entries. A consumer that owns parked entries remains in Redis for manual inspection and
  recovery.
- `packages/event-bus/event-delivery.ts` defines `DeliveryDisposition` as `commit`, `park-pending`,
  `dead-letter`, or `stop`; `applyEventDeliveryPolicy` maps package-owned failures to those outcomes.
- `packages/event-bus/lilac-bus.ts` exposes `LilacBus.subscribeTopic`. It decodes before invoking
  the handler, validates handler Results and policy output, creates dead-letter records, and delegates
  the resulting action to `RawBus.subscribe`.
- `packages/event-bus/event-dead-letter.ts` defines `EventDeadLetter`,
  `EventDeadLetterRecordV1`, and bounded or controlled-reference transport evidence.
- `packages/event-bus/redis-event-dead-letter.ts` durably appends a dead-letter record, copying
  referenced evidence when necessary, before `redis-streams-bus.ts` separately calls `XACK`. Every
  TTL-bound complete record and copied evidence value is an AES-256-GCM envelope with a random nonce,
  authentication tag, and ciphertext version. Authenticated additional data binds every value to its
  record/evidence kind, `deadLetterId`, and exact Redis storage key, so copying ciphertext between record
  or evidence identities cannot produce plaintext. The bounded index remains payload-free.
- `createCoreEventBusDeliveryOptions` in `apps/core/src/runtime/create-core-runtime.ts` configures
  `RedisEventDeadLetter` for Core with its default Redis key prefix and the persistent 32-byte key at
  `DATA_DIR/secret/event-dead-letter.key`. Core creates this mode-`0600` file atomically when absent;
  concurrent startups reuse the same winner.
- `packages/event-bus/tests/event-delivery.test.ts` proves that `park-pending`, `stop`, and failed
  dead-letter acceptance leave durable entries pending, while successful `commit` and dead-letter
  acceptance acknowledge them.
- `RedisStreamsBus.trimBeforeCheckpoint` and acknowledged-prefix trimming preserve pending group
  frontiers. `LilacBus.retireTopicConsumerGroup` is a rollout cleanup operation, not a pending-entry
  recovery mechanism; destroying a group also destroys its PEL.

The workflow runtime supplies a useful but subsystem-specific durability baseline:

- `DurableWorkflowStore.applySurfaceAction` in
  `apps/core/src/workflow/durable-workflow-store.ts` commits the workflow state change, consumes the
  action, and inserts stable `workflow_action_outbox` rows in one SQLite transaction.
- `apps/core/src/workflow/workflow-action-resolver.ts` publishes those rows with a stable
  `workflow_outbox_id` header, marks them published afterward, and retries failures from
  `listPendingActionOutboxEvents`.
- The current action outbox uses a fixed one-second retry in `recordActionOutboxFailure`; it records an
  attempt count but has no exhaustion policy. Publication and `markActionOutboxPublished` are separate,
  so a crash between them can publish the same logical event again.
- `apps/core/src/workflow/workflow-progress-projector.ts` independently replays pending projection rows
  and converges projection state. These existing workflow recovery semantics must remain valid while a
  general inbox/outbox facility is introduced.

## Goals

1. Recover abandoned in-flight consumer-group entries without stealing work from a live handler.
2. Make retry eligibility, timing, ownership, and exhaustion explicit and durable.
3. Keep manual parking distinct from automatic retry in types, state, logs, and operator tools.
4. Fence stale owners from acknowledging, rescheduling, or terminalizing an entry after ownership moves.
5. Provide stable identities for producer publication, consumer effects, and dead-letter acceptance.
6. Close the dead-letter/`XACK` crash window without losing the source entry or creating duplicate
   dead-letter records.
7. Provide an opt-in transactional inbox/outbox path for consumers that mutate durable application
   state.
8. Preserve existing Redis wire entries, event codecs, typed handler Results, workflow state/outbox
   atomicity, and projection recovery behavior.
9. Give operators supported inspection, retry, park, dead-letter, and acknowledgement operations with an
   audit trail.

## Non-Goals

- Stage 4 `park-pending` remains manual. It does not become an alias for retry, and no Stage 4 consumer
  gains automatic pending reclamation by completing the boundary type-safety refactor.
- `XREADGROUP ... ">"` does not retry pending entries. It reads entries never delivered to that group;
  restart, a new `consumerId`, and continued polling with `">"` do not recover the PEL.
- This plan does not add automatic retry to `tail` mode. Tail has no PEL and must continue to stop when a
  policy requires durable parking.
- This plan does not promise exactly-once execution across Redis, SQLite, and arbitrary external APIs.
  The target is at-least-once transport with effectively-once durable local effects when consumers use
  the transactional inbox/outbox contract.
- This plan does not infer that every handler error is retryable. Retry is opt-in and error-specific.
- This plan does not automatically replay entries parked by Stage 4 or by an operator. Legacy and
  manually parked PEL entries require an explicit recovery decision.
- This plan does not use `retireTopicConsumerGroup` to clear pending work. Group retirement remains a
  separately confirmed rollout operation after pending entries have been reconciled.
- This plan does not redesign event payload schemas or the Redis stream wire format.
- This plan does not replace the ordered tail/checkpoint design in
  `apps/core/src/workflow/workflow-wait-resolver.ts`. Consumers that require strict sequential ordering
  must not opt into concurrent reclamation without a separate ordering design.
- This plan does not require every read-only, convergent, or naturally idempotent consumer to create a
  SQLite inbox.
- This plan does not redesign all workflow projection leases or surface delivery behavior. It integrates
  only where necessary to prove the general delivery contract and preserve existing recovery.

## Delivery Guarantees And Invariants

The implementation must make the following guarantees explicit:

1. A Redis stream entry can be pending for one consumer in one group at a time, but Redis PEL ownership
   alone is not a sufficient application lease. An old process can continue after `XCLAIM` transfers the
   entry.
2. Every handler invocation has a durable delivery identity, a monotonically increasing dispatch attempt,
   and a unique lease token.
3. Only the current lease token can heartbeat, acknowledge, schedule retry, park, or begin terminal
   dead-letter handling.
4. Lease loss aborts the owned attempt signal and makes every later transport finalization from that
   attempt stale. A stale finalization must not call `XACK`.
5. `park-pending` removes an entry from all automatic due indexes while leaving it in the PEL.
6. Retry scheduling leaves the source in the PEL and records an absolute due time. Polling `">"` is not
   part of retry execution.
7. Attempt exhaustion is a durable state transition. Exhausted entries are not invoked again while
   dead-letter acceptance is retried or while awaiting manual recovery.
8. A dead-letter record is durably accepted before source acknowledgement. Repeating acceptance for the
   same terminal delivery identity returns the original acceptance rather than appending another record.
9. A transactional consumer acknowledges only after its inbox, domain mutations, and outbox rows commit.
10. Outbox publication can be repeated safely after a crash. The same producer idempotency key resolves
    to the same stream entry rather than appending another logical event.
11. Panic and broken handler contracts remain defect-supervisor events. They are not converted into
    ordinary retries or counted toward a configured expected-failure policy.
12. Ordinary logs and metrics never include raw payloads or dead-letter evidence.

## Identity Model

Define identities before adding reclamation:

- **Transport identity:** Redis stream key plus stream entry ID.
- **Delivery identity:** transport identity plus durable consumer-group ID. Fanout groups intentionally
  have independent delivery identities for the same stream entry.
- **Dispatch attempt:** a one-based counter incremented durably immediately before the handler may run.
  A crash after increment but before callback entry consumes an attempt; this conservative rule avoids
  claiming that an ambiguous dispatch never ran.
- **Lease identity:** delivery identity plus a random token and owner instance ID. The owner ID must
  contain a boot-unique component; PID-only consumer IDs are not sufficient.
- **Producer idempotency identity:** a producer namespace plus a stable producer-owned key. Existing
  `workflow_outbox_id` values are suitable keys in a workflow namespace; `request_id` alone is not.
- **Inbox identity:** consumer contract/version plus delivery identity, or a validated producer
  idempotency identity when multiple physical stream entries are known to represent one logical event.
- **Dead-letter identity:** a deterministic ID derived from delivery identity and terminal policy version.
  `EventDeadLetterRecordV1.deadLetterId` can carry the deterministic value. Add a versioned record codec
  rather than silently changing v1 if group, attempts, or policy metadata must be persisted.

Identity derivation must use an explicit version and unambiguous length-delimited or canonical encoding.
It must not concatenate uncontrolled strings with a separator and assume collision freedom.

## Durable Delivery State

Maintain Redis-side delivery metadata adjacent to the consumer-group PEL. The logical record contains:

- delivery identity and policy version;
- state: `in-flight`, `retry-scheduled`, `parked-manual`, `dead-letter-pending`, `exhausted`, or terminal;
- current consumer, owner instance, lease token, and lease deadline;
- handler dispatch attempt count;
- dead-letter acceptance attempt count, tracked separately;
- first-seen, last-transition, next-attempt, and optional exhaustion timestamps;
- a bounded error tag/reason code, never an exception object or payload;
- terminal dead-letter acceptance ID or producer/inbox reference when applicable.

Use Redis server time for lease and due-time comparisons. All state transitions that combine lease
validation with `XCLAIM`, `XACK`, due-index mutation, or terminalization must run in a Lua script or an
equivalent Redis transaction with a proven atomicity boundary. Keep all keys used by one transition in a
compatible Redis slot if cluster support is introduced.

The PEL remains the transport source of truth. Delivery metadata is the policy and fencing source of
truth. Startup reconciliation must detect both directions of drift:

- A PEL entry without metadata means the process may have crashed after `XREADGROUP` and before attempt
  initialization. Reconstruct it as abandoned with zero known handler attempts and require lease
  acquisition before dispatch.
- Metadata without a PEL entry must be terminalized or quarantined according to its recorded state; it
  must never cause a synthetic handler invocation.
- A PEL entry whose stream body is no longer available is quarantined as missing source evidence. Do not
  pretend it was successfully processed.
- Reconciliation is bounded and resumable so a large PEL cannot block startup.

## Lease And Claim Ownership

Add a delivery lease supervisor to `RedisStreamsBus.subscribe` for durable modes only:

1. A fresh entry returned by `XREADGROUP ... ">"` is initialized and leased before handler invocation.
2. A heartbeat extends the lease using a compare-token transition. The heartbeat interval must be
   comfortably less than the lease duration and both values must be validated.
3. The attempt receives an owned `AbortSignal`, delivery identity, attempt number, and lease deadline in
   `EventDeliveryContext`.
4. A failed heartbeat or observed token mismatch aborts the signal and records lease loss. It does not
   map the handler outcome to another disposition.
5. Completion, retry scheduling, parking, and dead-letter transition scripts reject stale tokens.
6. Shutdown stops new claims, aborts active attempts, waits for bounded cleanup, and leaves unresolved
   entries pending. It does not acknowledge merely to make consumer cleanup succeed.

Do not rely on `XAUTOCLAIM` alone. It can transfer Redis ownership based only on PEL idle time while a
live application handler still owns a valid lease. The reclaimer should inspect bounded pending ranges
and use an atomic lease-expiry check plus `XCLAIM` to transfer only eligible entries. If `XAUTOCLAIM` is
later used for scanning efficiency, the design must first prove that it cannot steal a valid leased
attempt.

Lease fencing prevents stale transport finalization, not arbitrary stale external side effects. A handler
that needs effectively-once effects must use the transactional inbox/outbox path and must not perform an
unfenced external mutation directly.

## Retry Scheduling And Backoff

Extend the policy result with a new explicit retry decision; do not reinterpret the existing
`park-pending` string. The eventual API should distinguish at least:

- commit;
- manual park;
- retry, with an optional bounded server-approved delay override;
- dead-letter;
- stop.

Retry configuration belongs to a subscription registration and is validated before the consumer group
starts. It includes:

- enabled/disabled, defaulting to disabled;
- policy version;
- maximum handler dispatch attempts;
- optional maximum elapsed delivery age;
- initial delay, multiplier, maximum delay, and deterministic jitter range;
- lease duration and heartbeat interval;
- exhaustion action: dead-letter, manual park, or stop;
- bounds for handler-provided delay overrides;
- maximum concurrent fresh and reclaimed attempts.

The default delay is capped exponential backoff. Jitter is deterministic from delivery identity and
attempt so a restart does not continuously move the due time. Persist the chosen absolute due time once;
do not recompute it on every scan.

A retry decision atomically validates the lease, clears active ownership, records the next due time, and
adds the delivery identity to a due sorted set. A reclaimer claims only due `retry-scheduled` entries or
expired `in-flight` entries. It never claims `parked-manual` entries.

Expired `in-flight` work is an ambiguous attempt and therefore consumes the already-recorded dispatch
attempt. It can be dispatched again only if the configured budget remains. Redis PEL delivery counts are
diagnostic input, not the authoritative handler attempt count, because claims, inspections, and recovery
operations can change Redis counters without invoking the handler.

Dead-letter adapter failures use a separate backoff and counter. They must not invoke the handler again
or consume another handler attempt after the delivery has entered `dead-letter-pending` or `exhausted`.

## Attempt Exhaustion

Before every dispatch, atomically increment the handler attempt and compare it with the snapshotted
policy. When the next invocation would exceed `maxAttempts`, transition directly to the configured
exhaustion action.

For dead-letter exhaustion:

- create one deterministic terminal record containing bounded error classification, final handler
  attempt, policy version, and source evidence;
- retry dead-letter acceptance independently if its adapter is unavailable;
- do not run the handler again while acceptance is pending;
- acknowledge only after acceptance is durable and idempotently recorded.

For manual-park exhaustion, remove the entry from due indexes, retain it in the PEL, and emit an
operator-visible event. For stop exhaustion, stop the subscription after durably recording why the entry
remains pending.

Changing live configuration must not silently grant or remove attempts from existing deliveries. Store
the policy version and effective limits when an entry first enters managed retry. Provide an explicit
operator migration for changing parked or scheduled entries to a new policy.

## Idempotency And Deduplication

### Producer Publication

Add an optional idempotent publish operation alongside the current `RawBus.publish` and
`LilacBus.publish` behavior. The operation atomically associates a producer namespace/key with one Redis
stream ID and appends only when the association is absent. A repeated call returns the original ID and
cursor.

Keep the existing stream fields and SuperJSON encoding unchanged. Store the idempotency index separately
and define retention so it cannot expire while an outbox row may still retry. Cleanup must be based on a
durable publication/outbox horizon, not a short arbitrary TTL.

Migrate `workflow_action_outbox` publication to use `workflow_outbox_id` as the producer key. A crash
after Redis append but before `markActionOutboxPublished` then republishes idempotently and marks the
existing stream ID complete.

### Consumer Inbox

Provide a versioned SQLite inbox schema and transaction adapter for durable state-mutating consumers. In
one immediate transaction it must:

1. Insert or identify the inbox identity.
2. If already completed, skip domain effects and return the recorded completion.
3. If new, apply domain state changes.
4. Insert all resulting outbox rows with stable IDs.
5. Mark the inbox entry completed and commit.

The bus acknowledges only after this transaction commits. A crash before commit leaves no effects and is
safe to retry. A crash after commit but before `XACK` is deduplicated by the inbox and then acknowledged.
An expected domain failure rolls back unless the domain explicitly commits a terminal rejection as its
business outcome.

The transaction adapter must use the repository's private rollback-sentinel pattern when a Result error
occurs after writes begin. It must never return an Err from a SQLite transaction body after partial writes
without forcing rollback.

### Outbox

Generalize only the proven parts of `workflow_action_outbox`:

- domain state, inbox completion, and outbox insertion share one local database transaction;
- each row has a stable producer namespace/key;
- publishers claim rows with owner/token leases and fenced completion/failure updates;
- retries use durable capped backoff and explicit exhaustion/quarantine;
- Redis publication is idempotent;
- startup and periodic drains resume unpublished rows;
- successful publication records the returned stream ID;
- projection-specific completion remains separate from publication completion.

Do not couple the generic event-bus package directly to `DurableWorkflowStore`. Put storage-specific inbox
and outbox adapters in the owning application/package and expose only the delivery identity and
idempotent publish capabilities needed to implement them.

## Dead-Letter And XACK Crash Window

The current sequence is:

1. `RedisEventDeadLetter.accept(record)` persists the record.
2. `RedisStreamsBus` calls `XACK` separately.

A crash between those operations leaves the source pending even though the dead-letter record exists.
With a newly generated `deadLetterId`, naive redelivery can append a duplicate record.

Close the window in two layers:

1. Make `EventDeadLetter.accept` idempotent by deterministic dead-letter identity. Repeated acceptance
   returns the first acceptance ID and never appends a second logical record.
2. Add a Redis-specific terminal finalizer that atomically validates the lease token, persists or observes
   the idempotent dead-letter acceptance, stores referenced evidence when needed, `XACK`s the source, and
   marks delivery metadata terminal when the source stream, group, metadata, and dead-letter store share
   Redis.

For a future dead-letter adapter outside the source Redis transaction, retain accept-before-ack. Persist
`dead-letter-pending` plus the acceptance ID so restart resumes at acknowledgement without invoking the
handler. Idempotent acceptance makes every crash point safe even though the two stores cannot commit
atomically.

Test crashes before acceptance, after evidence persistence, after record acceptance, before `XACK`, after
`XACK`, and before terminal metadata cleanup. At every point the result must be one logical dead-letter
record and either one pending recoverable source or one acknowledged source, never neither.

## API Evolution

Keep Stage 4 APIs operational while introducing the follow-up incrementally:

- Preserve `RawBus.subscribe` and `LilacBus.subscribeTopic` behavior when no retry policy is
  configured.
- Replace or extend the string-only policy return with an exhaustively checked delivery decision that can
  represent explicit retry. Existing `park-pending` retains manual semantics.
- Extend `EventDeliveryContext` with delivery identity, attempt, lease deadline, and owned abort signal for
  durable managed delivery. Tail contexts must identify that no lease exists.
- Add typed operational errors for lease loss, claim failure, retry-state failure, and terminalization
  failure. Do not place Redis driver errors or `unknown` in consumer-facing policy unions.
- Add an idempotent publish capability without changing existing non-idempotent publication or wire
  fixtures.
- Add Redis recovery APIs in a dedicated module rather than exposing `ioredis` through `LilacBus`.
- Keep handler-owned `commit()` deprecated; retry and reclamation must exist only on the transport-owned
  Result delivery path.

Expected files include changes to:

- `packages/event-bus/types.ts`;
- `packages/event-bus/raw-bus.ts`;
- `packages/event-bus/event-delivery.ts`;
- `packages/event-bus/redis-streams-bus.ts`;
- `packages/event-bus/event-dead-letter.ts`;
- `packages/event-bus/redis-event-dead-letter.ts`;
- `packages/event-bus/lilac-bus.ts`;
- a new Redis delivery-state/recovery module under `packages/event-bus/`;
- `packages/event-bus/tests/event-delivery.test.ts` and focused lease/reclamation tests;
- application-owned inbox/outbox migrations and adapters under `apps/core/src/`;
- workflow action outbox store, resolver, projector, and regression tests.

## Operational Recovery

### Operations Before This Follow-Up

Recovery is manual today. With Core's default prefix, a topic stream is
`lilac:event-bus:<topic>`; dead-letter records use
`lilac:event-bus:dead-letter:records`. This index exposes only bounded routing/recovery metadata. Complete
record and evidence keys are authenticated ciphertext, so ordinary Redis read access does not disclose
their payloads. Recovery requires both explicit access to the mode-`0600`
`DATA_DIR/secret/event-dead-letter.key` and the event-bus recovery decrypt helper. A missing or replaced
key makes retained ciphertext unrecoverable. Recovery must pass the expected `deadLetterId` and exact
record or evidence Redis key from the selected index/record context; a value copied from another key is
rejected as an authentication or context error. Back up and restore the key with the Redis retention set
and never print the key, ciphertext plaintext, or decrypted evidence to ordinary logs. Operators can
inspect controlled Redis state with commands
equivalent to:

```sh
redis-cli XPENDING 'lilac:event-bus:<topic>' '<group>'
redis-cli XPENDING 'lilac:event-bus:<topic>' '<group>' - + 100
redis-cli XRANGE 'lilac:event-bus:<topic>' '<message-id>' '<message-id>'
```

`XRANGE` exposes the original wire payload and must be restricted to approved operators; payloads must
not be pasted into ordinary logs or tickets.

An operator may transfer a selected idle entry with `XCLAIM`, inspect/read pending work as the selected
recovery consumer, deliberately re-publish it under a new audited identity, dead-letter it, or acknowledge
it. These are direct Redis interventions today, not supported Lilac recovery APIs. They require the live
consumer to be stopped or otherwise coordinated. `XACK` is destructive from the group's perspective and
must be the final step only after the chosen recovery outcome is durable.

Continuing the application, restarting it, changing `consumerId`, or running the existing
`XREADGROUP ... ">"` loop does not retry the pending entry. `XCLAIM` by itself also does not make the
existing `">"` loop invoke the application handler.

Do not use `LilacBus.retireTopicConsumerGroup` or `XGROUP DESTROY` as recovery. Before retiring a group,
operators must inventory its PEL, resolve every entry, confirm the mixed-version rollout is over, and
retain an audit record.

### Supported Operations Added By This Follow-Up

Add a payload-redacted recovery service and CLI with these fenced, audited operations:

- list groups with pending count, oldest idle age, due retries, expired leases, manual parks, and
  exhausted entries;
- inspect one delivery's envelope metadata, bounded issue summary, ownership, attempts, and timestamps;
- schedule an explicit retry under a selected policy version;
- move an entry to manual park or release a manual park into retry;
- force lease expiry only with an operator reason and confirmation of owner shutdown;
- dead-letter using the normal idempotent terminal path;
- acknowledge/drop only with a durable audit reason and elevated confirmation;
- reconcile missing PEL/metadata records in bounded batches;
- migrate selected entries to a new retry policy version;
- report whether source evidence required for recovery still exists.

Every operation must compare the observed lease token/state before mutation and write an append-only audit
record containing operator identity, delivery identity, old/new state, reason, and timestamp. The CLI must
default to read-only and require explicit confirmation for terminal actions.

Add payload-redacted metrics and alerts for PEL size, oldest pending age, active/expired leases, claim
rate, lease loss, retries by error tag, due-queue lag, exhausted deliveries, dead-letter acceptance lag,
dead-letter failures, inbox duplicate hits, outbox age, outbox attempts, and outbox exhaustion.

Document backup/restore behavior for stream keys, delivery metadata, idempotency indexes, dead-letter
records/evidence, and application inbox/outbox tables. Restoring only one side must trigger reconciliation,
not automatic acknowledgement.

## Rollout Plan

### Phase 0: Semantics And Observability

- Freeze the identity encoding, state machine, retry decision, attempt definition, and lease timing rules.
- Add current PEL metrics and a read-only inspection command before enabling claims.
- Inventory existing durable groups and manually classify every pre-existing pending entry.
- Require boot-unique owner identities for managed consumers.

### Phase 1: Delivery State And Fenced Manual Recovery

- Add durable metadata, lease scripts, heartbeat, startup reconciliation, and audit storage.
- Add supported manual claim/retry/dead-letter/ack operations.
- Keep automatic reclamation disabled.
- Prove stale owners cannot finalize after a manual claim transfer.

### Phase 2: Opt-In Automatic Reclamation

- Add durable due indexes, retry policy validation, backoff, and attempt exhaustion.
- Run the reclaimer in observe-only mode and compare proposed claims with live leases.
- Enable automatic retry for one low-risk idempotent consumer group using a new group generation.
- Keep `park-pending` excluded from automatic claims.

### Phase 3: Idempotent Dead-Letter Finalization And Publish

- Make dead-letter acceptance deterministic and idempotent.
- Add the Redis atomic dead-letter/`XACK` finalizer and crash-injection tests.
- Add idempotent publish and migrate the workflow action outbox publisher using
  `workflow_outbox_id`.
- Preserve v1 persisted dead-letter compatibility and current event wire fixtures.

### Phase 4: Transactional Inbox/Outbox Pilot

- Add the application-owned inbox schema and transaction adapter.
- Pilot it in the workflow surface-action path because `applySurfaceAction` already atomically mutates
  state and creates stable outbox rows.
- Ensure duplicate delivery returns the recorded inbox completion without applying the action twice.
- Add leased/fenced outbox publishing, durable backoff, and explicit quarantine/exhaustion.
- Prove existing progress projection and restart reconciliation still converge without duplicate cards.

### Phase 5: Consumer Migration

- Classify each durable subscriber as read-only, naturally idempotent, convergent, or transactional.
- Assign retry and exhaustion policies per closed handler error union.
- Migrate state-mutating consumers to inbox/outbox before enabling automatic reclamation.
- Use new consumer-group generations for mixed-version safety. Reconcile old PELs before calling
  `retireTopicConsumerGroup` with explicit single-version confirmation.
- Remove rollout flags only after operational recovery drills pass.

## Test Matrix

Use injected clocks and observable operations; do not synchronize tests with fixed sleeps.

Required Redis integration and application tests include:

- fresh delivery initializes one lease and one dispatch attempt;
- a heartbeating attempt is never reclaimed;
- an expired attempt is claimed once under contention;
- the old token cannot `XACK`, retry, park, or dead-letter after transfer;
- shutdown leaves unresolved work pending and recoverable;
- `park-pending` never enters the due set and is not automatically claimed;
- `XREADGROUP ... ">"` does not return an existing pending entry;
- a due retry is not invoked early and is invoked after the injected clock advances;
- deterministic jitter and persisted due time survive restart;
- Redis PEL delivery count changes do not alter the authoritative handler attempt count;
- exhaustion occurs exactly once at the configured attempt boundary;
- dead-letter retries do not increment handler attempts or invoke the handler;
- Panic and malformed handler Results still terminate/report as defects;
- crash after `XREADGROUP` but before metadata creates a reconcilable zero-attempt orphan;
- crash after attempt increment but before callback consumes one conservative attempt;
- crash after inbox/domain/outbox commit but before `XACK` deduplicates effects and acknowledges on replay;
- crash after outbox Redis append but before local publish marking returns the same stream ID;
- crash at every dead-letter acceptance/`XACK` boundary produces one logical dead-letter record;
- dead-letter evidence retention and controlled references remain available for the declared recovery
  period;
- missing source entries are quarantined rather than committed;
- two Core processes cannot publish, project, or complete the same claimed outbox row with stale tokens;
- workflow state plus outbox rollback leaves no publishable row;
- workflow restart replay retains stable outbox identity and no duplicate projection;
- group-generation rollout leaves old PEL entries visible until explicitly reconciled;
- trimming never removes source data required by a pending managed delivery;
- recovery CLI mutations are fenced, audited, payload-redacted, and read-only by default.

## Validation And Review

Each implementation phase must run:

- focused `packages/event-bus` tests and typecheck;
- focused Core inbox/outbox and workflow recovery tests and typecheck when Core changes;
- Redis integration tests with at least two consumers and injected crash points;
- architecture and lint-rule tests for new boundary, Result, and transaction adapters;
- root `bun run typecheck` and `bun run test:all` at phase boundaries;
- root `bun run lint:fix`, `bun run fmt`, `bun run lint`, `bun run fmt:check`, and `git diff --check`;
- an independent correctness review focused on stale ownership, ambiguous crash points, destructive
  recovery, and unsupported exactly-once claims;
- an operational recovery drill against disposable Redis and SQLite data before enabling automatic
  claims in production.

## Exit Criteria

This follow-up is complete only when:

1. Managed retries use a separate explicit decision; `park-pending` remains manual in API, storage,
   tests, and operator documentation.
2. Expired pending entries are reclaimed only after a fenced lease transfer, and a stale owner cannot
   finalize them.
3. Retry due times, handler attempts, dead-letter attempts, policy versions, and exhaustion are durable
   and restart-safe.
4. PEL delivery count is not presented as handler attempt count.
5. The Redis dead-letter/`XACK` crash window is covered by idempotent acceptance and atomic Redis
   finalization, with a safe resume path for external adapters.
6. Producer retries with one idempotency key return one stream entry.
7. The inbox transaction proves no duplicate durable domain effect across commit-before-ack crashes.
8. Outbox publication is leased, fenced, idempotent, backoff-controlled, and recoverable after restart.
9. Existing workflow state/outbox/projection rollback, replay, and convergence tests still pass.
10. Operators can inspect and resolve pending, exhausted, and dead-letter-pending entries without raw
    payload logging or direct unaudited Redis mutation.
11. Mixed-version group migration and legacy PEL reconciliation are documented and tested.
12. No documentation claims that `XREADGROUP ... ">"` retries pending entries or that this design offers
    general exactly-once external side effects.
