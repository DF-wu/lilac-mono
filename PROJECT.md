# Lilac Architecture And Ownership Guide

This is the durable map of the current Lilac monorepo: product boundaries, terminology, ownership, trust boundaries, persistence categories, and the best places to make changes. It intentionally omits route inventories, configuration field catalogs, startup call order, and implementation-plan history.

## Documentation Authority

Current behavior is authoritative in production source, wire schemas, persisted codecs, `scripts/architecture/manifest.ts`, and root `package.json` scripts. This guide summarizes those contracts; it does not replace them.

- `README.md` is the repository landing page and command index.
- `PROJECT.md` is the durable current-system and ownership guide.
- `AGENTS.md` defines repository-wide working constraints.
- `packages/utils/config-templates/core-config.example.yaml` documents current Core configuration, and
  `docs/core-config-migrations.md` records manual version upgrades.
- `MIGRATIONS.md` records persisted-data, wire, and protocol transitions.
- `scripts/architecture/README.md` explains the permanent architecture gate and exact registrations.
- `plan/README.md` identifies active implementation plans. Plans describe intended work, not current behavior until the code ships.
- Component documentation owns operational detail. In particular, see the self-documenting
  `packages/utils/config-templates/core-config.example.yaml`, `docs/core-config-migrations.md`,
  `docs/claude-code.md`, `docs/skill-authoring.md`, `docs/docker-deployment.md`, `PLUGIN_AUTHORING.md`,
  `apps/mini-lilac/README.md`, and `apps/acp-controller/README.md`.

`ref/` is vendored upstream reference material and is read-only unless a task explicitly says otherwise.

## Products And Stable Flows

### Core

Core is the Redis-backed multi-surface runtime in `apps/core`.

Current Core configuration is documented in
`packages/utils/config-templates/core-config.example.yaml`; manual version upgrades are in
`docs/core-config-migrations.md`.

1. Authenticated Discord gateway ingress publishes normalized adapter events to the typed bus. Verified GitHub webhooks can create request messages directly.
2. The Discord router converts eligible adapter events into `cmd.request.message` commands. A request is the unit of agent work; `prompt`, `steer`, `followUp`, and `interrupt` describe admission into a session's active work.
3. The bus agent runner serializes work per session, uses the shared AI SDK agent and a run-scoped toolset, publishes request lifecycle events, and streams output on `out.req.<request_id>`.
4. A registered surface relay consumes the request output stream and renders it to Discord or GitHub. Relay state can be snapshotted for bounded graceful-restart recovery.
5. The durable workflow engine uses the same request bus for child-agent operations while keeping journals, triggers, waits, receipts, and progress projection independent of a request's output relay.

`packages/event-bus/lilac-spec.ts` is the canonical event catalog and payload schema. `request_id`, `session_id`, and `request_client` are the correlation headers; request and output contracts require a request ID where specified by that catalog.

### Mini Lilac

Mini Lilac is a separate Redis-free local coding-agent product.

1. `apps/mini-lilac` dispatches the installable `mini-lilac` command to the TUI or server.
2. `apps/mini-lilac-tui` uses the strict client protocol in `packages/mini-lilac-client` to talk to `apps/mini-lilac-server` over HTTP and AI SDK-compatible SSE.
3. `packages/mini-lilac-runtime` owns session actors, model/profile resolution, tools, subagents, compaction, todos, immutable transcript chains, SQLite persistence, and workspace-history capture.
4. Active-run chunks and replay cursors are process-local. A disconnect detaches only the subscriber; explicit cancellation stops work. Finalized canonical model/UI history is durable, while a process crash loses partial active chunks and marks interrupted runs as errors.

Mini does not depend on Core, Redis, Core's event bus, Core surfaces, or Core's tool server. It shares lower-level agent, coding-tool, filesystem, result, provider, Claude bridge, and skill primitives.

### ACP Controller

`apps/acp-controller` builds the independent `lilac-acp` CLI. It discovers and launches ACP harnesses, communicates through the ACP SDK, runs prompt turns in detached workers, and persists controller run records and session indexes. It does not route through Core or Mini.

## Workspace Ownership

The fail-closed workspace inventory is `ACTIVE_WORKSPACES` in `scripts/architecture/manifest.ts`. Every current workspace has an explicit owner:

### Applications

- `apps/acp-controller`: ACP harness controller, worker lifecycle, session discovery, and controller persistence.
- `apps/core`: Core composition, surfaces, routing, tool adapters/server, workflows, recovery, and Core-owned persistence.
- `apps/mini-lilac`: publishable command dispatcher and single-file Mini bundle.
- `apps/mini-lilac-server`: Mini HTTP/SSE boundary, server authentication, process lock, and runtime composition.
- `apps/mini-lilac-tui`: OpenTUI/Solid terminal client and interaction state.
- `apps/tool-bridge`: `tools` HTTP client/CLI, its bundle, and the reduced dev-mode Core tool server entry.

### Packages

- `packages/agent`: provider-neutral AI SDK agent loop, steering/follow-up/interrupt queues, atomic tool execution, compaction hooks, retries, and cross-provider history projection.
- `packages/bash-safety`: static Bash analysis and accidental-damage policy. It is a guardrail, not isolation.
- `packages/claude-code-bridge`: Claude runtime integration, in-process MCP tool bridge, native attempt ownership, and continuation metadata.
- `packages/coding-tools`: shared coding-tool schemas and implementations, patch/edit behavior, batching, instruction discovery, and tool guardrails.
- `packages/event-bus`: event catalog, codecs, typed bus, delivery policy, dead letters, and Redis Streams transport.
- `packages/fs`: local filesystem operations, search backends, edit/hashline primitives, and the remote filesystem protocol.
- `packages/mini-lilac-client`: Mini wire schemas and reconnectable HTTP/SSE transport.
- `packages/mini-lilac-runtime`: Mini domain, sessions, providers, tools, SQLite store, skills, and workspace history.
- `packages/plugin-runtime`: generic Level 1/Level 2 plugin capability contracts, discovery, loading, lifecycle, and reload management.
- `packages/remote-fs-runner`: short-lived publishable remote runner used by Core SSH filesystem tools.
- `packages/tool-results`: bounded model-view output, media projection, and encrypted transient artifact storage.
- `packages/utils`: shared Core configuration, environment, model/provider resolution, prompt workspace, skills parsing/discovery, OAuth helpers, logging, and common utilities.

## Core Surfaces

Three concepts must remain distinct:

- The event bus `AdapterPlatform` is a compatibility wire enum and includes values that Core does not implement.
- `BUILTIN_SURFACE_PROTOCOLS` in `apps/core/src/surface/builtin-surface-protocols.ts` is the exhaustive static catalog for the closed `SessionRef`/`MsgRef` platforms, currently Discord and GitHub. It owns protocol-specific ref construction, request-ID interpretation, and tool target projection. Catalog membership does not enable a surface or grant trust.
- `SurfaceRuntimeRegistry` in `apps/core/src/surface/runtime-descriptor.ts` contains the executable descriptors installed in one Core process. A descriptor explicitly contributes an adapter and optional adapter ingress, request ingress, relay, workflow-progress, and health ports. Resolution is exact; it is not inferred from the wire enum or static catalog.

The registry binds one produced-ref-guarded adapter facade and passes that facade to descriptor ports. Caller refs and adapter-produced refs are checked before shared publication, persistence, relay recovery, or workflow progress. Workflow progress additionally gates exact target, binding, and ref correlation and persists permanent-versus-retryable operation policy. The registry is internal composition, not a dynamic surface plugin API.

Discord owns its gateway ingress, allowlists, mention/active router, local cache/search/thread services, and Discord rendering. GitHub owns webhook verification, trigger parsing, API authentication, acknowledgement state, pagination, and GitHub rendering. Shared code must not infer that a wire-valid platform has those capabilities.

Trust admission starts at authenticated Discord ingress or verified GitHub webhook ingress. A `SurfacePrincipal` is created only from correlated normalized identity carried through the trusted request path. Protocol catalog membership, descriptor registration, a request header, or a claimed platform cannot create authority; conflicting or missing correlation falls back to restricted behavior.

## Event Delivery

The typed API wraps Redis Streams and decodes complete `Message<unknown>` envelopes through the canonical event codec registry before handlers receive domain messages.

- `work` is a durable consumer group with competing consumers.
- `fanout` is a durable consumer group per `subscriptionId`; each distinct subscription receives every event.
- `tail` is a non-durable read without a consumer group and may start at the beginning, now, or a cursor.

Every subscription handler returns `Result<void, TaggedError>` and supplies an explicit delivery policy. Success commits. An error policy must choose `commit`, `park-pending`, `dead-letter`, or `stop`. `park-pending` leaves durable work in the Redis pending-entry list and is not an automatic retry; tail subscriptions cannot park and stop instead. Contract-invalid transport or event data is dead-lettered by the package policy. Dead-letter failure parks durable delivery or stops tail delivery. Throws, malformed Results, and Panics are defects handled by the registered fatal boundary, not ordinary handler failures. Manual fetch decodes the complete batch and fails on the first invalid entry rather than exposing it as typed data.

Durable consumers need stable `subscriptionId` values. `consumerId` identifies one process within a group, and the Redis stream entry ID is the cursor/checkpoint.

## Tools, Plugins, And Skills

Lilac uses progressive disclosure, but ownership is more important than the level number.

### Level 1: Agent-Local Tools

Level 1 tools are direct model-callable AI SDK tools assembled for each run. `packages/coding-tools`, `packages/fs`, `packages/bash-safety`, and `packages/tool-results` own portable behavior. Core-specific host, SSH, restricted execution, attachments, artifacts, logging, and bus delegation adapters live in `apps/core/src/tools`. Built-in exposure is declared in `apps/core/src/plugins/builtin`, and `apps/core/src/plugins/manager.ts` applies model, profile, safety, and request context.

Native Bash executes with the Core or Mini service user's host authority. Static Bash checks, denied paths, redaction, `network`, and `workspaceWrites` are behavioral guardrails, not security boundaries. Use restricted execution or OS isolation when same-user files, secrets, or network access must be unavailable.

### Level 2: Core Tool Server

Level 2 is Core's Elysia tool service in `apps/core/src/tool-server`, consumed by `apps/tool-bridge/client.ts` and commonly reached by an agent through Level 1 Bash. The same Core plugin manager owns Level 1 and Level 2 registration. Built-ins are composed from `apps/core/src/plugins/builtin`; external plugins are trusted process code discovered under `${DATA_DIR}/plugins` through `packages/plugin-runtime`.

Request capabilities bind request context, cwd, profile, callable authority, and expiry. They constrain agent calls but are not general public HTTP authentication. The Core tool server belongs on a trusted host/network. Core also owns configured MCP clients process-wide; MCP tools join the run-scoped catalog only through the Core manager and profile policy.

### Level 3: Skills

Skills are `SKILL.md` bundles discovered from product-owned state plus supported workspace/user compatibility roots. They are metadata-first instruction bundles loaded on demand; discovery does not execute scripts. Core parsing and broad compatibility discovery live in `packages/utils/skills.ts`; Mini's bounded catalog and Mini-specific roots live in `packages/mini-lilac-runtime/src/skills.ts`. See `docs/skill-authoring.md`.

Plugin code and skills are different extension mechanisms. Plugins execute trusted code and can contribute Level 1 and Level 2 capabilities. Skills contribute instructions and resources to an already-authorized agent. See `PLUGIN_AUTHORING.md` for the plugin contract.

## Workflows

Core has one current programmatic workflow runtime, `lilac-workflow-js-v4`, under `apps/core/src/workflow`.

- Definitions are JavaScript files in `<project>/.lilac/workflows` or `${DATA_DIR}/workflows`. The request capability's server-authorized cwd selects the project; a shell's later `cd` does not change that selection.
- A run is pinned to immutable source, input-schema, resource-policy, project, and runtime identity. Durable triggers pin that revision and origin when created and later fire without another human review.
- Workflow programs orchestrate; native subagent profiles authorize. `agent()` requires `explore`, `general`, or `self` plus optional cwd, model, reasoning, and label. The selected profile owns Level 1 tools/plugins, Level 2 callables/plugins, Bash mode, writes, network behavior, and delegation exactly as it does for direct subagents.
- Agent cwd is free-form, absolute or relative to the invocation project, and may address any path available to the service UID. Native Bash remains host-authority execution.
- The immutable resource policy bounds agent concurrency and count, nesting, allowed wait kinds, and per-operation idle time; separate limits bound source, input, operation output, and final result sizes.
- The deterministic program child is a plain `bun --smol` subprocess with deterministic-global lockdown and an NDJSON host protocol. It is not an OS security sandbox. The host owns cancellation, operation-idle, output-size, and protocol limits. A workflow has no total wall-time limit.
- Current host operations are agent orchestration, phase/parallel/pipeline composition, Discord-only `waitForReply`, and `sleep`. Reply waits are limited to the authenticated originating Discord session and user.
- Journals, dispatch epochs, owner fencing, pinned resolved-model identity, waits, triggers, cancellation, terminal receipts, generated subagent runs, and progress actions are durable. Replay reuses operation identity rather than rerunning completed effects.
- Primary-created runs, ordinary workflow children, durable triggers, and generated subagent runs share the global active-run cap. Shared filesystem or external operations may race.
- Progress projection is durable and independent of request output relays. Live-parent completion delivery is durable; when the parent cannot be restored, terminal output remains available through workflow progress/result state.

Workflow SQLite state is authoritative for execution and recovery. Do not reintroduce historical approval envelopes, workflow-specific tool authority, worktree isolation, or old workflow schemas without an explicit product and migration decision. Read `MIGRATIONS.md` before changing this contract.

## Storage And Durability

### Core

`DATA_DIR` defaults to `data/` and groups several categories:

- Operator-managed configuration and extensions: Core/MCP config, prompt workspace, skills, plugins, custom commands, personal workflow definitions, and the default tool workspace.
- Secrets and credentials under `secret/`. Tool denylists and redaction reduce accidents, but same-user native code can bypass them; the directory is not an OS security boundary.
- SQLite state for Discord cache/search and conversation threads, discovery, agent transcripts and continuation bindings, workflows, and graceful-restart snapshots. The workflow database path may be selected separately by `SQLITE_URL`.
- Transient or rebuildable artifacts and caches, including bounded tool-result artifacts and filesystem-search caches.

Redis Streams is separate durable bus state. Project workflow source lives in each project's `.lilac/workflows`, outside `DATA_DIR`. The workspace operated on by tools is user data, not Lilac metadata.

### Mini Lilac

Mini centralizes server state under `$XDG_STATE_HOME/mini-lilac`, falling back to `~/.local/state/mini-lilac`. Categories include strict server/provider configuration and owner credentials, the SQLite session/transcript/todo database, model metadata cache, encrypted transient tool-result artifacts, and private workspace-history storage. The selected project worktree remains separate user data. Active SSE logs are memory-only and cease to exist after finalization or process loss.

### ACP Controller

ACP Controller stores run records, cancellation records, and its session index under `$XDG_STATE_HOME/lilac-acp-controller`, falling back to `~/.local/state/lilac-acp-controller`. Harness-owned session storage remains owned by each external harness.

### Provider-Owned State

Claude native authentication, configuration, and transcripts live under `CLAUDE_CONFIG_DIR` or Claude's own default, outside Core and Mini stores. Lilac persists only its own bindings and attempt metadata and does not own Claude credentials or transcript retention. See `docs/claude-code.md` for the continuation and deployment contract.

Persisted formats are trust boundaries. Their codecs distinguish current, migrated, valid missing-defaulted, unsupported-version, malformed-serialization, and corrupt-field outcomes as applicable. Reads do not silently rewrite data. SQLite state transitions that pair domain changes with outbox records must remain atomic. Read `MIGRATIONS.md` and `scripts/architecture/README.md` before changing any stored contract.

## Trust And Failure Boundaries

- External HTTP, Redis, SDK, MCP, ACP, SSH, filesystem, subprocess, and persistence values are decoded or projected at registered boundaries before entering domain code.
- Open protocol values are normalized into closed local unions with explicit fallbacks. Internal services should not carry domain-bearing `unknown`.
- Expected failures use domain-owned `Result` error unions, including terminal errors for fallible streams. `Panic` is reserved for registered hard invariants and defects and must not be converted into an ordinary error.
- Exception capture, framework signaling, rollback sentinels, compatibility output, and defect supervision are allowed only at exact registrations in `scripts/architecture/manifest.ts`. The manifest also registers event delivery, persisted codecs, SQLite transactions, tool codecs, and cross-workspace consumers.
- Presentation receives closed render-ready projections, not raw SDK/tool payloads or ad hoc parsers.
- Mini's loopback server may omit HTTP authentication; a non-loopback listener requires its configured bearer token. Core's Level 2 server has no equivalent public authentication contract and must remain on a trusted network.
- Plugins, native tools, workflow agent processes, and other same-user processes are trusted code with service-user authority unless an explicit restricted or OS-isolated boundary says otherwise.

Run `bun run lint:architecture` for the semantic and production-syntax architecture gate. The root `bun run check` overlaps generated-code, lint, tests, typecheck, architecture, and format gates; `bun run ci` runs the conservative serial sequence.

## Runtime Lifecycle Invariants

`apps/core/src/runtime/create-core-runtime.ts` is the composition root. Its exact startup ordering is an implementation detail; preserve these phases and invariants:

- **Prepare:** establish `DATA_DIR`, configuration, stores, artifact/MCP services, and the built-in surface runtime registry before exposing dependent work.
- **Admit safely:** install adapter-event and durable wait/action consumers before connecting producers that could emit matching events.
- **Expose output before execution:** connect and validate registered adapters, establish workflow projection and tool services, then start request ingress and relays before the agent runner can publish replies.
- **Recover atomically:** when a graceful snapshot exists, start execution paused, preflight every required registered descriptor and live relay, apply restore behind rollbackable gates, conditionally consume the exact persisted row, and only then activate. Unavailable or failed targets leave the snapshot retained; unknown rollback atomicity is a Panic.
- **Enable durable producers:** triggers, workflow execution, heartbeat, and background workers start only when the durable queues or consumers needed to avoid losing their work are available. Overall readiness waits for recovery and the remaining required services, and is withdrawn when critical subscriptions become unhealthy.
- **Drain before release:** stop ingress and request producers first, drain agent/relay work to a bounded deadline, persist recoverable state, then stop consumers and release surface/store/bus resources. Surface lifecycle cleanup follows registry ownership and reverse-order release where required; cleanup is best-effort without hiding Panics.

These invariants matter more than a fragile numbered list. Update this section only when the lifecycle contract changes, not when independent setup calls move within a phase.

## Where To Change Things

- Event names, payloads, routing, keys, or codecs: `packages/event-bus/lilac-spec.ts` and compatibility fixtures; delivery behavior belongs in `event-delivery.ts`, `lilac-bus.ts`, and the transport.
- Core process composition or lifecycle: `apps/core/src/runtime/create-core-runtime.ts`, `compose-builtin-surface-runtimes.ts`, and `surface-runtime-lifecycle.ts`.
- Surface ref semantics versus executable participation: `apps/core/src/surface/builtin-surface-protocols.ts`, protocol modules, `runtime-descriptor.ts`, and the platform's runtime descriptor.
- Discord request admission and queue selection: `apps/core/src/surface/discord/discord-request-router.ts`.
- Shared agent turn, steering, interrupt, retry, or compaction behavior: `packages/agent`; Core bus/session policy stays in `apps/core/src/surface/bridge/bus-agent-runner.ts`.
- Portable coding tools: `packages/coding-tools`, `packages/fs`, `packages/bash-safety`, and `packages/tool-results`. Core host adapters belong in `apps/core/src/tools`.
- Core Level 1 or Level 2 exposure: `apps/core/src/plugins/builtin`, `apps/core/src/plugins/manager.ts`, and the implementation under `apps/core/src/tools` or `apps/core/src/tool-server/tools`.
- Plugin contract, loading, or lifecycle: `packages/plugin-runtime` and `PLUGIN_AUTHORING.md`.
- Core HTTP tool serving, request capability, or health: `apps/core/src/tool-server/create-tool-server.ts`, `request-control-authority.ts`, and `health-state.ts`.
- Skills parsing and Core discovery: `packages/utils/skills.ts`; Mini catalog behavior: `packages/mini-lilac-runtime/src/skills.ts`; authoring guidance: `docs/skill-authoring.md`.
- Workflow definition, runtime, persistence, scheduling, waits, or progress: the corresponding owner in `apps/core/src/workflow`; Level 2 adaptation is `apps/core/src/tool-server/tools/programmatic-workflow.ts`.
- Mini protocol: `packages/mini-lilac-client`; Mini domain/persistence/tools: `packages/mini-lilac-runtime`; HTTP boundary: `apps/mini-lilac-server`; terminal UX: `apps/mini-lilac-tui`; bundle/dispatch: `apps/mini-lilac`.
- ACP harness behavior or controller persistence: `apps/acp-controller`.
- Core config/model/provider/prompt behavior: `packages/utils`; config version changes also require
  `docs/core-config-migrations.md`.
- Architecture boundary registration or a new workspace: `scripts/architecture/manifest.ts` and its focused tests; read `scripts/architecture/README.md` first.
