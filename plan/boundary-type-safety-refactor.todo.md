# Boundary Type And Failure Safety Refactor Todo

## Operating Rules

- Use subagents for edits and review; parallelize work when it is independent.
- Maintain this todo file alongside `plan/boundary-type-safety-refactor.md`.
- Keep changes scoped to the agreed plan. Document residual review findings here and defer them unless
  they block the current stage.

## Current Stage

Stage 0 complete. Next: Stage 1, `better-result` Foundation And Pilot.

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

## Later Stages

- [ ] Stage 1: `better-result` foundation and pilot migrations.
- [ ] Stage 2: mechanical union, predicate, and failure guardrails.
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
