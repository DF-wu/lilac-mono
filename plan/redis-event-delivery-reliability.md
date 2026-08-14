# Redis Event Delivery Reliability

## Status

This is the active implementation plan for replacing durable Redis event delivery with one managed
delivery path. The boundary contracts summarized in `PROJECT.md` remain the starting point: complete
event decoding, typed handler Results, transport-owned acknowledgement, and explicit delivery
dispositions are already implemented.

This is a clean cut. The new path handles only events delivered to new versioned consumer groups after
the rollout. Existing streams, consumer groups, pending entries, delivery history, and v1 dead-letter
records are not migrated, reclaimed, or read by the new path.

## Scope

The implementation covers:

- leased ownership and stale-owner fencing for every `work` and `fanout` delivery;
- automatic reclamation after process loss;
- explicit durable retry scheduling and attempt exhaustion;
- atomic Redis dead-letter persistence, source acknowledgement, and metadata cleanup;
- safe stream retention for managed durable topics;
- graceful shutdown that leaves unresolved delivery pending and recoverable; and
- focused Redis integration tests for crash and contention boundaries.

The implementation does not include:

- legacy PEL reconciliation or replay;
- operator recovery APIs, a CLI, audit records, or mutation recipes;
- producer idempotency or publication deduplication;
- a SQLite inbox or outbox;
- workflow persistence, projector, or multi-process ownership changes;
- new delivery metrics or transition logs;
- Redis Cluster support;
- generic or external dead-letter adapters; or
- general exactly-once effects.

Core changes are limited to event-bus composition, API adaptation, and regression tests. No Core stored
data contract changes as part of this plan.

## Current Baseline

- `work` and `fanout` use Redis consumer groups and read only never-delivered entries with
  `XREADGROUP ... STREAMS <stream> ">"`.
- `tail` uses non-durable cursor reads and has no PEL.
- `park-pending` leaves a durable entry in the PEL without scheduling retry.
- Restarting a consumer or changing `consumerId` does not reclaim a pending entry.
- Redis PEL ownership does not fence an old process after ownership changes.
- Dead-letter acceptance and source `XACK` are separate operations.
- Durable reads may reserve a batch and invoke handlers sequentially.
- Publisher-provided approximate `MAXLEN` and output-stream expiry can remove source bodies independently
  of a durable group's pending frontier.

## Delivery Contract

### Modes

- Every `work` and `fanout` subscription uses managed delivery. There is no feature flag, alternate
  unmanaged durable path, or per-subscription lease policy.
- `tail` remains non-durable and keeps its existing cursor, ordering, and stop behavior.
- Ephemeral `work` and `fanout` groups use managed delivery while alive and retain destructive group
  cleanup on graceful stop.

### Clean Cut

- The transport derives a versioned physical group name from mode and logical `subscriptionId`.
- A physical group that does not exist is created at `$`.
- Durable subscriptions do not accept a beginning or cursor offset.
- Old unversioned groups and their PELs remain untouched and are outside the new transport contract.
- The new delivery-state and dead-letter key namespaces are versioned independently from old keys.

### Handler Outcomes

Managed durable handlers can produce:

- `commit`: acknowledge and remove delivery metadata atomically;
- `retry`: schedule the next attempt durably;
- `park-pending`: remove automatic scheduling while retaining the source in the PEL;
- `dead-letter`: persist one terminal record and acknowledge atomically; or
- `stop`: stop the subscription while retaining the current source in the PEL.

`park-pending` remains distinct from retry. There is no supported bus mutation API for a parked entry.
Redis reads may be used for inspection, but direct Redis mutations bypass delivery fencing and are outside
the bus guarantee.

Tail handlers do not support retry. A tail outcome that requires durable parking stops the tail instead.

Throws, malformed Results, and Panics remain defects. They are reported through the existing fatal
boundary and are not converted into ordinary retries.

## Fixed Policy

All managed groups use one package-owned policy:

- lease duration: 60 seconds;
- heartbeat interval: 15 seconds;
- maximum handler dispatch attempts: 5;
- initial retry delay: 1 second;
- retry multiplier: 2;
- maximum retry delay: 60 seconds;
- deterministic bounded jitter;
- exhaustion action: dead-letter; and
- durable read count: 1.

A live handler can heartbeat indefinitely. The bus imposes no execution timeout; handlers own any
operation-specific timeout and must observe the owned `AbortSignal` when their effects can be cancelled.

Fresh entries may continue while an older entry waits for retry. Managed delivery therefore preserves
throughput but does not promise strict ordering across retries.

## Guarantees And Limits

1. Every managed invocation has a delivery identity, one-based durable attempt number, random lease
   token, owner identity, and lease deadline.
2. Only the current lease token can heartbeat, commit, retry, park, stop, or terminalize the delivery.
3. Lease loss aborts the attempt signal. A later result from that stale attempt cannot acknowledge or
   mutate delivery state.
4. A due retry or expired in-flight delivery is claimed by at most one contender before invocation.
5. Retry due time and attempt count survive process restart.
6. Redis PEL delivery count is diagnostic only and is never used as the handler attempt count.
7. The sixth invocation never occurs. A fifth retry result or an expired fifth attempt transitions to
   dead-letter handling.
8. Dead-letter persistence, source `XACK`, and delivery-metadata deletion share one Redis atomic
   transition.
9. Successful commit performs source `XACK` and delivery-metadata deletion atomically.
10. Shutdown does not acknowledge, reschedule, or terminalize unresolved work merely to clean up.
11. Stream trimming cannot remove a body required by a managed pending delivery.
12. Ordinary logs do not include payloads or dead-letter evidence.

The transport is at-least-once. A handler that completed an external effect before an ambiguous crash may
run again. Handlers own idempotency for external effects. This plan does not claim exactly-once execution.

## Identity And Keys

Identity encodings are explicitly versioned and use canonical length-delimited input before hashing.

- Transport identity: stream key plus Redis stream entry ID.
- Delivery identity: transport identity plus versioned physical consumer-group name.
- Lease identity: delivery identity plus a random token and boot-unique owner ID.
- Dead-letter identity: deterministic digest of the delivery identity and terminal contract version.

For each stream and versioned physical group, Redis stores:

- delivery state and authoritative attempt count;
- current owner, consumer, lease token, and lease deadline;
- persisted retry due time;
- bounded final error classification needed for exhaustion; and
- temporary encrypted dead-letter material awaiting atomic finalization.

Lease deadlines and due times use Redis server time. Scripts validate key types and exact state before
mutation. Standalone Redis is the supported topology; cluster hash-slot design is outside scope.

Terminal delivery metadata is deleted in the same transition that acknowledges the source. No terminal
delivery history or audit log is retained by the managed-delivery subsystem.

## State Machine

Managed delivery states are:

- `in-flight`;
- `retry-scheduled`;
- `parked-manual`; and
- `dead-letter-pending`.

Transitions that combine lease validation with PEL ownership, due-index changes, `XACK`, dead-letter
persistence, or metadata cleanup run in Lua.

### Fresh Delivery

1. Read one entry with `XREADGROUP ... COUNT 1 ... ">"`.
2. Initialize its metadata, attempt 1, owner, token, and lease before invoking the handler.
3. Start heartbeating at the fixed interval.
4. Apply the handler outcome only if the token remains current.

### Retry

1. Validate the current token and state.
2. Persist one absolute due time derived from Redis time, delivery identity, and completed attempt.
3. Remove active lease ownership and add the delivery to the due index.
4. Continue polling fresh work.
5. When due, atomically claim PEL ownership, install a new token and lease, increment the attempt, and
   invoke once.

### Abandoned Delivery

- An expired `in-flight` lease is an ambiguous completed attempt.
- A contender atomically transfers PEL ownership and installs a new token.
- If another attempt remains, it increments the attempt and invokes the handler.
- If the expired attempt was attempt 5, it transitions directly to dead-letter exhaustion.
- A PEL entry without metadata in a versioned new group represents a crash between `XREADGROUP` and
  initialization. It is reconstructed as a zero-attempt orphan and claimed before its first invocation.

### Parking And Stop

- `park-pending` clears lease and retry scheduling while retaining metadata and the PEL entry.
- `stop` terminates the subscription without acknowledging. The current lease is allowed to expire so
  another process can reclaim it.
- Parked entries are never selected by automatic reclamation.

### Shutdown

- Stop fresh reads and recovery claims.
- Abort active attempt signals.
- Stop heartbeat work.
- Perform bounded connection and consumer cleanup.
- Leave unresolved managed entries in the PEL.
- Ephemeral groups retain their existing explicit destructive cleanup contract on graceful stop.

## Dead-Letter Contract

The old record contract is replaced rather than migrated. The new codec reads and writes only the new
record version under a new Redis key namespace.

A managed dead-letter record includes:

- deterministic dead-letter ID;
- source topic, stream ID, physical group, and mode;
- final handler attempt and fixed maximum attempts;
- bounded contract-invalid, handler-error, or attempts-exhausted reason;
- timestamp from Redis server time; and
- bounded inline or controlled-reference source evidence.

Complete records and copied evidence remain AES-256-GCM envelopes with random nonces and identity-bound
authenticated additional data. The index remains payload-free.

For managed delivery, the Redis transport owns finalization. It prepares encrypted terminal material and
passes it to one script that:

1. validates the lease token and state;
2. stores or observes the deterministic dead-letter record and evidence;
3. updates the bounded payload-free dead-letter index;
4. acknowledges the source entry; and
5. deletes all active and terminal delivery metadata.

Retrying this transition after an ambiguous client response cannot create a second logical record.

Tail dead-lettering uses the same new Redis store but has no lease or `XACK` transaction.

## Retention

- Remove the publisher-facing approximate `MAXLEN` hint from the active bus contract.
- Managed durable topics must not use whole-stream expiry.
- Output streams may keep their current expiry only while they remain tail-only; durable subscription to
  an expiring output topic fails before group creation.
- Existing acknowledged-prefix and checkpoint trimming remain the supported stream cleanup paths and
  must preserve every managed PEL frontier.
- Missing source bodies in a managed new group are treated as transport corruption, never as success.

## Expected Files

Primary implementation files:

- `packages/event-bus/types.ts`;
- `packages/event-bus/raw-bus.ts`;
- `packages/event-bus/event-delivery.ts`;
- `packages/event-bus/event-dead-letter.ts`;
- `packages/event-bus/redis-event-dead-letter.ts`;
- `packages/event-bus/redis-streams-bus.ts`;
- `packages/event-bus/lilac-bus.ts`;
- a new managed-delivery Redis module under `packages/event-bus/`;
- `packages/event-bus/index.ts`; and
- focused event-bus tests.

Integration changes may include Core runtime composition, event-bus test doubles, `PROJECT.md`,
`MIGRATIONS.md`, and exact architecture-manifest registrations. They must not add a Core persistence
migration or application inbox/outbox subsystem.

## Test Matrix

Tests use observable operations and controlled Redis state rather than fixed waits.

Required coverage includes:

- versioned groups begin at `$` and ignore old stream entries and old groups;
- durable reads use `COUNT 1`;
- fresh delivery initializes one lease and attempt 1;
- heartbeat preserves ownership for an arbitrarily long live handler;
- expired work is claimed once under contention;
- stale tokens cannot commit, retry, park, or dead-letter;
- lease loss aborts the owned signal;
- retry due time is persisted and not recomputed after restart;
- fresh entries continue while a retry is not due;
- deterministic jitter is stable for one delivery and attempt;
- attempts increment only immediately before invocation;
- PEL delivery count does not change the authoritative attempt count;
- attempt 5 exhaustion produces one dead-letter and no sixth invocation;
- parked entries never enter the due index and are never reclaimed;
- stop and shutdown leave unresolved durable work pending;
- a crash after `XREADGROUP` but before initialization creates a recoverable zero-attempt orphan;
- commit atomically acknowledges and removes metadata;
- every dead-letter crash boundary yields one record and one acknowledged source or one recoverable
  pending source, never neither;
- missing managed source bodies fail closed;
- unsafe retention and durable output-stream subscriptions are rejected;
- acknowledged-prefix trimming preserves managed pending source bodies;
- ephemeral groups retain managed runtime delivery and destructive graceful cleanup;
- tail behavior and ordering remain unchanged; and
- Panic and malformed handler Results remain defect-supervisor events.

## Validation

Implementation must run:

- focused `packages/event-bus` tests and typecheck;
- focused Core tests and typecheck for API/composition changes;
- Redis integration tests with at least two consumers and injected crash points;
- architecture and lint-rule tests for changed Result, decoder, and exception boundaries;
- root typecheck and full tests at the completed boundary;
- lint, format, and `git diff --check`; and
- an independent correctness review focused on stale ownership, ambiguous Redis responses, trimming,
  shutdown, and unsupported exactly-once claims.

## Exit Criteria

1. Every new durable group uses the versioned managed path without a feature flag.
2. Old stream entries, groups, PEL entries, and v1 dead-letter records are not consumed or migrated.
3. A stale owner cannot acknowledge or mutate a transferred delivery.
4. Abandoned entries recover automatically and retry scheduling survives restart.
5. The fixed attempt budget terminates exactly once through Redis dead-lettering.
6. Dead-letter persistence and source acknowledgement have one Redis atomicity boundary.
7. Commit acknowledgement and metadata deletion have one Redis atomicity boundary.
8. Managed pending source bodies cannot be removed by supported retention paths.
9. Tail delivery remains non-durable and does not gain retry.
10. No producer idempotency, SQLite inbox/outbox, workflow persistence change, operator subsystem, audit
    store, or metrics subsystem is introduced.
11. Documentation claims at-least-once delivery and does not claim exactly-once external effects.
