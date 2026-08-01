# Claude Code Native Session Continuation Implementation Todo

Companion tracker for `plan/claude-code-native-session-continuation.md`.

## Working Rules

- Implement and verify one stage before enabling the next.
- Run a review agent at each stage boundary.
- Fix review findings required for correctness, safety, or the stage ship gate.
- Preserve the agreed plan and product decisions over optional review suggestions.
- Record non-blocking residual issues under Deferred rather than expanding scope.
- Do not enable persistent native continuation until the Stage 0 foundation passes.

## Stage 0: Canonical And Retry Foundation

Status: completed.

- [x] Latch provider-executed external tool activity synchronously at execution entry.
- [x] Split canonical full-view preparation, ephemeral overlays, and final payload decoration.
- [x] Select compaction suffixes on canonical turn boundaries.
- [x] Persist only the Lilac summary plus the untouched canonical suffix after compaction.
- [x] Include ephemeral overlays in full-budget estimates without persisting or summarizing them.
- [x] Move Mini `<session-todos>` generation into the ephemeral-overlay hook.
- [x] Move Mini Codex item-ID sanitation into final payload decoration.
- [x] Move Core Anthropic message cache metadata into final payload decoration.
- [x] Add the post-compaction, pre-provider-call runtime preparation seam.
- [x] Add Stage 0 regression tests for canonical preservation, overlay budgeting, seam ordering, and
      retry safety.
- [x] Run focused Agent, Mini, and Core tests and package typechecks.
- [x] Run a Stage 0 review agent and resolve correctness blockers.
- [x] Pass the Stage 0 foundation gate.

## Stage 1: Shared Contracts And Text Replay

Status: completed. Covers implementation-order items 2, 7, and 8.

- [x] Add shared versioned canonical-head hash utilities and golden fixtures.
- [x] Add shared versioned execution-scope hash utilities and golden fixtures.
- [x] Add provider-family classification and committed-head provider state.
- [x] Implement deterministic plain-text boundary projection.
- [x] Implement exact `<historical-tool-activity>` lowering, bounds, outcomes, and XML escaping.
- [x] Keep projection as a model-facing-only helper; production selection belongs to Stages 3, 5,
      and 7 after durable provider-state lookup exists.
- [x] Verify projected payloads contain no hidden reasoning, provider metadata, binary payload, or
      structured tool protocol.
- [x] Run a Stage 1 review agent and resolve correctness blockers.

## Stage 2: Claude Bridge And Attempt Runtime

Status: completed. Covers implementation-order items 3 through 6.

- [x] Add typed `ephemeral`, `fresh`, and `fork` Claude materialization.
- [x] Capture requested, init, and result native session IDs.
- [x] Capture live terminal context usage and authoritative session information.
- [x] Validate candidate and unchanged source sessions during finalization.
- [x] Add replaceable Claude attempt runtime ownership and disposal.
- [x] Set AI SDK internal retries to zero for persistent Claude attempts.
- [x] Rematerialize safe retries from the unchanged clean base.
- [x] Add full-budget versus suffix-payload selection and native cursors.
- [x] Keep persistence feature-disabled until a durable binding owner is integrated.
- [x] Run a Stage 2 review agent and resolve correctness blockers.

## Stage 3: Mini Main Continuation

Status: completed. Covers implementation-order items 9 through 11.

- [x] Add Mini provider-state, native-binding, and native-attempt schema migration.
- [x] Add startup recovery and transactional store APIs.
- [x] Integrate fresh, fork, and text-replay selection for Mini main sessions.
- [x] Promote bindings transactionally with committed terminal history states.
- [x] Bind exact Mini history states for undo, redo, and branching.
- [x] Verify model and effort changes preserve compatible native bindings.
- [x] Run a Stage 3 review agent and resolve correctness blockers.

## Stage 4: Mini Named Continuation

Status: completed. Covers implementation-order item 12.

- [x] Integrate one current clean binding per named child session.
- [x] Add fresh, fork, and text-replay selection for named children.
- [x] Verify parent history navigation does not rewind named children.
- [x] Run a Stage 4 review agent and resolve correctness blockers.

## Stage 5: Core Named Continuation

Status: completed. Covers implementation-order item 13.

- [x] Add Core committed-head provider metadata.
- [x] Add named-subagent binding and bounded-attempt persistence.
- [x] Integrate exact canonical head selection and scope validation.
- [x] Add canonical-first transcript verification and CAS promotion.
- [x] Keep generic runs without stable continuation identity fresh-only.
- [x] Run a Stage 5 review agent and resolve correctness blockers.

## Stage 6: Core Primary Lineage

Status: complete. Covers implementation-order items 14 through 17.

- [x] Add immutable first-seen surface projections and owned attachment/blob references.
- [x] Add the runtime-validated first-class lineage-manifest bus contract.
- [x] Preserve and emit complete versioned lineage segments during composition.
- [x] Add request, checkpoint, synthetic, and surface atoms.
- [x] Add rolling prefix hashes and complete-segment boundaries.
- [x] Keep Core primary continuation fresh-only until the complete substrate passes.
- [x] Run a Stage 6 review agent and resolve correctness blockers.

## Stage 7: Core Primary Continuation And Selection

Status: completed. Covers implementation-order items 18 through 20.

- [x] Integrate Core primary fresh, fork, and text-replay selection.
- [x] Require exact complete-segment prefix matching; mismatch starts fresh.
- [x] Add canonical-first promotion and output-link reachability behavior.
- [x] Queue model-changing overrides instead of steering an incompatible active runtime.
- [x] Keep automatic fallback within its runtime-compatible provider family.
- [x] Run a Stage 7 review agent and resolve correctness blockers.

## Stage 8: Retention, Documentation, And Release

Status: completed. Covers implementation-order items 21 through 23.

- [x] Bound terminal attempts and current Mini named/Core bindings, retain Mini main historical
  bindings with retained history states (which may grow), and add conservative orphan diagnostics.
- [x] Update config examples, migration notes, provider/storage documentation, and plan references.
- [x] Run all package tests and typechecks.
- [x] Run root lint, format, typecheck, and full tests.
- [x] Run the authenticated validation matrix where credentials are available.
- [x] Run final code, retention, and documentation reviews and resolve release-blocking issues.

## Validation Log

- 2026-07-31: Initial code audit completed. Stage 0 is required before persistence work.
- 2026-07-31: Stage 0 canonical/model-view separation, overlays, final decoration, canonical-boundary
  compaction, and pre-call runtime preparation implemented and package-validated. Review/gate pending.
- 2026-07-31: Stage 0 review found and resolved generated server-compaction replay activation,
  retry-latch reset timing, and restored auto-continue preflight blockers. Foundation Gate passed.
- 2026-07-31: Stage 1 shared hashes, provider-state contracts, and bounded XML text replay implemented,
  hardened through review, and package-validated. Pure utility gate passed; product wiring remains in
  the owning Mini/Core stages.
- 2026-07-31: Stage 2 native fresh/fork lifecycle, live observations/finalization, replaceable attempt
  ownership, retry rematerialization, exact prefix cursors, and native occupancy budgeting substrate
  implemented and review-gated. Persistence and product wiring remain disabled until Stage 3.
- 2026-08-01: Stage 2 native observations gained per-call init/result freshness fencing, and the
  feature-disabled compaction substrate gained a validated native-occupancy estimate floor plus owner
  helper. Follow-up review and validation passed before Stage 3 began.
- 2026-08-01: Stage 3 Mini schema v7, conservative provider-head metadata, exact-state bindings,
  bounded attempts, startup uncertainty recovery, pre-call fresh/fork selection, cross-family text
  replay, canonical-first CAS promotion, restart continuation, and undo/redo/branch selection were
  implemented and independently review-gated. Review blockers for interruption retirement, exact
  canonical cursor promotion, compaction replay boundaries, steering promotion, observability
  degradation, execution scope, run ownership, and pending-finalization recovery were resolved.
  Mini's 354 tests, root/workspace tests, root/workspace typechecks, lint, formatting, and local lint
  rule tests all passed. Stage 3 is complete; Stage 4 remains intentionally disabled.
- 2026-08-01: Stage 4 implementation added schema v8 current named-child bindings and bounded
  attempts, explicit named-only fresh/fork/text-replay selection, canonical-verified CAS promotion,
  startup uncertainty handling, restart continuation, and parent-history independence. Targeted
  review blockers added canonical count/hash and stale-revision CAS coverage, direct v7 migration
  coverage, and succeeded pending-recovery parity with Mini main after canonical verification. Mini's
  366 tests and package typecheck passed; final focused review validation reported 55 passing tests,
  with lint, formatting, and diff checks clean. Final independent review found no blockers, and Stage
  4 is complete. Authenticated coverage remains in the Stage 8 release matrix.
- 2026-08-01: Stage 5 implementation added versioned Core transcript migration and provider-head
  metadata, explicit delegation-owned stable-name eligibility, exact request-client/session/provider
  bindings, bounded attempts with startup uncertainty and pending-success recovery, fresh/fork/text
  replay selection, native occupancy budgeting, and canonical-first run-owned CAS promotion. Focused
  post-format validation passed 217 store, runner-contract, delegation, and workflow tests; Core's
  build and full 1,381-test suite passed, as did repository-wide typecheck, lint, formatting, and diff
  checks. Stage 5 review and authenticated validation remain pending.
- 2026-08-01: Stage 5 independent review required five correctness fixes. Stable named lookup now
  rejects unmarked and cross-client transcripts; mixed/cross-family/legacy replacement prefixes
  remain text-lowered after compaction; cancellation is re-fenced through native finalization and
  immediately before durable success/CAS; fresh and forked candidates budget from their current live
  native cursor without synchronized-prefix double counting; and execution scope includes normalized
  direct-tool, subagent-depth/config/safety, and external/MCP authority. The five focused regressions
  passed within a 156-test post-format suite. Core's build, typecheck, and full 1,386-test suite passed,
  along with repository-wide typecheck, lint, formatting, and diff checks. Review remains unchecked
  pending the stage-boundary follow-up.
- 2026-08-01: Stage 5 boundary follow-up resolved the final correctness blockers. A newly forked
  candidate now uses the compatible persisted binding occupancy before candidate materialization and
  until live usage arrives, then uses its current native cursor without double-counting synchronized
  history. Core Claude success now
  saves an unmarked recovery transcript, finalizes native state, rechecks cancellation, and atomically
  publishes provider/head metadata with the succeeded attempt before CAS promotion; interrupted active
  attempts remain unmarked and pending published successes remain restart-promotable. Forced-rollback,
  crash-recovery, finalization-cancellation, and fork-occupancy regressions passed within a 158-test
  focused suite. Core's build and full 1,388-test suite passed, as did repository-wide typecheck, lint,
  formatting, and diff checks. Stage 5 remains in progress with review unchecked pending final review
  and authenticated validation.
- 2026-08-01: Stage 5 final independent review found no blockers. Resolved review themes covered exact
  marked/client-scoped head selection, replacement-safe cross-family text replay, complete direct-tool
  and subagent execution-scope authority, live and pre-materialization native occupancy without prefix
  double-counting, cancellation fencing through native finalization, and crash-safe atomic success
  publication before CAS promotion. Final focused review validation passed 224 Core tests and 38 Claude
  bridge tests. Core's build and full 1,388-test suite passed, along with repository-wide typecheck,
  lint, formatting, and diff checks. Stage 5 is complete; authenticated validation remains in Stage 8.
- 2026-08-01: Stage 6 composition/transport integration now admits immutable Discord projections and
  owned attachment blobs, preserves synchronized segment boundaries, emits aligned surface/request/
  checkpoint lineage, validates proof and durable references at runner intake, carries explicit
  complete/fresh-only state through queue and restart paths, and persists primary provider metadata
  plus valid request manifests while keeping Core primary Claude ephemeral. Focused Stage 6 tests,
  the 1,401-test Core suite/build, 33 event-bus tests, repository typecheck, lint, formatting, and diff
  checks passed. Stage 6 remains in progress pending its review agent.
- 2026-08-01: Stage 6 final independent review passed after resolving the remaining blockers. Lineage
  segments now enforce exact semantic forms and globally non-overlapping claims; split Discord output
  aliases are immutable, scoped, first-writer-linked request metadata with durable schema-v3
  reachability; merged bot chunks preserve every distinct request transcript; cross-scope request and
  checkpoint expansion fails closed; missing provider history remains conservative; and attachment
  ownership applies aggregate composition limits before blob writes with unreferenced cleanup. Final
  validation passed all 1,405 Core tests, all 34 event-bus tests including the 6 focused lineage tests,
  the Core remote-runner build, package and repository typechecks, lint, formatting, and diff checks.
  Stage 6 is complete; authenticated Discord/media validation remains in the Stage 8 release matrix.
- 2026-08-01: Stage 7 implementation added distinct schema-v4 Core-primary bindings and bounded
  attempts, startup uncertainty and pending-success recovery, exact complete-segment selection,
  fresh/fork/text-replay primary runtime ownership, canonical-first request-atom publication, and
  run-owned head/revision CAS promotion independent of output IDs. Core now queues incompatible
  active model/effort selections and filters automatic fallback to the latched provider family.
  Focused store, lineage, continuation, runner, and router validation passed; review remains pending.
- 2026-08-01: Stage 7 review-blocker remediation added explicit current-input lineage boundaries,
  protocol-safe full-budget and compaction projection before exact payload selection, strict
  pre-input-head fork eligibility, and request-level model/effort latching. Production-path runner
  tests now cover active ordering, cancellation, unqualified follow-ups, explicit incompatible model
  queuing, and fallback transport switching. Validation passed the Core build and all 1,418 Core
  tests, all 212 Agent tests, all 34 event-bus tests, and repository-wide typechecking. Stage 7 remains
  in progress with the review checkbox intentionally pending the independent follow-up.
- 2026-08-01: The remaining Stage 7 blockers were resolved. Local canonical compaction now reports
  original/replacement suffix offsets, retains every current-input segment, remaps the fresh-only
  boundary, retires the pre-compaction Claude candidate, and sends a fresh payload with retained mixed
  history text-lowered while current media remains intact. Production `startBusAgentRunner` coverage
  now uses validated Discord manifests and a temporary SQLite store to exercise fresh promotion, exact
  fork plus provider-tool cursor advancement/native occupancy, cancellation during native finalization,
  stale-revision CAS loss, and disabled Claude cross-family fallback. Post-format validation passed 182
  focused Core tests, all 212 Agent tests, all 50 Claude bridge tests, the Core build and all 1,421 Core
  tests, and repository-wide typechecking. Stage 7 remains in progress and review remains unchecked.
- 2026-08-01: Stage 7 passed final independent review with no blockers. Final resolutions cover
  explicit current-input lineage boundaries, strict pre-input-head fork selection, request-level
  model/effort latching, protocol-safe pre-compaction projection, canonical local-compaction boundary
  remapping with fresh candidate retirement, and production SQLite-backed Core-primary runner flows
  for fresh promotion, exact fork/tool-loop cursor advancement and occupancy, finalization
  cancellation, stale-revision CAS loss, and disabled cross-family Claude fallback. Final validation
  passed the Core remote-runner build and all 1,421 Core tests, all 212 Agent tests, all 34 event-bus
  tests, 182 focused Stage 7 Core tests, package and repository typechecks, lint, formatting, and diff
  checks. Stage 7 is complete; Stage 8 remains pending.
- 2026-08-01: Authenticated Mini main diagnosis reproduced a stale promoted snapshot with a minimal
  real `SessionService` harness. The provider closed its AI SDK output at the successful result while
  Agent SDK query cleanup remained active; a fork candidate's authoritative millisecond
  `lastModified` advanced 233 ms after the value Mini had persisted, so restart correctly rejected
  the dirty base. This was lifecycle ordering, not timestamp serialization. Bridge disposal now
  initially closed every streaming injector, awaited each Agent SDK async-generator `return()`, closed
  the MCP bridge, and only then snapshotted candidate/source session info. Deterministic bridge tests
  verified that ordering and exact source mutation rejection; the independent review below then found
  that `return()` itself did not prove process exit. The authenticated initial smoke asserted native
  `fresh -> fork -> fork` modes through restart, Sonnet/none to Opus/low
  requested and initialized model switching, promotable finalizations, and exact persisted/preflight
  timestamps without fallback replay. Follow-up validation passed all 51 bridge tests, the 26 focused
  Mini continuation tests, all 367 Mini runtime tests, the Core remote-runner build and all 1,427 Core
  tests, repository-wide typechecks and lint, formatting, and diff checks. Stage 8 remains in progress
  and its final checkboxes remain intentionally incomplete pending the remaining release matrix and
  final review.
- 2026-08-01: Independent settlement review found that Agent SDK `Query.return()` was not itself an
  exit proof: installed SDK 0.3.205 races `ProcessTransport.waitForExit()` against two seconds, then
  schedules SIGTERM and a SIGKILL up to five seconds later while allowing query cleanup to resolve.
  The bridge now uses the provider's documented `spawnClaudeCodeProcess` seam, preserves the SDK's
  exact spawn request, and tracks each returned `SpawnedProcess` through its actual `exit` event.
  Disposal closes process registration synchronously, dynamically drains controllers registered by
  already-spawned queries, combines `Query.return()` with actual child-exit proof, and permits ten
  seconds for the SDK's documented two-plus-five-second termination path plus OS exit delivery. No
  proof fails finalization closed before metadata reads. Injector, process, and MCP cleanup are all
  attempted and their errors aggregated, so one settlement rejection cannot skip later cleanup.
  Deterministic review regressions cover delayed exit after query return, unavailable exit proof,
  controller registration during disposal, settlement rejection with MCP/injector closure, and exact
  source mutation rejection. The authenticated Mini smoke again asserted native
  `fresh -> fork -> fork` through restart, Sonnet/none to Opus/low materialization and initialization,
  promotable finalizations, and an exact authoritative final timestamp. Validation passed all 55
  bridge tests, the 26 focused Mini continuation tests, all 367 Mini runtime tests, the Core
  remote-runner build and all 1,427 Core tests, repository-wide typechecks, lint, formatting, and diff
  checks. Stage 8 remains in progress; final release and review checkboxes remain incomplete.
- 2026-08-01: Synchronous cleanup-boundary follow-up now defers every runtime/injected controller
  `settle()` and tracked process-exit wait invocation into promises before `allSettled`, so one direct
  throw cannot abort batch enumeration. Control clearing similarly attempts every injector and bridge
  state clear before reporting its aggregate, while disposal still attempts MCP close and returns one
  final aggregate before any native metadata read. Deterministic regressions prove later controllers,
  process waits, and injectors run after synchronous failures and MCP still closes. Validation passed
  all 57 bridge tests, the 26 focused Mini continuation tests, all 367 Mini runtime tests, the Core
  remote-runner build and all 1,427 Core tests, and repository-wide typechecks. Stage 8 remains in
  progress with release and final-review checkboxes incomplete.
- 2026-08-01: Stage 8 retention settled with bounded terminal attempt metadata, one current Mini
  named/Core binding per owner, retained-history-owned Mini main historical bindings, lazy exact
  Core-primary verification, indexed aggregate orphan diagnostics, and explicit ownership-safe blob
  cleanup. The final independent retention/orphan gate passed with no remaining blocker.
- 2026-08-01: Config examples, migration notes, provider/storage documentation, and related plans
  were updated. Final documentation review passed with no release blocker.
- 2026-08-01: Final repository validation after all process-exit settlement fixes passed
  `bun run test:all`: Core 1,427 tests, Mini runtime 367 tests, Claude bridge 57 tests, Agent 212
  tests, event-bus 34 tests, and every other workspace passed. `bun run typecheck`,
  `bun run codegen:model-options:check`, lint, formatting, the Core remote-runner build, and the final
  diff check also passed.
- 2026-08-01: Authenticated local direct-bridge validation passed a fresh Sonnet run followed by an
  Opus fork, with both native finalizations promotable and context usage observed. Authenticated actual
  Mini main and caller-explicit named runs each asserted persisted `fresh -> fork -> fork` across
  restart, exact source session IDs, and Sonnet/none to Opus/low switching after the process-exit
  settlement fix.
- 2026-08-01: The environment had no `DISCORD_TOKEN`, `REDIS_URL`, or alternate-provider credentials.
  Deployed Core Discord lineage/media, live GPT-to-Claude and Claude-to-GPT boundary/server-compaction,
  and their dependent cancellation scenarios were therefore not run; these remain environment
  residuals, not passed coverage.
- 2026-08-01: Final code, retention, and documentation reviews found no remaining release blockers.
  Stage 8 and the native-session continuation plan are complete.
- 2026-08-01: Live staging Discord session `1533077220589830164` exposed a post-release
  Core-primary gap: automatic conversation-thread search appended a complete provider-visible tool
  exchange but degraded its otherwise complete input lineage to fresh-only. The first Claude call
  succeeded, yet finalization had no complete manifest to publish, so no binding was created; the next
  exact reply selected text replay for a missing binding and only then promoted revision 1. Core now
  appends the whole injected exchange as one deterministic synthetic segment using the exact canonical
  message digest, preserves all prior ranges/digests and the current-input boundary, re-parses the
  aligned result through the event-bus contract, and retains the existing fresh-only failure path when
  proof is unavailable. Surface composition restores that durable synthetic suffix before its terminal
  request atom, while transient search status remains outside lineage. Deterministic contract,
  composition, and production `startBusAgentRunner` regressions prove first-turn promotion followed by
  exact fork selection with suffix-only input. Validation passed 191 focused Core tests, all 34
  event-bus tests, the Core remote-runner build and all 1,431 Core tests, repository-wide typechecking,
  `bun run test:all`, lint, formatting, and diff checks. The completed plan status is unchanged.
- 2026-08-01: Review-blocker follow-up replaced the manually assembled second-turn runner setup with
  the public production orchestration: Discord adapter ingress, request router and Stage 6 composition,
  `startBusAgentRunner`, bus-to-adapter output relay, and relay-owned SQLite output-alias linking. The
  deterministic adapter creates the first bot output on the auto-search start status, emits updates for
  the end status and streamed/final text, then sends a real Discord reply to that alias. The router
  reconstructs `surface -> synthetic -> request -> surface` from first-seen projections, the persisted
  manifest/transcript, and the linked output, after which Claude selects exact fork and receives only
  the unmatched current suffix. Five consecutive focused runs passed without fixed waits; validation
  also passed 235 focused Core router/relay/runner/composition tests, all 34 event-bus tests, the Core
  remote-runner build and all 1,431 Core tests, repository-wide typechecking, and `bun run test:all`.
  No production implementation change was required, and the completed plan status remains unchanged.
- 2026-08-01: Follow-up aligned generated `subagent_delegate` names with the public continuation
  contract. New Core and Mini delegations persist native continuation eligibility whether the name was
  supplied or generated; reusing the returned generated name resumes the same exact child binding.

## Deferred

- Environment residual: without `DISCORD_TOKEN`, `REDIS_URL`, or alternate-provider credentials,
  deployed Core Discord lineage/media, live GPT-to-Claude and Claude-to-GPT
  boundary/server-compaction, and their dependent cancellation scenarios remain unvalidated.
- Legacy requests with a missing or malformed lineage manifest conservatively degrade fresh using the
  latest reachable user boundary. This may replay more history as text but cannot reuse an unsafe
  native binding.
- Active-runtime compatibility compares provider family, model specifier, and reasoning effort. An
  explicit alias that changes only provider options for the same spec remains on the already-latched
  options until a new request run.
