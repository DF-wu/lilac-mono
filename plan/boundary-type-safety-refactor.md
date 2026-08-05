# Boundary-First Type And Failure Safety Refactor

This document records the staged implementation and the compatibility decisions that remain permanent.

The refactor removed repeated runtime parsing from internal code, replaced weak structural guards and
unsafe assertions with owned boundary codecs, moved expected exceptions to typed Result values, and
made closed-union control flow exhaustive. The permanent gate now rejects violations directly.

Internal APIs may break freely, but existing wire formats, persisted data, and external plugin contracts
remain compatible unless a separate compatibility change is explicitly approved.

## Outcome

The target invariants are:

> No unvalidated boundary data reaches domain, service, orchestration, or presentation logic.

> No expected failure travels through `throw`, promise rejection, or an untyped exception channel.

This does not mean eliminating every use of `unknown`, schema parser, predicate, assertion, or runtime
exception mechanism. `unknown` remains correct for caught external errors, opaque pass-through data,
serialization utilities, and values entering through a real trust boundary. Registered adapters may
catch external exceptions or signal failure through a framework-required exception channel. Panic
remains available only for unrecoverable defects and hard invariants. The refactor controls where a
value becomes typed, where an external exception becomes a typed error value, and where framework
exception semantics may exist.

The permanent architecture requires:

- Every external crossing has an owned decoder or normalizer.
- Internal functions accept the narrowest useful typed input rather than `unknown`.
- A value is decoded once per trust boundary and stays typed until it crosses another boundary.
- Closed project-owned unions use exhaustive switches or exhaustive typed maps.
- Open external protocols normalize to closed local unions with explicit fallback variants.
- Rich structural values are validated by schemas or dedicated decoders, not partial `isX` guards.
- Assertions from `unknown` to structured types are prohibited.
- Expected failures are returned as `Result<T, E>`, `Promise<Result<T, E>>`, or the defined fallible
  stream contract.
- Domain errors have stable tagged variants and remain visible until a policy boundary handles them.
- Internal fallible APIs do not throw, reject, catch, or unwrap Results.
- Panic and framework exception adapters are individually registered and reviewable.
- CI rejects new violations, while `AGENTS.md` tells models how to avoid producing them.

## Compatibility Contract

- Preserve existing Redis/SuperJSON event wire representations while introducing typed payload
  decoding above the raw transport.
- Preserve worker, socket, HTTP, SSE, and subprocess wire representations unless a compatible decoder
  can accept both old and new forms.
- Preserve all supported persisted records. Legacy, unsupported-version, and corrupt records must be
  distinguishable rather than silently collapsed into one default.
- Preserve external plugin and custom-command contracts. Validate them at the loader boundary and add
  adapters when internal types change.
- Preserve existing `{ ok }`, `{ success }`, status, HTTP, Redis, worker, subprocess, filesystem-tool,
  and plugin result representations. Map them to internal Results at compatibility boundaries rather
  than leaking `better-result` objects or changing wire shapes.
- Preserve external plugin exception behavior at plugin-hook adapters while converting it immediately
  to an internal Result.
- Breaking changes to private functions, internal service interfaces, render models, and package-private
  helpers are expected.

## Terminology

### Trust Boundary

A trust boundary is a point where runtime data enters from a representation that TypeScript cannot
guarantee. The recognized categories are:

- HTTP request and response bodies, path/query parameters, SSE, and WebSocket messages.
- Redis/event-bus payloads and headers after wire decoding.
- Worker messages, subprocess output, socket/IPC envelopes, and CLI/stdin JSON.
- Filesystem configuration, persisted JSON, database rows with JSON columns, and cache files.
- Dynamic imports, external plugins, custom commands, and external SDK opaque values.
- LLM output, AI SDK tool input/output, and other open protocol payloads.

Crossing from one trusted process to another is still a boundary. A sender having a typed value does
not make the receiver's runtime bytes typed.

### Boundary Codec

A boundary codec owns conversion from a raw representation to an internal type. It validates the full
shape that its return type promises and applies only boundary-specific compatibility behavior.

Boundary decoders return Result when malformed input is an expected outcome:

```ts
export function decodeWorkerRequest(raw: unknown): Result<WorkerRequest, InvalidWorkerRequest>;
export function decodeStoredAboutness(
  raw: string,
): Result<DecodedStoredAboutness, StoredAboutnessError>;
export function projectToolObservation(raw: ToolObservation): ToolProjection;
```

Avoid generic APIs such as `parseJson<T>()` or `decodeEnvelope<T>()` when the function has no runtime
schema capable of establishing `T`.

### Domain-Bearing Unknown

A domain-bearing `unknown` is a value that internal code inspects to make business, state-transition,
rendering, authorization, or persistence decisions. This is prohibited outside a registered boundary,
projection, or persistence codec.

Opaque logging, error formatting, safe serialization, hashing, and pass-through values may continue to
use `unknown` when they do not claim a richer domain type.

### Expected Failure

An expected failure is any condition a caller can classify, report, retry, recover from, or deliberately
propagate. It includes invalid input, not-found, conflict, denial, authentication failure, cancellation,
timeout, unavailable dependencies, malformed boundary data, unsupported persisted versions, and
operational I/O or network failure.

Expected failures use `better-result`'s `Result<T, E>` or `Promise<Result<T, E>>`. Error variants are
domain-owned `TaggedError` instances or precise domain values. `TaggedError` extends JavaScript
`Error`, but it is instantiated and returned as a value; it is never thrown.

Expected failures that can occur after streaming begins use
`AsyncIterable<Result<TChunk, TTerminalError>>`. The adapter yields Ok chunks, yields exactly one Err for
an expected terminal failure, and then closes. It must capture rejection from the external iterator,
map exact-signal cancellation to a typed cancellation error, and never reject for an expected terminal
condition. A framework compatibility adapter maps the terminal Err to an existing error frame or, when
the protocol has no error value, to the host's stream-failure signal.

### Panic And Defect

A Panic is reserved for a state that cannot be handled meaningfully by the current operation: a proven
unreachable branch, violated hard invariant, broken Result callback contract, or corrupted internal
state for which continuing would be unsafe. Panic is not a replacement for configuration, dependency,
storage, cancellation, or user-facing errors.

Explicit `panic()` callsites must be individually registered with an invariant reason. Implicit Panics
from `better-result` are reported at defect supervisors and must not be converted into ordinary Err
values.

### Exception Adapter

Exception mechanics are restricted to the smallest immediate crossing. Registered adapter classes are:

- External-to-result adapter: catches or captures one external throwing/rejecting operation and returns
  a Result with a specific typed error.
- Result-to-framework adapter: exhaustively maps a Result and may throw, reject, call
  `controller.error`, or use another error signal only when the host framework requires it.
- Transaction rollback adapter: throws one private sentinel inside a transaction callback, catches it
  immediately outside, and returns the sentinel's typed Err.
- Defect supervisor: catches Panic or an unexpected rejection to report and fail the current operation;
  it never converts the defect into an expected error.
- Compatibility adapter: maps an existing wire, persisted, tool, or plugin representation to or from an
  internal Result without changing the external contract.

Registration applies to exact symbols or stable callsite fingerprints, not whole files. An adapter must
not wrap domain orchestration merely to make its exceptions pass lint.

## Target Module Shape

Use small feature-local modules rather than introducing a universal codec framework:

```text
feature/
  protocol.ts           schemas, z.input/z.output types, encode/decode functions
  errors.ts             domain-owned expected failure variants
  transport.ts          HTTP, Redis, worker, socket, or subprocess interaction
  service.ts            typed internal API
  projection.ts         open protocol to closed local presentation union
  persistence-codec.ts  stored versions to current domain value
```

Not every feature needs every file. Keep a codec beside its feature unless multiple packages truly
share the protocol. Colocate schemas and inferred output types, and distinguish `z.input` from
`z.output` whenever defaults, transforms, coercion, or stripping make them differ.

Use `better-result` directly rather than adding a repository wrapper package. Declare
`better-result: "3.0.0"` once in the root Bun workspace catalog and require each importing workspace to
declare `"better-result": "catalog:"`. Upgrade the catalog only through an explicit compatibility
check. If the dependency becomes unmaintained or develops an unresolved security/compatibility issue,
the contingency is to vendor the audited pinned implementation while preserving its public API; do not
introduce a wrapper abstraction preemptively.

## Rule Taxonomy

### Hard Rules

- `unknown` may enter a structured type only through a registered boundary, projection, or persistence
  codec. Domain constructors accept already typed values.
- Internal service, orchestration, and presentation APIs must not accept domain-bearing `unknown`.
- Assertions from `unknown` to a structured type, including `as unknown as T`, are prohibited.
- A type predicate from `unknown` to a rich structural type must be a registered boundary capability
  check or be replaced by a complete decoder.
- Local `isRecord` equivalents are prohibited outside the canonical utility.
- Nested ternaries are prohibited in production code.
- Switches over closed project-owned unions must be exhaustive and must not use a silent `default`.
- Typed maps over closed unions must use `satisfies Record<Union, Value>` or an equivalent exhaustive
  shape.
- Open external protocols must normalize into a local union with an explicit `unsupported`, `unknown`,
  or `malformed` variant before entering internal control flow.
- Fallible internal functions return `Result<T, E>`, `Promise<Result<T, E>>`, or
  `AsyncIterable<Result<TChunk, TTerminalError>>`; expected failures must not throw or reject.
- Production code must not contain `throw`, catch clauses, `Promise.reject`, rejection callbacks,
  `.catch`, stream error signaling, or other exception control flow outside a registered adapter.
- `try/finally` remains allowed for resource cleanup.
- `TaggedError` instances are returned with `Result.err`; they are never thrown.
- `Result.try` and `Result.tryPromise` require an explicit `catch` mapper to a specific domain error.
  The generic `UnhandledException` form is prohibited in production code.
- `Result.unwrap`, unsafe Result codecs, and equivalent assertion-style extraction are prohibited in
  production flow.
- Explicit `panic()` is allowed only at an individually registered hard-invariant site.
- Result combinator and generator callbacks must not contain uncaptured external effects that can throw
  or reject.
- Inline async callbacks in Result combinators are prohibited. Use a named Result-returning adapter or a
  declarative `Result.gen` workflow so external capture remains visible and reviewable.
- `Result.allAsync` inputs must be statically `Promise<Result<T, E>>` from non-rejecting Result APIs;
  otherwise capture each input first or use an explicit adapter.
- Internal Results and TaggedErrors must not cross existing wire, persistence, tool, or plugin
  compatibility boundaries without an explicit schema-backed mapping.

### Allowed Patterns

- `unknown` caught errors converted with `errorMessage` or equivalent safe handling.
- Recursive JSON-safety, logging, redaction, canonicalization, and serialization utilities that do not
  claim domain structure.
- Semantic predicates over typed values, such as `isTerminalOperation` or `isPathWithin`.
- Precise capability checks at dynamic import or external SDK boundaries when the checked capability is
  exactly the returned type.
- Direct discriminant checks for local binary narrowing.
- A simple non-nested ternary for local binary value selection.
- Narrow assertions for a documented representation-preserving compiler limitation, with no `unknown`
  source and no missing runtime validation.
- Direct `result.status` branching for short failure paths.
- `Result.gen` with `Result.await` for several named sequential Result-returning operations.
- Mapped `Result.try` or `Result.tryPromise` inside an immediate external-to-result adapter.
- A private transaction rollback sentinel contained entirely inside a registered transaction adapter.
- Existing operation-specific `{ ok }`, `{ success }`, status, Zod `SafeParseResult`, tool-output, and
  `PromiseSettledResult` unions where they represent compatibility or richer state semantics.
- Opaque `cause: unknown` metadata on an in-memory tagged error when it is not inspected as domain data
  or serialized without redaction.

### Review Requirements

Automated rules do not replace review of schema completeness, compatibility behavior, broad catch
regions, hidden effects in named Result callbacks, tolerant persistence fallback, cancellation races,
or fire-and-forget supervision. These are permanent review concerns, not advisory checker findings.

## Permanent `AGENTS.md` Guidance

`AGENTS.md` is the operational source for boundary decoding, predicates, union exhaustiveness,
assertions, Result composition, Panic, persistence, presentation projections, event delivery, and
framework adapters. Update its accepted pattern in the same change as an enforcement change. Repeated
model violations indicate an instruction defect; do not add broad exceptions to silence them.

## Enforcement Architecture

### Production Syntax

Oxlint owns package-wide `no-nested-ternary` and `lilac/no-local-is-record`. The production syntax gate
owns exception flow, inline async Result callbacks, presentation decoder imports, store-owned inline
decoding, and direct SQLite transactions. It scans active production files and uses exact manifest
registrations; tests, generated output, and the generated remote-runner bundle follow the shared source
policy. There is no syntax baseline or separate syntax exception catalog.

### Semantic Architecture Check

The standalone checker under `scripts/architecture/` uses the `typescript-codegen` TypeScript 6 compiler
API. Each architecture run creates exactly one `Program` per active workspace; it does not cache Programs
across workspaces or runs. Declaration indexes are cached per `Program` and identity root while that
Program is analyzed. Production typecheck remains TypeScript 7.

The semantic checker owns only checks requiring symbol or type information:

- `architecture/no-unregistered-decoder`: resolve Zod parse APIs and permit runtime decoding only in a
  registered boundary, projection, or persistence codec. Hard-invariant code receives typed values and
  may Panic on an impossible typed state; it may not decode `unknown`.
- `architecture/no-domain-unknown`: reject domain-bearing `unknown` parameters in production code.
- `architecture/no-unknown-assertion`: reject assertions whose source type is `unknown` and target is a
  structured type.
- `architecture/no-rich-unknown-predicate`: reject structural predicates from `unknown` unless registered
  as an exact boundary capability check.
- `architecture/closed-union-exhaustiveness`: reject incomplete switches and silent defaults over
  project-owned literal unions.
- `architecture/closed-union-map-exhaustiveness`: require typed maps over closed unions to use a
  compiler-checked exhaustive shape.
- `architecture/open-protocol-normalization`: require registered open-protocol adapters to produce a
  closed local union with an explicit fallback variant before internal consumption.
- `architecture/no-unknown-member-read`: reject property access, destructuring, iteration, and manual
  object assembly from `unknown` outside a registered decoder.
- `architecture/no-unregistered-custom-decoder`: identify known raw sources such as JSON parsing,
  response bodies, wire messages, database JSON, and custom decoder exports, and require their conversion
  symbol to be registered.
- `architecture/no-production-unwrap`: reject Result `unwrap`, unsafe codecs, and equivalent assertion
  APIs in production.
- `architecture/no-unmapped-result-capture`: reject generic `Result.try` and `Result.tryPromise` forms
  that expose `UnhandledException` rather than a specific mapped error.
- `architecture/no-unhandled-exception-contract`: reject `UnhandledException` in Result error
  types or exported contracts.
- `architecture/no-result-wire-leak`: reject Result or TaggedError values passed directly to registered
  HTTP, Redis, worker, subprocess, persistence, tool, or plugin outputs.
- `architecture/no-unredacted-tagged-error-log`: reject TaggedError values passed directly to
  `JSON.stringify`, generic structured logger fields, or other implicit serialization; require the
  approved redacting formatter.
- `architecture/registered-panic-site`: permit explicit `panic()` only at a fingerprinted callsite with
  an invariant reason.
- `architecture/fallible-api-result`: require registered operational fallible APIs to return Result,
  Promise<Result>, or the fallible stream contract instead of a rejecting contract.
- `architecture/raw-event-message-boundary`, `architecture/complete-event-codec-registry`,
  `architecture/event-handler-result`, and `architecture/event-delivery-policy-exhaustiveness`: enforce
  unknown raw receive data, complete codec coverage, typed handler Results, and exhaustive delivery
  policy ownership.
- `architecture/complete-tool-codec-registry`, `architecture/result-decoder-contract`, and
  `architecture/unknown-free-module`: enforce complete tool projection ownership and closed presentation
  inputs.
- `architecture/persisted-codec-contract`, `architecture/persisted-codec-fixture-catalog`,
  `architecture/sqlite-transaction-adapter-contract`, `architecture/sqlite-transaction-consumer`, and
  `architecture/no-result-err-in-sqlite-callback`: enforce persistence provenance and transaction
  atomicity.

### Manifest Contributions

- Use exact `module#exportName` identities for registrations whose schema owns a symbol, including
  decoders, adapters, codecs, consumers, operational Result APIs, and local compatibility sinks.
- Use exact module paths for module registries such as `unknownFreeModules` and registration-owned rule
  zones. Wildcards and broad module exemptions are rejected.
- Supply reasons only for schemas that define them, including opaque-unknown and capability exceptions,
  compatibility outputs, structured loggers, open-protocol adapters, Panic sites, and exception
  adapters. Do not invent reason fields for registrations that do not own one.
- Link specialized Result-bearing registrations through `operationalResultApis` when manifest integrity
  requires it. Event family declarations must partition the canonical event catalog exactly once.
- Add exception adapters to the owning workspace. `APPROVED_EXCEPTION_ADAPTER_CATALOG` is derived from
  workspace registrations; review its derived metadata and update
  `APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256` plus focused tests. Do not hand-add a duplicate approval.

Registration is not proof that a decoder is correct. It makes boundary ownership visible and
reviewable. Reviews and focused tests must still verify full shape validation and compatibility
behavior.

### Permanent Gate

Every semantic or production-syntax finding is an error. The runner accepts only `check`; there is no
baseline generation, finding suppression, inventory-expansion mode, registration status, or stale-entry
path. Every active workspace receives the package-wide rule set over `**`, while manifest integrity
derives exact modules for registration-owned rules and rejects missing, stale, wildcard, or extra zones.

### Root Commands

The permanent scripts are:

- `bun run lint:architecture`: run the semantic checker and production syntax gate.
- `bun run test:architecture`: run analyzer and fixture tests.
- `bun run test:lint-rules`: run focused Oxlint rule tests.
- `bun run typecheck:architecture`: typecheck the checker, manifest, and fixtures.
- Root `lint`, `test:all`, and `typecheck` include the corresponding architecture commands; `ci` also
  runs the repository format check.

Each policy has one enforcement owner. Pure syntax belongs to Oxlint or the production syntax gate;
resolved type/symbol policy belongs to the standalone checker. Do not implement the same rule twice.

## Historical Rollout

The Stage 0 through Stage 7 sections preserve the implementation sequence. Their references to advisory
checks, baselines, ratchets, inventories, migration statuses, and staged activation are historical and
do not describe the permanent contribution workflow above.

## Stage 0: Instructions, Inventory, And Ratchet Infrastructure

### Goal

Stop creating new violations before beginning broad code migration.

### Work

1. Add `better-result: "3.0.0"` to the root Bun workspace catalog, reference it as `catalog:` from the
   pilot workspace, and run a minimal compatibility preflight covering Bun ESM import, TypeScript 7
   inference, `Result.gen`, `Result.await`, mapped capture, and Panic observation. Do not activate
   Result-specific instructions or rules until this preflight passes.
2. Update `AGENTS.md` with the boundary, predicate, union, persistence, assertion, Result, Panic, and
   framework-adapter guidance above.
3. Add the narrow architecture manifest, TypeScript 6 `typescript-codegen` checker runner, diagnostic
   model, and movement-tolerant fingerprint format.
4. Add fixture-based tests only for rules consumed by Stages 1 through 3: boundary decoder ownership,
   domain-bearing `unknown`, unknown assertions, rich unknown predicates, exception flow, unsafe Result
   extraction/capture, Panic registration, nested ternaries, and duplicate record guards. Later stages
   add their specialized rules and fixtures when their first migration uses them.
5. Inventory active `apps/*` and `packages/*`, including decoders, domain-bearing `unknown`, assertions,
   predicates, nested ternaries, throws, catches, explicit rejection, `.catch`, Result-like unions,
   framework callbacks, transaction callbacks, and hard invariants. Exclude tests where a rule is
   production-specific, generated output, and `ref/`.
6. Commit separate package-level boundary-validation and failure-flow baselines with reasons for
   deliberately retained opaque `unknown`, compatibility behavior, framework adapters, and Panic sites.
7. Wire architecture scripts into root test, typecheck, lint, formatting, and CI commands.
8. Update `PROJECT.md` only with the durable architectural convention and checker location; keep the
   detailed implementation policy in `AGENTS.md` and this plan.

### Instruction And Rule Pairing

- The new boundary guidance lands with `no-domain-unknown`, `no-unregistered-decoder`, and
  `no-unknown-assertion` in ratchet mode.
- The errors-as-values guidance lands with no-new-throw, catch, rejection, unwrap, unmapped-capture, and
  Result-wire-leak checks in ratchet mode.
- The Panic and framework-adapter guidance lands with exact-symbol and fingerprint registration, never
  broad file allowlists.
- Predicate and union guidance may land in `AGENTS.md` now, but their specialized hard rules activate in
  Stage 2 rather than expanding the Stage 0 checker scope.
- Diagnostic messages must name the compliant alternative, such as moving validation to a boundary
  decoder or typing the internal parameter.

### Exit Criteria

- New semantic violations fail CI without requiring the existing tree to be clean.
- The pinned library preflight passes before Result-specific guidance and ratchets become active.
- Initial analyzer fixtures cover aliases, imported schemas, nested local helpers, overloads, callbacks,
  `z.input`/`z.output`, and false-positive opaque utilities.
- `AGENTS.md` no longer broadly recommends user-defined `unknown -> T` guards.
- `AGENTS.md` no longer permits expected failures to throw or reject and explains Result composition,
  adapter placement, and Panic limits.
- New expected exception flow fails CI even though existing packages retain independent baselines.
- The TypeScript 6 architecture checker adds acceptable CI time, while ordinary TypeScript 7 typecheck
  remains authoritative for compilation.

## Stage 1: `better-result` Foundation And Pilot

### Goal

Prove the Result conventions, dependency behavior, inference, cancellation, and supervision model in a
contained vertical slice before broad API migration.

### Work

1. Retain the Stage 0 root catalog pin and add `"better-result": "catalog:"` directly to any additional
   pilot workspace that imports it. Do not add a wrapper or re-export workspace package.
2. Require each importing workspace to declare `"better-result": "catalog:"`; the root catalog is the
   single version authority, so no custom same-version checker is added.
3. Pilot synchronous and asynchronous error flow in `apps/core/src/mcp/value-source.ts` and
   `apps/core/src/mcp/config-file.ts`. These paths already have value outcomes, filesystem boundaries,
   parsing, sequential composition, and no required wire-format change.
4. Define domain-owned TaggedError variants for caller-actionable failures. Keep existing external MCP
   config representations unchanged.
5. Use mapped `Result.try` or `Result.tryPromise` only around the immediate YAML/filesystem operations;
   do not expose `UnhandledException`.
6. Use direct Result branching for short flows and `Result.gen`/`Result.await` for the multi-step path.
7. Test Bun ESM loading, TypeScript 7 inference, tagged-error narrowing, generator cleanup, asynchronous
   Result inference, exact-signal cancellation, and Panic supervision.
8. Add negative fixtures proving `unwrap`, generic capture, thrown TaggedError, broad catches, rejected
   Result promises, and direct Result serialization are rejected.
9. Add a redacting TaggedError formatter and negative fixtures for implicit `toJSON`, `JSON.stringify`,
   and generic structured logging of external causes.
10. Prove cancellation-aware retry behavior separately from `Result.tryPromise`'s default abort behavior;
   do not use built-in retry where an aborted delay must produce a distinct Cancelled error.
11. Test cleanup precedence: primary Ok plus cleanup Err, primary Err plus cleanup Err, and rollback or
    cleanup failure severe enough to become Panic.

### Instruction And Rule Pairing

- Land concrete `AGENTS.md` examples for mapped external capture, short direct branching, linear
  generator composition, tagged error definition, and policy-boundary handling with the pilot.
- Make failure-flow rules hard errors in the pilot symbols once conversion is complete.
- Require every diagnostic to suggest a specific Result or adapter pattern rather than merely saying
  that throwing is forbidden.

### Exit Criteria

- The pilot has no expected throw or rejected-promise path.
- Every external exception becomes a specific tagged error in the immediate adapter.
- No `UnhandledException`, `unwrap`, Result object, or TaggedError leaks into an existing external
  contract.
- Panic is reported and propagated as a defect, never converted to an expected error.
- The direct dependency and generator APIs work under Bun, ESM, and the repository TypeScript version.

## Stage 2: Mechanical Union, Predicate, And Failure Guardrails

### Goal

Remove mechanically decidable patterns and enable simple global rules and no-new-exception ratchets.

### Work

1. Replace every production nested ternary with a simple conditional, named helper, switch, or typed
   map. Preserve simple non-nested binary ternaries.
2. Enable Oxlint's built-in `no-nested-ternary` globally for production files.
3. Add and enable `lilac/no-local-is-record`; replace duplicates with the canonical utility where
   package dependency direction permits.
4. Where importing the canonical utility would violate package layering, move the canonical primitive
   to the lowest suitable package rather than retaining duplicate guards.
5. Enable closed-union exhaustiveness in the architecture checker and migrate existing silent defaults
   package by package.
6. Express intentional external/open-protocol fallbacks in adapter modules with the documented fallback
   variant, not an exemption inside domain logic.
7. Enable no-new-throw, catch, explicit-rejection, `.catch`, unwrap, generic Result capture, and
   unregistered Panic ratchets for production code.
8. Register only the current narrow external-to-result, result-to-framework, rollback, compatibility,
   and defect-supervisor symbols needed by later stages.

### Priority Sites

- `apps/mini-lilac-tui/src/render.ts`: execution errors, tool render states, operation status, and tool
  part state mappings.
- `apps/core/src/workflow/workflow-engine.ts`: operation transition tables, durable handoff states, and
  completion-state mappings.
- `apps/core/src/workflow/workflow-live-parent-bridge.ts`: terminal run mappings.
- `packages/event-bus/redis-streams-bus.ts`: offset-to-Redis-ID mapping.
- Switches with silent defaults in TUI chunk rendering and ACP session history.

### Instruction And Rule Pairing

- The `AGENTS.md` nested-ternary prohibition lands no later than global `no-nested-ternary`.
- The closed/open union guidance lands with the first exhaustiveness diagnostics.
- The Result and adapter guidance lands no later than the failure-flow ratchets.
- Rule messages must distinguish a closed internal union from an intentionally open adapter protocol.

### Exit Criteria

- Production code has no nested ternaries.
- No package declares a duplicate canonical record guard.
- Migrated closed unions cannot gain a member without a compile- or architecture-check failure.
- Open protocol fallbacks are explicit and tested.
- Production code cannot add a new unregistered expected exception path or unsafe Result extraction.

## Stage 3: High-Risk Process And Extension Boundaries

### Goal

Eliminate small, high-risk unsound conversions before broader architectural work.

### Work

1. Replace summarization worker request/response guards with shared Zod schemas, following
   `thread-materializer-worker-protocol.ts`, and return typed decode Results for malformed messages.
2. Validate complete remote-fs request and response envelopes. Remove the response cast after checking
   only `ok`, capture subprocess/socket failures immediately, and expose an internal Result without
   changing the wire envelope.
3. Validate the complete required plugin module capability at dynamic import. Keep the external plugin
   interface compatible, including thrown/rejected hook behavior, but convert each hook outcome to an
   internal Result at the immediate manager adapter.
4. Validate every custom-command result variant and required payload before returning a typed Result.
5. Replace weak attachment/tool-output guards with typed producer results when the producer is owned;
   otherwise use a complete boundary schema.
6. Add malformed-envelope, malformed-payload, unknown-variant, and compatibility tests for every
   migrated protocol.
7. Remove expected throws, catch propagation, and rejected internal promises from the complete adapter
   to consumer call paths rather than converting isolated throw statements.

### Instruction And Rule Pairing

- The complete-shape decoder guidance becomes a hard error for these migrated modules.
- `no-rich-unknown-predicate` moves from advisory to error in the affected packages.
- `no-unknown-assertion` moves to error in the affected protocol and loader modules.
- Failure-flow rules move to error for the migrated worker, remote-fs, plugin-manager, and custom-command
  internal paths. External plugin hook signatures remain registered compatibility inputs.

### Exit Criteria

- Workers, remote-fs IPC, plugin loading, and custom-command execution expose typed values only after
  complete runtime validation.
- Existing wire and plugin fixtures remain accepted.
- No migrated guard promises fields it does not validate.
- Consumers handle specific Result errors linearly; no expected external failure escapes through throw
  or promise rejection.

## Stage 4: Typed Event-Bus Codec And Delivery Registry

### Goal

Close the largest cross-process type and failure-flow gaps without rewriting the raw Redis transport or
wire format.

### Work

1. Change the raw bus boundary to expose `Message<unknown>` after Redis/SuperJSON field decoding.
2. Add an event-type codec registry keyed by canonical Lilac event type.
3. Colocate each payload schema with its event contract and derive the typed payload from schema output.
4. Decode headers and payload before invoking typed `subscribeType`, `subscribeTopic`, or typed fetch
   handlers.
5. Remove `as Message<TData>` and `as unknown as LilacMessage<...>` bridges from the typed bus path.
6. Keep deliberately opaque fields such as adapter `raw` payloads typed as `unknown` inside an otherwise
   validated envelope.
7. Route invalid envelope/header/payload decoding through the same delivery-disposition policy as handler
   errors. Emit a structured `event_bus.contract_invalid` diagnostic without raw payload contents and
   default to dead-letter, not silent commit. Commit the source message only after the dead-letter record
   is durably accepted. The dead-letter record preserves the bounded original wire entry or a retrievable
   reference under explicit retention/access controls, while ordinary logs remain redacted. If
   dead-lettering fails, park the source message or stop according to policy.
8. Replace handler-owned acknowledgement in migrated subscriptions with
   `Promise<Result<void, HandlerError>>`. Registration policy maps each error variant exhaustively to
   commit, park-pending, dead-letter, or stop.
9. Preserve today's no-reclamation semantics in this refactor. Name the disposition `park-pending`, not
   retry or redelivery: the current `XREADGROUP ... ">"` loop does not reclaim pending entries
   automatically. Document manual recovery behavior explicitly.
10. Capture Redis/transport rejection at the immediate subscription supervisor. Do not convert Panic or
    a broken handler contract into an ordinary delivery error.
11. Migrate event families incrementally, beginning with command/request and workflow-control events,
   then lifecycle, adapter, surface, and agent-output events.
12. Add producer/consumer compatibility fixtures for every event family before its package baseline is
   removed.
13. Create a separate follow-up plan for pending reclamation, attempt ownership, retry delays, retry
    exhaustion, idempotency/deduplication, and transactional inbox behavior. That work is not a gate for
    typed codecs or Result-returning handlers.

### Instruction And Rule Pairing

- Add an `AGENTS.md` event-bus example showing that compile-time `publish` typing does not eliminate
  receiver-side validation.
- Make unregistered typed event payloads fail the architecture check once the registry exists.
- Ban structured assertions in the typed bus wrapper when the first family migrates.
- Add event-handler Result and delivery-disposition examples before removing `commit()` from migrated
  handler APIs.

### Exit Criteria

- Typed handlers never receive an undecoded payload.
- The raw transport remains generic and contains no false generic data assertion.
- Invalid payload behavior is deterministic, observable, payload-redacted, and tested.
- Existing Redis data and event publishers remain compatible.
- Migrated handlers return Results, cannot commit directly, and have tested commit, park-pending,
  dead-letter, stop, dead-letter failure, and Panic behavior.
- The plan and API do not misrepresent parked pending entries as automatic retries.

## Stage 5: TUI Tool Observation Projection

### Goal

Parse open tool payloads once and remove schema logic from rendering.

### Work

1. Define a raw `ToolObservation` boundary model for tool name, lifecycle state, input, output, partial
   output, denial, cancellation, and error.
2. Add a known-tool decoder that returns Result, then `projectToolObservation` that produces a closed
   `ToolProjection` union.
3. Give known tools typed projection variants containing only render-ready semantic data.
4. Add explicit malformed-known-tool and unknown-tool fallback variants with bounded safe previews.
   Mapping a known-tool decode Err into a successful malformed projection is an intentional recovery
   policy owned only by this projection boundary.
5. Preserve partial Bash output and subagent lifecycle behavior in the projection layer.
6. Change transcript and render functions to consume typed projections instead of raw input/output.
7. Remove tool-payload Zod parsing from `apps/mini-lilac-tui/src/render.ts`.
8. Add tests for every known projection, malformed known payloads, unknown tools, partial streams,
   cancellation, denial, and newly added tool states.

### Instruction And Rule Pairing

- Add a presentation example to `AGENTS.md`: external/open protocol to local projection to renderer.
- Make `no-unregistered-decoder` and `no-domain-unknown` errors for TUI render and transcript modules
  once projection coverage is complete.
- Exhaustiveness errors apply to `ToolProjection` and `ToolRenderState` because they are local closed
  unions.
- Failure-flow rules become errors for projection consumers and render modules; expected malformed or
  unknown tool data never throws.

### Exit Criteria

- `render.ts` performs no tool input/output schema parsing.
- Rendering APIs do not accept tool-payload `unknown`.
- Unknown and malformed tools remain forward-compatible through explicit fallback projections.
- Adding a local projection member requires deliberate rendering behavior.

## Stage 6: Versioned Persistence Codecs And Transaction Results

### Goal

Move storage parsing out of stores, separate compatibility from corruption handling, and preserve
transaction atomicity while exposing typed failure values.

### Work

1. Begin with conversation thread string-array, importance, and aboutness fields currently parsed in
   `thread-store.ts`.
2. Define current and supported legacy schemas, even when the legacy form is an implicit unversioned
   v0 record.
3. Return
   `Result<{ value: T; provenance: "current" | "migrated" | "missing-defaulted" }, StorageError>`.
   Unsupported version, malformed serialization, and corrupt fields are typed errors.
   `missing-defaulted` is Ok only when the storage contract explicitly defines absence as a valid
   default.
4. Preserve existing readable data. Do not rewrite records during reads unless an explicit migration
   transaction owns that behavior.
5. Add bounded diagnostics for corruption without logging persisted content.
6. Apply the same pattern to transcript stores, Mini Lilac SQLite data, workspace history/cache files,
   and artifact metadata.
7. Consolidate repetitive JSON-read and schema-error scaffolding only after at least three codecs show a
   stable shared shape. Do not begin with a generic codec framework.
8. Add a transaction adapter before converting transactional stores. A transaction callback may throw
   one private rollback sentinel containing a typed Err; the adapter catches it immediately outside the
   transaction and returns that Err.
9. The transaction adapter must re-propagate Panic, translate only recognized SQLite/driver failures,
   and treat unknown thrown values as defects rather than generic store unavailability.
10. Move non-database fallible work before transaction callbacks where possible. Add atomicity tests that
    prove an Err after an earlier write rolls back all writes and an Ok commits exactly once.
11. Migrate Mini Lilac SQLite, workspace history, and durable workflow transactions only after the
    adapter passes focused concurrency, rollback, cleanup, and defect tests.
12. Preserve the workflow runtime's existing durable action-outbox and projection recovery semantics.
    Add regression fixtures for state plus outbox commit, rollback with no publishable entry, stable
    outbox identity, publication failure, restart replay, and no duplicate projection. Do not redesign
    outbox leasing or delivery semantics as part of this type/failure-safety refactor.

### Instruction And Rule Pairing

- Land the detailed persistence guidance in `AGENTS.md` before the first codec extraction.
- Make unregistered JSON/Zod decoding an error in each migrated store.
- Require compatibility fixture coverage before removing a store package's baseline.
- Add persistence Result and transaction-adapter examples to `AGENTS.md` before the first transactional
  migration.

### Exit Criteria

- Migrated stores receive typed decoded values and do not hand-narrow JSON objects.
- Tests distinguish current, legacy, absent, unsupported, malformed, and corrupt inputs.
- Existing supported data remains readable.
- Corruption is not silently represented as legitimate empty domain state unless the codec contract
  explicitly defines and reports that fallback.
- Migrated public store methods return typed Results for expected storage failures.
- Transaction Err, Panic, driver failure, and cleanup behavior preserve atomicity and are independently
  tested.
- Existing durable state/outbox consistency remains unchanged across rollback, commit, crash, and
  publication retry.

## Stage 7: Package-By-Package Internal API Migration

### Goal

Remove remaining domain-bearing `unknown`, redundant internal guards, unsafe assertions, and expected
exception flow from the active tree.

### Order

1. Leaf/shared packages: `packages/bash-safety`, `packages/fs`, `packages/utils`,
   `packages/event-bus`, `packages/tool-results`, and `packages/plugin-runtime`.
2. Execution/protocol packages: `packages/claude-code-bridge`, `packages/agent`,
   `packages/coding-tools`, `packages/remote-fs-runner`, `packages/mini-lilac-client`, and
   `packages/mini-lilac-runtime`.
3. Applications: `apps/core`, `apps/tool-bridge`, `apps/acp-controller`,
   `apps/mini-lilac-server`, `apps/mini-lilac-tui`, and `apps/mini-lilac`.

The actual order may move a package earlier when dependency direction requires it, but a higher layer
must not introduce a duplicate decoder because its lower layer has not migrated yet.

### Per-Package Procedure

1. Classify every boundary finding as a real boundary, opaque utility, typed internal API, or obsolete
   compatibility path. Classify every exception finding as expected external failure, expected domain
   failure, compatibility signal, host signal, hard invariant, or defect.
2. Add or reuse the owned decoder at the lowest correct boundary.
3. Propagate the typed output through internal call chains.
4. Replace repeated parses and weak guards with typed parameters and direct discriminant narrowing.
5. Replace unsafe casts by fixing producer/consumer signatures.
6. Preserve semantic predicates that communicate real domain policy.
7. Add focused tests for boundary rejection and internal typed behavior.
8. Define caller-owned tagged errors and propagate them through complete Result-returning vertical
   slices. Do not replace individual throws without migrating their callers.
9. Convert expected async failure to `Promise<Result<T, E>>`; cancellation is a typed result and external
   abort rejection is captured by the immediate signal-owning adapter.
10. Convert expected failures after streaming starts to
    `AsyncIterable<Result<TChunk, TTerminalError>>`; adapters catch external iterator rejection and
    consumers handle the terminal Err before framework translation.
11. Preserve richer status/state unions when they are not simple failures, and preserve public
    compatibility representations at explicit adapters.
12. Reduce both boundary-validation and failure-flow hard-rule baselines to zero and mark the package
    migrated.

### Instruction And Rule Pairing

- Before migrating each pattern category, add one concise compliant example to `AGENTS.md` if existing
  instructions have proven insufficient.
- Do not add rule-specific exception prose merely to silence existing code; exceptions require an
  architectural reason.
- Treat repeated model violations as an instruction defect and update guidance in the same change as
  the enforcement fix.

### Exit Criteria

- Every active package is at zero for intended hard rules.
- Remaining `unknown` parameters are boundary, error, opaque, serialization, or generic algorithm
  values with documented classification.
- Remaining `isX` helpers are semantic predicates or exact capability checks.
- Remaining assertions are typed representation bridges and do not originate from `unknown`.
- Remaining catches, throws, rejections, stream error signals, and Panic sites are exact registered
  adapters, supervisors, or hard invariants.
- Every migrated fallible API exposes its expected error union and does not reject for expected
  conditions.
- Every migrated fallible stream represents expected terminal failure as a value rather than iterator
  rejection.

## Stage 8: Install The Permanent Gate

### Goal

Delete the rollout machinery and leave one fail-direct quality gate.

### Work

1. Delete semantic and syntax baseline files, generators, application code, and migration-status
   registries. Do not retain a path that can suppress a finding.
2. Replace the syntax ratchet with a production syntax gate and make both semantic and syntax checks fail
   directly on every finding.
3. Consolidate instruction text based on actual failure patterns and remove temporary migration notes.
4. Document the final boundary architecture briefly in `PROJECT.md`.
5. Verify custom rule and architecture-check diagnostics remain actionable for models and humans.
6. Measure architecture-gate cost while retaining exactly one TypeScript `Program` per workspace per run
   and per-Program declaration indexes. Do not claim cross-run or cross-workspace Program caching.
7. Run the complete repository validation suite and inspect the final active-tree inventory.

### Exit Criteria

- No baseline, suppression, advisory, inventory-expansion, or migration-status path remains.
- The semantic and production syntax gates report every finding as an error.
- `AGENTS.md`, lint diagnostics, architecture diagnostics, and code examples describe the same accepted
  patterns.
- The checker has focused tests for every permanent rule and exception mechanism.
- Full tests, typecheck, lint, format, and required builds pass.

## Permanent Subsystem Contracts

- Mini Lilac SQLite and workspace history use the registered transaction adapter, typed cleanup policy,
  rollback coverage, and versioned persistence Results.
- The durable workflow store and engine preserve transaction-scoped state/action/outbox consistency,
  explicit delivery dispositions, and existing projection recovery semantics.
- Agent streaming, AI SDK integration, SSE, WebSocket, timeout races, and interrupt/cancellation flow use
  fallible streams, exact-signal cancellation adapters, and explicit terminal framework mapping.
- Event-bus handlers may return `park-pending` with manual recovery semantics. Automatic retry claims
  remain prohibited until the separate reclamation/idempotency work is implemented.
- Public filesystem contracts retain their existing operation-specific `success` results unless a
  separate compatibility decision approves a public API change.
- External plugin interfaces retain their existing throwing/rejecting callback contract. Only the
  internal manager side is Result-based.

## Validation Strategy

- Run focused tests for changed codecs, Results, tagged errors, adapters, protocols, analyzers, and rules.
- Run `bun run lint:architecture`, `bun run test:architecture`, `bun run test:lint-rules`, and
  `bun run typecheck:architecture` for architecture changes.
- Run the changed workspace typecheck and tests.
- Run root `bun run lint:fix`, `bun run fmt`, `bun run lint`, `bun run test:all`, `bun run typecheck`, and
  `bun run fmt:check` before completion, plus required builds for affected applications.

Compatibility-sensitive changes maintain fixtures representing data emitted before the change. Tests
prove old wire/storage/plugin inputs still decode, new encoding preserves the existing golden output
shape or bytes, round trips preserve supported information where applicable, and plugin invocation,
thrown/rejected hooks, skip behavior, and cleanup remain compatible.

Failure-sensitive changes cover every tagged error branch plus Panic behavior. Async adapters test
pre-abort, in-flight abort, retry-delay abort, completion races, external rejection, and unrelated errors
that merely resemble cancellation. Transaction adapters test rollback after partial writes, successful
commit, driver failure, private sentinel containment, cleanup failure, and Panic propagation.

## Completion Criteria

The refactor is complete when all of the following hold:

1. The semantic checker reports no unregistered production `unknown -> structured type` conversion,
   member read, custom decoder, or manual object assembly; review confirms no alternate raw-data path
   bypasses those checks.
2. Internal services, workflow logic, and renderers do not accept domain-bearing `unknown`.
3. No assertion narrows `unknown` to a structured domain type.
4. Every expected failure returns through `Result<T, E>`, `Promise<Result<T, E>>`, or the fallible stream
   contract; no expected condition throws or rejects.
5. Workers, IPC, plugins, custom commands, event-bus handlers, and persisted records validate complete
   runtime contracts.
6. External throwing/rejecting APIs are captured by immediate registered adapters and mapped to specific
   domain errors; no Result contract contains `UnhandledException`.
7. TaggedErrors are returned as values and never thrown; Result `unwrap` and unsafe codecs do not appear
   in production flow.
8. Explicit Panic sites are individually registered, reported, and propagated rather than converted to
   expected errors.
9. TUI rendering consumes typed tool projections and contains no tool-payload parsing.
10. Closed union mappings and Result error handling are exhaustive, and production code contains no
    nested ternaries.
11. Open external protocols have explicit local fallback variants.
12. Transaction Result adapters preserve rollback and commit atomicity.
13. Event handlers return delivery Results, while subscription policy owns acknowledgement and delivery
    disposition.
14. Decode failures default to durable dead-letter disposition, parked entries are not described as
    automatic retries, and existing workflow outbox/projection recovery behavior has no regression.
15. Expected cleanup failures have typed precedence, while rollback failure that leaves atomicity unknown
    becomes Panic.
16. The semantic and production syntax gates report zero findings, and no baseline, suppression,
    advisory, inventory-expansion, or migration-status path exists.
17. Existing supported wire formats, persisted data, filesystem-tool results, and plugin contracts
    remain compatible; no Result or TaggedError object leaks onto them.
18. The root Bun catalog pins the approved exact `better-result` version and every importing workspace
    declares `"better-result": "catalog:"`.
19. `AGENTS.md` teaches every enforced pattern with concise positive and negative guidance.

## Explicit Non-Goals

- Do not eliminate `unknown` from caught errors, logging, redaction, serialization, hashing, or truly
  opaque pass-through data.
- Do not turn Panic, impossible states, or broken internal contracts into recoverable generic Err values.
- Do not ban the exception mechanics required inside exact external/framework adapters or defect
  supervisors.
- Do not wrap total functions in Result merely for consistency.
- Do not introduce a repository Result wrapper, generic catch helper, or universal service error that
  hides domain ownership or `better-result` Panic semantics.
- Do not brand every decoded domain value as a substitute for boundary ownership. Generic brands can be
  forged by assertion, pollute internal signatures, and do not remove the need to revalidate at each
  process/wire/storage crossing. Use nominal brands only for genuine domain identities or invariants.
- Do not replace richer workflow, cancellation, stale, skipped, denied, or protocol state unions with a
  generic binary Result when the states carry independent domain meaning.
- Do not serialize internal Result or TaggedError objects onto existing contracts.
- Do not ban all `isX` names or all user-defined type predicates.
- Do not replace complete runtime validation with assertions.
- Do not force closed-world exhaustiveness directly onto third-party/open protocols.
- Do not rewrite the Redis transport, storage formats, or external plugin API solely for stylistic
  consistency.
- Do not create a universal codec abstraction before repeated concrete codecs demonstrate a stable
  need.
- Do not make Redis pending reclamation, retry ownership, idempotency/deduplication, transactional inbox,
  or new workflow outbox design prerequisites for this refactor. Track those runtime projects in
  separate plans.
- Do not add backward-compatibility code for private internal APIs; change their signatures directly.
