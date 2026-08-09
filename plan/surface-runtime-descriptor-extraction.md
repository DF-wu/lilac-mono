# Surface Runtime Descriptor Extraction

Status: proposed production-behavior-preserving refactor with malformed-header hardening.

This is Part 1 of the surface extension work. Part 2 is
`plan/third-platform-surface-readiness.md`.

Part 1 centralizes the runtime composition of the existing Discord and GitHub surfaces without claiming
that another `AdapterPlatform` is supported. It preserves current wire formats, persisted data, external
plugin contracts, protocol behavior, and the closed Discord/GitHub reference model.

## Outcome

Core owns one closed registry of the currently implemented surface runtimes. That registry drives:

- adapter connection and disconnection;
- adapter-event ingress publication;
- independently hosted ingress such as the GitHub webhook;
- bus-to-adapter output relay startup;
- workflow-progress adapter selection;
- graceful relay drain, snapshot collection, and restore dispatch;
- surface shutdown.

Adding or changing an existing surface's runtime wiring should happen in its descriptor rather than by
adding another platform branch to `create-core-runtime.ts`, `publish-to-bus.ts`,
`subscribe-from-bus.ts`, or `workflow-progress-projector.ts`.

Part 1 does not widen any platform-bearing persisted or plugin-facing contract. The only registered
platforms remain Discord and GitHub.

## Current Baseline

The current runtime is split into Discord singleton variables and GitHub singleton variables:

- `apps/core/src/runtime/create-core-runtime.ts` constructs `DiscordAdapter` and `GithubAdapter`
  separately, retains separate ingress and relay handles, builds a hard-coded workflow adapter map, and
  branches during graceful restore, drain, snapshot collection, and shutdown.
- `apps/core/src/surface/bridge/publish-to-bus.ts` is mostly platform-neutral but imports five event
  projections from `discord-adapter.ts`.
- Those projections at the end of
  `apps/core/src/surface/discord/discord-adapter.ts` hard-code `platform: "discord"` even though their
  inputs are normalized surface messages and references.
- `apps/core/src/surface/bridge/subscribe-from-bus.ts` is a shared output state machine, but it owns
  Discord request-ID parsing and reasoning behavior plus GitHub supersession and acknowledgement cleanup.
- `apps/core/src/workflow/workflow-progress-projector.ts` uses generic surface CRUD operations but
  constructs refs and selects adapters through explicit Discord/GitHub branches.
- Discord ingress arrives through `SurfaceAdapter.subscribe()`. GitHub request ingress bypasses
  `subscribe()` and publishes from a separately hosted, signature-verified webhook server.
- Discord search, local surface storage, conversation-thread materialization, and request composition are
  intentionally Discord-owned services.
- `SurfaceAdapter.getCapabilities()` has no production call sites, and its GitHub reaction declaration
  already disagrees with runtime behavior. The declaration, implementations, and test fakes are dead.
- The current output relay tolerates a missing `request_client` even though every first-party production
  publisher supplies it. That tolerance can route one malformed event to multiple surface relays.
- `bus-request-router` is Discord-specific throughout request composition and publishes literal Discord
  headers. Its broad adapter input must not be mistaken for a reusable cross-platform router.

These asymmetries mean a descriptor cannot be only `{ platform, adapter }`. It must expose independent
ports for the subsystems a surface actually participates in.

## Trusted Redis Decision

Redis is trusted infrastructure in the same sense as the main database. A publisher with access to the
Core bus is within the trusted deployment boundary. Part 1 does not add signatures, provenance tokens,
or platform re-authentication between bus producers and consumers.

Redis messages remain process and serialization boundaries. Receivers continue decoding complete
messages because trusted storage can contain malformed, stale, corrupt, or older-version data. Platform,
session, and ref consistency checks remain correctness and compatibility invariants rather than defenses
against a hostile Redis server.

External authentication remains protocol-owned:

- Discord identity comes from the authenticated gateway connection and decoded Discord SDK values.
- GitHub identity comes from verified webhook signatures and decoded webhook payloads.
- A descriptor declaration alone never authenticates an external actor.

## Terminology

### Registered Surface Platform

`RegisteredSurfacePlatform` is the closed set implemented by Core in Part 1:

```ts
type RegisteredSurfacePlatform = SessionRef["platform"];
```

It is currently `"discord" | "github"`. It is deliberately narrower than the event-bus
`AdapterPlatform`, which also contains wire-level placeholders for WhatsApp, Slack, Telegram, web, and
unknown.

### Descriptor

A descriptor is Core-owned runtime composition metadata. It is not a dynamic plugin API and does not
make persistence, authentication, or protocol schemas open-ended.

### Ingress Categories

Ingress has two lifecycle categories:

- Adapter-event ingress subscribes to normalized `AdapterEvent` values and must be installed before an
  adapter connection can emit events.
- Request ingress is independently hosted, such as a GitHub webhook, and publishes normalized requests
  directly after its external protocol boundary verifies and decodes them.

The two categories must not be collapsed into `SurfaceAdapter.subscribe()`. GitHub intentionally has no
adapter-event subscription path.

## Part 1 Descriptor Contract

Use the existing closed ref union to bind descriptor policies without yet changing the public
`SurfaceAdapter` interface:

```ts
type SessionRefFor<P extends RegisteredSurfacePlatform> = Extract<
  SessionRef,
  { platform: P }
>;

type MsgRefFor<P extends RegisteredSurfacePlatform> = Extract<MsgRef, { platform: P }>;

type SurfaceRuntimeDescriptor<P extends RegisteredSurfacePlatform> = {
  readonly platform: P;
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress?: SurfaceAdapterIngress<P>;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly relay?: SurfaceRelayDescriptor<P>;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<P>;
};
```

The registry validates unique platform keys and verifies during startup that `getSelf()` identifies the
descriptor platform. `SurfaceAdapter` remains unparameterized in both parts; platform generics stay at
the descriptor ports where the platform remains concrete.

### Relay Descriptor

The relay descriptor provides narrow policy to the shared bus/output state machine:

```ts
type ReplyTargetResolution<T> =
  | { readonly kind: "none" }
  | { readonly kind: "target"; readonly ref: T }
  | { readonly kind: "invalid"; readonly error: SurfaceReplyTargetInvalid };

type SurfaceRelayDescriptor<P extends RegisteredSurfacePlatform> = {
  readonly refs: {
    createSessionRef(sessionId: string): SessionRefFor<P>;
    resolveInitialReplyTarget(input: {
      requestId: string;
      sessionId: string;
    }): ReplyTargetResolution<MsgRefFor<P>>;
    decodeReanchorTarget(input: {
      ref: SurfaceMsgRef;
      expectedSessionId: string;
    }): Result<MsgRefFor<P>, SurfaceRefInvalid>;
  };
  readonly finalization?: SurfaceRelayFinalization<P>;
};
```

Use `relay` or `refs`, not `routing`, for this port. In this codebase, routing means the Discord policy
that turns adapter messages into agent requests.

`SurfaceRelayFinalization` must expose only named operations needed by current behavior:

- determine whether a final GitHub response is superseded;
- clear the exact GitHub ingress acknowledgement at the existing terminal points;
- clean up surface output created before a skipped final response when stream abort alone cannot provide
  the required behavior.

Do not add arbitrary `beforeFinish`, `afterFinish`, or generic cleanup hooks. Core owns ordering,
serialization, logging, transcript linking, and failure policy.

### Structural Ports And Runtime Operations

Descriptor port presence is authoritative only for coarse subsystem participation:

- `adapterIngress` means the surface participates in normalized adapter-event ingress;
- `requestIngress` means it hosts independent request ingress;
- `relay` means it participates in request output delivery and relay recovery;
- `workflowProgress` means it supports the complete durable workflow-progress contract.

There is no capability-advice layer. Remove `SurfaceAdapter.getCapabilities()` and
`AdapterCapabilities`. Level 2 help may list registered platforms, but it does not predict which
fine-grained operations will succeed.

The adapter call is authoritative. Part 1 preserves the existing operation result contract while Part 2
introduces a typed `SurfaceOperationUnsupported` result for optional user/tool operations.

Prefer making `SurfaceOutputStream.push()` total over all `SurfaceOutputPart` members. An adapter may
render or intentionally ignore reasoning, tool status, stats, attachments, or another optional
presentation part. `startOutput`, `push`, `finish`, and `abort` are mandatory for a descriptor that
provides a relay. The output stream owns rendering or intentional omission without a capability flag.

Recovery, exact terminal finalization, acknowledgement cleanup, and durable workflow participation are
structural descriptor contracts because Core must know their semantics before it creates or restores
durable work.

### Workflow Progress Port

The projector already uses generic `readMsg`, `sendMsg`, and `editMsg` operations. Existing Discord and
GitHub refs have the same persisted minimum shape, action rendering already belongs to adapters, and the
single Discord timestamp formatter can remain a local presentation branch with ISO as the default.

The real protocol leak is failure classification: the projector currently imports GitHub error classes
to distinguish `created(ref)`, `not-found`, and ordinary failure. Part 1 replaces those raw exceptions
with a narrow protocol-owned Result adapter:

```ts
type WorkflowProgressCheckFailure = {
  readonly kind: "failed";
  readonly error: WorkflowProgressOperationFailed;
};

type WorkflowProgressSendFailure<P extends RegisteredSurfacePlatform> =
  | { readonly kind: "created"; readonly ref: MsgRefFor<P> }
  | { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed };

type WorkflowProgressEditFailure =
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed };

type SurfaceWorkflowProgressPort<P extends RegisteredSurfacePlatform> = {
  checkMessage(...): Promise<Result<"found" | "missing", WorkflowProgressCheckFailure>>;
  send(...): Promise<Result<MsgRefFor<P>, WorkflowProgressSendFailure<P>>>;
  edit(...): Promise<Result<void, WorkflowProgressEditFailure>>;
};
```

The port remains optional and promises the complete current workflow-progress contract, including action
rendering and ingress. There is no separate action-support declaration. Protocol modules capture their
SDK failures immediately; the projector sees no provider error class or domain-bearing `unknown`.

## Lifecycle Contract

The runtime manager owns phase ordering. Descriptors contribute operations but cannot reorder global
startup or shutdown.

Required startup invariants:

1. Initialize Core stores and shared dependencies before descriptor operations use them.
2. Install adapter-event ingress before connecting an adapter that can immediately emit events.
3. Preserve existing request-cache, workflow-consumer, router, and adapter ordering during the first
   extraction. Any correction to observed ordering is a separate behavior change with dedicated tests.
4. Start each enabled bus-to-adapter relay before the agent runner can publish output for that surface.
5. Start independently hosted request ingress only at its declared phase after required downstream
   consumers exist.
6. Record each completed startup operation immediately so partial startup cleanup owns exactly the
   resources that were created.

Required graceful-shutdown invariants:

1. Stop request ingress and adapter-event ingress before beginning output drain.
2. Stop request-producing shared services before snapshotting active work.
3. Begin drain on every active relay and the agent runner.
4. Collect all relay snapshots through the registry without changing their persisted representation.
5. Persist one combined graceful snapshot using the existing codec.
6. Stop remaining services and disconnect adapters in deterministic reverse ownership order.
7. Preserve the existing expected cleanup failure policy and Panic supervision.

GitHub availability is per subsystem. App credentials, webhook credentials, output relay availability,
workflow projection, and no-op adapter connection must not be collapsed into one `enabled` boolean. A
GitHub descriptor factory may omit unavailable ports after resolving configuration, while retaining the
ports that remain valid.

## Generic Adapter-Event Projection

Move the five `toBusEvtAdapter*` functions into a platform-neutral surface bridge module before wiring
descriptors through adapter-event ingress.

The projection must:

- derive platform from the normalized event/ref rather than writing `"discord"`;
- require event, session, and message-ref platforms to agree;
- preserve all current event types, field names, headers, `raw` values, and timestamps;
- keep command-specific Discord metadata, such as `discord-slash`, in the Discord command projection;
- remain an internal typed projection rather than inspect an external SDK value.

The Discord adapter remains responsible for SDK decoding, partial hydration, allowlisting, mentions,
reply semantics, and its closed raw projection.

## Shared Relay Boundary

`bridgeBusToAdapter` retains ownership of:

- subscriptions to `cmd.request`, `cmd.surface`, `evt.request`, and `out.req.<requestId>`;
- exact `request_client` selection;
- relay serialization and reanchor serialization;
- output cursor tracking and graceful recovery state;
- text phase, final-text, and `NO_REPLY` handling;
- transcript linkage and output-created event publication;
- idle timeout, drain, stop, and snapshot mechanics;
- cleanup supervision and delivery error policy.

Descriptors own only protocol decisions:

- session/ref construction and request-ID reply-target interpretation;
- final-delivery supersession policy;
- acknowledgement cleanup;
- protocol-specific cleanup of partially created output.

The relay pushes normalized output parts to the selected output stream. The output stream renders or
intentionally ignores optional presentation parts. Unsupported generic CRUD/tool operations are outside
the relay and become typed runtime operation results in Part 2.

`request_client` is required alongside `request_id` and `session_id` for the three relay-consumed event
paths. Missing values use the existing required-header error category and `park-pending`; explicit
`"unknown"` continues to mismatch every surface relay for workflow and heartbeat requests.

The generic relay must no longer import Discord request-ID helpers, GitHub API functions, or GitHub
process-local state.

## Protocol-Owned Sidecars And Non-Goals

Part 1 does not place these systems into the generic descriptor contract:

- Discord search and `DiscordSearchStore`;
- `DiscordSurfaceStore` and Discord entity mapping;
- conversation-thread materialization or summarization;
- Discord reply-chain composition, merge windows, raw normalization, aliases, or pagination;
- GitHub webhook signature verification, trigger grammar, API authentication, or protocol rendering;
- platform-specific surface tools;
- workflow reply waits, which remain intentionally Discord-only;
- configuration schemas for hypothetical surfaces;
- dynamic external surface plugins.

Protocol-owned runtime modules may construct sidecars and return narrow handles to Core, but generic
interfaces must not pretend their storage or semantics are portable.

Runtime health remains one such concrete escape hatch. Core's existing health aggregation continues to
read `DiscordAdapter.getHealthSnapshot()` and Redis/runtime state directly. Do not add a descriptor health
port until a second surface has a real, comparable health signal.

The request router is another protocol-owned subsystem. Part 1 gives it a Discord-specific public input
type and Discord-owned module/name, with a runtime invariant as additional defense. It does not thread a
generic platform only through publish headers while request composition remains Discord-specific. A
future platform that needs message routing requires a separate routing design in Part 2.

## Implementation Sequence

### Stage 0: Groundwork

- Remove `SurfaceAdapter.getCapabilities`, `AdapterCapabilities`, both production implementations, and all
  test fakes.
- Verify and remove the unused `hasAuthoritativeSelfMessageProvider` contract while retaining the used
  reply-chain-planner and cache-burst structural providers.
- Require `request_client` in the `cmd.request`, `cmd.surface`, and `evt.request` relay consumers; park a
  missing value and add exact-match/missing-header tests.
- Add focused tests for Discord skipped-output cleanup, reasoning replay, GitHub supersession, GitHub
  acknowledgement cleanup, and workflow progress actions before moving policy.
- Characterize that GitHub acknowledgement cleanup runs on skip, empty output, and finish but deliberately
  not on supersession.
- Give the router a Discord-specific public input type and Discord-owned module/name; retain its literal
  Discord headers and add a hard invariant as defense in depth.

Keep Stage 0 in one groundwork PR with reviewable commits for dead-contract deletion, strict relay
headers, and relay-finalization characterization. It is not a separate architectural part.

### Stage 1: Lifecycle Characterization

- Add parity tests for registry uniqueness, startup operation order, partial-start cleanup, connection,
  relay activation, graceful drain, combined snapshots, restore dispatch, and reverse shutdown.

### Stage 2: Generic Event Projection

- Move generic adapter-message/reaction bus projections out of `discord-adapter.ts`.
- Preserve literal event compatibility fixtures and add platform-consistency tests.
- Update exact architecture registrations if projection ownership changes require them.

### Stage 3: Descriptor Types And Existing Registrations

- Add descriptor, relay-policy, workflow-progress, ingress-handle, and registry types.
- Add Discord and GitHub descriptor factories.
- Validate duplicate registrations and adapter-reported platform mismatches.
- Keep the registry Core-owned and closed to the existing `SessionRef` platform union.

### Stage 4: Runtime Lifecycle Migration

- Replace separate adapter/relay/ingress handle variables with maps keyed by registered platform.
- Drive connection, disconnection, relay startup, drain, snapshots, restore, and stop through registry
  iteration.
- Preserve Discord-only sidecar ownership and its two currently distinct `DiscordSurfaceStore` handles.
- Preserve subsystem-specific GitHub availability and logging.

### Stage 5: Relay Policy Extraction

- Move Discord and GitHub reply-target parsing into their descriptor policies.
- Move GitHub supersession and acknowledgement cleanup behind narrow finalization operations.
- Move or contractually assign Discord skipped-output cleanup to the Discord output stream or relay policy.
- Push normalized optional presentation parts to each output stream; require adapters to render or
  intentionally ignore them.
- Remove protocol imports and platform branches from the shared relay while preserving its state machine.

### Stage 6: Workflow Migration

- Derive narrow Result-returning workflow progress ports from descriptors.
- Remove direct GitHub error imports from `workflow-progress-projector.ts` without widening durable
  workflow schemas, action authorization, or renderer abstractions.
- Keep the existing Discord timestamp formatting branch and generic ISO fallback until another platform
  has a concrete presentation requirement.

### Stage 7: Verification And Documentation

- Run focused surface bridge, adapter, webhook, runtime, workflow, and graceful-restart tests.
- Run `bun run test:all`, `bun run typecheck`, `bun run lint:fix`, and `bun run fmt`.
- Update `PROJECT.md` with the descriptor registry and the distinction between registered Core surfaces
  and wire-level `AdapterPlatform` values.
- Document that Part 2 is required before registering a third platform.

## Blast Radius

Expected direct production changes:

- `apps/core/src/surface/adapter.ts` and `apps/core/src/surface/types.ts` for dead capability deletion;
- `apps/core/src/runtime/create-core-runtime.ts`;
- `apps/core/src/surface/bridge/publish-to-bus.ts`;
- `apps/core/src/surface/bridge/subscribe-from-bus.ts`;
- `apps/core/src/surface/discord/discord-request-router.ts` and
  `apps/core/src/surface/discord/discord-request-router/publish.ts` for Discord-owned routing;
- `apps/core/src/surface/discord/discord-adapter.ts` for capability deletion and projection movement;
- `apps/core/src/surface/github/github-adapter.ts` for capability and dead-provider deletion;
- GitHub acknowledgement/latest-request state integration;
- `apps/core/src/workflow/workflow-progress-projector.ts`;
- new descriptor/registry modules under `apps/core/src/surface/`;
- exact architecture registrations for moved projections or exception adapters.

Expected test impact includes runtime, publish bridge, output relay, Discord adapter, GitHub adapter/webhook,
workflow progress, graceful restart, and architecture tests.

No event-bus wire schema, persisted snapshot schema, transcript schema, workflow schema, request-principal
schema, plugin contract, or Core config version should change in Part 1.

Stage 0 is the first PR in the Part 1 stack, not a separate Part 0 plan.

## Risks

### High: Lifecycle Reordering

A generic loop can connect an adapter before subscriptions are installed or stop a relay before its
snapshot is captured. The lifecycle manager must use explicit phases and characterization tests rather
than descriptor declaration order alone.

### High: Relay Behavior Drift

GitHub acknowledgement cleanup and supersession occur at exact terminal points. Discord reasoning and
skipped-output behavior interact with restore and reanchor state. Move one policy at a time while keeping
the shared state machine unchanged.

### High: False Platform Support

Using `AdapterPlatform` as the registry key would make existing wire placeholders appear implemented.
Part 1 keys the registry by the existing `SessionRef` platform union.

### Medium: Resource Ownership Confusion

Core and `DiscordAdapter` currently open distinct Discord surface-store handles. Descriptor extraction
must not merge, transfer, or double-close those handles without a separate storage design.

## Acceptance Criteria

- Dead `getCapabilities`, `AdapterCapabilities`, and authoritative-self-provider contracts are removed.
- Every relay-consumed event requires exact `request_client`; missing values park pending.
- Core has exactly one closed descriptor registry for Discord and GitHub.
- `create-core-runtime.ts` no longer owns separate Discord/GitHub relay lifecycle branches.
- Generic adapter-event projections no longer live in `discord-adapter.ts` or hard-code Discord.
- The shared output relay has no direct imports from Discord request-ID or GitHub API/state modules.
- Output streams render or ignore optional presentation parts without capability metadata.
- Workflow progress obtains narrow Result-returning protocol ports from the descriptor registry; the
  projector imports no provider error class and inspects no domain-bearing `unknown`.
- The current request router is explicitly Discord-owned rather than partially generalized.
- Core health keeps its existing concrete Discord/Redis aggregation without a descriptor health port.
- Initial reply-target and reanchor decoding distinguish no-target, malformed, cross-platform, and
  cross-session outcomes; invalid targets never degrade to a top-level reply.
- GitHub acknowledgement cleanup remains on skip, empty output, and finish but not supersession; Discord
  skipped-output cleanup and reasoning restore/reanchor behavior remain intact.
- Adapter-event ingress and independently hosted request ingress remain separate and preserve their
  specified startup and shutdown ordering.
- Existing wire compatibility fixtures and persisted graceful-restart fixtures remain byte-shape
  compatible.
- Discord search/storage, GitHub protocol behavior, workflow waits, tools, and plugin contracts retain
  their existing behavior.
- All focused and repository-wide validation passes.
