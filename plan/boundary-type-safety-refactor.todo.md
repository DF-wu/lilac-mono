# Boundary Type And Failure Safety Refactor Todo

## Operating Rules

- Use subagents for edits and review; parallelize work when it is independent.
- Maintain this todo file alongside `plan/boundary-type-safety-refactor.md`.
- Complete the remaining plan stage by stage, in order, until every stage is complete.
- Commit each stage separately after its exit criteria, validation, and review are complete.
- Keep changes scoped to the agreed plan. Document residual review findings here and defer them unless
  they block the current stage.

## Current Stage

Stages 0 through 5 complete. Next: Stage 6, Versioned Persistence Codecs And Transaction Results.

## Stage 0

- [x] Pin `better-result@3.0.0` in the root Bun catalog and add the pilot workspace dependency.
- [x] Add and pass the Bun/TypeScript/Result compatibility preflight.
- [x] Update `AGENTS.md` with the planned boundary, Result, union, assertion, Panic, and adapter guidance.
- [x] Add the architecture manifest, diagnostic model, and movement-tolerant fingerprints.
- [x] Implement the Stage 0 semantic architecture checks and fixtures.
- [x] Implement the Stage 0 syntactic Oxlint checks and fixtures.
- [x] Inventory active workspaces and commit separate boundary-validation and failure-flow baselines.
- [x] Wire architecture checks into root lint, test, typecheck, format, and CI commands.
- [x] Add the durable architecture convention and checker location to `PROJECT.md`.
- [x] Run Stage 0 focused tests, repository typecheck, lint, formatting, and full tests.
- [x] Run an independent Stage 0 review and resolve blocking or high-severity in-scope findings.

## Stage 1

- [x] Migrate MCP value-source and config-file expected failures to domain-owned `better-result` values.
- [x] Preserve MCP YAML, registry status, OAuth SDK, tool output, and atomic-file compatibility.
- [x] Prove direct branching, generator composition, exact-signal cancellation, retry abort behavior,
      cleanup precedence, and Panic supervision under Bun and TypeScript 7.
- [x] Add the canonical redacting TaggedError log projection and focused leak tests.
- [x] Add Stage 1 Result-contract, serialization, redaction, and syntax enforcement with real-library fixtures.
- [x] Remove repaired pilot baseline debt while retaining reviewed unrelated migration debt.
- [x] Run independent Core, enforcement, and exit-criteria reviews and resolve all blocking findings.
- [x] Run focused tests, root typecheck, full tests, lint, architecture ratchets, and formatting.

## Stage 2

- [x] Remove every production nested ternary and enable Oxlint's production rule.
- [x] Remove canonical record-guard duplicates and enable semantic duplicate detection.
- [x] Add and globally activate closed-union switch and map exhaustiveness checks.
- [x] Add exact open-protocol normalization checks and ACP/TUI fallback projections.
- [x] Broaden exception-flow syntax coverage to all `.catch` and rejection callbacks.
- [x] Preserve Mini Lilac `ChatTransport`, plugin identity, filesystem, remote-fs, wire, and persisted shapes.
- [x] Run partitioned independent reviews and resolve all blocking behavioral and enforcement findings.
- [x] Run focused tests, root typecheck, full tests, lint, architecture ratchets, and formatting.

## Stage 3

- [x] Migrate summarization worker messages to a shared, fully decoded protocol and typed Result flow.
- [x] Migrate remote filesystem runner requests, responses, socket handling, cancellation, cleanup, and
      deployment/version boundaries to complete codecs and typed Results.
- [x] Migrate plugin discovery, capability snapshots, hooks, lifecycle, reload cleanup, and late-Panic
      supervision while preserving plugin identity and external contracts.
- [x] Decode every custom-command result variant and migrate discovery, import, initialization, argument
      parsing, and execution to typed Results.
- [x] Replace attachment and tool-output assertions with complete schemas or owned typed narrowing.
- [x] Migrate all declared Stage 3 debt in SSH execution, tool-server routing, and conversation-thread
      dispatch rather than retaining module-local semantic or syntax baseline entries.
- [x] Preserve original-Panic precedence and independently supervise terminal worker, bus, remote-runner,
      plugin, startup-lock, and synchronous cleanup failures.
- [x] Enforce zero semantic and syntax baseline debt across every declared Stage 3 module.
- [x] Run final independent Stage 3 acceptance and defect reviews and resolve all blocking findings.
- [x] Run focused builds/tests plus root typecheck, full tests, lint, architecture ratchets, and formatting.
- [x] Commit the validated Stage 3 changes separately with a conventional commit.

## Stage 4

- [x] Expose raw Redis/SuperJSON messages as `Message<unknown>` and remove false generic payload
      assertions from the typed bus path.
- [x] Add a canonical event-type codec registry with colocated complete envelope/header/payload decoders.
- [x] Preserve deliberately opaque adapter `raw` fields as `unknown` inside otherwise decoded envelopes.
- [x] Route invalid contracts through a payload-redacted `event_bus.contract_invalid` disposition that
      durably dead-letters before source commit and parks or stops when dead-lettering fails.
- [x] Migrate handler delivery to typed Results and an exhaustive commit, park-pending, dead-letter, or
      stop policy without handler-owned acknowledgement.
- [x] Preserve current pending-entry behavior and document that `park-pending` does not automatically
  reclaim or retry Redis consumer-group entries.
- [x] Capture transport rejections at the immediate subscription supervisor without converting Panic or
      broken handler contracts into ordinary delivery errors.
- [x] Migrate command/request and workflow-control event families with producer/consumer compatibility
  fixtures.
- [x] Migrate lifecycle, adapter, surface, and agent-output event families with compatibility fixtures.
- [x] Add a separate follow-up plan for reclamation, leases, retry timing/exhaustion,
      idempotency/deduplication, and transactional inbox behavior.
- [x] Activate Stage 4 architecture rules and remove repaired semantic/syntax baseline debt.
- [x] Run independent Stage 4 review and resolve all blocking findings.
- [x] Run focused and full repository validation, then commit Stage 4 separately.

## Stage 5

- [x] Define the raw `ToolObservation` boundary model for tool name, lifecycle state, input, output,
  partial output, denial, cancellation, and error.
- [x] Add a Result-returning known-tool decoder and one `projectToolObservation` boundary that produces a
  closed render-ready `ToolProjection` union.
- [x] Add explicit malformed-known-tool and unknown-tool projections with bounded safe previews.
- [x] Preserve partial Bash output, subagent lifecycle, cancellation, denial, and newly added tool states.
- [x] Change transcript and render APIs to consume typed projections rather than raw tool payloads.
- [x] Remove tool-payload Zod parsing and domain-bearing `unknown` from TUI render/transcript modules.
- [x] Add exhaustive tests for every known projection plus malformed, unknown, partial, cancelled, denied,
  and forward-compatible states.
- [x] Add the presentation-boundary guidance and activate Stage 5 decoder, domain-unknown, Result, and
  exhaustiveness enforcement with zero repaired baseline debt.
- [x] Run independent Stage 5 review and resolve all blocking findings.
- [x] Run focused and full repository validation, then commit Stage 5 separately.

## Later Stages

- [x] Stage 1: `better-result` foundation and pilot migrations.
- [x] Stage 2: mechanical union, predicate, and failure guardrails.
- [x] Stage 3: high-risk process and extension boundaries.
- [x] Stage 4: typed event-bus codec and delivery registry.
- [x] Stage 5: TUI tool-observation projection.
- [ ] Stage 6: versioned persistence codecs and transaction Results.
- [ ] Stage 7: package-by-package internal API migration.
- [ ] Stage 8: close ratchets and simplify governance.

## Deferred Findings

- Advanced alias and provenance coverage in the semantic checker remains advisory until later migration evidence justifies hard enforcement.
- Add the repository TaggedError redaction formatter in Stage 1; until then, callers must avoid implicit serialization and emit only explicitly approved safe fields.
- Hard-activate nested-ternary and duplicate record-guard enforcement in Stage 2 after the planned cleanup.
- Add later-stage specialized semantic rules only when their first migrations consume them.
- Remove the Node `MODULE_TYPELESS_PACKAGE_JSON` warning from the standalone Oxlint RuleTester path
  without changing root package module semantics.

## Work Log

- 2026-08-02: Started Stage 0 and created this persistent execution ledger.
- 2026-08-02: Independent review of the completed Stage 0 preflight and documentation found no blocking issues; compatibility, pre-formatter redaction, and cleanup-precedence guidance were clarified, with non-blocking later-stage findings deferred above.
- 2026-08-02: Added active semantic and syntax ratchets for all 18 workspaces, package/rule baselines,
  fail-closed workspace inventory checks, root CI wiring, and focused analyzer/rule fixtures. Independent
  reviews found and drove fixes for no-op semantic zones, collision-prone per-file baselines, common
  Promise-channel bypasses, unregistered new workspaces, and excessive checker runtime.
- 2026-08-02: Stage 0 validation passed: `bun run typecheck`, `bun run test:all`, `bun run lint:fix`,
  `bun run fmt`, `bun run lint`, `bun run fmt:check`, and `git diff --check`. The active syntax ratchet
  matched all 2,620 reviewed findings with zero new errors.
- 2026-08-02: Stage 1 migrated MCP value/config failure flow to typed Results, added safe TaggedError
  logging, cancellation/retry and cleanup proofs, and activated focused Result/redaction enforcement.
  Independent reviews found and drove fixes for Panic cleanup/state conversion, hidden auth rejection,
  direct Result serialization, overbroad adapter registration, formatter leaks, and provenance bypasses.
- 2026-08-02: Stage 1 validation passed: `bun run typecheck`, `bun run test:all`, `bun run lint:fix`,
  `bun run fmt`, `bun run lint`, `bun run fmt:check`, and `git diff --check`. The syntax ratchet matched
  all 2,593 reviewed findings with zero new errors.
- 2026-08-02: Stage 2 removed production nested ternaries and duplicate record guards, activated
  compiler-backed closed-union/map checks, and added reachable ACP and TUI open-protocol fallbacks.
  Reviews drove fixes for Mini Lilac transport/header compatibility, plugin identity, remote response
  completeness, sparse result shapes, map/never provenance, and rejection-callback blind spots.
- 2026-08-02: Stage 2 validation passed: `bun run typecheck`, `bun run test:all`, `bun run lint:fix`,
  `bun run fmt`, `bun run lint`, `bun run fmt:check`, and `git diff --check`. The strengthened syntax
  ratchet matched all 2,799 reviewed findings with zero new errors.
- 2026-08-02: Stage 3 migrated worker, remote-fs, plugin-runtime, custom-command, attachment, and
  tool-output boundaries to complete decoding and typed failure values. Exact decoder, capability,
  opaque-input, exception-adapter, and migrating-workspace registrations now enforce the converted
  paths without broad module exemptions.
- 2026-08-03: Final Stage 3 review enforcement registered the exact worker, bus, and remote-runner
  Panic supervisors; immediate Result adapters; operational Result APIs; wire projections; and exact
  Stage 3 rule zones. Reviews exposed and drove fixes for Panic consumption and cleanup masking, plugin
  hostile getters and identity compatibility, remote symlink/cancellation/deployment behavior, complete
  custom-command variants, and exact startup/host adapters.
- 2026-08-03: Strengthened Stage 3 acceptance from symbol-scoped checks to module-wide zero-debt
  enforcement. This exposed and resolved remaining SSH execution, tool-server routing, and
  conversation-thread dispatch debt. The integrated architecture and syntax ratchets now pass with
  2,690 reviewed syntax findings; final repository validation and independent acceptance remain.
- 2026-08-03: Three independent final reviews accepted Stage 3 with no blocker, high, or medium
  findings after fixes for explicit fatal supervision, original-Panic cleanup precedence, hostile value
  classification, dynamic plugin catalogs, custom-command compatibility, and deterministic SSH
  cancellation. Final validation passed both remote-runner builds, `bun run test:all` including 1,611
  Core tests, `bun run typecheck`, `bun run lint:fix`, `bun run fmt`, `bun run lint`,
  `bun run fmt:check`, and `git diff --check`. The syntax ratchet contains 2,686 reviewed findings with
  zero errors, and every declared Stage 3 module has zero semantic and syntax baseline debt.
- 2026-08-03: Added `plan/redis-event-delivery-reliability.md` as the separate Stage 4 follow-up for
  pending reclamation, fenced leases, retry timing and exhaustion, attempt accounting,
  idempotency/deduplication, dead-letter/`XACK` crash recovery, transactional inbox/outbox processing,
  and audited operations. The plan keeps Stage 4 `park-pending` manual and explicitly records that the
  current `XREADGROUP ... ">"` loop does not retry pending entries.
- 2026-08-03: Stage 4 moved raw Redis delivery to `Message<unknown>`, added complete schema-derived
  codecs and compatibility fixtures for all 25 event types, and migrated all 21 production consumers to
  typed Results with transport-owned commit, park-pending, dead-letter, and stop dispositions. Invalid
  contracts are logged without payloads and durably dead-lettered before source acknowledgement.
- 2026-08-03: Independent reviews drove fixes for malformed Result fail-open acknowledgements, zero-count
  `XACK`, descendant zero-debt enforcement, router termination supervision, legal publisher overrides,
  opaque adapter projections, and encrypted TTL-bound dead-letter recovery with identity-bound AES-GCM.
  Final validation passed `bun run test:all` including 1,687 Core and 93 event-bus tests,
  `bun run typecheck`, `bun run lint:fix`, `bun run fmt`, `bun run lint`, `bun run fmt:check`, and
  `git diff --check`. The syntax ratchet contains 2,554 reviewed findings with zero errors.
- 2026-08-03: Stage 5 introduced the closed TUI tool-observation projection, migrated canonical and live
  render paths away from raw payloads and presentation-layer decoders, and activated exact registry,
  Result, recursive unknown-free, exhaustiveness, and presentation-import enforcement. Reviews drove
  fixes for hostile payloads, complete known-tool schemas, Bash partial errors, canonical/live lifecycle
  parity, terminal cancellation, subagent links, shared runtime catalog drift, and total leak-free URL
  validation. Final validation passed `bun run test:all`, including 300 TUI, 372 Mini runtime, 64
  architecture, and 37 lint-rule tests, plus `bun run typecheck`, `bun run lint:fix`, `bun run fmt`,
  `bun run lint`, `bun run fmt:check`, and `git diff --check`. The syntax ratchet contains 2,553 reviewed
  findings with zero errors.
