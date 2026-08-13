# Built-In Surface Registry Routing Refactor

Status: completed (2026-08-14).

Stage 8 completion record: the implementation added the exhaustive static built-in protocol catalog,
registry map routing, generic normalized-identity routing, `SurfacePrincipal`, and focused built-in
composition. Runtime descriptors now use approved narrow `createRelay` and `createWorkflowProgress`
factories: the registry creates the guarded adapter once, supplies that exact facade to both factories,
and guards the resulting workflow-progress port before exposing it. Discord and GitHub retain their
existing protocol-local behavior, while shared callers route through the catalog and executable
descriptors through the registry. Focused surface, runtime, tool, request-cache, workflow, and
composition verification passed. Final `bun run check` passed repository-wide tests and typechecking,
lint, formatting, generated-code validation, production syntax validation, and the semantic architecture
gate, including 2,429 Core tests and 96 architecture tests.

This plan reduces the number of shared Core modules that explicitly route between the existing Discord
and GitHub surface implementations. It is a behavior-preserving registry routing refactor for adapters
compiled and shipped with Core, including generic consumption of the normalized identity that trusted
built-in ingress publishes to trusted Redis.

It does not add a trust boundary, platform admission policy, wire contract, persisted-data contract, or
product behavior. It does not add a third platform or create a dynamic surface plugin API.

## Decision

Replace repeated Discord/GitHub selection branches with one static built-in protocol catalog and the
existing runtime registry.

The refactor has one governing invariant:

> For every currently accepted input and runtime configuration, Discord and GitHub produce the same
> authorization, validation, operation Result, output, recovery, and workflow behavior before and after
> this migration.

Existing guards remain in force. They may be moved to one owner and duplicate wrapping may be removed,
but this plan adds no guard, restriction, validation rule, trust gate, or failure mode.

Built-in surface code is trusted Core code. Its protocol ingress authenticates external input before
publishing normalized actor and origin metadata to the trusted event bus. Downstream Core consumers trust
that internal event provenance while retaining correlation and invariant checks. A platform name is not a
second authorization decision, and catalog or descriptor registration does not require a separate trusted-
platform allowlist.

## Outcome

Core retains three distinct concepts:

1. **Closed platform/ref contracts** define the Discord and GitHub ref shapes understood by this build.
2. **Built-in protocol routing definitions** provide the existing platform-specific ref, tool-target, and
   normalized-origin interpretation needed by shared callers.
3. **Runtime descriptors** declare which understood platforms are executable in the current process and
   which coarse subsystems they participate in.

Shared callers select existing protocol behavior through the catalog instead of branching on
`"discord"` and `"github"`. Runtime callers select executable adapters and ports through the registry.
Compatibility readers remain independent and unchanged.

## Expected Adapter Addition

After this migration, a normal built-in adapter using an existing event-bus platform value should require:

- protocol-local adapter, output, ingress, relay-policy, and optional sidecar modules;
- one `SessionRef` variant and one `MsgRef` variant;
- one built-in protocol catalog entry;
- one runtime composition entry;
- protocol tests and registration in the shared contract harness; and
- exact architecture registrations for its actual external SDK, gateway, webhook, or host boundaries.

The ordinary thin-adapter path should require approximately two to four shared production edits, down from
roughly ten to fourteen. Built-in ingress authenticates its external protocol and publishes the same
normalized trusted event shape consumed by Core; it does not require a second Core platform trust admission
entry.

A fully durable adapter still has approximately seven to ten intentional touch points when it opts into
independently owned configuration, wire, recovery, workflow-persistence, transcript, or plugin-compatible
contracts. Those edits are explicit compatibility review, not repeated runtime routing or trust admission.

## Goals

- Remove explicit Discord/GitHub selection branches from the runtime registry.
- Give shared callers one typed lookup path for existing protocol ref construction and decoding.
- Move platform-specific session target resolution, request-origin inference, and help routing out of the
  generic surface tool.
- Replace shared workflow and request-cache ref-construction switches with protocol routing.
- Remove repeated Discord/GitHub route selection from normalized authenticated request projection while
  preserving current identity correlation and safety behavior.
- Use one shared built-in surface principal shape through Core and plugin request contexts.
- Make the runtime registry the single owner of the existing descriptor-bound adapter and workflow-port
  wrapping.
- Move built-in descriptor construction out of the large Core composition root.
- Keep `SessionRef` and `MsgRef` as the authoritative closed ref unions.
- Preserve all current Discord/GitHub behavior and compatibility contracts.

## Non-Goals

- Adding, selecting, or simulating a third platform.
- Dynamically loading surface adapters, protocols, or descriptors.
- Adding authentication-evidence ports or a trusted-platform admission policy.
- Moving external authentication out of protocol ingress.
- Treating raw external HTTP, gateway, SDK, CLI, or operator input as trusted bus input.
- Changing safety-mode outcomes, request-control authority, identity correlation, or capability checks.
- Adding new guards, restrictions, validation rules, or unsupported outcomes.
- Changing how historical placeholder platform values behave when read or recovered.
- Changing graceful-restart admission, workflow activation, workflow authorization, or action issuance.
- Freezing, regenerating, or deriving persisted codecs from the protocol catalog or runtime registry.
- Changing an event-bus schema, persisted snapshot version, workflow schema, transcript schema, plugin
  contract, or Core config version.
- Parameterizing the complete adapter, event, output, workflow, or persistence graph.
- Adding capability metadata or default adapter operation implementations.
- Generalizing Discord routing, reply waits, search, caches, health, aliases outside the surface tool, or
  other protocol sidecars.
- Allowing a runtime descriptor to manufacture authenticated identity; identity enters through trusted
  normalized request events only.

## Current Routing Friction

### Runtime Registry

`apps/core/src/surface/runtime-descriptor.ts` has a generic descriptor model, but descriptor guard wrapping
and adapter resolution explicitly enumerate Discord and GitHub. The registry can route through a map
without changing accepted platforms or behavior.

Guard wrapping is currently repeated in Core composition, protocol descriptor factories, and the registry.
This plan consolidates the existing wrapping in the registry. The wrapped operations and defect behavior
must remain identical.

### Surface Tool

`apps/core/src/tool-server/tools/surface.ts` selects adapters through the registry but still routes several
target concerns itself:

- Discord/GitHub ref construction;
- request-ID origin parsing;
- Discord aliases, allowlists, guild resolution, and config adaptation;
- per-platform session-ID help; and
- session resolution through a GitHub branch with an implicit Discord fallback.

The generic tool should select one registered protocol, invoke its existing target behavior, call the
guarded adapter, and map the existing operation Result. Protocol-specific message presentation and Discord
search behavior that are not target routing remain where they are.

### Shared Ref Callers

The workflow progress projector, request cache, and parts of runner plumbing reconstruct Discord/GitHub
refs through local switches. These are routing branches when they only translate an already selected,
registered platform into its existing concrete ref shape.

External authentication, capability enforcement, persistence, recovery, Discord-only product behavior, and
compatibility are not routing concerns and remain unchanged. Existing platform switches that merely select
protocol-local projection or safety behavior move behind protocol routing without changing their results.

### Trusted Identity Routing

`apps/core/src/surface/authenticated-request.ts` combines compatible outer metadata decoding,
Discord/GitHub route selection, ref construction, and generic actor/origin/session correlation. Built-in
Discord and GitHub ingress already publish normalized authenticated actor/origin metadata after external
protocol authentication.

The event bus is trusted internal infrastructure. Core should decode the normalized event and route ref
construction through the selected built-in protocol without a second Discord/GitHub trust-admission switch.
Generic correlation, latching, durable proof, capability checks, and existing safety-mode outcomes remain
unchanged.

Principal platform unions are repeated in Core and the in-repository plugin runtime even though they carry
the same `{ platform, userId }` shape. Deriving one shared principal type from the closed built-in ref
platform union removes those routing edits without granting authority from registry membership. The
principal is populated only from the existing correlated normalized request projection.

### Composition

`apps/core/src/runtime/create-core-runtime.ts` constructs Discord and GitHub adapters, relay policies,
ingress ports, and descriptors inline. Lifecycle execution is generic, but executable registration is
obscured by the larger composition root.

## Target Architecture

### Protocol Routing Definition

Introduce a narrow protocol routing contract under `apps/core/src/surface/`. It contains only behavior
already selected through repeated shared platform branches:

```ts
export type SurfaceRefRouting<P extends RegisteredSurfacePlatform> = {
  createSessionRef(sessionId: string): SessionRefFor<P>;
  createMessageRef(sessionRef: SessionRefFor<P>, messageId: string): MsgRefFor<P>;
  resolveRequestMessageRef(input: {
    requestId: string;
    sessionRef: SessionRefFor<P>;
  }): ReplyTargetResolution<MsgRefFor<P>>;
  decodeMessageRef(input: {
    ref: SurfaceMsgRef;
    expectedSessionId?: string;
  }): Result<MsgRefFor<P>, SurfaceRefInvalid>;
};

export type SurfaceToolTargetRouting<P extends RegisteredSurfacePlatform> = {
  resolveSession(input: {
    selector: string;
    contextSessionId?: string;
  }): Promise<Result<SessionRefFor<P>, SurfaceToolTargetError>>;
  describeSessionIds(): SurfaceSessionIdHelp;
};

export type SurfaceRequestProjectionRouting<P extends RegisteredSurfacePlatform> = {
  projectProtocolMetadata?(input: {
    requestId: string;
    sessionRef: SessionRefFor<P>;
    common: CorrelatedSurfaceRequestMetadata<P>;
  }): Result<SurfaceProtocolRequestMetadata<P>, AuthenticatedRequestProjectionInvalid>;
  isProtocolProjectionValid?(projection: AuthenticatedRequestProjectionFor<P>): boolean;
  hasDurableProtocolProof?(projection: AuthenticatedRequestProjectionFor<P>): boolean;
  resolveExternalSafetyMode?(input: {
    projection: AuthenticatedRequestProjectionFor<P>;
    assertedSafetyMode: "trusted" | "restricted";
  }): "trusted" | "restricted";
};

export type SurfaceProtocolRouting<P extends RegisteredSurfacePlatform> = {
  readonly platform: P;
  readonly refs: SurfaceRefRouting<P>;
  readonly toolTargets?: SurfaceToolTargetRouting<P>;
  readonly requestProjection?: SurfaceRequestProjectionRouting<P>;
};
```

The exact types may reuse existing Result errors and helper signatures. They must not introduce stricter
input validation. Existing constructors that accept non-empty tool input continue accepting it; existing
adapter validation and produced-ref guards remain authoritative.

The request-message resolver preserves the existing relay's `none`, `target`, and typed `invalid`
outcomes, including malformed, platform-mismatch, and session-mismatch classifications. Callers interpret
that result according to their existing contract: relays retain typed invalid outcomes, surface-tool
defaulting treats a non-target as no inferred default before applying its existing required-input errors,
and authenticated request projection retains its existing projection validation behavior. Sharing the
protocol primitive must not make these caller contracts identical.

Common normalized `authenticatedActor` and `authenticatedOrigin` projection is generic and does not require
a per-platform callback. A request-projection callback exists only for current protocol-specific metadata,
such as GitHub trigger correlation and durable trigger proof. Discord request-ID message inference routes
through the ref method. An ordinary future adapter that publishes only the common normalized identity shape
does not need a new shared projection branch.

The optional safety method routes an existing exceptional per-platform safety decision after correlated
normalized identity has been accepted. Without an override, Core preserves the trusted event's asserted
safety mode. Discord and GitHub retain their current outcomes. The method does not authenticate ingress or
admit a platform; a future protocol needs it only when its policy differs from the common path.

This contract is not an external authentication port, lifecycle container, persistence codec, service
locator, or extension permission mechanism. It interprets trusted normalized internal events after ingress;
it does not authenticate raw protocol input. Add no callback unless it directly replaces a current shared
Discord/GitHub routing branch in this plan.

### Static Protocol Catalog

Add one exhaustive built-in catalog:

```ts
export const BUILTIN_SURFACE_PROTOCOLS = {
  discord: discordSurfaceProtocol,
  github: githubSurfaceProtocol,
} satisfies {
  [P in RegisteredSurfacePlatform]: SurfaceProtocolRouting<P>;
};
```

The catalog is a typed projection of the existing `SessionRef` and `MsgRef` unions. It does not redeclare
ref shapes, widen the implemented platform set, imply runtime enablement, establish trust, or affect
compatibility decoding.

Keep the existing compile-time assertion that session and message platform sets are exactly equal. Add a
focused assertion that catalog keys exactly equal that same platform set.

### Runtime Descriptor Binding

Bind each runtime descriptor to its protocol routing definition:

```ts
export type SurfaceRuntimeDescriptor<P extends RegisteredSurfacePlatform> = {
  readonly protocol: SurfaceProtocolRouting<P>;
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress?: SurfaceAdapterIngress<P>;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly createRelay?: (adapter: SurfaceAdapter) => SurfaceRelayDescriptor<P>;
  readonly createWorkflowProgress?: (
    adapter: SurfaceAdapter,
  ) => SurfaceWorkflowProgressPort<P>;
};
```

The protocol's `platform` is the descriptor's authoritative platform value. Lifecycle callers that need a
platform read it from the protocol or from a derived accessor rather than a second independently supplied
field. Platform agreement among typed ports remains a compile-time constraint; this plan adds no runtime
registration error for a new mismatch class.

`SurfaceRuntimeRegistry.create()` retains existing duplicate registration behavior, applies the existing
descriptor-bound adapter and workflow-port wrappers exactly once, and stores entries by platform. It first
wraps the raw adapter, passes that exact guarded facade to the optional relay and workflow-progress
factories, then wraps the resulting workflow-progress port. This binding order preserves adapter-produced
ref checks inside relay and workflow operations without composition-level pre-wrapping. Existing
asynchronous `adapter.getSelf()` validation remains unchanged.

The factories are narrow construction seams, not lifecycle callbacks or service locators. They receive only
the registry-guarded adapter and close over the same concrete protocol dependencies as today. The bound
descriptors exposed by the registry contain the constructed `relay` and `workflowProgress` ports; callers do
not invoke the factories.

Registry resolution becomes map lookup after validation:

```ts
resolve(platform: AdapterPlatform): ResolvedSurfaceAdapter | null {
  const descriptor = this.byPlatform.get(platform);
  return descriptor
    ? { platform: descriptor.protocol.platform, adapter: descriptor.adapter }
    : null;
}
```

Wire-valid placeholder values still resolve to `null` because no production protocol or runtime descriptor
is added for them.

### Built-In Composition

Move existing surface construction into a focused module such as:

`apps/core/src/runtime/compose-builtin-surface-runtimes.ts`

The module returns the current Discord and conditionally available GitHub descriptors. It preserves the
current distinctions among adapter connection, adapter-event ingress, request ingress, relay availability,
and workflow progress.

Do not collapse availability into one `enabled` flag and do not pass a broad service locator. Protocol and
descriptor factories receive only their current concrete dependencies.

`create-core-runtime.ts` remains responsible for global startup prerequisites, Discord-owned sidecars, and
the existing lifecycle order.

## Ownership Rules

| Concern                                                      | Owner                          |
| ------------------------------------------------------------ | ------------------------------ |
| Closed Discord/GitHub ref shapes                             | `surface/types.ts`             |
| Existing protocol ref and tool-target routing                | Static protocol definition     |
| Executable membership and adapter selection                  | Runtime registry               |
| Existing produced-ref guard wrapping                         | Runtime registry               |
| Coarse ingress, relay, workflow, and lifecycle participation | Runtime descriptor             |
| External protocol authentication                             | Built-in protocol ingress      |
| Trusted normalized event decoding and identity correlation   | Core authentication service    |
| Safety policy and request-control authority                  | Existing Core runtime policy   |
| Protocol rendering, output, routing, and sidecars            | Existing protocol modules      |
| Wire values and event compatibility                          | Event-bus package              |
| Persisted versions, decoding, and migration                  | Existing persistence owner     |
| Workflow authorization and atomic transitions                | Workflow domain/store          |

## Detailed Behavior Requirements

### Reference Routing

Keep `SessionRef` and `MsgRef` as explicit Discord/GitHub discriminated unions.

Shared callers use the selected protocol's ref routing only where they currently construct or decode a ref
after platform selection. The routing methods delegate to existing protocol helpers where available.

Adapters continue validating caller-supplied primary and nested refs before protocol access. The existing
descriptor-bound guards continue validating adapter-produced refs. This plan neither adds validation nor
changes error classification.

The protocol ref routing replaces duplicate ref construction and reanchor decoding currently held by relay
policies. Request-ID reply-target interpretation, finalization, and recovery behavior remain in relay
policy. During migration, any retained relay ref methods delegate to protocol routing; the completed design
has one implementation for ref construction and decoding.

### Surface Tool Routing

Refactor only target selection and help routing in the generic surface tool:

1. Resolve the effective registered adapter and matching protocol from request context or explicit client.
2. Preserve the current context-versus-input client mismatch behavior.
3. Resolve the session selector through that protocol's tool-target routing.
4. Construct message refs through that protocol's ref routing.
5. Invoke the existing guarded adapter operation.
6. Map the existing closed `SurfaceOperationError` union exactly as today.

Move the current Discord target behavior behind the Discord tool-target routing:

- aliases and optional `#` normalization;
- guild lookup and allowlist policy;
- Discord session metadata construction;
- Discord request-ID origin inference; and
- Discord session help and related configuration keys.

Move the current GitHub target behavior behind the GitHub tool-target routing:

- current session ref construction;
- GitHub request-ID origin inference; and
- GitHub session help.

GitHub selector handling must remain as permissive as it is today. This refactor must not begin rejecting a
non-empty selector merely because it does not match `OWNER/REPO#number`.

Keep attachment loading, common input schemas, adapter operation calls, common Result mapping, transcript
linking, message projection, Discord-rich presentation, referenced-message behavior, search, and common
output formatting in the generic tool unless moving a helper is mechanically required by target routing.

Help continues listing runtime-registered clients only. Its content and fallback behavior must remain
fixture-compatible; routing the data through a protocol definition must not alter the public tool output.

### Workflow And Request Cache

Replace platform switches only where they construct or decode non-authoritative refs for an already known
registered platform.

The workflow progress projector may use protocol ref decoding instead of reconstructing a concrete
`MsgRef`, but it must retain all existing target/binding/session checks, port lookup, authorization, action
issuance, retry policy, repair behavior, outbox writes, and state transitions.

The request cache and runner may use protocol ref construction instead of Discord/GitHub switches. They
must preserve the current distinction among registered external requests, unregistered external requests,
internal delegated requests, and aliases without trust proof.

Do not change `AuthenticatedSurfaceOrigin`, reconstruct trust from protocol refs, alter delegation payloads,
or change durable workflow data.

### Trusted Request Projection And Principals

Keep the existing trust boundary: Discord gateway and GitHub webhook code authenticate external input and
publish normalized actor/origin metadata onto trusted Redis. Downstream Core does not re-authenticate the
platform or consult a platform admission allowlist.

Refactor authenticated request handling into behavior-preserving routing steps:

1. Decode the complete compatible outer event envelope and normalized actor/origin fields.
2. Select the built-in protocol from the correlated `request_client` platform.
3. Construct session/message refs and interpret current protocol-specific metadata through that protocol's
   routing definition.
4. Apply the existing generic actor, origin, platform, session, message, latching, durable-proof,
   capability, and safety correlation.

Requests for wire-valid platforms without a built-in protocol retain their current unregistered,
principal-less, restricted behavior. This is an understood-platform routing outcome, not a trust admission
policy.

Introduce one shared principal shape derived from the closed built-in ref platform union:

```ts
export type SurfacePrincipal = {
  readonly platform: RegisteredSurfacePlatform;
  readonly userId: string;
};
```

Use it through Core request-control, tool-server, runner, subagent, and workflow contexts. Because
`packages/plugin-runtime` cannot depend on Core's closed ref union, make its request context generic in the
principal platform string and instantiate that generic with `RegisteredSurfacePlatform` inside Core. The
default external plugin-facing type remains structural and does not enumerate built-in platforms. A future
built-in adapter therefore does not require another plugin-runtime principal-union edit. This is a
type-level projection of the same correlated identity, not a new authority source or wire format.

Preserve all current Discord/GitHub projection results, metadata kinds, verified-ingress values, durable
proof results, request-control decisions, and safety-mode outcomes. Protocol registration alone cannot
populate a principal; only normalized identity carried by a correlated trusted bus event can do so.

### Persistence, Recovery, And Compatibility

No persisted or wire decoder changes are planned.

Graceful-restart v1-v4 readers, workflow persistence, transcript persistence, plugin-compatible values, and
event-bus codecs retain their current schemas and behavior. Do not derive accepted values from
`BUILTIN_SURFACE_PROTOCOLS` or the runtime registry.

Current behavior for wire-valid placeholder platforms remains unchanged. This plan neither quarantines
historical work nor makes it executable through a new descriptor.

Recovery may use registry map lookup in place of a Discord/GitHub selection branch only when the resulting
preflight set, availability outcome, and agent admission are byte-for-byte behavior-equivalent for all
current snapshot values. Otherwise leave the branch unchanged.

### Architecture Enforcement

Use TypeScript exhaustiveness and focused tests for catalog/ref equality and descriptor/protocol
correlation. Continue using the architecture manifest for exact boundary, Result, exception, persistence,
and `Panic` registrations already owned by moved symbols.

Do not add a new architecture rule or registration category for this internal routing refactor. Do not move
external decoders or exception adapters unless mechanically necessary. If a registered symbol moves,
update its exact registration without broadening the approved boundary.

## Implementation Sequence

### Stage 1: Characterization

- Inventory shared production Discord/GitHub branches relevant to runtime selection, ref construction, tool
  targets, and composition.
- Classify trust, compatibility, persistence, recovery-policy, and Discord-only product branches as
  explicitly retained.
- Add or confirm focused characterization tests for registry resolution, descriptor guards, surface tool
  targets/help, authenticated request projection, principal propagation, request-cache refs, and workflow
  ref correlation.
- Add a checked-in extension scorecard listing shared production files required by an ordinary built-in
  adapter before the migration. Classify independently owned config, wire, persistence, and protocol
  boundary registrations separately from accidental routing edits.

Exit criteria: removable routing branches and intentionally retained policy branches are explicit, and
current public behavior is covered before movement.

### Stage 2: Static Protocol Routing Catalog

- Add the minimal ref-routing and protocol-routing types.
- Implement Discord and GitHub ref routing by delegating to current behavior.
- Add the exhaustive built-in catalog.
- Retain `SessionRef` and `MsgRef` as the sole ref-shape declarations.
- Enforce catalog/ref platform equality with TypeScript and focused tests.

Exit criteria: catalog entries typecheck and all existing behavior tests pass without changing runtime
composition or compatibility formats.

### Stage 3: Registry Map Routing

- Bind runtime descriptors to protocol routing definitions.
- Use the protocol platform as the sole descriptor registration key and keep port correlation enforced by
  existing generic types.
- Make the registry the sole owner of existing descriptor-bound adapter and workflow-port wrapping.
- Bind adapter-dependent relay and workflow-progress construction through narrow factories that receive the
  exact registry-guarded adapter.
- Remove duplicate pre-wrapping from Core composition and protocol descriptor factories.
- Replace registry Discord/GitHub switches with validated map lookup.
- Preserve duplicate-registration, unsupported-wire-platform, adapter-self mismatch, and produced-ref defect
  behavior.

Exit criteria: the registry contains no Discord/GitHub selection switch, each existing guard is applied once,
and lifecycle plus adapter contract tests retain behavior.

### Stage 4: Surface Tool Target Routing

- Add the optional tool-target routing to protocol definitions.
- Route ref construction, request-ID origin inference, session help, and target resolution through the
  selected protocol.
- Preserve caller-specific request-ID interpretation: relay invalid outcomes remain typed, while tool
  defaulting retains its current no-inference and required-input behavior.
- Move current Discord alias, guild, and allowlist target behavior behind Discord routing.
- Preserve permissive GitHub selector behavior.
- Keep generic tool schemas, output, operation Results, presentation, and search behavior unchanged.
- Add a regression test proving an unregistered wire client cannot fall through to Discord routing.

Exit criteria: generic target selection has no implicit non-GitHub-to-Discord fallback, and existing tool
fixtures remain unchanged.

### Stage 5: Trusted Request And Principal Routing

- Decode common normalized actor/origin metadata generically after selecting the built-in protocol.
- Route session/message ref construction, protocol-specific metadata projection, semantic checks, durable
  proof, and external safety selection through the selected protocol where current branches differ.
- Preserve the existing trusted Redis boundary and all Discord/GitHub projection, correlation, capability,
  and safety outcomes.
- Introduce the shared `SurfacePrincipal` type and use it in Core request-control, tool-server, runner,
  workflow, and subagent plumbing.
- Make `packages/plugin-runtime` request contexts generic in principal platform and instantiate them with
  `RegisteredSurfacePlatform` inside Core, without changing runtime context shape.
- Add tests proving catalog/descriptor membership without normalized actor/origin metadata remains
  principal-less and restricted, while correlated normalized metadata retains current trusted behavior.

Exit criteria: adding an ordinary built-in protocol no longer requires shared authentication route or
principal-union edits, and all current Discord/GitHub trust and safety behavior is unchanged.

### Stage 6: Shared Ref Caller Routing

- Route workflow progress ref decoding through the selected built-in protocol.
- Route request-cache and non-authoritative runner ref construction through the selected built-in protocol.
- Keep delegation authority, workflow authorization, recovery policy, and persistence unchanged.
- Leave Discord-only routing, continuation, workflow waits, search, and sidecars explicit.

Exit criteria: remaining platform branches in shared modules represent retained product, trust, recovery,
or compatibility behavior rather than generic ref routing.

### Stage 7: Built-In Composition Extraction

- Move current Discord/GitHub adapter, ingress, relay-policy, and descriptor construction into a focused
  built-in composition module.
- Preserve startup prerequisites, lifecycle ordering, subsystem-specific GitHub availability, and
  Discord-owned sidecars.
- Keep descriptor registration explicit and statically reviewable.

Exit criteria: `create-core-runtime.ts` receives one descriptor collection and does not construct individual
surface descriptors inline.

### Stage 8: Extension Scorecard And Verification

- Update `PROJECT.md` to describe the static routing catalog, executable registry, and unchanged
  compatibility ownership, including trusted built-in ingress and trusted Redis event provenance.
- Update surface tool help or adapter authoring guidance only where required to describe the same behavior.
- Update the checked-in extension scorecard with the post-migration shared production touch points.
- Verify an ordinary built-in adapter using an existing wire platform requires no more than four shared
  production edits, excluding explicit config, wire, persisted-data, and external-boundary registrations.
- Record the intentional additional touch points for a fully durable adapter without deriving them from
  runtime registration.
- Run focused Core surface, runtime, tool, request-cache, workflow, graceful-restart, and architecture tests.
- Run Core typechecking and architecture checks during the migration.
- Run repository-wide tests, typechecking, lint, formatting, and architecture validation at completion.

Exit criteria: all repository gates pass, characterization fixtures retain their meanings, no excluded
contract changed, and the ordinary adapter scorecard is within the two-to-four shared-production-edit
target.

## Expected Blast Radius

The routing refactor is expected to touch:

- new protocol-routing and catalog modules under `apps/core/src/surface/`;
- Discord and GitHub protocol modules for ref and tool-target routing;
- `apps/core/src/surface/runtime-descriptor.ts` and existing produced-ref guard ownership;
- `apps/core/src/tool-server/tools/surface.ts` target/help routing;
- `apps/core/src/surface/authenticated-request.ts` for generic normalized identity routing;
- shared Core principal plumbing and the in-repository `packages/plugin-runtime` principal platform type;
- ref-construction sites in request cache, runner, and workflow progress;
- `apps/core/src/runtime/create-core-runtime.ts` and a new built-in composition module;
- exact architecture registrations only for symbols that move; and
- focused surface, descriptor, tool, request-cache, workflow, and lifecycle tests.

The refactor changes internal principal type ownership and plugin-runtime's compile-time platform source, but
not its runtime request-context shape or authority semantics. It should not change external authentication,
event-bus schemas, persisted codecs, workflow schemas, transcript schemas, graceful-restart versions, or
Core config versions.

## Risks

### High: Behavior Drift During Tool Routing

Discord aliases, allowlists, guild lookup, cache bursting, help fallback, and GitHub request-ID behavior are
user-visible. Move one routing family at a time and preserve literal fixtures. Do not add GitHub selector
validation.

### High: Guard Behavior Drift

Removing duplicate wrappers must not remove a check or change a defect into an operation Result. The
registry must apply the same existing descriptor-bound wrappers exactly once, with focused produced-ref
contract tests before and after.

### High: Routing Refactor Expands Into Policy

Authentication, trust, recovery, workflow activation, and persistence contain intentional platform
behavior. Route existing external safety and protocol-proof decisions through protocol definitions without
changing their results. Do not add admission, quarantine, authorization, or compatibility policy merely to
reduce branch counts. Stop and request a separate plan if routing cannot be separated from one of these
contracts.

### High: Confusing Trusted Bus Provenance With Raw Input

Only normalized events emitted by reviewed built-in ingress onto trusted Redis receive the existing internal
trust treatment. HTTP headers, gateway payloads, SDK objects, CLI input, and arbitrary strings remain owned
by their current boundary adapters. The routing catalog must not become an alternate raw-ingress path.

### Medium: Second Ref Source

Protocol routing can drift if it redeclares ref shapes. Catalog entries must consume `SessionRefFor<P>` and
`MsgRefFor<P>`, with exact key equality enforced from the existing unions.

### Medium: Composition Service Locator

A broad factory context would hide dependencies. Keep current concrete dependencies explicit while moving
construction out of the composition root.

## Acceptance Criteria

- Core has one exhaustive static built-in protocol routing catalog keyed by the existing closed ref-platform
  union.
- `SessionRef` and `MsgRef` remain the sole declarations of implemented ref shapes and retain equal platform
  sets.
- Runtime descriptor registration remains distinct from protocol routing and compatibility decoding.
- The runtime registry resolves validated entries through a map and contains no Discord/GitHub selection
  switch.
- The runtime registry is the sole production owner of the existing descriptor-bound adapter and
  workflow-port wrappers.
- Adapter-dependent relay and workflow-progress factories receive the exact registry-guarded adapter before
  their bound ports are exposed.
- No new guard, restriction, validation rule, authority gate, or failure outcome is introduced.
- Generic surface target selection and help use protocol routing without an implicit Discord fallback.
- Discord aliases, allowlists, guild lookup, cache behavior, and help output retain current semantics.
- GitHub session selectors retain current permissive behavior.
- Built-in protocol ingress remains the owner of external authentication, and downstream Core trusts its
  normalized events on trusted Redis without a second platform admission allowlist.
- Common normalized actor/origin projection is generic; protocol routing owns only current protocol-specific
  ref, metadata, durable-proof, and external safety interpretation.
- Discord and GitHub authenticated projections, verified-ingress values, durable-proof decisions,
  principals, request-control authority, and safety modes retain current behavior.
- Core and plugin request contexts use one principal platform type derived from the closed built-in ref
  platform union, without changing the runtime context shape.
- A future ordinary built-in protocol does not require a shared authentication route switch or repeated
  principal-union edits.
- Workflow and request-cache ref routing changes do not alter workflow authorization, actions, retries,
  delegation, or persistence.
- Capability correlation and authority assignment remain unchanged.
- Graceful-restart, workflow, transcript, event-bus, tool, config, and plugin compatibility contracts retain
  their current meanings.
- Wire and persisted codecs do not derive accepted platforms or versions from the protocol catalog or live
  registry.
- Current placeholder-platform recovery and workflow behavior remains unchanged.
- Runtime composition registers current built-in descriptors in one focused module while preserving
  subsystem availability and lifecycle order.
- Discord and GitHub pass the existing shared adapter/descriptor harness and focused characterization tests.
- The checked-in extension scorecard demonstrates approximately two to four shared production edits for an
  ordinary built-in adapter using an existing wire platform.
- Fully durable adapters retain explicit review touch points for independently owned config, wire,
  persistence, recovery, workflow, transcript, plugin-compatible, and external-boundary contracts.
- All focused and repository-wide validation passes.
