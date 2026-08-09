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
- [x] Replace unsupported no-ops, empty successes, and private rejection errors.
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

- [ ] Inject a registry-derived adapter resolver into the surface tool.
- [ ] Route generic session, message, and reaction operations through adapters.
- [ ] Remove GitHub REST operation imports and branches from the generic tool.
- [ ] Preserve Discord authorization, aliases, and sidecars as protocol-owned adapters.
- [ ] Preserve shared discovery queries while keeping Discord indexing/storage outside the descriptor.
- [ ] Narrow help and executable adapter resolution without narrowing compatible persistence readers.
- [ ] Run focused tool/MCP tests, Core typecheck, lint/fmt, and independent review.

## Stage 5: Authenticated Origin And Principal Consistency

- [ ] Add the mapped internal authenticated-origin union.
- [ ] Preserve current Discord/GitHub raw wire inputs and fixtures.
- [ ] Dead-letter malformed or conflicting actor/origin/header identities.
- [ ] Correlate active-relay events and terminal lifecycle cache entries by exact `(requestId, platform, sessionId)`, including terminal-before-relay ordering; dead-letter mismatches before relay or cache mutation.
- [ ] Bind request-cache origin and request-control capability identity.
- [ ] Propagate the validated identity through tool, plugin, workflow, and subagent contexts.
- [ ] Implement the explicit safety-mode precedence without changing current Discord/GitHub behavior.
- [ ] Run focused cache/control/runner/plugin tests, typechecks, lint/fmt, and independent review.

## Stage 6: Workflow Port And Durable Correlation

- [ ] Generalize partial-send recovery without a GitHub conditional type.
- [ ] Consume adapter operation Results in both workflow progress ports.
- [ ] Separate permanent descriptor failures from retryable protocol failures.
- [ ] Validate durable binding, action, origin, target, actor, and ref correlation.
- [ ] Preserve repair, authorization, and transactional outbox behavior.
- [ ] Run focused workflow tests, Core typecheck, architecture checks, lint/fmt, and independent review.

## Stage 7: Versioned Recovery Hardening

- [ ] Add centralized relay snapshot correlation decoding.
- [ ] Add snapshot v3 with required `requestClient`.
- [ ] Normalize missing legacy request clients to relay platform and retain v1/v2 fixtures.
- [ ] Define explicit unavailable descriptor/relay restore behavior.
- [ ] Preflight complete snapshots and add apply/rollback restore-attempt handles.
- [ ] Roll back partial relay application before agent restore and supervise rollback failure.
- [ ] Consume restorable snapshots only after success; consume empty/stale after classification.
- [ ] Retain unavailable and failed-restoration snapshots.
- [ ] Define row dispositions for every load, decode, staleness, and SQLite outcome.
- [ ] Preserve transcript and Discord primary-continuation compatibility.
- [ ] Run focused restart/transcript tests, Core typecheck, architecture checks, lint/fmt, and independent review.

## Stage 8: Shared Contract Harness And Documentation

- [ ] Run one parameterized adapter/descriptor harness against Discord and GitHub.
- [ ] Cover lifecycle, relay, operation, workflow, recovery, and cleanup contracts.
- [ ] Keep protocol integration tests deterministic and credential-free.
- [ ] Update project, architecture, and tool documentation.
- [ ] Run `bun run test:all`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run lint:fix`.
- [ ] Run `bun run fmt`.
- [ ] Complete independent final review.
