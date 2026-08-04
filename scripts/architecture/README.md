# Architecture Gate

The permanent architecture gate combines TypeScript semantic analysis with focused production-syntax
checks. It creates one TypeScript `Program` per active Bun workspace and reports every finding as an error
with an exact workspace, source location, rule, owning symbol, remediation, and fingerprint.

```sh
# Standalone subsets for focused development
bun scripts/architecture/runner.ts check
bun scripts/oxlint-plugins/check-production-syntax.mts
bun test scripts/architecture/architecture.test.ts

# Full permanent gate, then complete repository CI
bun run lint
bun run ci
```

The standalone commands cover only their named subset. Use `bun run lint` for the complete lint and
architecture gate, or `bun run ci` for all generated-code, lint, test, typecheck, and format validation.

There is no baseline, suppression, inventory-expansion, or migration-status path. `runner.ts` accepts only
`check`; new findings must be fixed or represented by one of the exact reviewed registrations below.

## Fail-Closed Inventory

`workspace-inventory.ts` discovers every `apps/*` and `packages/*` directory containing `package.json`.
The gate fails before analysis when a discovered workspace is missing from `ACTIVE_WORKSPACES`, a manifest
workspace no longer exists, or a root is duplicated. Adding a workspace therefore requires adding its
architecture policy in the same change.

Every active workspace always receives every rule in `FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES` over the
single `**` zone. Registration-owned rules remain exact: manifest integrity derives their complete module
set from the registrations and rejects missing, stale, wildcard, or extra zones.

## Exact Registrations

`manifest.ts` is the reviewed catalog for:

- boundary decoders, opaque values, and exact capability predicates;
- open-protocol adapters and their explicit local fallback variants;
- event, tool, Result-decoder, persistence, and SQLite contracts;
- event delivery APIs and cross-workspace consumers;
- operational Result APIs, compatibility outputs, and Panic sites; and
- exception adapters and defect supervisors.

Registrations name exact modules and symbols. Specialized Result-bearing registrations must also appear
in `operationalResultApis`. Event family declarations partition every canonical event exactly once, and
event codec coverage must be complete.

`APPROVED_EXCEPTION_ADAPTER_CATALOG` is derived from the exact exception-adapter registrations. Manifest
integrity validates callable identity, direction, syntax kinds, provenance, external/host relationship,
reason, complete registration coverage, and `APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256`. Change the
owning registration, review the derived catalog metadata, then update the digest and focused tests.

## Permanent Rules

Semantic rules enforce boundary decoding, domain-owned `unknown`, assertion and predicate safety, closed
union exhaustiveness, Result handling, Panic registration, compatibility serialization, redacted
TaggedError logging, event delivery, persisted codecs, and SQLite transaction atomicity.

The syntax gate rejects unregistered exception flow, inline async Result callbacks, presentation decoder
imports, store-owned inline decoding, and direct SQLite transactions. Oxlint also applies the permanent
package-wide nested-ternary and local-record-guard rules. Syntax registrations use the same exact manifest
identities as semantic analysis; there is no separate syntax exception catalog.

Production tests, generated output, and the generated Core remote-runner bundle are excluded by
`source-policy.ts` and `syntax-policy.mts`; their TypeScript source remains enforced.

## Performance

`runner.ts check` validates workspace inventory and manifest integrity once in the parent, then analyzes
workspaces sequentially in isolated subprocesses. Each child resolves one workspace configuration, creates
exactly one TypeScript `Program`, prints that workspace's diagnostics, and exits. The operating system then
reclaims the Program, checker, source files, and lazy declaration indexes before the next workspace starts.
Package-root, event-delivery, persistence, and approved-exception catalogs are still derived from the full
manifest in every workspace analysis, so partitioning does not narrow cross-workspace rules.

Workers run in manifest order with inherited output, preserving deterministic diagnostics. Exit status is
aggregated so findings from any worker fail the unchanged parent command; an unexpected worker exit aborts
the gate and fails closed. Nothing is cached across processes, and workers never overlap, so peak memory is
bounded by the parent plus the largest single workspace rather than all workspace Programs retained by one
runtime.

Focused integration tests spawn the real worker against checked-in `fixtures/workspace-runner` projects and
assert its exact output and exit protocol. The fixture manifest is selected only for those direct test
processes; `runner.ts check` removes the fixture selector from every production worker environment.

On 2026-08-04, `/usr/bin/time -v bun scripts/architecture/runner.ts check` on the Stage 8 development
checkout measured 61.67 seconds and 5,993,228 KB maximum RSS before subprocess partitioning. The same
command after partitioning measured 76.68 seconds and 3,830,520 KB maximum RSS, a 36.1% peak reduction.
Re-run the command and record both wall time and maximum RSS when changing program creation, process
partitioning, source traversal, or registration resolution.
