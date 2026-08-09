# Third-Platform Surface Readiness

Status: proposed compatibility and extension follow-up.

This is Part 2 of the surface extension work. It starts only after
`plan/surface-runtime-descriptor-extraction.md` lands and its Discord/GitHub parity suite is stable.

Part 2 makes the descriptor seam honest for an actual third Core surface. It widens platform-bound type,
persistence, workflow, and authenticated-principal contracts deliberately. It does not claim that one
descriptor registration can silently redefine old persisted data or security-sensitive behavior.

## Outcome

A basic new surface can be added through this reviewed workflow:

1. Add its protocol types, boundary decoders, normalized refs, and trusted-ingress projection.
2. Implement its adapter, ingress, output stream, and protocol-owned rendering.
3. Add one Core runtime descriptor.
4. Add the exact persistence, workflow, principal, and plugin compatibility registrations required by
   the support level it declares.
5. Pass the shared descriptor contract harness and protocol integration tests.

The descriptor is the only runtime-composition registration. Closed persistence, authentication, and
external API contracts remain explicit review points rather than becoming dynamic descriptor data.

The extension model uses one deliberate split:

> Descriptor port presence is authoritative for coarse subsystem participation. Optional user/tool
> operations are attempted directly, and their typed runtime Result is authoritative. There is no
> capability metadata layer.

## Relationship To Part 1

Part 1 intentionally retains:

- `SessionRef` and `MsgRef` as Discord/GitHub unions;
- an unparameterized `SurfaceAdapter` compatibility contract;
- Discord/GitHub-only graceful relay snapshots;
- Discord/GitHub workflow action authorization;
- Discord/GitHub authenticated principal types;
- current transcript and plugin representations.

Part 2 widens those contracts only where a new platform needs them. It relies on Part 1 for registry
lifecycle, generic adapter-event publication, protocol relay policies, workflow ports, and graceful
handle iteration.

## Trusted Redis And Authentication Model

Redis is trusted deployment infrastructure, comparable to the main database. Core does not sign bus
messages or re-authenticate a platform actor at every consumer.

The trust flow is:

1. A protocol ingress verifies its external connection, request, or webhook.
2. The ingress decodes external data into a closed platform projection.
3. It publishes a normalized authenticated origin onto the trusted Core bus.
4. Bus consumers decode that structure and may treat a valid, internally consistent origin as
   authoritative.

The normalized contract is platform-bound:

```ts
type AuthenticatedSurfaceOrigin = {
  [P in CoreSurfacePlatform]: {
    readonly platform: P;
    readonly userId: string;
    readonly sessionRef: SessionRefFor<P>;
    readonly messageRef?: MsgRefFor<P>;
  };
}[CoreSurfacePlatform];
```

No cryptographic provenance token is required inside Redis. Complete receiver decoding remains required
because Redis contains runtime bytes and may retain malformed, stale, corrupt, or older-version entries.
Consumers verify platform/header/ref/session consistency as an internal invariant.

An operator or process with arbitrary Redis publication access is inside the trusted infrastructure
boundary. Protecting Core from a malicious trusted bus publisher is not a goal of this plan.

## Support Levels

Platform support must be described by subsystem rather than one `enabled` or `supported` flag.

Levels A through E are planning and rollout labels only. They are not descriptor fields, persisted
metadata, or runtime capability declarations. Runtime support comes only from installed descriptor ports
and typed operation Results.

### Level A: Request And Reply Transport

The platform can authenticate ingress, publish normalized requests or adapter events, receive request
output, and participate in connect/drain/shutdown.

Required work includes refs, adapter/ingress/output implementation, descriptor registration, exact relay
selection, and versioned restart compatibility.

### Level B: Durable Workflow Progress

The platform can create, edit, verify, and recover workflow progress output, including the current
workflow action presentation and ingress contract.

Required work includes workflow progress target/ref codecs, bindings, action authorization, renderer
behavior, persistence fixtures, and projector integration.

### Level C: Authenticated Agent And Level 2 Context

The platform can establish an authenticated request principal used by request-control and plugin APIs.

Required work includes normalized authenticated-origin publication, request-cache decoding, control
authority, plugin `RequestContext`, subagent propagation, and mismatch tests.

### Level D: Generic Surface Tool Operations

The platform supports selected read, send, edit, delete, reaction, history, session, pagination, or
attachment operations through the surface tools.

Tools invoke the registered adapter operation directly and handle a typed unsupported-operation result.
Level 2 help may list registered platforms but does not predict operation support. Level A does not imply
that any particular Level D operation succeeds.

### Level E: Protocol-Owned Search And Sidecars

The platform adds search indexes, aliases, local caches, webhook delivery state, thread materialization,
or other protocol-specific services. These remain separately owned and are not fields on the generic
descriptor.

## Platform Type Model

Separate wire-recognized values from implemented Core surfaces without adding a second ref map. The
canonical `SessionRef` and `MsgRef` discriminated unions remain the single declaration of implemented ref
shapes:

```ts
type CoreSurfacePlatform = SessionRef["platform"];

type SessionRefFor<P extends CoreSurfacePlatform> = Extract<
  SessionRef,
  { platform: P }
>;

type MsgRefFor<P extends CoreSurfacePlatform> = Extract<MsgRef, { platform: P }>;
```

Adding a platform means adding its variants to the canonical ref unions. `Extract` provides local
platform correlation without restating the platform-to-ref relationship in `SurfaceRefMap`.

Add a compile-time equality assertion and a contract test requiring
`SessionRef["platform"]` and `MsgRef["platform"]` to contain the same platform set. A missing message-ref
variant must fail explicitly rather than make `MsgRefFor<P>` silently become `never`.

`AdapterPlatform` remains the event-bus wire enum. A value can be wire-valid while unsupported by the
running Core surface registry. Boundary adapters distinguish:

- malformed platform values;
- recognized but unsupported wire platforms;
- implemented but currently unavailable descriptors;
- active descriptors.

Do not add `unknown` to `CoreSurfacePlatform` and do not derive runtime support from the broad wire enum.

## Adapter And Typed Seam Contract

Keep `SurfaceAdapter` unparameterized. Full adapter parameterization creates broad churn through events,
messages, output streams, tests, tools, and heterogeneous registries while every wire and persistence
crossing still requires runtime checks.

Keep platform generics only where `P` remains concrete:

```ts
type SurfaceRuntimeDescriptor<P extends CoreSurfacePlatform> = {
  readonly platform: P;
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress?: SurfaceAdapterIngress<P>;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly relay?: SurfaceRelayDescriptor<P>;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<P>;
};
```

Each protocol adapter narrows `SessionRef` and `MsgRef` at its entry and returns a typed
`SurfacePlatformMismatch` for caller-supplied wrong-platform refs. This narrowing covers primary and
nested refs, including:

- `replyTo`;
- `resume.created`;
- message/session pairs returned by reads and lists;
- refs emitted through `onMessageCreated`;
- `SurfaceOutputResult.created` and `last`.

The descriptor/relay seam validates every adapter-produced ref before publication or persistence. A ref
whose platform differs from the selected descriptor is an adapter contract defect, not an unsupported
operation. Restored relay platform and every nested restored ref must also agree.

Do not parameterize global `AdapterEvent`, `SurfaceMessage`, `StartOutputOpts`, `SurfaceOutputStream`, or
`SurfaceOutputResult` types. Use closed discriminated unions and narrow descriptor ports instead. No cast
from `unknown` or broad compatibility assertion may replace the runtime checks.

## Operation Result Model

Fine-grained operations use one closed expected-error union. Unsupported behavior is returned as a value,
not thrown or rejected:

```ts
class SurfaceOperationUnsupported extends TaggedError("SurfaceOperationUnsupported")<{
  readonly platform: CoreSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly message: string;
}> {}

class SurfacePlatformMismatch extends TaggedError("SurfacePlatformMismatch")<{
  readonly operation: SurfaceOperation;
  readonly refRole: string;
  readonly expectedPlatform: CoreSurfacePlatform;
  readonly receivedPlatform: AdapterPlatform;
  readonly message: string;
}> {}

type SurfaceOperationError =
  | SurfaceOperationUnsupported
  | SurfacePlatformMismatch
  | SurfaceMessageNotFound
  | SurfacePermissionDenied
  | SurfaceRateLimited
  | SurfaceUnavailable;

type SurfaceOperationResult<T> = Result<T, SurfaceOperationError>;
```

`SurfacePlatformMismatch` records the expected platform, received platform, operation, and ref role. A
protocol entry validates primary and nested caller refs before invoking the external SDK and returns that
typed error. Descriptor wrappers validate callbacks, read/list results, and output results after the SDK
returns; a produced mismatch is a supervised adapter contract defect and never reaches publication or
persistence.

Adapter methods that represent optional user/tool operations return
`Promise<SurfaceOperationResult<T>>`. Immediate external SDK adapters capture protocol exceptions and map
them to the exact owned operation error. Panic remains preserved and unexpected exceptions remain defects.

Callers switch exhaustively over `SurfaceOperationError`. `SurfaceOperationUnsupported` is stable and
non-retryable. Permission, rate-limit, unavailability, and not-found retain their own policy rather than
being collapsed into unsupported.

Coarse subsystem participation remains structural:

- ingress requires an ingress descriptor port;
- output delivery and recovery require a relay port;
- workflow progress requires a workflow-progress port;
- authenticated tool context requires normalized trusted ingress support;
- workflow actions are part of the complete workflow-progress port contract.

The registry infers no support from metadata. Structural port presence and operation Results are the only
support mechanisms.

## Ref And Request Identity

Protocol hooks own:

- session and message ref construction;
- request-ID creation and parsing;
- initial reply-target interpretation;
- reanchor ref decoding;
- protocol-specific reply syntax and native/thread semantics.

Core owns the minimum normalized identity `{ platform, channelId, messageId }` used on the event bus and
in generic transcript links.

Reply-target decoding returns explicit outcomes for no target, malformed identity, session mismatch, and
unsupported identity. It must not convert an invalid cross-platform target into `undefined` and silently
send a top-level response. Reanchor decoding receives the expected session ID and rejects a valid ref for
another session.

## Exact Relay Selection

Every surface-bound request, lifecycle event, cancellation, and reanchor must select exactly one active
descriptor by `request_client`.

Part 1 makes `request_client` required for every relay-consumed `cmd.request`, `cmd.surface`, and
`evt.request` event. Missing values park pending; explicit `"unknown"` and unsupported but wire-valid
values match no surface descriptor. Part 2 preserves that invariant and adds no compatibility broadcast.

The current `bus-request-router` remains explicitly Discord-owned. A third platform may publish requests
directly from trusted ingress. Reusing Discord's message router requires a separate routing design that
generalizes its composition semantics, not merely its output header.

## Ingress And Authenticated Origins

Each ingress is the external trust boundary for its protocol. It must:

- authenticate the external connection/request according to protocol;
- decode the complete external envelope and every field used afterward;
- normalize open protocol variants into a closed local projection;
- construct platform-bound refs;
- publish normalized adapter events or requests;
- include `AuthenticatedSurfaceOrigin` only when actor identity is established;
- avoid putting SDK objects or parser functions on the bus.

`AuthenticatedSurfaceOrigin` is an internal projection, not a new required wire shape. The registered
request-cache decoder continues accepting the existing Discord/GitHub `authenticatedActor`,
`authenticatedOrigin`, and GitHub trigger metadata. It combines decoded wire data with required request
headers to construct the mapped internal union, including `sessionRef`, while preserving existing wire
fixtures. New platform metadata is added as another explicitly decoded input variant rather than silently
changing legacy raw payloads.

Bus receivers decode the normalized origin and require:

- origin platform equals `headers.request_client`;
- session and message refs use the same platform;
- the origin session equals `headers.session_id`;
- the platform is implemented and registered;
- required user and identity fields are non-empty.

The projected origin, any parallel authenticated actor metadata, `authenticatedPrincipal`, request-control
authority, subagent propagation, and workflow launch context must preserve one consistent
`(platform, userId, sessionId)` identity. Conflicting identities fail closed. Add current and legacy wire
fixtures for successful projection plus malformed and conflicting cases.

These failures are internal producer or compatibility defects under the trusted Redis model. They still
fail closed for trusted tool/control decisions.

## Persistence Compatibility

### Graceful Restart

`apps/core/src/runtime/graceful-restart-store.ts` currently closes relay platform and message refs to
Discord/GitHub. Every registered relay participates in versioned snapshot and restore. Before adding a
new relay descriptor:

- increment the snapshot version if the accepted persisted union changes;
- retain decoders and fixtures for every supported previous version;
- distinguish unsupported versions, malformed serialization, and corrupt refs;
- do not rewrite snapshots as a side effect of reading;
- require restored refs and relay platform to match the selected descriptor;
- define unavailable-descriptor restore behavior explicitly.

The descriptor registry selects a restore target after the centralized codec decodes the snapshot.
Descriptors do not contribute Zod schemas dynamically. A snapshot for a valid but currently unavailable
descriptor produces an explicit unavailable-restore outcome and test; it is not dropped or restored by a
different surface.

### Workflows

Workflow origin, progress target, completion target, surface binding, and action records are durable. A
new workflow-capable platform requires coordinated codec and store support. Do not widen only the
projector map while leaving action authorization or stored refs closed.

Workflow reply waits remain Discord-only unless the new protocol receives a separate wait identity,
matching, cursor, suppression, and documentation design.

### Transcripts

The event bus already stores generic surface refs, but transcript codecs and SQL paths contain explicit
Discord/GitHub support and historical Discord primary-run assumptions. Preserve historical rows and SQL
checks. Add a migration only for tables or constraints that must store the new platform.

Protocol-owned search databases are not migrated merely because transcript links support a new platform.

## Workflow Progress Contract

A descriptor that opts into workflow progress supplies a narrow `SurfaceWorkflowProgressPort<P>`. It is
a protocol-owned Result adapter around only the operations needed by durable projection:

```ts
type WorkflowProgressCheckFailure = {
  readonly kind: "failed";
  readonly error: WorkflowProgressOperationFailed;
};

type WorkflowProgressSendFailure<P extends CoreSurfacePlatform> =
  | { readonly kind: "created"; readonly ref: MsgRefFor<P> }
  | { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed };

type WorkflowProgressEditFailure =
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed };

type SurfaceWorkflowProgressPort<P extends CoreSurfacePlatform> = {
  checkMessage(...): Promise<Result<"found" | "missing", WorkflowProgressCheckFailure>>;
  send(...): Promise<Result<MsgRefFor<P>, WorkflowProgressSendFailure<P>>>;
  edit(...): Promise<Result<void, WorkflowProgressEditFailure>>;
};
```

The immediate protocol adapter maps Discord/GitHub/new-platform SDK failures into this closed algebra.
The projector no longer imports provider error classes or inspects `unknown`.

Workflow actions require the same platform in the run origin, progress target, persisted action, incoming
action event, authenticated actor, and message ref. Widen the action resolver and its persisted schema in
the same change as the projector.

The existing renderer remains shared. Keep the one Discord timestamp branch and ISO fallback until a real
third platform requires different syntax. Action meaning, issuance, persistence, and authorization remain
generic; protocol adapters already own Discord button and GitHub textual-command rendering/ingress.

The presence of `SurfaceWorkflowProgressPort<P>` promises the complete current workflow-progress
contract, including action presentation and ingress. There is no separate action-support flag. An
unsupported operation from a registered workflow port is a permanent descriptor/configuration failure and
must not enter an unbounded transient retry loop.

## Output Contract

The output stream owns protocol rendering, chunking, rate limits, preview behavior, native reply syntax,
attachments, controls, and abort cleanup. A relay-participating output stream accepts every normalized
`SurfaceOutputPart`; it may intentionally ignore optional presentation parts that have no representation
on its protocol.

The relay continues to own bus decoding, ordering, cursor recovery, text-phase state, `NO_REPLY`,
transcript linking, and terminal coordination.

The relay pushes reasoning, tool status, stats, and attachments to the output stream. The stream renders or
ignores each optional presentation part. Required relay semantics such as recoverable resume, observable
output creation, final text mode, and skipped-output cleanup are explicit output-stream or relay-port
contracts.

Attachment, reaction, workflow-action, and pagination operations report their own runtime Results.

## Tools And Plugin Contracts

`packages/plugin-runtime/types.ts` currently closes `authenticatedPrincipal` to Discord/GitHub. A Level C
platform requires one coordinated compatibility change across:

- request message cache origin decoding;
- request control authority;
- tool-server request context;
- bus agent runner and subagent context propagation;
- plugin runtime request types;
- programmatic workflow launch context;
- portable MCP request-client projection where applicable.

Because Redis is trusted, consumers do not verify a signature on the normalized origin. They still decode
and require exact header/origin/ref consistency before setting `serverOwnedRequest`, trusted safety mode,
or `authenticatedPrincipal`.

Generic surface tool routing is optional and operation-based. Discord aliases, Discord CDN handling,
GitHub reaction translation, GitHub auth injection, and protocol pagination remain in platform modules.
Tools select a registered adapter, invoke the operation, and map `SurfaceOperationUnsupported` to a stable
tool result. Help may list registered platforms and explain that operation support is determined at call
time; it does not maintain a support matrix.

## Configuration

A real surface may require Core configuration or environment secrets. Add configuration only when the
platform implementation needs it.

- Keep the v1 Core config input shape frozen.
- Add v1 fallbacks when universal config gains fields.
- Add v2 platform configuration with explicit defaults and availability semantics.
- Update `MIGRATIONS.md` when v1/v2 shapes or defaults diverge.
- Update `packages/utils/config-templates/core-config.example.yaml`.
- Keep protocol secret file and webhook formats under protocol-owned codecs.

Do not add a generic opaque `surfaces: Record<string, unknown>` configuration solely to mirror the
descriptor registry.

## Architecture Enforcement

Every new external decoder, projection, persistence codec, compatibility output, exception adapter, or
Panic site must receive its exact architecture registration.

Expected impact includes:

- `scripts/architecture/manifest.ts`;
- Core boundary and exception identity catalogs;
- derived exception-adapter approval hash when exception mechanics change;
- architecture checker fixtures and exact-identity tests.

The descriptor registry is not a broad architecture exemption. Protocol modules remain responsible for
their external and persistence boundaries.

## Implementation Sequence

### Stage 1: Choose The Proof Platform And Support Level

- Select one actual third platform rather than designing only against a fake adapter.
- Declare its required support levels A through E.
- Record protocol authentication, ingress model, session/message identity, reply semantics, output model,
  and availability dependencies.
- Identify which existing `AdapterPlatform` wire value it uses. Change the event-bus enum only if no
  existing value matches.

### Stage 2: Platform-Bound Core Types

- Derive `CoreSurfacePlatform` from `SessionRef["platform"]` and add `SessionRefFor<P>` and `MsgRefFor<P>`
  helpers without introducing `SurfaceRefMap`.
- Keep `SurfaceAdapter` and global event/message/output contracts unparameterized.
- Add platform generics only to descriptors, relay policies, workflow progress ports, and the mapped
  authenticated-origin union.
- Define `SurfaceOperationUnsupported`, the remaining closed operation-error variants, and exhaustive
  caller policies.
- Add complete protocol-entry and adapter-output consistency checks without compatibility casts.
- Add a compile-time equality assertion and contract test for the session/message ref platform sets.
- Add tests for nested input refs, callback refs, output results, restored refs, and descriptor mismatch.

### Stage 3: Protocol Boundary And Transport

- Implement the platform boundary decoders and normalized projections.
- Implement adapter connection, ingress, output stream, and descriptor policy.
- Register one descriptor and prove exact request-client relay selection.
- Keep protocol rendering and external exceptions inside the platform module.

### Stage 4: Recovery And Persisted Refs

- Version graceful-restart persistence where required.
- Extend transcript storage only where the new platform produces transcript-linked output.
- Add current, previous-version, malformed, corrupt-field, and unsupported-version fixtures.
- Test restart with active and reanchored relays for the new platform.
- Test explicit restore behavior when the snapshot platform is valid but its descriptor is unavailable.

### Stage 5: Optional Workflow Progress

- Add the workflow progress port only if Level B is selected.
- Widen progress targets, bindings, actions, action resolver, and renderer behavior together.
- Test create, edit, not-found recreation, retry, restart reconciliation, terminal retention, action
  authorization, and mismatched actor/ref rejection.
- Test that an unsupported operation from a declared workflow port is permanent and does not retry
  indefinitely.

### Stage 6: Optional Authenticated Tool Context

- Add normalized authenticated-origin publication only if Level C is selected.
- Preserve existing Discord/GitHub raw wire inputs and project them into the mapped internal origin union;
  add current and legacy fixtures.
- Widen request cache, control authority, plugin context, subagent propagation, and workflow launch context
  in one compatibility change.
- Add malformed, mismatched, absent-origin, wrong-platform, wrong-session, and wrong-user tests.
- Preserve trusted Redis semantics without introducing internal signatures.

### Stage 7: Optional Surface Tools And Sidecars

- Route each Level D operation to the selected adapter and map `SurfaceOperationUnsupported` to a stable
  tool result.
- List registered platforms in `--help` without maintaining operation-support metadata.
- Keep protocol pagination, search, storage, aliases, rate limits, and rendering platform-owned.
- Add Level E sidecars only when required by the product, with independent persistence and shutdown
  contracts.

### Stage 8: Contract Harness And Rollout

- Run the shared descriptor harness against Discord, GitHub, and the new platform.
- Test startup rollback, connection loss, ingress shutdown, relay drain, snapshot/restore, reanchor,
  cancellation, skip, finalization, and cleanup.
- Run protocol-specific integration tests without requiring live credentials where deterministic adapters
  can prove behavior.
- Update `PROJECT.md`, config examples, tool help, and operator documentation.
- Run `bun run test:all`, `bun run typecheck`, `bun run lint:fix`, and `bun run fmt`.

## Blast Radius

### Required For Level A

Expected changes span:

- surface refs, adapter, event, and output types;
- the Part 1 descriptor registry and relay policy;
- one new protocol module and integration tests;
- graceful-restart persistence and restore dispatch;
- transcript codecs/stores if output is linked;
- architecture registrations;
- runtime and bridge contract tests.

### Additional For Level B

Expected changes span workflow domain codecs, durable store rows, progress projector/view, action resolver,
workflow tests, and persisted fixtures.

### Additional For Level C

Expected changes span request cache, request-control authority, tool server, bus agent runner, subagents,
plugin runtime types, programmatic workflow tools, and security-invariant tests.

### Additional For Levels D And E

Expected changes span surface tools, discovery/help output, attachments, protocol API clients, config,
search/storage migrations, and protocol-specific tests.

An honest Level A through C implementation is expected to touch roughly 20 to 35 production and test
files. Full Discord-like tools, search, aliases, reply composition, and workflow waits are a separate
project rather than descriptor work.

Deleting capability metadata removes a central operation-gating matrix and its per-platform branches.
Keeping the general adapter unparameterized also removes a large type-propagation migration. Level D tool
work is expected to be roughly 25 to 40 percent smaller than the original plan, and Stage 2 type churn is
expected to shrink by at least one third. Persisted recovery, relay finalization, workflow contracts, and
authenticated origins remain unchanged in difficulty.

## Risks

### Critical: Persisted Recovery Incompatibility

Widening runtime types without versioning graceful snapshots can make restart data unreadable or restore
cross-platform refs into the wrong adapter. Keep one centralized versioned codec and old fixtures.

### Critical: Trusted Principal Misprojection

Redis is trusted, so a structurally valid normalized origin is authoritative downstream. A bug in a
trusted ingress producer can therefore grant the wrong principal or safety context. Require exact
platform/session/ref consistency and fail closed before setting trusted request context.

### High: False Support From The Wire Enum

The event-bus enum already contains unimplemented platforms. Use the closed ref union plus descriptor
registry as the implemented set and retain explicit unsupported outcomes.

### High: Workflow Authorization Drift

Updating workflow rendering without updating persisted action authorization can issue controls that no
resolver can safely consume. Widen projector, store, and resolver together.

### High: Protocol Semantics Hidden Behind Generic Hooks

Reply chains, reactions, acknowledgements, rendering, rate limits, and pagination are not equivalent
across protocols. Use narrow ports and keep protocol state in protocol modules.

### High: Rolling-Deployment Incompatibility

Old and new Core processes can observe the same Redis streams during rollout. Preserve wire event shapes,
decode optional new fields compatibly, and do not publish new platform values until all required consumers
can decode or explicitly reject them.

### High: Broad Adapter Ref Mismatch

An unparameterized adapter can receive or produce a ref for another platform. Every protocol entry,
nested option, callback, output result, restore path, and persistence/publication seam must check the
platform. Caller input mismatch is a typed expected error; adapter output mismatch is a supervised defect.

### Medium: Plugin API Compatibility

`RequestContext.authenticatedPrincipal` is plugin-facing. Widen it deliberately and retain the existing
Discord/GitHub representation.

## Non-Goals

- Treating every `AdapterPlatform` value as implemented.
- Introducing `SurfaceRefMap` beside the canonical ref unions.
- Parameterizing the entire adapter/event/message/output graph.
- Loading third-party surface descriptors dynamically.
- Signing messages inside trusted Redis.
- Re-authenticating a Discord/GitHub/new-platform actor at every bus consumer.
- Making descriptor membership redefine persisted codecs at runtime.
- Replacing protocol-owned storage, search, webhook verification, pagination, rendering, or rate limits
  with one generic interface.
- Requiring Discord feature parity before a transport-only surface can ship.
- Generalizing Discord workflow reply waits as part of basic surface support.
- Adding capability metadata or operation-support matrices.

## Acceptance Criteria

- The first real third platform implements its reviewed planning levels without new platform branches in
  `create-core-runtime.ts`, `publish-to-bus.ts`, `subscribe-from-bus.ts`, or
  `workflow-progress-projector.ts`.
- Runtime support is derived from `CoreSurfacePlatform` and the descriptor registry, not the broad wire
  enum.
- Descriptor relay/workflow ports and authenticated origins preserve platform/ref correlation by type.
- The broad adapter validates all input and produced refs at its protocol and descriptor seams.
- Every surface-bound bus event selects exactly one descriptor.
- Coarse subsystem participation is controlled by descriptor port presence; optional operations are
  determined only by runtime Results.
- Fine-grained tools invoke the adapter and handle typed `SurfaceOperationUnsupported` results rather than
  consulting support metadata.
- Existing Discord/GitHub wire and persisted fixtures remain supported.
- New persisted platform data has explicit versioned codecs and migration behavior.
- Authenticated origin is established once at protocol ingress, carried over trusted Redis, decoded by
  consumers, and checked for exact cross-field consistency.
- Workflow, tool, and plugin support is present only when the reviewed rollout scope has the required
  descriptor ports and corresponding closed compatibility contracts.
- Session and message ref unions have exactly the same platform set.
- Legacy Discord/GitHub authenticated-origin wire inputs project into the internal mapped union, and every
  principal-bearing context preserves one consistent platform/user/session identity.
- Invalid initial reply or reanchor targets never degrade to top-level output, including cross-session and
  cross-platform refs.
- Every relay descriptor participates in versioned snapshot and restore, including explicit handling for
  an unavailable descriptor.
- Protocol-specific storage, search, verification, rendering, pagination, and cleanup remain
  protocol-owned.
- Focused and repository-wide validation passes.
