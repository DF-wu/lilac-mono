# Surface Adapter Contract Readiness Todo

Source: `plan/surface-adapter-contract-readiness.md`

## Stage 1: Canonical Types And Operation Algebra

- [x] Add the session/message platform-set equality assertion and contract test.
- [x] Define the closed surface operation and error unions.
- [x] Include detailed reactions, session participants, invalid input, and partial completion.
- [x] Add compile-time contract fixtures without changing production adapter signatures.
- [x] Run focused tests, Core typecheck, lint/fmt, and independent review.

## Stage 2: Discord And GitHub Adapter Normalization

- [x] Migrate all Discord operations and nested refs to the canonical contract.
- [x] Migrate all GitHub operations to the canonical contract.
- [x] Atomically migrate the base interface, both adapters, callers, and test fakes.
- [x] Separate adapter-event ingress subscription from the base adapter contract.
- [x] Move supported GitHub CRUD and detailed reaction behavior behind GitHub adapter operations.
- [x] Use typed unsupported Results instead of no-ops, empty successes, or private error channels.
- [x] Add deterministic Discord/GitHub SDK failure-classification tests.
- [x] Run focused tests, Core typecheck, lint/fmt, and independent review.

## Stage 3: Descriptor-Bound Produced-Ref Guards

- [x] Add the descriptor-bound guarded facade for all shared production callers.
- [x] Guard session lists, reads, lists, reply contexts/chains, partial completion, outputs, and tool refs.
- [x] Guard workflow send results, snapshot collection, and relay restore refs.
- [x] Register and test exact adapter contract-defect Panic sites.
- [x] Remove duplicated protocol-specific produced-platform checks.
- [x] Run focused tests, Core typecheck, architecture checks, lint/fmt, and independent review.

## Stage 4: Registry-Selected Surface Tools

- [x] Inject a registry-derived adapter resolver into the surface tool.
- [x] Route generic session, message, and reaction operations through adapters.
- [x] Remove GitHub REST operation imports and branches from the generic tool.
- [x] Preserve Discord authorization, aliases, and sidecars as protocol-owned adapters.
- [x] Preserve shared discovery queries while keeping Discord indexing/storage outside the descriptor.
- [x] Narrow help and executable adapter resolution without narrowing compatible persistence readers.
- [x] Run focused tool/MCP tests, Core typecheck, architecture checks, and lint/fmt. Parent review remains independent.

## Stage 5: Authenticated Origin And Principal Consistency

- [x] Add the mapped internal authenticated-origin union.
- [x] Preserve current Discord/GitHub raw wire inputs and fixtures.
- [x] Dead-letter malformed or conflicting actor/origin/header identities.
- [x] Correlate active-relay events and terminal lifecycle cache entries by exact `(requestId, platform, sessionId)`, including terminal-before-relay ordering; dead-letter mismatches before relay or cache mutation.
- [x] Bind request-cache origin and request-control capability identity.
- [x] Propagate the validated identity through tool, plugin, workflow, and subagent contexts.
- [x] Implement the explicit safety-mode precedence without changing current Discord/GitHub behavior.
- [x] Run focused cache/control/runner/plugin tests, typechecks, architecture checks, and lint/fmt. Parent review remains independent.

The runner is the sole request-cache writer. After all bus entries are acknowledged and all queue/run owners finish, request-ID reuse starts a new in-process lifecycle; this relies on globally unique request IDs and adds no persisted identity contract. Queue cancellation and buffered absorption retain delivery-keyed progress while parked, release each removed entry only after its cancellation publication succeeds, and resume without repeating accepted lifecycle or agent-control effects. The cache retains the complete set of parked event IDs, so resolving one PEL entry cannot release a lifecycle that still has another pending delivery.

## Stage 6: Workflow Port And Durable Correlation

- [x] Generalize partial-send recovery without a GitHub conditional type.
- [x] Consume adapter operation Results in both workflow progress ports.
- [x] Separate permanent descriptor failures from retryable protocol failures.
- [x] Validate durable binding, action, origin, target, actor, and ref correlation.
- [x] Preserve repair, authorization, and transactional outbox behavior.
- [x] Run focused workflow tests, Core typecheck, architecture checks, and lint/fmt. Parent review remains independent.

Permanent workflow-port failures are stored on the surface binding with the exact target snapshot and adapter contract/policy revision. Matching event, retry, outbox, and startup paths perform no provider operation; target repair or a reviewed revision bump atomically clears the gate and revokes stale actions before fresh controls are rendered. Independently selected cross-session and cross-platform progress targets remain readable and operable; actions additionally require a transferable origin platform/user identity and exact target/binding/message correlation. Schema v25 adds the nullable gate column, migrates existing rows without rewriting them during decode, retains a v24 codec default, and rejects retry-only permanent reasons. The port failure contract is a disposition-discriminated union, and descriptor guards reject forged reason/disposition pairs and non-integer Retry-After values before projector policy. Persisted retry deadlines gate every projection path and remain integral; rate-limit deadlines honor the greater of bounded local backoff and provider delay, while provider and host timer delays are capped at 24 hours. Startup reconciliation synchronously processes at most one 1,000-row batch, then an owned, supervised concurrency-one drain continues the stable `(updated_at, run_id)` keyset so binding mutations cannot starve later rows. The drain advances its owned position only after a page completes; ordinary failures retain that position and retry with exponential 1-second to 60-second backoff, while Panic reports once without retry. Manual reconciliation cancels a pending retry and resumes the same position without overlapping an active drain. Matching current permanent gates are skipped before projection, while changed revisions remain eligible through the shared revision rule. Shutdown cancels retry timers, stops new pages, awaits an in-flight provider operation, and prevents its completion from scheduling new work. Populated v24 migration and direct binding/action rollback fixtures cover the persistence transitions. The shared Discord/GitHub contract suite, full repository tests/typecheck, architecture checks/tests, root lint fix/format, and final diff check pass.

## Stage 7: Versioned Recovery Hardening

- [x] Add centralized relay snapshot correlation decoding.
- [x] Add snapshot v3 with required `requestClient`.
- [x] Normalize missing legacy request clients to relay platform and retain v1/v2 fixtures.
- [x] Define explicit unavailable descriptor/relay restore behavior.
- [x] Preflight complete snapshots and add paused apply/rollback/activation restore-attempt handles.
- [x] Roll back partial relay application before agent restore and supervise rollback failure.
- [x] Persist and restore parked queued-cancellation and buffered-absorption attempt state, PEL delivery identity, queue reservations, `controlApplied`, and partial lifecycle-publication progress; restore reservations before queue drain or fail-safe exclude affected entries until PEL recovery so process replacement cannot duplicate effects or run cancelled work.
- [x] Persist and restore normalized actor, origin, GitHub target/trigger, delegated authority, verified-ingress, and safety evidence through the shared live-ingress semantic policy; recompute current safety and keep delegated/legacy recovery restricted unless durable authority proves otherwise.
- [x] Keep paused ownership through every later fallible startup, compare-and-delete the exact restorable row as the final startup transition, and then perform total synchronous activation; conditionally consume empty/stale rows after classification.
- [x] Retain unavailable and failed-restoration snapshots.
- [x] Define row dispositions for every load, decode, staleness, and SQLite outcome.
- [x] Preserve transcript and Discord primary-continuation compatibility.
- [x] Add current-version and legacy snapshot/restore fixtures and process-replacement tests covering parked attempts, both `controlApplied` states, partial lifecycle publication, delegated/authenticated identity, verified ingress, restricted legacy fallback, cache/registry re-admission, and pre-Level-2 restore ordering.
- [x] Run focused restart/transcript tests, Core/root typechecks, architecture checks/tests, root lint/fmt, and diff check. Parent review remains independent.

Snapshot v3 requires correlated relay clients, exact decoded authentication evidence, typed workflow delegation proof, stable queue-entry IDs, globally unique PEL event IDs, validated queue topology, and top-level queue-attempt state. Legacy v1/v2 rows migrate in memory without rewrite and default relay clients from their platform; active-only state restores principal-less and restricted, while any queued entry remains retained because reservation absence cannot be proven. Recovery reads an immutable row token, preflights every relay plus every agent-required surface, constructs output streams, hydrates restored presentation state locally, and starts subscriptions behind paused gates. Paused admission performs no provider push, typing, acknowledgement, or bus publication; Discord may decode refreshed output configuration but defers presence mutation to a normal output/config path. Workflow-authority, cache, and queue admission remain rollbackable. A runner activation-or-stop gate releases retained callbacks before subscription shutdown can wait for them. Every later runtime startup completes while ownership remains rollbackable. The final transition compare-and-deletes the exact row, synchronously restores the Discord router's validated active output-chain state, and immediately opens all relay and agent gates through an idempotent state flip; no Result, promise, provider operation, or awaited startup follows. Router seeding occurs before recovered queue drain, emits no restored output-created events, and is absent on pre-consume rollback. The router retains bounded exact terminal lifecycle tombstones without time expiry while activation is pending, so a terminal-before-activation race cannot resurrect a completed chain after a long startup. Only a matching `(requestId, platform, sessionId)` suppresses seeding, conflicting known routes fail closed, and capacity overflow suppresses every chain in that explicit recovery generation without evicting a relevant key. Generation finalization clears pending tombstones and overflow while retaining weak idempotence for repeated activation; an explicit new running lifecycle preserves ordinary request-ID reuse. Conflict or later startup failure rolls back every admitted resource in reverse order while retaining the row. Direct multi-relay restore also cleans partial application in reverse and raises the registered Panic if cleanup leaves atomicity unknown. Queue-attempt redelivery additionally requires the exact persisted event and control route before touching reserved targets. Unavailable, malformed, corrupt, unsupported, read-failed, apply-failed, conflicting-replacement, and fail-safe incomplete-control rows remain retained.

## Stage 8: Shared Contract Harness And Documentation

- [x] Run one parameterized adapter/descriptor harness against Discord and GitHub.
- [x] Cover lifecycle, relay, operation, workflow, recovery, and cleanup contracts.
- [x] Keep protocol integration tests deterministic and credential-free.
- [x] Update project, architecture, and tool documentation.
- [x] Run `bun run test:all`.
- [x] Run `bun run typecheck`.
- [x] Run `bun run lint:architecture`, `bun run test:architecture`, and `bun run typecheck:architecture`.
- [x] Run `bun run lint:fix`.
- [x] Run `bun run fmt` and `bun run fmt:check`.
- [x] Run `git diff --check`.
- [x] Complete independent final review.

Stage 8 implementation, validation, and independent parent review are complete. No nested reviewer was
used as the acceptance review.
