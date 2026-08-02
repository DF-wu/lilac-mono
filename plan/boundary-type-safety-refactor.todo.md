# Boundary Type And Failure Safety Refactor Todo

## Operating Rules

- Use subagents for edits and review; parallelize work when it is independent.
- Maintain this todo file alongside `plan/boundary-type-safety-refactor.md`.
- Complete the remaining plan stage by stage, in order, until every stage is complete.
- Commit each stage separately after its exit criteria, validation, and review are complete.
- Keep changes scoped to the agreed plan. Document residual review findings here and defer them unless
  they block the current stage.

## Current Stage

Stages 0 through 2 complete. Next: Stage 3, High-Risk Process And Extension Boundaries.

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

## Later Stages

- [x] Stage 1: `better-result` foundation and pilot migrations.
- [x] Stage 2: mechanical union, predicate, and failure guardrails.
- [ ] Stage 3: high-risk process and extension boundaries.
- [ ] Stage 4: typed event-bus codec and delivery registry.
- [ ] Stage 5: TUI tool-observation projection.
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
