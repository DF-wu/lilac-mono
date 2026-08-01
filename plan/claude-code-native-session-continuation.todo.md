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

Status: pending. Covers implementation-order item 12.

- [ ] Integrate one current clean binding per named child session.
- [ ] Add fresh, fork, and text-replay selection for named children.
- [ ] Verify parent history navigation does not rewind named children.
- [ ] Run a Stage 4 review agent and resolve correctness blockers.

## Stage 5: Core Named Continuation

Status: pending. Covers implementation-order item 13.

- [ ] Add Core committed-head provider metadata.
- [ ] Add named-subagent binding and bounded-attempt persistence.
- [ ] Integrate exact canonical head selection and scope validation.
- [ ] Add canonical-first transcript verification and CAS promotion.
- [ ] Keep generic runs without stable continuation identity fresh-only.
- [ ] Run a Stage 5 review agent and resolve correctness blockers.

## Stage 6: Core Primary Lineage

Status: pending. Covers implementation-order items 14 through 17.

- [ ] Add immutable first-seen surface projections and owned attachment/blob references.
- [ ] Add the runtime-validated first-class lineage-manifest bus contract.
- [ ] Preserve and emit complete versioned lineage segments during composition.
- [ ] Add request, checkpoint, synthetic, and surface atoms.
- [ ] Add rolling prefix hashes and complete-segment boundaries.
- [ ] Keep Core primary continuation fresh-only until the complete substrate passes.
- [ ] Run a Stage 6 review agent and resolve correctness blockers.

## Stage 7: Core Primary Continuation And Selection

Status: pending. Covers implementation-order items 18 through 20.

- [ ] Integrate Core primary fresh, fork, and text-replay selection.
- [ ] Require exact complete-segment prefix matching; mismatch starts fresh.
- [ ] Add canonical-first promotion and output-link reachability behavior.
- [ ] Queue model-changing overrides instead of steering an incompatible active runtime.
- [ ] Keep automatic fallback within its runtime-compatible provider family.
- [ ] Run a Stage 7 review agent and resolve correctness blockers.

## Stage 8: Retention, Documentation, And Release

Status: pending. Covers implementation-order items 21 through 23.

- [ ] Add bounded binding/attempt metadata retention and orphan diagnostics.
- [ ] Update config examples, migration notes, provider/storage documentation, and plan references.
- [ ] Run all package tests and typechecks.
- [ ] Run root lint, format, typecheck, and full tests.
- [ ] Run the authenticated validation matrix where credentials are available.
- [ ] Run a final review agent and resolve release-blocking correctness issues.

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

## Deferred

- Stage 0: Add a Core end-to-end regression for generated OpenAI server-compaction rejection through
  exact fallback wiring when that area next changes; Agent-layer behavior is covered.
- Stage 0: Authenticated OpenAI server-compaction validation requires provider credentials and remains
  part of the release validation matrix.
- Stage 1: Normalize equivalent bare and tagged provider-reference file forms in the canonical hash.
  The current mismatch fails safe by starting fresh rather than permitting incorrect native reuse.
- Stage 3: Add an automatic-compaction integration test for a mixed-family active tool exchange. The
  explicit admitted-user boundary and fresh replacement are implemented; focused coverage currently
  exercises the underlying replay, cursor, and compaction contracts separately.
- Stage 3: Add an explicit named-child regression asserting Claude remains ephemeral with no Mini
  main attempt rows when Stage 4 begins. Production depth-positive routing remains on the existing
  ephemeral bridge path.
- Stage 3: Cancellation before native materialization may conservatively record the selected target
  family on a user-only terminal error state. It cannot reuse an unsafe binding and may only cause a
  later fresh text replay.
- Stage 3: Authenticated Claude interruption, observability, and restart validation remains part of
  the Stage 8 credentialed release matrix.
