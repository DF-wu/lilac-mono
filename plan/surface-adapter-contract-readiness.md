# Surface Adapter Contract Readiness

Status: proposed Discord/GitHub contract hardening and compatibility refactor.

This is Part 2 of the surface extension work. It starts after
`plan/surface-runtime-descriptor-extraction.md` and its Discord/GitHub parity suite are stable.

Part 2 makes Discord and GitHub the complete reference implementations for Core surface adapters. It
does not add a platform. Instead, it establishes the type, operation, trust, workflow, persistence, and
tool contracts that every current adapter must satisfy and that a future adapter can implement without
redesigning the shared runtime.

Adding an actual platform is a separate future plan. This plan adds no descriptor, protocol module,
surface-ref variant, wire enum member, configuration section, or persisted platform value.

## Outcome

Discord and GitHub use one canonical surface pattern:

1. The closed ref unions define the implemented Core platforms.
2. A typed descriptor binds each adapter to its concrete platform and structural subsystem ports.
3. User and tool operations return one closed Result algebra, including explicit unsupported behavior.
4. Each adapter validates every caller-supplied primary and nested ref before invoking its protocol SDK.
5. Shared descriptor seams validate every adapter-produced ref before publication or persistence.
6. Generic surface tools select a registered adapter and invoke its operations instead of branching into
   protocol APIs.
7. Authenticated origins, workflow records, and graceful-restart snapshots preserve exact platform,
   session, user, and ref correlation.
8. Both descriptors pass one shared contract harness plus protocol-owned integration tests.

The extension model retains one deliberate split:

> Descriptor port presence is authoritative for coarse subsystem participation. Optional user/tool
> operations are attempted directly, and their typed runtime Result is authoritative. There is no
> capability metadata layer.

Discord and GitHub do not need identical features. A missing operation is a typed
`SurfaceOperationUnsupported`; a missing coarse subsystem is represented by an absent descriptor port.

## Relationship To Part 1

Part 1 established:

- `SessionRef` and `MsgRef` as the closed Discord/GitHub ref unions;
- an unparameterized `SurfaceAdapter` compatibility contract;
- one closed `SurfaceRuntimeRegistry` with Discord and GitHub descriptor factories;
- generic lifecycle, adapter-event publication, exact relay selection, graceful handle iteration, and
  workflow progress ports;
- protocol-owned relay policies and independent adapter/request ingress ports.

Part 2 hardens those existing registrations rather than adding another one. It changes current internal
operation contracts where necessary while preserving existing wire, valid persisted-data, filesystem-tool,
and plugin compatibility contracts.

## Canonical Adapter Pattern

The reference pattern consists of five layers:

1. Canonical closed refs and platform-correlated helper types.
2. An unparameterized adapter with Result-returning runtime operations.
3. A platform-parameterized descriptor with structural ingress, relay, and workflow ports.
4. Descriptor-bound guards for every value an adapter produces.
5. Protocol modules that own external decoding, SDK exceptions, rendering, pagination, and sidecars.

The pattern does not make protocols semantically interchangeable. Discord aliases, allowlists, gateway
events, search, local cache, and reply composition remain Discord-owned. GitHub webhook verification,
trigger grammar, App authentication, reaction IDs, and issue/comment rendering remain GitHub-owned.

## Trusted Redis And Authentication Model

Redis is trusted deployment infrastructure, comparable to the main database. Core does not sign bus
messages or re-authenticate a platform actor at every consumer.

The trust flow is:

1. Discord gateway ingress or GitHub webhook ingress authenticates its external protocol boundary.
2. The ingress decodes external values into a closed protocol projection.
3. It publishes existing compatible wire metadata onto the trusted Core bus.
4. The request-cache boundary decodes that metadata into one normalized authenticated origin.
5. Downstream control, tool, workflow, and subagent contexts use only the normalized origin.

The internal contract is platform-bound:

```ts
type AuthenticatedSurfaceOrigin = {
  [P in RegisteredSurfacePlatform]: {
    readonly platform: P;
    readonly userId: string;
    readonly sessionRef: SessionRefFor<P>;
    readonly messageRef?: MsgRefFor<P>;
  };
}[RegisteredSurfacePlatform];
```

No cryptographic provenance token is required inside Redis. Complete receiver decoding remains required
because Redis contains runtime bytes and may retain malformed, stale, corrupt, or older-version entries.
Consumers require platform/header/ref/session consistency as an internal invariant.

An operator or process with arbitrary Redis publication access is inside the trusted infrastructure
boundary. Protecting Core from a malicious trusted bus publisher is not a goal of this plan.

## Platform Type Model

Keep the canonical `SessionRef` and `MsgRef` discriminated unions as the single declaration of implemented
ref shapes:

```ts
type RegisteredSurfacePlatform = SessionRef["platform"];

type SessionRefFor<P extends RegisteredSurfacePlatform> = Extract<
  SessionRef,
  { platform: P }
>;

type MsgRefFor<P extends RegisteredSurfacePlatform> = Extract<MsgRef, { platform: P }>;
```

Do not add `SurfaceRefMap`, a second platform union, or placeholder ref variants. Add a compile-time
equality assertion and a contract test requiring `SessionRef["platform"]` and `MsgRef["platform"]` to
contain exactly the same set.

`AdapterPlatform` remains the event-bus wire enum. A value can be wire-valid while unsupported by the
running registry. Boundaries distinguish malformed values, recognized but unimplemented wire platforms,
registered adapters, and unavailable descriptor ports.

Do not derive runtime support from the broad wire enum.

## Adapter And Typed Seam Contract

Keep `SurfaceAdapter` unparameterized. Parameterizing it would spread generics through events, messages,
output streams, test fakes, and a heterogeneous registry while every wire and persistence crossing would
still require runtime validation.

Keep platform generics where `P` remains concrete:

```ts
type SurfaceRuntimeDescriptor<P extends RegisteredSurfacePlatform> = {
  readonly platform: P;
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress?: SurfaceAdapterIngress<P>;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly relay?: SurfaceRelayDescriptor<P>;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<P>;
};
```

Lifecycle methods and host-framework adapters remain separate from expected operation failures. User,
tool, and output-start operations return typed Results. Adapter-event subscription belongs to the narrow
descriptor ingress port; GitHub must not implement a meaningless no-op subscription merely to satisfy the
base adapter.

Every protocol adapter narrows refs at its entry. This includes:

- primary session and message refs;
- `SendOpts.replyTo`;
- `StartOutputOpts.replyTo`;
- every `StartOutputOpts.resume.created` ref;
- session/message pairs such as `markRead`;
- operation-specific nested refs added later.

A caller-supplied mismatch is an expected typed error. The adapter must not silently omit an invalid ref,
turn a cross-platform reply into a top-level message, return an empty collection, or report success without
performing the requested operation.

Every adapter-produced value is checked against the selected descriptor before publication, transcript
linking, workflow persistence, or snapshotting. This includes:

- `SurfaceMessage.ref` and `SurfaceMessage.session` from reads and lists;
- refs emitted through adapter events;
- refs emitted through `onMessageCreated`;
- `SurfaceOutputResult.created` and `SurfaceOutputResult.last`;
- workflow progress send results;
- refs restored from graceful snapshots.

A produced mismatch is an adapter contract defect and enters registered `Panic` supervision. It is not an
unsupported operation or a retryable provider failure.

Do not parameterize global `AdapterEvent`, `SurfaceMessage`, `StartOutputOpts`, `SurfaceOutputStream`, or
`SurfaceOutputResult`. Narrow descriptor ports and runtime guards preserve correlation without compatibility
casts.

## Operation Result Model

Fine-grained operations use one closed expected-error union. Unsupported behavior is returned as a value,
not thrown, rejected, converted to a no-op, or represented as an empty successful result:

```ts
class SurfaceOperationUnsupported extends TaggedError("SurfaceOperationUnsupported")<{
  readonly platform: RegisteredSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly message: string;
}> {}

class SurfacePlatformMismatch extends TaggedError("SurfacePlatformMismatch")<{
  readonly operation: SurfaceOperation;
  readonly refRole: string;
  readonly expectedPlatform: RegisteredSurfacePlatform;
  readonly receivedPlatform: AdapterPlatform;
  readonly message: string;
}> {}

class SurfaceSessionMismatch extends TaggedError("SurfaceSessionMismatch")<{
  readonly operation: SurfaceOperation;
  readonly refRole: string;
  readonly expectedSessionId: string;
  readonly receivedSessionId: string;
  readonly message: string;
}> {}

class SurfaceInvalidInput extends TaggedError("SurfaceInvalidInput")<{
  readonly platform: RegisteredSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly field: string;
  readonly message: string;
}> {}

class SurfaceOperationPartiallyCompleted extends TaggedError(
  "SurfaceOperationPartiallyCompleted",
)<{
  readonly platform: RegisteredSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly created: MsgRef;
  readonly message: string;
}> {}

type SurfaceOperationError =
  | SurfaceOperationUnsupported
  | SurfacePlatformMismatch
  | SurfaceSessionMismatch
  | SurfaceInvalidInput
  | SurfaceOperationPartiallyCompleted
  | SurfaceMessageNotFound
  | SurfacePermissionDenied
  | SurfaceRateLimited
  | SurfaceUnavailable;

type SurfaceOperationResult<T> = Result<T, SurfaceOperationError>;
```

The exact `SurfaceOperation` union covers every adapter operation used by shared relay, workflow, request
composition, and surface tools. Adding an operation extends this closed union and both adapter contract
fixtures in the same change. It includes detailed reaction and session-participant operations rather than
leaving them behind capability checks. Protocol-owned search indexing, healing, and storage remain separate
from adapter operations; shared query-facing services remain available outside the descriptor.

`SurfaceInvalidInput` owns expected malformed protocol identifiers, empty required content, and invalid
operation options after the platform boundary has decoded their outer shape.

`SurfaceOperationPartiallyCompleted` carries the operation and a created `MsgRef` when an external protocol
creates durable output before a later step fails. The descriptor-bound produced-ref guard validates that
ref before a caller observes it. Workflow progress maps a valid partial `send` outcome to
`WorkflowProgressSendFailure.created`; ordinary tool callers map it to a stable partial-completion failure
without repeating the operation blindly.

Immediate Discord and GitHub SDK adapters capture recognized protocol failures and map them to the exact
owned operation error. `Panic` remains preserved. Unrecognized exceptions remain defects rather than being
collapsed into unavailable or unsupported.

Callers switch exhaustively over `SurfaceOperationError`. Unsupported is permanent and non-retryable.
Permission, rate-limit, unavailable, and not-found keep separate policies.

Remove `signalSurfaceFailure` and private rejection-only adapter contract errors after every production
caller has migrated.

## Existing Adapter Normalization

### Discord

Discord becomes the complete streaming/gateway reference adapter:

- validate all primary and nested refs before Discord SDK or output-stream construction;
- reject a wrong-platform or wrong-session reply target rather than omitting it;
- return concrete Discord refs from protocol-owned constructors;
- map recognized Discord not-found, permission, rate-limit, and availability failures;
- preserve gateway adapter-event ingress, resumable output, skipped-output cleanup, search, aliases,
  allowlists, cache bursting, and reply-chain behavior in Discord modules;
- keep Discord search indexing/healing/storage and local surface storage outside the generic descriptor
  contract without making shared query-facing discovery APIs Discord-only.

### GitHub

GitHub becomes the complete webhook/buffered-output reference adapter:

- validate refs even when the requested operation is unsupported;
- replace no-op unread/mark-read behavior and empty list-sessions/reaction success with explicit unsupported
  Results;
- move currently supported surface-tool issue/comment CRUD, detailed reaction, and reaction mutation
  behavior behind typed GitHub adapter operations;
- keep safe reaction removal based on the authenticated outbound actor and concrete reaction IDs;
- make `sendMsg` reject unsupported replies and attachments, cursor modes, issue-body mutation, and session
  discovery with stable operation errors;
- make `startOutput` validate its reply target while preserving the existing GitHub textual reply-prefix
  behavior, and continue intentionally ignoring output-stream attachment parts;
- preserve webhook verification, request ingress, App authentication, acknowledgements, supersession, and
  rendering in GitHub modules.

These adapters may return different Results for the same operation. They must not use different operation
contracts or bypass the adapter seam from generic tools.

## Exact Relay And Produced-Ref Guards

Every surface-bound request, lifecycle event, cancellation, and reanchor selects exactly one active relay
descriptor by `request_client`. Missing values park pending; explicit `"unknown"` and unsupported but
wire-valid values match no descriptor. There is no compatibility broadcast.

The shared relay retains ownership of bus decoding, ordering, cursor recovery, text-phase state,
`NO_REPLY`, transcript linking, and terminal coordination. Protocol descriptors retain request-ID parsing,
reply semantics, finalization, acknowledgement cleanup, and protocol-specific skipped-output cleanup.

Before shared code records or publishes a ref, a descriptor-bound guard requires:

- ref platform equals descriptor platform;
- ref channel/session equals the relay session where the contract requires it;
- read/list message refs and their session refs agree;
- output `created` and `last` refs agree with the selected stream;
- adapter events agree with the descriptor that installed their ingress.

The registry exposes adapters to shared relay, workflow, request-composition, and tool callers only through
a descriptor-bound guarded facade. The facade validates session-list refs, read/list/reply-context message
pairs, reply-chain planner refs, partial-completion refs, output callbacks/results, and tool-returned refs.
Protocol adapters remain directly testable, but production shared callers do not bypass the facade.

The existing Discord request router remains explicitly Discord-owned. This plan does not generalize Discord
request composition into a cross-platform router.

## Authenticated Origins And Principals

The request-cache decoder continues accepting current Discord/GitHub `authenticatedActor`,
`authenticatedOrigin`, and GitHub trigger metadata. It projects those compatible wire forms into the
mapped internal origin union, including a correlated `sessionRef`.

Projection fails closed when:

- actor, origin, and request header platforms differ;
- actor and origin user IDs differ;
- the origin session differs from `headers.session_id`;
- message and session refs use different platforms or sessions;
- required user or identity fields are empty;
- GitHub trigger metadata conflicts with the projected message identity;
- a follow-up attempts to replace the first accepted origin with another identity.

When neither `authenticatedOrigin.userId` nor `authenticatedActor.userId` supplies a non-empty identity,
the request remains valid but produces no `AuthenticatedSurfaceOrigin` or principal. Discord requests with
`authenticatedOrigin.userId` remain authenticated without a parallel actor object. An explicitly present
empty identity is malformed and dead-letters.

Conflicting trusted-bus metadata dead-letters as a producer or compatibility defect. It must not merely
remove the principal while accepting the request as otherwise valid.

The request-cache origin, request-control capability, tool-server context, Level 1 context, subagent
delegation, workflow origin, and plugin-facing principal preserve one consistent
`(platform, userId, sessionId)` identity. When plugin compatibility retains the existing
`{ platform, userId }` principal shape, the surrounding request context supplies and validates the session.

Trusted safety policy uses this precedence while preserving current behavior:

1. An authenticated operator context keeps its existing operator policy and has no surface principal.
2. A dedicated heartbeat capability remains `trusted` and principal-less under its existing policy.
3. A valid request-control capability carries the already-resolved safety mode and is authoritative only
   after its platform, session, and principal agree with the cached request projection.
4. A server-owned GitHub request with validated verified-webhook trigger/header/session metadata is
   `trusted`; an omitted user identity prevents a principal but does not invalidate the verified ingress.
5. A server-owned Discord request with a validated origin uses the configured session override, then the
   configured parent-session override, then the existing `trusted` default for a known Discord session.
6. Unknown sessions, absent or unverified origins, unimplemented platforms, and every non-operator context
   not matched above are `restricted`.

Conflicting identity metadata dead-letters before this policy runs and therefore can never downgrade into
an unauthenticated but trusted request.

## Tools And Protocol Operations

Generic surface tools resolve only registered Discord/GitHub adapters. The request context remains
authoritative when it names a registered surface; an explicit conflicting `--client` fails closed.

The generic tool module:

- constructs normalized tool inputs and platform-bound refs through protocol-owned helpers;
- selects the registered adapter through a narrow registry-derived resolver;
- invokes the operation directly;
- maps every `SurfaceOperationError` once at the server-tool compatibility boundary;
- preserves existing callable input/output wire shapes;
- lists registered platforms in help without predicting operation support.

The generic module must not import GitHub REST helpers or branch into Discord/GitHub SDK behavior. Discord
allowlists and aliases remain an authorization/identity adapter around Discord operations. GitHub reaction
translation, actor resolution, IDs, and auth remain inside the GitHub operation module.

Search ownership is split deliberately:

- `DiscordSearchStore`, `DiscordSearchService`, the adapter-event indexer, healing, and the deprecated
  `surface.messages.search` path remain Discord-owned sidecars, not generic adapter operations;
- `DiscoveryService` and `discovery.search` remain shared query-facing application services; Discord search
  rows are one current conversation source, alongside transcript, prompt, and heartbeat sources;
- `ConversationThreadService` and `conversation.thread.*` remain separately owned and explicitly
  Discord-derived today, despite being public tools;
- public tool exposure does not make indexing lifecycle, storage, or search implementation a descriptor
  port.

A future platform can contribute normalized conversation documents through a separately reviewed discovery
ingestion boundary. It does not register its search database, indexer lifecycle, or protocol query semantics
on `SurfaceRuntimeDescriptor`.

Portable MCP and deferred-tool persistence retain their existing broad wire-compatible readers. Surface
adapter execution resolves only registered Discord/GitHub platforms and never treats a decoded historical
wire value as an installed adapter. Any future restriction on new persisted writes requires its own
versioned compatibility decision; this plan does not narrow existing persisted codecs.

## Workflow Progress Contract

Both descriptors currently declare workflow progress, so both must satisfy the complete durable
progress/action contract.

The generic send failure algebra permits partial creation for every concrete platform:

```ts
type WorkflowProgressSendFailure<P extends RegisteredSurfacePlatform> =
  | { readonly kind: "created"; readonly ref: MsgRefFor<P> }
  | { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed };
```

Discord may never emit `created`; GitHub currently can. The generic type must not encode GitHub as the only
protocol capable of partial creation.

Workflow ports consume adapter operation Results rather than catch provider exceptions. A declared port
classifies failures as permanent or retryable. Unsupported from a declared workflow port is a permanent
descriptor/configuration defect and must not enter an unbounded retry loop.

Durable workflow decoding and authorization require agreement among:

- run origin client and session;
- progress target platform and channel;
- persisted surface binding and message ref;
- persisted action expected platform and message ref;
- incoming action event platform, actor, and message ref.

Existing valid records remain readable. Corrupt cross-field combinations fail closed or use an explicitly
documented existing repair path. Action state changes, action consumption, and workflow outbox records
remain atomic.

The shared renderer and Discord timestamp branch remain. Discord button and GitHub textual-command
rendering/ingress stay protocol-owned. Workflow reply waits remain Discord-only.

## Graceful Restart And Persistence

Graceful snapshots are centralized persisted data, not dynamic descriptor schemas. The codec validates the
complete snapshot before registry dispatch.

The hardened current/v3 contract requires:

- relay platform equals `requestClient`;
- relay platform equals `replyTo.platform` when present;
- every `createdOutputRefs` and `activeOutputRefs` entry matches the relay platform;
- refs that belong to the active relay session use that session;
- the selected descriptor and active relay handle agree with the decoded platform.

Snapshot v3 requires `requestClient`. Retain v1 and v2 decoders and fixtures. For a valid legacy relay,
normalize a missing `requestClient` to `platform`; an explicit disagreement is corrupt. Do not rewrite
storage as a side effect of decoding. Keep unsupported versions, malformed serialization, corrupt fields,
and unavailable restore targets distinct.

Restore preflights the complete snapshot by `(requestId, platform, sessionId)` before starting any relay or
agent restoration. The policy is all-or-nothing for snapshot admission: if any required descriptor or relay
port is unavailable, restore nothing and return a typed unavailable outcome.

Relay restoration uses attempt handles with explicit apply and rollback operations. Agent recovery starts
only after every relay attempt applies successfully. If an apply fails, Core rolls back every relay state
created by that attempt and retains the snapshot. A rollback failure leaves recovery atomicity unknown and
is a registered `Panic`. Restore operations are idempotent by request identity so an unconsumed snapshot can
be retried safely.

Replace the destructive load-and-consume read with a read-only load plus explicit disposition operations:

- absent rows require no write;
- empty and stale snapshots are explicitly consumed after classification;
- successfully restored snapshots are consumed after relay and agent restoration completes;
- valid unavailable snapshots and retryable restore failures remain completed for retry or operator action;
- malformed, corrupt, and unsupported-version rows remain retained, return their distinct persisted-data
  error, and require explicit operator clear or repair;
- SQLite read failures perform no disposition write.

Transcript storage already supports generic surface links. Add no migration unless a changed constraint or
shape requires one. Preserve historical Discord-only primary-run continuation rows and SQL checks.
Protocol-owned search databases are not migrated by this plan.

## Output Contract

The output stream owns protocol rendering, chunking, rate limits, preview behavior, native reply syntax,
attachments, controls, and abort cleanup. A relay-participating output stream accepts every normalized
`SurfaceOutputPart`; it may intentionally ignore optional presentation parts with no protocol
representation.

The relay pushes reasoning, tool status, stats, and attachments to the output stream. Required semantics
such as recoverable resume, observable output creation, final text mode, and skipped-output cleanup remain
explicit output-stream or relay-port contracts.

Caller-supplied output refs are validated before stream construction. Callback and finish-result refs are
validated at the descriptor seam before they affect bus events, transcripts, or recovery state.

## Configuration

This plan adds no surface configuration. Existing Discord and GitHub availability remains subsystem
specific. GitHub App credentials, webhook credentials, relay availability, and workflow progress must not
be collapsed into one enabled flag.

A descriptor exposes a structural port only when the complete port contract is available. An adapter
operation whose external dependency is temporarily unavailable returns `SurfaceUnavailable`.

Keep the v1 Core config input shape frozen. No generic opaque `surfaces: Record<string, unknown>` is added.

## Architecture Enforcement

Every new or moved external decoder, projection, persistence codec, compatibility output, exception
adapter, or `Panic` site receives its exact architecture registration.

Expected impact includes:

- `scripts/architecture/manifest.ts`;
- Core boundary and exception identity catalogs;
- the derived exception-adapter approval hash when exception mechanics change;
- architecture checker fixtures and exact-identity tests.

The descriptor registry is not a broad architecture exemption. Protocol modules remain responsible for
their external and persistence boundaries.

## Implementation Sequence

### Stage 1: Canonical Types And Operation Algebra

- Add the session/message platform-set equality assertion and contract test.
- Define the closed operation and error unions with `better-result` tagged errors.
- Enumerate all shared operations, including detailed reactions, session participants, invalid input, and
  partial completion.
- Add compile-time contract fixtures without changing the implemented adapter interface yet.

Exit criteria: Core typechecks with the new algebra unused by production adapters; no new platform type or
ref map exists.

### Stage 2: Discord And GitHub Adapter Normalization

- Migrate every Discord operation to the common Result contract and validate all nested refs.
- Migrate every GitHub operation to the common Result contract.
- Atomically change the base adapter interface, both implementations, production callers, and test fakes.
- Separate adapter-event subscription from the base adapter lifecycle contract.
- Move currently supported GitHub CRUD and detailed reaction behavior behind GitHub adapter operations.
- Replace unsupported no-ops, empty successes, and private rejected-Promise errors.
- Add deterministic SDK/API classification tests for both protocols.

Exit criteria: both adapters expose the same operation contract, preserve their existing supported
behavior, and return stable unsupported Results for absent behavior.

### Stage 3: Descriptor-Bound Produced-Ref Guards

- Guard adapter-event platform identity before bus publication.
- Add the descriptor-bound guarded facade used by all shared production callers.
- Guard session lists, read/list/reply-context results, reply-chain refs, partial completion, output
  callbacks, finish results, workflow sends, and tool-returned refs.
- Guard snapshot collection and direct relay restore inputs.
- Register and test the exact contract-defect `Panic` sites.
- Remove duplicated protocol-specific output-platform checks after the shared guard owns them.

Exit criteria: no adapter-produced ref reaches publication or persistence before descriptor correlation is
validated.

### Stage 4: Registry-Selected Surface Tools

- Inject a narrow registry-derived adapter resolver into the surface tool.
- Route generic session, message, and reaction operations through the selected adapter.
- Remove GitHub REST imports and protocol operation branches from the generic tool module.
- Preserve Discord authorization/alias adaptation and protocol-owned sidecars.
- Narrow help and executable adapter resolution to registered platforms without narrowing compatible
  persistence readers or adding a support matrix.

Exit criteria: generic surface tools select an adapter and handle operation Results; existing tool wire
fixtures remain compatible.

### Stage 5: Authenticated Origin And Principal Consistency

- Add the mapped internal authenticated-origin union.
- Preserve and decode current Discord/GitHub raw wire forms.
- Dead-letter malformed and conflicting actor/origin/header identities.
- Compare cache origins with request-control capabilities before assigning principals.
- Propagate the validated identity through tool, Level 1, plugin, workflow, and subagent contexts.
- Implement the explicit operator, capability, GitHub ingress, Discord config, and restricted-default safety
  precedence.

Exit criteria: every principal-bearing context preserves one Discord/GitHub platform, user, and session
identity; legacy successful fixtures still project correctly.

### Stage 6: Workflow Port And Durable Correlation

- Generalize partial-send recovery without a GitHub conditional type.
- Consume operation Results in both workflow progress ports.
- Separate permanent descriptor errors from retryable protocol failures.
- Validate binding, action, origin, target, actor, and ref correlation at durable boundaries.
- Preserve repair, action authorization, and transactional outbox behavior.

Exit criteria: Discord and GitHub workflow progress pass the same port contract tests and no declared
unsupported operation retries indefinitely.

### Stage 7: Versioned Recovery Hardening

- Add centralized relay snapshot correlation decoding.
- Add v3 with required `requestClient`; normalize missing legacy values to relay platform.
- Retain valid v1/v2 readers, provenance, and fixtures without read-time rewrites.
- Define unavailable descriptor/relay restoration as an explicit typed outcome.
- Preflight complete snapshots and add apply/rollback restore-attempt handles.
- Roll back partial relay application before agent restore; Panic if rollback leaves atomicity unknown.
- Consume snapshots explicitly only after successful restoration; retain unavailable snapshots.
- Define explicit absent, empty, stale, malformed, corrupt, unsupported, and SQLite-failure dispositions.
- Preserve transcript and Discord primary-continuation compatibility.

Exit criteria: current, legacy, malformed, corrupt, unsupported-version, and unavailable-target cases have
explicit Discord/GitHub fixtures and policies.

### Stage 8: Shared Contract Harness And Documentation

- Run one parameterized descriptor/adapter harness against Discord and GitHub.
- Cover startup rollback, connection loss, ingress shutdown, relay drain, exact selection, cancellation,
  reanchor, output creation, finalization, cleanup, workflow progress, snapshot, and restore.
- Keep protocol-specific integration tests deterministic and credential-free.
- Update `PROJECT.md`, architecture documentation, and tool help.
- Run repository-wide tests, typechecking, architecture checks, lint, and formatting.

Exit criteria: both existing adapters are complete reference implementations and all focused and
repository-wide validation passes.

## Blast Radius

Expected production changes span:

- `apps/core/src/surface/adapter.ts` and `apps/core/src/surface/types.ts`;
- `apps/core/src/surface/runtime-descriptor.ts`;
- Discord and GitHub adapters, output streams, descriptors, and protocol exception adapters;
- shared adapter-event and output relay bridges;
- surface tools and their runtime dependency injection;
- request cache, request-control authority, tool context, bus runner, and subagent propagation;
- workflow domain codecs, stores, progress projector, and action resolver;
- graceful-restart persistence and restore lifecycle;
- plugin runtime request types and portable MCP projections where required;
- exact architecture registrations and approval catalogs.

Test impact includes adapter, descriptor, relay, tool, request-cache, control, runner, workflow, restart,
transcript compatibility, plugin, MCP, and architecture suites.

This is expected to touch roughly 30 to 50 production and test files. Most churn comes from replacing the
legacy Promise adapter contract and removing direct GitHub tool API dispatch, not from adding platform
types or configuration.

## Risks

### Critical: Trusted Principal Misprojection

Redis is trusted, so a structurally valid normalized origin is authoritative downstream. Require exact
platform, user, session, and ref consistency before assigning a principal or trusted safety context.

### Critical: Persisted Recovery Incompatibility

Stronger snapshot invariants can reject old data that was previously accepted independently. Retain valid
v1/v2 fixtures, version changed current contracts, and distinguish corrupt data from unavailable runtime
ports.

### High: Broad Adapter Ref Mismatch

An unparameterized adapter can receive or produce another platform's ref. Validate every primary, nested,
callback, output, workflow, and restored ref at the protocol and descriptor seams.

### High: Tool Behavior Drift

Moving GitHub API behavior from the generic tool into its adapter can change formatting, auth, reaction
removal, or issue/comment distinctions. Preserve literal tool fixtures and move one operation family at a
time.

### High: Workflow Authorization Drift

Tightening persisted correlation without preserving repair and atomic authorization can strand progress or
consume the wrong action. Change projector, store, and resolver together.

### High: False Support From The Wire Enum

The event-bus enum includes unimplemented values. Use the closed ref union and registry for executable
surface support.

### Medium: Plugin API Compatibility

`RequestContext.authenticatedPrincipal` is plugin-facing. Preserve its existing Discord/GitHub wire shape
unless a coordinated compatibility change is required, and keep session correlation in the surrounding
context.

## Non-Goals

- Adding or selecting a third platform.
- Adding a descriptor, ref variant, wire enum value, protocol module, or config for a future platform.
- Writing the future platform-addition plan in this scope.
- Introducing `SurfaceRefMap` or parameterizing the entire adapter/event/message/output graph.
- Loading surface descriptors dynamically.
- Adding capability metadata or operation-support matrices.
- Treating every `AdapterPlatform` value as implemented.
- Signing messages inside trusted Redis or re-authenticating actors at every consumer.
- Making descriptor membership redefine persisted codecs dynamically.
- Generalizing Discord request routing or workflow reply waits.
- Moving Discord search indexing/storage, GitHub webhook verification, rendering, pagination, or protocol
  auth into generic modules; shared discovery query interfaces remain generic.
- Requiring Discord and GitHub to support identical optional operations.

## Acceptance Criteria

- Discord and GitHub pass one shared adapter/descriptor contract harness.
- `RegisteredSurfacePlatform` remains derived from `SessionRef`, and session/message platform sets are
  exactly equal.
- `SurfaceAdapter` remains unparameterized while descriptor ports preserve concrete platform correlation.
- User and tool operations return the closed `SurfaceOperationResult` algebra.
- Unsupported behavior is explicit and stable; no adapter represents it as a no-op or empty success.
- Every caller-supplied primary and nested ref is validated before protocol access.
- Every adapter-produced ref is descriptor-validated before publication, transcript linking, workflow
  persistence, or snapshotting.
- Shared production callers obtain adapters through the descriptor-bound guarded facade.
- Generic surface tools resolve registered adapters and import no GitHub REST operation helpers.
- Existing Discord/GitHub surface-tool inputs and successful output fixtures remain compatible.
- Existing Discord/GitHub authenticated-origin wire forms project into one correlated internal union.
- Conflicting principal identities fail closed before trusted tool, control, workflow, or subagent use.
- Workflow progress ports use the shared Result contract and distinguish permanent from retryable failures.
- Workflow bindings, actions, origins, targets, actors, and refs preserve platform/session correlation.
- Every relay snapshot has correlated platform, request client, session, and nested refs.
- Legacy snapshots normalize a missing request client to relay platform and reject explicit disagreement.
- Restorable snapshots consume only after successful restoration; empty and stale snapshots consume after
  classification, while unavailable and failed restorations remain retained.
- Existing valid wire and persisted fixtures remain supported, including previous snapshot versions.
- Protocol-specific storage, search, verification, rendering, pagination, and cleanup remain protocol-owned.
- No third platform, speculative platform config, or persisted platform value is added.
- Focused and repository-wide validation passes.
