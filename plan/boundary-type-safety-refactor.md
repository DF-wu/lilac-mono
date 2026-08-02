# Boundary-First Type And Failure Safety Refactor

Status: proposed multi-stage implementation plan.

This plan removes repeated runtime parsing from internal code, replaces weak structural guards and
unsafe assertions with owned boundary codecs, replaces expected exceptions with typed Result values,
and makes closed-union control flow exhaustive. It also updates repository instructions before or
alongside enforcement so newly generated code follows the target architecture instead of adding to the
migration backlog.

The rollout uses package-level ratchets. Internal APIs may break freely, but existing wire formats,
persisted data, and external plugin contracts must remain compatible unless a separate migration is
explicitly approved.

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

When complete:

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
- Migrated internal code must not contain `throw`, catch clauses, `Promise.reject`, rejection callbacks,
  `.catch`, stream error signaling, or other exception control flow outside a registered adapter.
- `try/finally` remains allowed for resource cleanup.
- `TaggedError` instances are returned with `Result.err`; they are never thrown.
- `Result.try` and `Result.tryPromise` require an explicit `catch` mapper to a specific domain error.
  The generic `UnhandledException` form is prohibited in migrated production code.
- `Result.unwrap`, unsafe Result codecs, and equivalent assertion-style extraction are prohibited in
  production flow.
- Explicit `panic()` is allowed only at an individually registered hard-invariant site.
- Result combinator and generator callbacks must not contain uncaptured external effects that can throw
  or reject.
- Inline async callbacks in Result combinators are prohibited. Use a named Result-returning adapter or a
  declarative `Result.gen` workflow so external capture remains visible and reviewable.
- `Result.allAsync` inputs must be statically `Promise<Result<T, E>>` from migrated non-rejecting APIs;
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

### Advisory Checks

The following start as review diagnostics because reliable whole-program proof would be noisy:

- A predicate that may validate fewer fields than its return type promises.
- A typed `isX` helper that may be clearer as a direct discriminant check.
- A cast that may be hiding an API typing problem rather than bridging a real compiler limitation.
- Tolerant persistence fallback that may be masking corruption.
- A fallible-looking `Promise<T>` API that may reject for an expected condition.
- A Result combinator callback containing I/O, parsing, mutation, or another effect hidden behind a
  named helper. This remains advisory because TypeScript does not encode effects.
- A broad adapter catch region covering domain orchestration rather than one external call.
- A helper that maps every unknown exception to one generic error without preserving caller-relevant
  distinctions.
- A fire-and-forget promise without an explicit Result observer or defect supervisor.
- `Result.allAsync` whose static types pass but whose implementations have not yet migrated to the
  non-rejecting contract.

Advisory findings become hard errors only after the analyzer demonstrates low false-positive rates on
the active tree.

## Planned `AGENTS.md` Changes

Stage 0 replaces the current broad advice to pass `unknown` and prefer user-defined type guards. The
new guidance must land before semantic migration starts so model-generated changes follow the target
architecture.

Add a dedicated `Trust boundaries and runtime validation` section with these instructions:

- Keep `unknown` at real trust boundaries. Decode it immediately and return a typed value.
- Do not accept `unknown` in an internal function merely because its caller originally received
  external data. Move parsing to the caller's boundary adapter and type the internal parameter.
- Decode again when data crosses another process, wire, persistence, plugin, or SDK boundary.
- Use Zod for rich external structures. Validate the complete envelope and every payload field relied
  on after parsing.
- Do not call `parse` or `safeParse` in ordinary service, domain, orchestration, or render functions.
  Use a registered boundary decoder, projection, or persistence codec. Domain constructors accept
  already typed values.
- Keep boundary schemas and `z.output` types together. Use `z.input` explicitly when input and output
  differ.
- Do not write generic `parseJson<T>` helpers that establish `T` only through an assertion.
- For persisted data, define explicit behavior for valid current data, supported legacy data,
  unsupported versions, malformed serialization, and corrupt fields.

Replace the current broad type-guard recommendation with:

- Use `isX` for semantic predicates over typed values or exact capability checks.
- Do not use a partial `isX(value: unknown): value is RichType` guard. Use a complete schema-backed
  decoder when downstream code relies on a rich structure.
- On a project-owned discriminated union, prefer a direct discriminant check, exhaustive switch, or
  precise `Extract`-based predicate.
- Never add a local `isRecord`; use the centralized utility only for small boundary inspections.

Add union-control-flow guidance:

- Do not write nested ternaries. Extract the decision or use a switch.
- Treat project-owned unions as closed. Handle every member with an exhaustive switch or exhaustive
  typed map.
- Do not use `default: return`, a generic fallback, or a final ternary arm to hide an unhandled closed
  union member.
- Treat third-party/open protocols as open only in their adapter. Normalize unknown variants to an
  explicit local fallback before internal use.

Strengthen assertion guidance:

- Never cast `unknown` to a structured domain type and never use `as unknown as T`.
- A cast is not a substitute for boundary validation or a typed function signature.
- Assertions are allowed only for documented representation-preserving bridges where the source is
  already typed and TypeScript cannot express the relationship.
- Prefer fixing producer and consumer signatures over adding a cast or guard.

Add a dedicated `Errors as values` section with these instructions:

- Return expected failures as `Result<T, E>` or `Promise<Result<T, E>>`; do not throw or reject them.
- Use `better-result` directly. The root catalog pins the exact version and every importing workspace
  declares `"better-result": "catalog:"`.
- Define expected error variants in the vocabulary of the owning domain. Prefer `TaggedError` variants
  with stable `_tag` discriminants over strings or generic `Error`.
- Instantiate a `TaggedError` and return it with `Result.err`; never throw it.
- Catch an external exception only in the smallest immediate adapter and map it to a specific typed
  error. Do not pass `unknown`, `UnhandledException`, SDK errors, or driver errors to consumers.
- Use `Result.gen` and `Result.await` for multi-step linear workflows. Keep effects in named
  Result-returning functions and keep generator bodies declarative.
- Use direct `result.status` branching for one or two steps. Handle or translate the complete error
  union at the next policy boundary.
- Do not use `unwrap`, unsafe Result codecs, or generic `Result.try`/`tryPromise` in production flow.
- Keep Result callbacks total. Capture throwing/rejecting operations before passing values into
  `map`, `andThen`, `match`, `tap`, collection helpers, or a Result generator.
- For a stream that can fail after yielding data, use `AsyncIterable<Result<TChunk, TTerminalError>>`.
  Yield one terminal Err and close; do not reject the iterator for an expected failure.
- Use Panic only for an individually registered unrecoverable defect or hard invariant. Never convert a
  Panic to an ordinary Err.
- Do not wrap total helpers in Result and do not flatten state-machine outcomes such as cancelled,
  stale, expired, or skipped into generic success/error when those states carry domain meaning.
- Do not serialize `better-result` objects or TaggedErrors onto existing contracts. Map to the existing
  wire, storage, tool, or plugin representation at its compatibility adapter.
- Never pass a TaggedError to implicit `JSON.stringify` or generic structured logging. Its `toJSON()`
  includes `cause`; format it through a repository redaction helper that emits only an approved tag,
  message, and explicitly safe fields.

Add framework-edge guidance:

- `try/finally` is allowed for cleanup; catch clauses are restricted to registered adapters and defect
  supervisors.
- A result-to-framework adapter may signal an exception only when the host contract requires rollback,
  delivery parking, stream termination, or callback failure.
- SQLite transaction bodies must not return Err after partial writes unless a transaction adapter turns
  that Err into a private rollback sentinel and converts it back immediately outside.
- Event handlers return typed delivery Results. Handler code does not acknowledge messages directly
  after migration; the subscription policy maps each error to commit, park-pending, dead-letter, or
  stop.
- Cancellation is a typed expected result. External abort rejections are captured using the exact owned
  `AbortSignal`; do not classify arbitrary errors solely by an `AbortError` name.
- `Result.tryPromise` stopping an aborted retry delay returns its latest Err; it does not synthesize a
  cancellation error. Where cancellation must remain distinct, use a cancellation-aware adapter that
  checks the owned signal before and after each attempt and delay, or do not use built-in retry.
- Expected cleanup operations return Result explicitly. If the main operation succeeds and cleanup
  fails, return the cleanup Err. If both fail, return a domain-owned combined failure preserving both.
  A rollback failure that leaves atomicity unknown is a Panic. Do not put expected throwing cleanup in a
  Result generator's `finally` block.

The instruction update and each matching lint rule must be reviewed together. If a rule needs a
recurring exception, `AGENTS.md` must explain the accepted pattern so models can produce compliant
code without guessing. Repeated model violations are an instruction defect and must trigger a guidance
update in the same change as the enforcement fix.

## Enforcement Architecture

### Oxlint

Use Oxlint only for rules that are reliably syntactic in the current setup:

- Enable built-in `no-nested-ternary` for all active production JavaScript and TypeScript extensions,
  including JS, JSX, CJS, MJS, TS, and TSX.
- Add `lilac/no-local-is-record` to reject local declarations named `isRecord`, `isPlainObject`, or an
  equivalent configured canonical duplicate outside approved utility files.
- Add `lilac/no-exception-flow` as the single authoritative syntactic rule for production `throw`, catch
  clauses, `Promise.reject`, rejection callbacks, `.catch`, and stream/framework error signaling.
  Registered adapter and test exclusions come from the architecture manifest rather than path-name
  guesses. The rule owns existing-violation ratchets; the semantic checker must not duplicate it.
- Add a narrow syntactic Result-callback rule that rejects inline async callbacks in Result combinators.
  Do not attempt to classify every named helper's totality; hidden effects remain an advisory review
  finding.
- Keep rule implementation and RuleTester coverage under `scripts/oxlint-plugins/`, following the
  existing test-wait rule structure.

Do not embed a new TypeScript program in every Oxlint file callback. The current plugin API does not
provide a shared `TypeChecker`, and reparsing/typechecking per file would be slow and inconsistent.

### Semantic Architecture Check

Add a standalone checker under `scripts/architecture/` using the existing `typescript-codegen` alias
pinned to the TypeScript 6 compiler API, one `Program` per workspace. TypeScript 6 is the preparation
line for TypeScript 7 and is an acceptable programmatic compiler for these checks; production typecheck
continues to use TypeScript 7. Prefer syntax plus import/export graph checks where type queries add no
value, and reserve the TypeChecker for rules that genuinely need resolved types or symbols.

The semantic checker owns only checks requiring symbol or type information:

- `architecture/no-unregistered-decoder`: resolve Zod parse APIs and permit runtime decoding only in a
  registered boundary, projection, or persistence codec. Hard-invariant code receives typed values and
  may Panic on an impossible typed state; it may not decode `unknown`.
- `architecture/no-domain-unknown`: reject domain-bearing `unknown` parameters in migrated internal
  zones.
- `architecture/no-unknown-assertion`: reject assertions whose source type is `unknown` and target is a
  structured type.
- `architecture/no-rich-unknown-predicate`: reject structural predicates from `unknown` in migrated
  internal zones unless registered as an exact boundary capability check.
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
- `architecture/no-unhandled-exception-contract`: reject `UnhandledException` in migrated Result error
  types or exported contracts.
- `architecture/no-result-wire-leak`: reject Result or TaggedError values passed directly to registered
  HTTP, Redis, worker, subprocess, persistence, tool, or plugin outputs.
- `architecture/no-unredacted-tagged-error-log`: reject TaggedError values passed directly to
  `JSON.stringify`, generic structured logger fields, or other implicit serialization; require the
  approved redacting formatter.
- `architecture/registered-panic-site`: permit explicit `panic()` only at a fingerprinted callsite with
  an invariant reason.
- `architecture/fallible-api-result`: require migrated fallible exported and internal APIs to return
  Result, Promise<Result>, or the fallible stream contract instead of a rejecting contract. Each package
  migration names only the operational API surfaces being migrated; the checker does not infer
  fallibility or classify total helper functions.
- `architecture/no-handler-commit`: reject handler-owned event acknowledgement in migrated subscription
  APIs.

Use a typed architecture manifest containing:

- Boundary module or exported decoder identity.
- Boundary category.
- Internal zones where domain-bearing `unknown` is prohibited.
- Explicit opaque-unknown exceptions with a reason.
- Exception adapter category, exact symbol, external or host API, and permitted exception direction.
- Explicit Panic callsite fingerprint and hard-invariant reason.
- Compatibility boundaries where Result and TaggedError values must be mapped to an existing
  representation.
- Package migration zones and the limited operational API surfaces currently required to satisfy a
  Result signature.
- Package migration status and baseline location.

Registration is not proof that a decoder is correct. It makes boundary ownership visible and
reviewable. Reviews and focused tests must still verify full shape validation and compatibility
behavior.

### Ratchets

- Generate independent baselines per package and rule.
- Keep boundary-validation and failure-flow baselines separate so progress remains visible.
- Reject new findings immediately in every package.
- Report stale baseline entries as warnings during migration so ordinary moves and renames do not block
  unrelated work; promote stale entries to errors only in Stage 8.
- Prefer exported-symbol or local-symbol paths plus syntax kind and normalized structural context.
  Fingerprints must tolerate line movement and unrelated edits within a file.
- Require a reason for every persistent exception.
- Mark a package migrated only when its intended hard-rule baseline reaches zero.
- Once migrated, CI must reject any new baseline entry for that package.
- Do not baseline a broad adapter module when only one symbol or callsite requires exception mechanics.

### Root Commands

Add and wire these scripts:

- `lint:architecture`: run the semantic architecture checker against active workspaces.
- `test:architecture`: run analyzer unit tests and fixture tests.
- `typecheck:architecture`: typecheck checker, manifest, and fixtures.
- Include `lint:architecture` in `lint` or `ci` once baselines are committed.
- Include `test:architecture` in `test:all` and `test:ci`.
- Extend root formatting and typecheck globs to include `scripts/architecture/**/*.{ts,mts,json}`.

Each policy has one enforcement owner. Pure syntax belongs to Oxlint; resolved type/symbol policy
belongs to the standalone checker. Do not implement the same rule in both systems. An enforcement owner
may change only when the replacement removes the old implementation and preserves diagnostics,
performance, exclusions, and package-level ratchets.

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

## Stage 8: Close Ratchets And Simplify Governance

### Goal

Turn migration machinery into a small permanent quality gate.

### Work

1. Delete zeroed boundary-validation and failure-flow package baselines and prohibit recreating them
   without explicit approval.
2. Promote stale-baseline diagnostics from warning to error, then remove advisory checks that did not
   prove useful and promote other reliable checks to errors.
3. Consolidate instruction text based on actual failure patterns and remove temporary migration notes.
4. Document the final boundary architecture briefly in `PROJECT.md`.
5. Verify custom rule and architecture-check diagnostics remain actionable for models and humans.
6. Measure CI cost and cache or partition TypeScript programs if needed without weakening checks.
7. Run the complete repository validation suite and inspect the final active-tree inventory.

### Exit Criteria

- No hard-rule baseline remains.
- `AGENTS.md`, lint diagnostics, architecture diagnostics, and code examples describe the same accepted
  patterns.
- The checker has focused tests for every permanent rule and exception mechanism.
- Full tests, typecheck, lint, format, and required builds pass.

## Migration Gates For Exception-Heavy Subsystems

Do not use these areas as the initial Result pilot. Their migration starts only after the named
prerequisites are complete:

- Mini Lilac SQLite and workspace history require the Stage 6 transaction adapter, rollback tests,
  cleanup policy, and versioned persistence Results.
- Durable workflow store and engine require the transaction adapter plus Stage 4 event delivery Results,
  explicit park/dead-letter/stop dispositions, and regression proof that the existing durable action
  outbox and projection recovery semantics remain unchanged.
- Agent streaming, AI SDK integration, SSE, WebSocket, timeout races, and interrupt/cancellation flow
  require the fallible stream contract, proven exact-signal cancellation adapters, and tests for
  rejected external async iterators and terminal framework mapping.
- Event-bus handler conversion may use `park-pending` with today's manual recovery semantics. Automatic
  retry claims remain prohibited until the separate reclamation/idempotency follow-up is implemented.
- Public filesystem contracts retain their existing operation-specific `success` results unless a
  separate compatibility decision approves a public API change.
- External plugin interfaces retain their existing throwing/rejecting callback contract. Only the
  internal manager side becomes Result-based.

Deferral does not permit new exception debt. The package ratchet still blocks new unregistered throws,
catches, rejection paths, unsafe extraction, and broad adapter allowances in these subsystems.

## Validation Strategy

Every stage must run:

- Focused tests for changed codecs, Results, tagged errors, adapters, protocols, analyzers, and rules.
- Typecheck for every changed workspace.
- `bun run test:architecture` after Stage 0.
- `bun run test:lint-rules` after changing Oxlint plugins.
- Root `bun run lint:fix` and `bun run fmt` before completion.
- Root `bun run typecheck` and relevant workspace tests before a stage is declared complete.
- `bun run test:all` at major stage boundaries, especially event-bus, TUI, and persistence completion.

Compatibility-sensitive stages must maintain fixtures representing data emitted by the current code
before refactoring. Tests must prove old wire/storage/plugin inputs still decode, new encoding preserves
the existing golden output shape or bytes, round trips preserve supported information where applicable,
and plugin invocation, thrown/rejected hooks, skip behavior, and cleanup remain compatible.

Failure-sensitive stages must cover every tagged error branch plus Panic behavior. Async adapters must
test pre-abort, in-flight abort, retry-delay abort, completion races, external rejection, and unrelated
errors that merely resemble cancellation. Transaction adapters must test rollback after partial writes,
successful commit, driver failure, private sentinel containment, cleanup failure, and Panic propagation.

## Completion Criteria

The refactor is complete when all of the following hold:

1. The raw-source inventory and semantic checker report no unregistered production
   `unknown -> structured type` conversion, member read, custom decoder, or manual object assembly;
   migrated package review confirms no alternate raw-data path bypasses those checks.
2. Internal services, workflow logic, and renderers do not accept domain-bearing `unknown`.
3. No assertion narrows `unknown` to a structured domain type.
4. Every migrated expected failure returns through `Result<T, E>`, `Promise<Result<T, E>>`, or the
   fallible stream contract; no expected condition throws or rejects.
5. Workers, IPC, plugins, custom commands, event-bus handlers, and persisted records validate complete
   runtime contracts.
6. External throwing/rejecting APIs are captured by immediate registered adapters and mapped to specific
   domain errors; no migrated Result contract contains `UnhandledException`.
7. TaggedErrors are returned as values and never thrown; Result `unwrap` and unsafe codecs do not appear
   in production flow.
8. Explicit Panic sites are individually registered, reported, and propagated rather than converted to
   expected errors.
9. TUI rendering consumes typed tool projections and contains no tool-payload parsing.
10. Closed union mappings and Result error handling are exhaustive, and production code contains no
    nested ternaries.
11. Open external protocols have explicit local fallback variants.
12. Transaction Result adapters preserve rollback and commit atomicity.
13. Migrated event handlers return delivery Results and cannot acknowledge messages directly.
14. Decode failures default to durable dead-letter disposition, parked entries are not described as
    automatic retries, and existing workflow outbox/projection recovery behavior has no regression.
15. Expected cleanup failures have typed precedence, while rollback failure that leaves atomicity unknown
    becomes Panic.
16. Every package has zero boundary-validation and failure-flow hard-rule findings and no ratchet
    baseline.
17. Existing supported wire formats, persisted data, filesystem-tool results, and plugin contracts
    remain compatible; no Result or TaggedError object leaks onto them.
18. The root Bun catalog pins the approved exact `better-result` version and every importing workspace
    declares `"better-result": "catalog:"`.
19. `AGENTS.md` teaches every enforced pattern with concise positive and negative guidance, preventing
    model-generated code from recreating the migration.

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
